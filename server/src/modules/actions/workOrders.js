import { badRequest, forbidden } from '../../lib/errors.js';
import { plantAudience, publish } from '../../lib/events.js';
import { addSecondsToHms } from '../../lib/format.js';
import { notifyUsers } from './notify.js';

export const WORK_STATUSES = ['Open', 'In Progress', 'On Hold', 'Completed', 'Closed', 'Re Open'];

/** Allowed status moves (prompt §7.2): Open→In Progress→On Hold/Completed→Closed, Completed/Closed→Re Open. */
export const TRANSITIONS = {
  Open: ['In Progress'],
  'In Progress': ['On Hold', 'Completed'],
  'On Hold': ['In Progress'],
  Completed: ['Closed', 'Re Open'],
  Closed: ['Re Open'],
  'Re Open': ['In Progress'],
};

const automate = (ctx, comment, at = new Date()) => ({
  user: ctx.userId,
  type: 'automate',
  comment,
  createdAt: at,
});

/** A work order raised for an anomaly links back to it and acknowledges it (as the managers do). */
const linkAnomaly = async (ctx, doc, svc) => {
  const Anomaly = svc.getModule('anomalies').Model;
  const where = { _id: doc.anomalyId, companyId: ctx.companyId };
  const linked = await Anomaly.updateOne({ ...where, workOrderId: null }, { $set: { workOrderId: doc._id } });
  const acked = await Anomaly.updateOne(
    { ...where, state: 'open' },
    { $set: { state: 'acknowledged', acknowledgedBy: ctx.userId, updatedBy: ctx.userId } },
  );
  if (linked.modifiedCount || acked.modifiedCount) {
    publish(
      ctx.companyId,
      'record',
      { module: 'anomalies', id: String(doc.anomalyId), change: 'updated' },
      plantAudience(doc.plantId),
    );
  }
};

export const workOrderHooks = {
  beforeCreate: ({ ctx, doc, opts }) => {
    const now = new Date();
    doc.workStatus = 'Open';
    doc.scheduleType = opts.scheduleType ?? (doc.pmId || doc.calibrationId ? 'Time Based' : 'Manual');
    doc.trackProcess = { openedAt: now, reOpenProcess: [] };
    doc.durations = { timeInProgress: '00:00:00', timeOnHold: '00:00:00' };
    doc.comments = [
      automate(ctx, opts.source === 'agent' ? 'Created via SARA.' : 'Created the work order.', now),
    ];
    doc.lastModifiedBy = ctx.userId;
  },
  afterCreate: async ({ ctx, doc, svc }) => {
    if (doc.anomalyId) await linkAnomaly(ctx, doc, svc);
    if (!doc.people?.length) return;
    await notifyUsers(svc, ctx, {
      userIds: doc.people,
      title: `${doc.workOrderId} assigned to you`,
      description: doc.name,
      module: 'workorders',
      recordId: doc._id,
      assetId: doc.asset,
      plantId: doc.plantId,
      priority: doc.priority === 'High' ? 'high' : 'medium',
    });
  },
};

/** Takes consumed spare parts out of stock lots, oldest lot first (FIFO), as "used" transactions. */
const consumeSpareParts = async (ctx, record, svc) => {
  const rows = (record.spareParts ?? []).filter((r) => r.consumedQuantity > 0 && !r.consumedAt);
  if (!rows.length) return;
  const Lot = svc.getModule('sparepartinventories').Model;
  const Part = svc.getModule('spareparts').Model;
  const plans = [];
  for (const row of rows) {
    const lots = await Lot.find({
      companyId: ctx.companyId,
      sparePartId: row.sparePart,
      deleted: { $ne: true },
      stockQuantity: { $gt: 0 },
    })
      .sort({ purchaseDate: 1, createdAt: 1 })
      .lean();
    let need = row.consumedQuantity;
    const takes = [];
    for (const lot of lots) {
      if (need <= 0) break;
      const take = Math.min(need, lot.stockQuantity);
      takes.push({ lot, take });
      need -= take;
    }
    if (need > 0) {
      const part = await Part.findById(row.sparePart).select('name').lean();
      throw badRequest(`Not enough stock of ${part?.name ?? 'a spare part'}: ${need} more needed`);
    }
    plans.push({ row, takes });
  }
  const system = { ...ctx, role: 'system' };
  for (const { row, takes } of plans) {
    for (const { lot, take } of takes) {
      await svc.create(
        system,
        'sparepartstransactions',
        {
          sparePartId: String(row.sparePart),
          inventoryId: String(lot._id),
          quantity: take,
          type: 'used',
          reason: { manual: `Used on ${record.workOrderId}`, workOrderId: String(record._id) },
        },
        { source: 'system' },
      );
    }
    row.consumedAt = new Date();
  }
};

/** Status change with CMMS-style stamping of timers, pauses and automate comments. */
export const changeStatus = async ({ ctx, record, input, svc }) => {
  const from = record.workStatus;
  const to = input.workStatus;
  if (from === to) throw badRequest(`${record.workOrderId} is already ${to}`);
  if (!TRANSITIONS[from]?.includes(to)) {
    throw badRequest(
      `Can't move ${record.workOrderId} from ${from} to ${to}. Allowed next: ${TRANSITIONS[from].join(', ')}`,
    );
  }
  const now = new Date();
  const tp = record.trackProcess;
  record.durations ??= {};
  const durations = record.durations;
  const closeTimer = (startKey, durationKey) => {
    if (!tp[startKey]) return;
    durations[durationKey] = addSecondsToHms(durations[durationKey], (now - tp[startKey]) / 1000);
    tp[startKey] = null;
  };
  const notes = [];

  switch (to) {
    case 'In Progress': {
      if (tp.onHoldAt) {
        closeTimer('onHoldAt', 'timeOnHold');
        const pause = record.pauseHistory.at(-1);
        if (pause && !pause.resumedAt) {
          pause.resumedAt = now;
          pause.resumedBy = ctx.userId;
        }
        notes.push('Resumed the work order.');
      } else if (from === 'Re Open') {
        const reopen = tp.reOpenProcess.at(-1);
        if (reopen) reopen.startedAt = now;
        notes.push('Started the re-opened work order.');
      } else {
        tp.startedAt ??= now;
        notes.push('Started the work order.');
      }
      tp.inProgressAt = now;
      break;
    }
    case 'On Hold':
      closeTimer('inProgressAt', 'timeInProgress');
      tp.onHoldAt = now;
      record.pauseHistory.push({ pausedAt: now, pausedBy: ctx.userId });
      notes.push('Put the work order on hold.');
      break;
    case 'Completed': {
      const openTasks = (record.taskAndChecklist ?? [])
        .flatMap((t) => t.tasks ?? [])
        .filter((t) => !t.completed);
      if (openTasks.length) {
        throw badRequest(
          `Finish the checklist first: ${openTasks.length} task(s) open (${openTasks
            .slice(0, 3)
            .map((t) => t.task)
            .join('; ')})`,
        );
      }
      await consumeSpareParts(ctx, record, svc);
      closeTimer('inProgressAt', 'timeInProgress');
      closeTimer('onHoldAt', 'timeOnHold');
      const reopen = tp.reOpenProcess.at(-1);
      if (reopen && !reopen.completedAt) reopen.completedAt = now;
      else tp.completedAt = now;
      notes.push('Completed the work order.');
      break;
    }
    case 'Closed':
      if (input.rating != null) {
        if (!['owner', 'admin', 'superAdmin'].includes(ctx.role))
          throw forbidden('Only owners and admins can rate');
        record.rating = input.rating;
      }
      tp.closedAt = now;
      record.closedBy = ctx.userId;
      notes.push('Closed the work order.');
      break;
    case 'Re Open':
      tp.reOpenProcess.push({ reOpenedAt: now });
      notes.push('Re-opened the work order.');
      break;
  }

  record.workStatus = to;
  record.lastModifiedBy = ctx.userId;
  record.updatedBy = ctx.userId;
  for (const note of notes) record.comments.push(automate(ctx, note, now));
  if (input.note)
    record.comments.push({ user: ctx.userId, type: 'manual', comment: input.note, createdAt: now });
  await record.save();

  const schedule = record.pmId ? 'preventivemaintenances' : record.calibrationId ? 'calibrations' : null;
  if (to === 'Completed' && schedule) {
    await svc
      .getModule(schedule)
      .Model.updateOne(
        { _id: record.pmId ?? record.calibrationId, companyId: ctx.companyId },
        { $set: { lastMaintenanceDate: now } },
      );
  }
  if (to === 'Completed' && record.anomalyId && record.asset) {
    // dynamic import: watch.js imports the registry, which imports this file
    const { markDue } = await import('../../ai/anomaly/watch.js');
    markDue(String(ctx.companyId), String(record.asset)); // re-review now; one clean scan then resolves it
  }

  const plain = record.toObject();
  publish(
    ctx.companyId,
    'record',
    { module: 'workorders', id: String(plain._id), change: 'status', workStatus: to },
    plantAudience(plain.plantId),
  );
  return plain;
};

export const addComment = async ({ ctx, record, input }) => {
  if (record.workStatus === 'Closed')
    throw badRequest(`Can't comment on ${record.workOrderId}: it is closed`);
  record.comments.push({ user: ctx.userId, type: 'manual', comment: input.comment, createdAt: new Date() });
  record.updatedBy = ctx.userId;
  await record.save();
  return record.toObject();
};

export const workOrderActions = {
  status: {
    label: 'Change status',
    icon: 'ArrowRightLeft',
    fields: {
      workStatus: { type: 'enum', values: WORK_STATUSES, required: true, label: 'New status' },
      note: { type: 'text', label: 'Note' },
      rating: { type: 'number', min: 0, max: 5, label: 'Rating (when closing)' },
    },
    run: changeStatus,
  },
  comment: {
    label: 'Add comment',
    icon: 'MessageSquarePlus',
    fields: { comment: { type: 'text', required: true, max: 4000 } },
    run: addComment,
  },
};
