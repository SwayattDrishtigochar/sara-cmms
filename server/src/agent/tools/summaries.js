import { DateTime } from 'luxon';
import { z } from 'zod';
import { badRequest } from '../../lib/errors.js';
import { shiftAt } from '../../lib/shifts.js';
import { scopeFilter } from '../../modules/records.js';
import { getModule } from '../../modules/registry.js';
import {
  asObjectId,
  compact,
  findByIdOrCode,
  fmtDate,
  labelsFor,
  money,
  plantOf,
  readableModule,
  round,
  rowsResult,
  timeWindow,
  zoneOf,
} from './common.js';

/** Convenience aggregations (phase 4 §2 maintenance / production / people groups). */

const MAX_TIME_MS = 15_000;
const DONE = ['Completed', 'Closed'];
const plantMatch = (plantId) => {
  if (!plantId) return {};
  const id = asObjectId(plantId);
  if (!id) throw badRequest('plantId must be a 24-character id');
  return { plantId: id };
};
const assetMatch = (assetId) => {
  if (!assetId) return {};
  const id = asObjectId(assetId);
  if (!id) throw badRequest('assetId must be a 24-character id');
  return { assetId: id };
};
const rangeLabel = (ctx, w) =>
  `${fmtDate(ctx, w.start, { time: true })} – ${fmtDate(ctx, w.stop, { time: true })}`;
const aggregate = (mod, pipeline) => mod.Model.aggregate(pipeline).option({ maxTimeMS: MAX_TIME_MS }).exec();
const dayKey = (zone) => ({ $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: zone } });

const workOrdersSummary = {
  name: 'work_orders_summary',
  group: 'maintenance',
  description:
    'Counts work orders by status, priority, category, asset, assignee or plant, with overdue and high-priority counts per group. scope: open (default: not Completed/Closed), overdue, completed, all. start/stop filter by creation date. Example: { groupBy: "priority", scope: "open" }.',
  schema: z.object({
    groupBy: z.enum(['status', 'priority', 'category', 'asset', 'assignee', 'plant']),
    scope: z.enum(['open', 'overdue', 'completed', 'all']).default('open'),
    start: z.string().optional(),
    stop: z.string().optional(),
    plantId: z.string().optional(),
  }),
  run: async (ctx, { groupBy, scope, start, stop, plantId }) => {
    const mod = readableModule(ctx, 'workorders');
    const now = new Date();
    const match = { ...plantMatch(plantId), ...scopeFilter(ctx, mod) };
    if (scope === 'open' || scope === 'overdue') match.workStatus = { $nin: DONE };
    if (scope === 'overdue') match.dueDate = { $lt: now };
    if (scope === 'completed') match.workStatus = { $in: DONE };
    const window = start || stop ? timeWindow({ start, stop }) : null;
    if (window) match.createdAt = { $gte: window.start, $lt: window.stop };
    const field = {
      status: 'workStatus',
      priority: 'priority',
      category: 'category',
      asset: 'asset',
      assignee: 'people',
      plant: 'plantId',
    }[groupBy];
    const pipeline = [{ $match: match }];
    if (groupBy === 'assignee')
      pipeline.push({ $unwind: { path: '$people', preserveNullAndEmptyArrays: true } });
    const isOverdue = { $and: [{ $lt: ['$dueDate', now] }, { $not: [{ $in: ['$workStatus', DONE] }] }] };
    pipeline.push(
      {
        $group: {
          _id: `$${field}`,
          count: { $sum: 1 },
          overdue: { $sum: { $cond: [isOverdue, 1, 0] } },
          highPriority: { $sum: { $cond: [{ $eq: ['$priority', 'High'] }, 1, 0] } },
        },
      },
      { $sort: { count: -1 } },
      { $limit: 200 },
    );
    const groups = await aggregate(mod, pipeline);
    const refModule = { asset: 'assets', assignee: 'users', plant: 'plants' }[groupBy];
    const labels = refModule
      ? await labelsFor(
          ctx,
          refModule,
          groups.map((g) => g._id),
        )
      : null;
    const rows = groups.map((g) => ({
      [groupBy]: labels
        ? (labels.get(String(g._id)) ?? (g._id ? String(g._id) : 'Unassigned'))
        : (g._id ?? 'None'),
      count: g.count,
      overdue: g.overdue,
      highPriority: g.highPriority,
    }));
    const total = rows.reduce((s, r) => s + r.count, 0);
    return rowsResult({
      rows,
      what: `${groupBy} groups (${total} work orders)`,
      forModel: {
        scope,
        groupBy,
        ...(window ? { timeRange: rangeLabel(ctx, window) } : {}),
        total,
        rows: compact(rows),
      },
    });
  },
};

const sparePartsBelowMinimum = {
  name: 'spare_parts_below_minimum',
  group: 'maintenance',
  description:
    'Spare parts whose stock (sum of their stock lots) is below the minimum quantity, with shortfall, criticality, suppliers and lead time. Example: {}.',
  schema: z.object({ plantId: z.string().optional() }),
  run: async (ctx, { plantId }) => {
    const mod = readableModule(ctx, 'spareparts');
    readableModule(ctx, 'sparepartinventories');
    const parts = await aggregate(mod, [
      { $match: { ...plantMatch(plantId), ...scopeFilter(ctx, mod) } },
      {
        $lookup: {
          from: 'sparepartinventories',
          let: { id: '$_id' },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ['$sparePartId', '$$id'] },
                    { $eq: ['$companyId', ctx.companyId] },
                    { $ne: ['$deleted', true] },
                  ],
                },
              },
            },
            { $project: { stockQuantity: 1, supplier: 1, leadTime: 1, cost: 1 } },
          ],
          as: 'lots',
        },
      },
      { $addFields: { stock: { $sum: '$lots.stockQuantity' } } },
      { $match: { $expr: { $lt: ['$stock', { $ifNull: ['$minimumQuantity', 0] }] } } },
      {
        $project: {
          name: 1,
          partNumber: 1,
          minimumQuantity: 1,
          criticality: 1,
          stock: 1,
          lots: 1,
          assignedAsset: 1,
          unit: 1,
        },
      },
      { $sort: { name: 1 } },
      { $limit: 500 },
    ]);
    const supplierIds = parts.flatMap((p) => p.lots.map((l) => l.supplier)).filter(Boolean);
    const suppliers = supplierIds.length
      ? await getModule('suppliers')
          .Model.find({ _id: { $in: supplierIds }, companyId: ctx.companyId })
          .select('name contactPerson phone email leadTimeDays')
          .lean()
      : [];
    const supplierById = new Map(suppliers.map((s) => [String(s._id), s]));
    const assetLabels = await labelsFor(
      ctx,
      'assets',
      parts.flatMap((p) => p.assignedAsset ?? []),
    );
    const rows = parts.map((p) => {
      const sups = [...new Set(p.lots.map((l) => String(l.supplier)))]
        .map((id) => supplierById.get(id))
        .filter(Boolean);
      return {
        part: p.name,
        partNumber: p.partNumber ?? null,
        stock: p.stock,
        minimum: p.minimumQuantity ?? 0,
        shortfall: (p.minimumQuantity ?? 0) - p.stock,
        unit: p.unit ?? 'pcs',
        criticality: p.criticality,
        suppliers:
          sups
            .map(
              (s) =>
                `${s.name}${s.contactPerson ? ` (${s.contactPerson}${s.phone ? `, ${s.phone}` : ''})` : ''}`,
            )
            .join('; ') || 'No supplier on record',
        leadTimeDays:
          Math.max(0, ...p.lots.map((l) => l.leadTime ?? 0), ...sups.map((s) => s.leadTimeDays ?? 0)) || null,
        usedOn: (p.assignedAsset ?? []).map((id) => assetLabels.get(String(id)) ?? String(id)).join(', '),
      };
    });
    return rowsResult({ rows, what: 'spare parts below minimum' });
  },
};

const upcomingMaintenance = {
  name: 'upcoming_maintenance',
  group: 'maintenance',
  description:
    'Preventive maintenance and calibrations due within the next N days (overdue ones included and flagged), with asset, assignees and estimated duration. Example: { days: 7, type: "both" }.',
  schema: z.object({
    days: z.int().min(1).max(365).default(7),
    type: z.enum(['pm', 'calibration', 'both']).default('both'),
    plantId: z.string().optional(),
  }),
  run: async (ctx, { days, type, plantId }) => {
    const now = new Date();
    const horizon = new Date(now.getTime() + days * 86_400_000);
    const floor = new Date(now.getTime() - 30 * 86_400_000);
    const modules = {
      pm: ['preventivemaintenances'],
      calibration: ['calibrations'],
      both: ['preventivemaintenances', 'calibrations'],
    }[type];
    const docs = [];
    for (const name of modules) {
      const mod = readableModule(ctx, name);
      const found = await mod.Model.find({
        ...plantMatch(plantId),
        ...scopeFilter(ctx, mod),
        isActive: { $ne: false },
        nextGenerationDate: { $gte: floor, $lt: horizon },
      })
        .sort({ nextGenerationDate: 1 })
        .limit(300)
        .lean();
      for (const doc of found) docs.push({ mod, doc });
    }
    const assetLabels = await labelsFor(
      ctx,
      'assets',
      docs.map(({ doc }) => doc.assetAllocation),
    );
    const people = await labelsFor(
      ctx,
      'users',
      docs.flatMap(({ doc }) => doc.selectWorkOrder?.people ?? []),
    );
    const rows = docs
      .map(({ mod, doc }) => ({
        type: mod.name === 'calibrations' ? 'Calibration' : 'PM',
        code: doc[mod.codeField],
        name: doc.name,
        asset: assetLabels.get(String(doc.assetAllocation)) ?? null,
        due: doc.nextGenerationDate?.toISOString() ?? null,
        dueLabel: fmtDate(ctx, doc.nextGenerationDate, { time: true }),
        overdue: doc.nextGenerationDate < now,
        estimatedDurationMin: doc.estimatedDurationMin ?? null,
        priority: doc.selectWorkOrder?.priority ?? 'Medium',
        assignees:
          (doc.selectWorkOrder?.people ?? []).map((id) => people.get(String(id)) ?? String(id)).join(', ') ||
          'Unassigned',
        id: String(doc._id),
      }))
      .sort((a, b) => (a.due ?? '').localeCompare(b.due ?? ''));
    return rowsResult({
      rows,
      what: `maintenance tasks due within ${days} days`,
      extra: { days, now: now.toISOString() },
    });
  },
};

const jobCardProgress = {
  name: 'job_card_progress',
  group: 'production',
  description:
    'Progress and quality of one job card (by code like JC-12 or id): parts produced versus target, expected by now, rejection count, OEE when completed. Example: { jobCard: "JC-12" }.',
  schema: z.object({ jobCard: z.string().min(1).max(60) }),
  run: async (ctx, { jobCard }) => {
    const jc = await findByIdOrCode(ctx, 'jobcards', jobCard);
    const [assetLabels, toolLabels] = await Promise.all([
      labelsFor(ctx, 'assets', [jc.asset]),
      labelsFor(ctx, 'tools', [jc.tool]),
    ]);
    const now = Date.now();
    const progress = jc.operations?.[0]?.progress ?? {};
    const good = progress.partsOut ?? 0;
    const rejected = progress.partsRejected ?? 0;
    const produced = good + rejected;
    const startMs = jc.startDate ? new Date(jc.startDate).getTime() : null;
    const endMs = jc.endDate ? new Date(jc.endDate).getTime() : null;
    const elapsed =
      startMs && endMs && endMs > startMs
        ? Math.min(1, Math.max(0, (now - startMs) / (endMs - startMs)))
        : null;
    const expectedByNow = elapsed == null ? null : Math.round(jc.target * elapsed);
    let rejectionsLogged = null;
    if (ctx.modules.includes('rejections')) {
      const rej = readableModule(ctx, 'rejections');
      const [sum] = await aggregate(rej, [
        { $match: { ...scopeFilter(ctx, rej), jobCardId: jc._id } },
        { $group: { _id: null, rejected: { $sum: '$rejectedCount' }, events: { $sum: 1 } } },
      ]);
      rejectionsLogged = sum ? { rejected: sum.rejected, events: sum.events } : { rejected: 0, events: 0 };
    }
    const metrics = jc.completionMetrics ?? {};
    const result = {
      jobCard: jc.jobCardId,
      id: String(jc._id),
      name: jc.jobName,
      status: jc.jobStatus,
      asset: assetLabels.get(String(jc.asset)) ?? null,
      tool: toolLabels.get(String(jc.tool)) ?? null,
      partName: jc.partName ?? null,
      target: jc.target,
      goodParts: good,
      rejectedParts: rejected,
      progressPct: jc.target ? round((good / jc.target) * 100, 1) : null,
      expectedByNow,
      onTrack: expectedByNow == null ? null : good >= expectedByNow * 0.95,
      qualityPct: produced ? round((good / produced) * 100, 1) : null,
      expectedRejectionPct: jc.rejectionPercentage ?? null,
      plannedStart: jc.startDate?.toISOString?.() ?? null,
      plannedEnd: jc.endDate?.toISOString?.() ?? null,
      actualStart: jc.actualStart?.toISOString?.() ?? null,
      actualEnd: jc.actualEnd?.toISOString?.() ?? null,
      idealCycleTimeSec: jc.idealCycleTime ?? null,
      totalShotCount: jc.totalShotCount ?? 0,
      rejectionsLogged,
      oee: metrics.oee?.oee != null ? metrics.oee : null,
      timeAndEfficiency: metrics.timeAndEfficiency ?? null,
      note:
        metrics.oee?.oee != null
          ? 'OEE from completion metrics'
          : 'OEE is computed when the job completes; use telemetry_status_timeline for live availability',
    };
    return {
      forModel: result,
      summary: `${jc.jobCardId}: ${good}/${jc.target} parts`,
      data: { rows: [result] },
    };
  },
};

const rejectionSummary = {
  name: 'rejection_summary',
  group: 'production',
  description:
    'Rejected parts in a time range grouped by reason, part, asset, shift, jobCard or day, with counts and share. Example: { start, stop, groupBy: "reason" }.',
  schema: z.object({
    start: z.string(),
    stop: z.string(),
    groupBy: z.enum(['reason', 'part', 'asset', 'shift', 'jobCard', 'day']).default('reason'),
    plantId: z.string().optional(),
    assetId: z.string().optional(),
  }),
  run: async (ctx, { start, stop, groupBy, plantId, assetId }) => {
    const mod = readableModule(ctx, 'rejections');
    const window = timeWindow({ start, stop });
    const zone = zoneOf(ctx);
    const match = {
      ...plantMatch(plantId),
      ...assetMatch(assetId),
      ...scopeFilter(ctx, mod),
      createdAt: { $gte: window.start, $lt: window.stop },
    };
    let rows;
    if (groupBy === 'shift') {
      const docs = await mod.Model.find(match).select('createdAt plantId rejectedCount').limit(5000).lean();
      const buckets = new Map();
      for (const d of docs) {
        const w = shiftAt(plantOf(ctx, d.plantId), d.createdAt, zone);
        const key = w ? `Shift ${w.shiftName}` : 'Outside shifts';
        const b = buckets.get(key) ?? { rejected: 0, events: 0 };
        b.rejected += d.rejectedCount ?? 0;
        b.events += 1;
        buckets.set(key, b);
      }
      rows = [...buckets].map(([key, b]) => ({ shift: key, ...b }));
    } else {
      const key = {
        reason: '$rejectionReason',
        part: '$partName',
        asset: '$assetId',
        jobCard: '$jobCardId',
        day: dayKey(zone),
      }[groupBy];
      const groups = await aggregate(mod, [
        { $match: match },
        { $group: { _id: key, rejected: { $sum: '$rejectedCount' }, events: { $sum: 1 } } },
        { $sort: { rejected: -1 } },
        { $limit: 200 },
      ]);
      const refModule = { asset: 'assets', jobCard: 'jobcards' }[groupBy];
      const labels = refModule
        ? await labelsFor(
            ctx,
            refModule,
            groups.map((g) => g._id),
          )
        : null;
      rows = groups.map((g) => ({
        [groupBy]: labels ? (labels.get(String(g._id)) ?? 'Unknown') : (g._id ?? 'Unspecified'),
        rejected: g.rejected,
        events: g.events,
      }));
    }
    rows.sort((a, b) => b.rejected - a.rejected);
    const total = rows.reduce((s, r) => s + r.rejected, 0);
    for (const r of rows) r.sharePct = total ? round((r.rejected / total) * 100, 1) : 0;
    return rowsResult({
      rows,
      what: `${groupBy} groups (${total} rejected parts)`,
      forModel: { timeRange: rangeLabel(ctx, window), groupBy, totalRejected: total, rows: compact(rows) },
    });
  },
};

const downtimeSummary = {
  name: 'downtime_summary',
  group: 'production',
  description:
    'Machine downtime (Stopped/OFF inside shifts) in a time range grouped by asset, reason or day: hours, number of stops, cost at the asset downtime rate, top reasons per asset. Example: { start, stop, groupBy: "asset" }.',
  schema: z.object({
    start: z.string(),
    stop: z.string(),
    groupBy: z.enum(['asset', 'reason', 'day']).default('asset'),
    plantId: z.string().optional(),
    assetId: z.string().optional(),
  }),
  run: async (ctx, { start, stop, groupBy, plantId, assetId }) => {
    const mod = readableModule(ctx, 'downtimes');
    const window = timeWindow({ start, stop });
    const zone = zoneOf(ctx);
    const settings = ctx.modules.includes('costsettings')
      ? await getModule('costsettings').Model.findOne({ companyId: ctx.companyId }).lean()
      : null;
    const defaultRate = settings?.defaultDowntimeCostPerHour ?? 2500;
    const match = {
      ...plantMatch(plantId),
      ...assetMatch(assetId),
      ...scopeFilter(ctx, mod),
      startedAt: { $gte: window.start, $lt: window.stop },
    };
    const key = {
      asset: '$assetId',
      reason: { $ifNull: ['$reason', 'Unspecified'] },
      day: { $dateToString: { format: '%Y-%m-%d', date: '$startedAt', timezone: zone } },
    }[groupBy];
    const pipeline = [
      { $match: match },
      { $lookup: { from: 'assets', localField: 'assetId', foreignField: '_id', as: 'assetDoc' } },
      {
        $addFields: {
          rate: { $ifNull: [{ $arrayElemAt: ['$assetDoc.downtimeCostPerHour', 0] }, defaultRate] },
          hours: { $divide: [{ $ifNull: ['$totalDowntimeInSeconds', 0] }, 3600] },
        },
      },
      { $addFields: { cost: { $multiply: ['$hours', '$rate'] } } },
    ];
    if (groupBy === 'reason')
      pipeline.push({ $unwind: { path: '$reason', preserveNullAndEmptyArrays: true } });
    pipeline.push(
      {
        $group: {
          _id: key,
          seconds: { $sum: { $ifNull: ['$totalDowntimeInSeconds', 0] } },
          stops: { $sum: 1 },
          cost: { $sum: '$cost' },
          unverified: { $sum: { $cond: [{ $eq: ['$isVerified', true] }, 0, 1] } },
          reasons: { $push: '$reason' },
        },
      },
      { $sort: { seconds: -1 } },
      { $limit: 200 },
    );
    const groups = await aggregate(mod, pipeline);
    const labels =
      groupBy === 'asset'
        ? await labelsFor(
            ctx,
            'assets',
            groups.map((g) => g._id),
          )
        : null;
    const topReasons = (list) => {
      const counts = new Map();
      for (const r of list.flat().filter(Boolean)) counts.set(r, (counts.get(r) ?? 0) + 1);
      return [...counts]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([r, n]) => `${r} (${n})`)
        .join(', ');
    };
    const rows = groups.map((g) => ({
      [groupBy]: labels ? (labels.get(String(g._id)) ?? 'Unknown asset') : (g._id ?? 'Unspecified'),
      hours: round(g.seconds / 3600, 1),
      stops: g.stops,
      cost: Math.round(g.cost),
      unverified: g.unverified,
      ...(groupBy === 'asset' ? { topReasons: topReasons(g.reasons) || 'No reason recorded' } : {}),
    }));
    const totalHours = round(
      rows.reduce((s, r) => s + r.hours, 0),
      1,
    );
    const totalCost = rows.reduce((s, r) => s + r.cost, 0);
    return rowsResult({
      rows,
      what: `${groupBy} groups (${totalHours} h downtime)`,
      forModel: {
        timeRange: rangeLabel(ctx, window),
        groupBy,
        totalHours,
        totalCost: money(ctx, totalCost),
        rows: compact(rows),
      },
    });
  },
};

const attendanceSummary = {
  name: 'attendance_summary',
  group: 'people',
  description:
    'Who checked in during a time range, with shift, check-in/out, hours worked and break minutes. Example: { start, stop } for today.',
  schema: z.object({ start: z.string(), stop: z.string(), plantId: z.string().optional() }),
  run: async (ctx, { start, stop, plantId }) => {
    const mod = readableModule(ctx, 'checkinouts');
    const breaksMod = readableModule(ctx, 'userbreaktimes');
    const window = timeWindow({ start, stop });
    const checkins = await mod.Model.find({
      ...plantMatch(plantId),
      ...scopeFilter(ctx, mod),
      checkInTime: { $gte: window.start, $lt: window.stop },
    })
      .sort({ checkInTime: 1 })
      .limit(1000)
      .lean();
    const breaks = checkins.length
      ? await breaksMod.Model.find({
          ...scopeFilter(ctx, breaksMod),
          $or: [
            { checkInOutId: { $in: checkins.map((c) => c._id) } },
            {
              userId: { $in: checkins.map((c) => c.userId) },
              startTime: { $gte: window.start, $lt: window.stop },
            },
          ],
        }).lean()
      : [];
    const names = await labelsFor(
      ctx,
      'users',
      checkins.map((c) => c.userId),
    );
    const now = Date.now();
    const minutes = (from, to) =>
      Math.max(0, Math.round(((to ? new Date(to).getTime() : now) - new Date(from).getTime()) / 60_000));
    const rows = checkins.map((c) => {
      const own = breaks.filter((b) =>
        b.checkInOutId ? String(b.checkInOutId) === String(c._id) : String(b.userId) === String(c.userId),
      );
      const breakMinutes = own.reduce((s, b) => s + minutes(b.startTime, b.endTime), 0);
      return {
        person: names.get(String(c.userId)) ?? String(c.userId),
        shift: c.shiftName ?? null,
        checkedIn: c.checkInTime.toISOString(),
        checkedOut: c.checkOutTime?.toISOString() ?? null,
        hours: round(minutes(c.checkInTime, c.checkOutTime) / 60, 2),
        breakMinutes,
        breaks: own.length,
        stillIn: !c.checkOutTime,
      };
    });
    return rowsResult({ rows, what: 'check-ins', extra: { timeRange: rangeLabel(ctx, window) } });
  },
};

export const summaryTools = [
  workOrdersSummary,
  sparePartsBelowMinimum,
  upcomingMaintenance,
  jobCardProgress,
  rejectionSummary,
  downtimeSummary,
  attendanceSummary,
];

/** Day in the company zone for a point stamped at a window stop (used by telemetry buckets). */
export const localDay = (ms, zone) => DateTime.fromMillis(ms - 1000, { zone });
