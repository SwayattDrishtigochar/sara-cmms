import { plantAudience, publish } from '../../lib/events.js';
import { humanize } from '../../lib/format.js';
import { logger } from '../../lib/logger.js';
import { notifyUsers } from '../../modules/actions/notify.js';
import { records } from '../../modules/records.js';
import { getModule } from '../../modules/registry.js';
import { CATEGORY_MIN } from '../../planning/maintenance.js';
import { SEVERITIES } from './guardrails.js';

/**
 * The instant reaction of the anomaly watch: an anomaly the AI keeps seeing (or a critical one on first
 * sight) opens one work order by itself, assigned to a free maintenance technician when there is one.
 */

export { DEFAULT_AUTO_WO } from '../settings.js';

export const CATEGORY_OF = {
  vibration_high: 'Mechanical',
  temperature_high: 'Mechanical',
  temperature_low: 'Mechanical',
  pressure_low: 'Hydraulic',
  pressure_high: 'Hydraulic',
  current_high: 'Electrical',
  current_imbalance: 'Electrical',
  power_high: 'Electrical',
  idle_power_high: 'Electrical',
  cycle_time_drift: 'Inspection',
  quality_degradation: 'Inspection',
  sensor_flatline: 'Calibration',
  sudden_stop: 'Breakdown',
  efficiency_drop: 'Inspection',
  other: 'Inspection',
};
export const PRIORITY_OF = { critical: 'High', warning: 'Medium', info: 'Low' };

const HOUR = 3600_000;
/** A claim this old without a work order was cut off (a restart mid-create): the next scan may take it over. */
export const STALE_CLAIM_MS = 5 * 60_000;
const rank = (severity) => SEVERITIES.indexOf(severity);
const Model = (name) => getModule(name).Model;

const claimable = (anomaly, now) =>
  !anomaly.autoWorkOrderAt || now - new Date(anomaly.autoWorkOrderAt) >= STALE_CLAIM_MS;

/** Pure: whether this scan's stored anomaly (scansSeen already stamped) earns a work order now. */
export const shouldOpenWorkOrder = (anomaly, decisionState, settings, now = new Date()) =>
  Boolean(settings?.enabled) &&
  !anomaly.workOrderId &&
  claimable(anomaly, now) &&
  ['open', 'acknowledged'].includes(anomaly.state) &&
  decisionState === 'anomalous' &&
  rank(anomaly.severity) >= rank(settings.minSeverity) &&
  (anomaly.scansSeen ?? 0) >= (anomaly.severity === 'critical' ? 1 : settings.afterScans);

const parameterLine = (p) => {
  const unit = p.unit ? ` ${p.unit}` : '';
  const dev = p.deviation ? ` (${p.deviation})` : '';
  return `- ${humanize(p.field)}: ${p.observed}${unit} observed vs ${p.expected}${unit} expected${dev}`;
};

/** SARA's insight as the work order description: explanation, flagged parameters, recommended actions. */
export const describeAnomaly = (anomaly) =>
  [
    anomaly.explanation ?? anomaly.summary,
    anomaly.parameters?.length
      ? ['Flagged parameters:', ...anomaly.parameters.map(parameterLine)].join('\n')
      : null,
    anomaly.recommendedActions?.length
      ? ['Recommended actions:', ...anomaly.recommendedActions.map((a, i) => `${i + 1}. ${a}`)].join('\n')
      : null,
    `Opened automatically by SARA from ${anomaly.anomalyCode}.`,
  ]
    .filter(Boolean)
    .join('\n\n');

/** A free, skill-matched maintenance technician of the plant, or null (people.js missing or failing). */
const pickTechnician = async (ctx, { plantId, assetType, category, now, durationMin }) => {
  try {
    const { loadPeople, pickPerson, skillsForTask } = await import('../../planning/people.js');
    const people = await loadPeople(ctx, {
      department: 'Maintenance',
      plantId,
      window: { start: now, end: new Date(now.getTime() + 8 * HOUR) },
    });
    const interval = { start: now, end: new Date(now.getTime() + durationMin * 60_000) };
    return pickPerson(people, interval, { skills: skillsForTask({ category, assetType }) });
  } catch (err) {
    logger.warn({ err }, 'no technician picked for the automatic work order');
    return null;
  }
};

/**
 * Owners and the plant's maintenance managers (admins of department Maintenance, plant-locked to it or
 * company-wide). The technician is not one: the work order's own hook already tells them it is theirs.
 */
const recipients = async (companyId, plantId) => {
  const users = await Model('users')
    .find({
      companyId,
      deleted: { $ne: true },
      $or: [
        { role: 'owner' },
        {
          role: 'admin',
          department: 'Maintenance',
          ...(plantId && { plantId: { $in: [plantId, null] } }),
        },
      ],
    })
    .select('_id')
    .lean();
  return users.map((u) => String(u._id));
};

const DONE = ['Completed', 'Closed'];

/**
 * One fault often shows as several anomalies on one machine (bearing wear: vibration, current and
 * temperature). The first one opens the work order; the others join it as a comment, not a second order.
 */
const joinOpenOrder = async (ctx, claimed, now) => {
  const open = await Model('workorders')
    .findOne({
      companyId: ctx.companyId,
      asset: claimed.assetId,
      anomalyId: { $ne: null },
      workStatus: { $nin: DONE },
      deleted: { $ne: true },
    })
    .sort({ createdAt: -1 })
    .lean();
  if (!open) return null;
  const comment = `SARA also found ${humanize(claimed.type).toLowerCase()} (${claimed.anomalyCode}): ${claimed.summary}`;
  await Model('workorders').updateOne(
    { _id: open._id },
    { $push: { comments: { user: ctx.userId, type: 'automate', comment, createdAt: now } } },
  );
  await Model('anomalies').updateOne({ _id: claimed._id }, { $set: { workOrderId: open._id } });
  // As the work order's own hook does for the anomaly it was opened for.
  await Model('anomalies').updateOne(
    { _id: claimed._id, state: 'open' },
    { $set: { state: 'acknowledged', acknowledgedBy: ctx.userId, updatedBy: ctx.userId } },
  );
  const fresh = await Model('anomalies').findById(claimed._id).lean();
  publish(ctx.companyId, 'anomaly', { anomaly: fresh, change: 'work_order' }, plantAudience(fresh.plantId));
  return { workOrder: open, technician: null, notified: 0, joined: true };
};

/** A work order already opened for this detection but not linked (a restart between create and link). */
const linkOrphan = async (ctx, claimed) => {
  const orphan = await Model('workorders')
    .findOne({
      companyId: ctx.companyId,
      anomalyId: claimed._id,
      deleted: { $ne: true },
      ...(claimed.detectedAt && { createdAt: { $gte: claimed.detectedAt } }),
    })
    .lean();
  if (!orphan) return null;
  await Model('anomalies').updateOne({ _id: claimed._id }, { $set: { workOrderId: orphan._id } });
  return { workOrder: orphan, technician: null, notified: 0, linked: true };
};

/**
 * Opens the work order for an anomaly once: the claim on `autoWorkOrderAt` is atomic, so two scans (or
 * two processes) never open a second one. Null when it was already claimed (a claim older than
 * STALE_CLAIM_MS without a work order is taken over). When the machine already has an open work order
 * from another anomaly, this one joins it (`joined: true`).
 */
export const openWorkOrderFor = async (ctx, anomaly, { feature, now = new Date() }) => {
  const Anomaly = Model('anomalies');
  const claimed = await Anomaly.findOneAndUpdate(
    {
      _id: anomaly._id,
      workOrderId: null,
      $or: [{ autoWorkOrderAt: null }, { autoWorkOrderAt: { $lte: new Date(now - STALE_CLAIM_MS) } }],
    },
    { $set: { autoWorkOrderAt: now } },
    { new: true },
  ).lean();
  if (!claimed) return null;
  try {
    const orphan = await linkOrphan(ctx, claimed);
    if (orphan) return orphan;
    // ponytail: two processes opening for two anomalies of one machine at the same instant can still
    // make two orders; a per-asset claim would close that if several watch processes ever run.
    const joined = await joinOpenOrder(ctx, claimed, now);
    if (joined) return joined;
    const category = CATEGORY_OF[claimed.type] ?? 'Inspection';
    const estimatedDurationMin = CATEGORY_MIN[category] ?? 60;
    const technician = await pickTechnician(ctx, {
      plantId: claimed.plantId,
      assetType: feature?.type,
      category,
      now,
      durationMin: estimatedDurationMin,
    });
    const workOrder = await records.create(
      ctx,
      'workorders',
      {
        name: `${humanize(claimed.type)} on ${feature?.name ?? 'machine'} – auto`,
        description: describeAnomaly(claimed),
        asset: String(claimed.assetId),
        priority: PRIORITY_OF[claimed.severity] ?? 'Medium',
        category,
        estimatedDurationMin,
        dueDate: new Date(now.getTime() + Math.max(1, claimed.urgencyHours ?? 24) * HOUR),
        anomalyId: String(claimed._id),
        people: technician ? [technician.userId] : [],
      },
      { source: 'system' },
    );
    // The work order's own hook links back too; this keeps the link even if that hook changes.
    await Anomaly.updateOne({ _id: claimed._id }, { $set: { workOrderId: workOrder._id } });
    const userIds = await recipients(ctx.companyId, claimed.plantId);
    await notifyUsers(records, ctx, {
      userIds,
      title: `Work order ${workOrder.workOrderId} opened for ${feature?.name ?? 'a machine'}`,
      description: claimed.summary,
      module: 'workorders',
      recordId: workOrder._id,
      assetId: claimed.assetId,
      plantId: claimed.plantId,
      type: 'alert',
      priority: 'high',
    });
    const fresh = await Anomaly.findById(claimed._id).lean();
    publish(ctx.companyId, 'anomaly', { anomaly: fresh, change: 'work_order' }, plantAudience(fresh.plantId));
    return { workOrder, technician, notified: userIds.length };
  } catch (err) {
    // Give the claim back so the next scan tries again instead of leaving the anomaly without a work order.
    await Anomaly.updateOne({ _id: claimed._id, workOrderId: null }, { $set: { autoWorkOrderAt: null } });
    throw err;
  }
};
