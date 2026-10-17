import { z } from 'zod';
import { systemContext } from '../../context/buildUserContext.js';
import { plantAudience, publish } from '../../lib/events.js';
import { humanize } from '../../lib/format.js';
import { logger } from '../../lib/logger.js';
import { notifyUsers } from '../../modules/actions/notify.js';
import { ANOMALY_TYPES } from '../../modules/defs/maintenance.js';
import { records } from '../../modules/records.js';
import { getModule } from '../../modules/registry.js';
import { RUNNING_STATES } from '../../telemetry/catalog.js';
import { usageToday } from '../budget.js';
import { generate } from '../gemini.js';
import { getAiSettings } from '../settings.js';
import { openWorkOrderFor, shouldOpenWorkOrder } from './autoWorkOrder.js';
import { ensureBaselines } from './baselines.js';
import { computeFeatures } from './features.js';
import { applyGuardrails, SEVERITIES, STATES } from './guardrails.js';
import { investigateAnomaly } from './investigate.js';
import { logScan } from './scanLog.js';

/**
 * The anomaly watch: every tick, per company, screen the telemetry (features.js), ask Gemini once
 * about the assets that are due, check its answer (guardrails.js) and write the effects: health
 * scores, anomalies, notifications, live events and investigations.
 */

const MIN = 60_000;
export const CLEAN_SCANS_TO_RESOLVE = 3;
/** A resolved anomaly of the same asset and type seen again within this window is reopened, not duplicated. */
export const REOPEN_WINDOW_MS = 6 * 60 * MIN;
/** After a false positive, the same evidence (same fields, no worse) stays quiet this long. */
export const FALSE_POSITIVE_QUIET_MS = 60 * MIN;
/** Past this share of the background budget, quiet assets are reviewed QUOTA_STRETCH times less often. */
export const QUOTA_STRETCH_AT = 0.7;
export const QUOTA_STRETCH = 3;
/** A stored health score this high means the asset was last judged normal (see SYSTEM_PROMPT's scale). */
const HEALTHY_SCORE = 90;
const SEVERITY_RANK = Object.fromEntries(SEVERITIES.map((s, i) => [s, i]));
const Model = (name) => getModule(name).Model;

const lastReviewed = new Map(); // `${companyId}:${assetId}` → ms
const judgedEvidence = new Map(); // `${companyId}:${assetId}` → Set of evidenceOf() at the last review
const inflight = new Map(); // companyId → running scan promise

const parameterSchema = z.object({
  field: z.string().describe('A field name taken from the asset table'),
  observed: z.number().describe('That field’s last value or 10-minute mean, as shown in the table'),
  expected: z.number().describe('The baseline mean from the table'),
  deviation: z.string().describe('Short, e.g. "+4.2σ, rising" or "frozen for 10 min"'),
});
const anomalySchema = z.object({
  type: z.enum(ANOMALY_TYPES),
  severity: z.enum(SEVERITIES),
  confidence: z.number().min(0).max(1),
  parameters: z.array(parameterSchema).min(1),
  explanation: z.string().describe('What the readings show and why it matters, in plain language'),
  likelyCauses: z.array(z.string()),
  recommendedActions: z.array(z.string()),
  urgencyHours: z.number().min(0).describe('Hours before someone should act'),
});
export const decisionSchema = z.object({
  assets: z.array(
    z.object({
      assetId: z.string(),
      healthScore: z.number().min(0).max(100),
      state: z.enum(STATES),
      summary: z.string().describe('One sentence on the machine’s condition'),
      anomalies: z.array(anomalySchema),
    }),
  ),
});
/** JSON Schema Gemini is asked to answer with (zod's `$schema` marker removed: not part of its subset). */
export const RESPONSE_SCHEMA = (() => {
  const { $schema: _, ...schema } = z.toJSONSchema(decisionSchema, { io: 'input', unrepresentable: 'any' });
  return schema;
})();

export const SYSTEM_PROMPT = `You are SARA's machine-health analyst for a manufacturing plant. For every asset below, judge whether its live readings show a real physical problem.
Judge physically, from correlated signals: vibration, motor current and bearing/oil temperature rising together means bearing wear; pressure sagging and turning unsteady while oil heats up means a hydraulic or air leak; high power while Idle, Stopped or OFF means an energy leak; a value frozen at exactly one reading on a running machine means a sensor fault; a rising rejection rate with cycle-time drift means a process or tool problem; a sudden drop to zero while a job runs means a stop.
Be conservative: most assets are normal most of the time, and a false alarm costs the plant trust. Prefer "watch" unless the evidence is strong and sustained: a clear deviation (|z| of 3 or more on the 10-minute mean) that is physically consistent, ideally on two or more related fields or with a steady trend. These are not anomalies: a single mild deviation, |z| below 3, a short spike that is not sustained, a value just outside a spec band, warm-up or cool-down after a status change (the context says how long the status has held; right after a change z is unreliable; a temperature above its baseline but falling, or below it and rising, within an hour of a status change is cooling down or warming up, not a fault, unless vibration or current deviates with it), a machine that just started or stopped, and plant-level meters (incomers) following the plant's load.
An Idle or Stopped machine can still be faulty: its table is compared with its own baseline for that status, so vibration or a bearing/oil temperature rising on it at |z| of 3 or more is judged the same way as on a running one, whatever the absolute level.
Rejection rate: judge it by the counts and the significance given (z, from a binomial test against the reference rate). It is meaningful only with enough parts and z of 3 or more, and is stronger evidence when the cycle time or a process value drifts too; "too few parts" or no reference means it cannot be judged.
Report an anomaly only for a real, specific problem; use the type "other" only when none fits and you are confident. Findings that are merely worth noting belong in the summary of a "watch" asset, not in anomalies.
Cite only fields from that asset's table, by their field key in parameters but by their label in explanations and summaries: observed must be the field's last value or 10-minute mean exactly as shown, expected the baseline mean. A rejection rate given in the context line may be cited as the field "rejectionRate" (percent).
Give every asset a health score (100 = perfect, 70-89 minor concerns, 40-69 needs attention, below 40 urgent) and a one-sentence summary in plain, friendly language. Severity: info = worth noting only (never raised as an alert), warning = plan maintenance soon, critical = act within hours.`;

const fmt = (v, places = 2) => (v == null || !Number.isFinite(v) ? '–' : String(Number(v.toFixed(places))));
const signed = (v, places = 2) => (v == null ? '–' : `${v >= 0 ? '+' : ''}${fmt(v, places)}`);
const minutesSince = (iso, now) => (iso ? Math.round((now - Date.parse(iso)) / MIN) : null);

// The first column is the bare key the model must cite; the unit rides with the label.
export const fieldLine = (f) =>
  [
    f.field,
    f.unit ? `${f.label ?? f.field} (${f.unit})` : (f.label ?? f.field),
    fmt(f.last),
    fmt(f.mean),
    f.baseline ? `${fmt(f.baseline.mean)}±${fmt(f.baseline.std, 3)} (${f.baseline.source})` : 'no baseline',
    f.z == null ? '–' : signed(f.z, 1),
    signed(f.slopePerHour),
    f.band ?? '–',
    f.flags.join(',') || '–',
  ].join(' | ');

/** The rejection-rate context: counts first, so the model sees how much the percentage rests on. */
export const rejectionLine = (r) => {
  const window = `rejection rate ${fmt(r.recentPct)} % (${r.rejected} of ${r.parts} parts in the last ${fmt(r.windowHours, 1)} h)`;
  const ref =
    r.baselinePct == null
      ? 'no reference rate'
      : `reference ${fmt(r.baselinePct)} % (${r.baselineSource === 'fleet' ? 'machines of this type, 7 days' : '7 days'})`;
  const significance = !r.enoughParts ? 'too few parts to judge' : r.z == null ? null : `z ${signed(r.z, 1)}`;
  return [window, ref, significance].filter(Boolean).join(', ');
};

/** Compact, line-per-field prompt for the assets under review. */
export const buildPrompt = (features, now = new Date()) =>
  features
    .map((f) => {
      const since = minutesSince(f.statusSince, now);
      const context = [
        `status ${f.status}${since != null ? ` for ${since} min` : ''}${f.transition ? ' (changed < 3 min ago: z unreliable)' : ''}`,
        f.inShift ? 'in shift' : 'outside shift',
        f.job ? `job ${f.job.jobCardId}${f.job.toolName ? ` (${f.job.toolName})` : ''}` : 'no job',
        f.rejectionRate ? rejectionLine(f.rejectionRate) : null,
        f.idlePowerRatio != null ? `power vs baseline for this status ${fmt(f.idlePowerRatio)}×` : null,
        `screens fired: ${f.flags.join(', ') || 'none'}`,
      ]
        .filter(Boolean)
        .join(' · ');
      return [
        `## ${f.name}${f.tag ? ` (${f.tag})` : ''} — ${f.type} — assetId ${f.assetId}`,
        context,
        'field | label (unit) | last | 10-min mean | baseline mean±std (source) | z | slope/h | band | flags',
        ...f.fields.map(fieldLine),
      ].join('\n');
    })
    .join('\n\n');

/** |z| levels past the first flag that count as new evidence: a deviation that keeps growing is re-judged. */
export const ESCALATION_Z = [5, 10];

/** The screens that fired on an asset, per field: `vibration:z`, `vibration:z5`, `rejects` … */
export const evidenceOf = (f) => [
  ...f.fields.flatMap((field) => [
    ...field.flags.map((flag) => `${field.field}:${flag}`),
    ...ESCALATION_Z.filter((z) => Math.abs(field.z ?? 0) >= z).map((z) => `${field.field}:z${z}`),
  ]),
  ...f.flags.filter((flag) => !f.fields.some((field) => field.flags.includes(flag))),
];

/**
 * Which assets Gemini reviews this tick: ones not reviewed for `quietIntervalMin` (assets with open
 * anomalies included), ones where a screen fired that had not fired at their last review in this
 * process (new evidence), ones in `confirming` (an anomaly counting scans toward its work order), or
 * all of them when forced / alwaysAskAi. The same evidence is not judged again every tick. After a
 * restart (no memory) a flagged asset waits for its quiet interval unless it was last judged healthy:
 * then the flag is new, and a fault starting during a restart is not missed.
 */
export const dueAssets = (
  features,
  {
    lastReviewedAt,
    lastEvidence,
    quietIntervalMin,
    confirming = new Set(),
    force = false,
    alwaysAskAi = false,
    now = Date.now(),
  },
) =>
  features.filter((f) => {
    if (
      force ||
      alwaysAskAi ||
      confirming.has(f.assetId) ||
      now - (lastReviewedAt.get(f.assetId) ?? 0) >= quietIntervalMin * MIN
    ) {
      return true;
    }
    const seen = lastEvidence.get(f.assetId);
    // ponytail: a healthy asset with a lasting harmless flag costs one review per restart; persist the
    // judged evidence on the asset if restarts become frequent with a real key.
    if (!seen) return f.flags.length > 0 && (f.healthScore ?? 0) >= HEALTHY_SCORE;
    return evidenceOf(f).some((e) => !seen.has(e));
  });

const firstSentence = (text) => text.split(/(?<=[.!?])\s/)[0]?.slice(0, 300) ?? '';

/**
 * Assets with an anomaly still short of the consecutive scans that open its automatic work order: they
 * are reviewed every tick, so "after N consecutive scans" means N ticks, not N quiet intervals. Bounded:
 * at most afterScans - 1 extra reviews per anomaly (a critical one opens its order on first sight).
 */
export const confirmingAssets = (open, autoWorkOrder) =>
  new Set(
    autoWorkOrder?.enabled
      ? open
          .filter(
            (a) =>
              !a.workOrderId &&
              SEVERITY_RANK[a.severity] >= SEVERITY_RANK[autoWorkOrder.minSeverity] &&
              (a.scansSeen ?? 0) >= 1 &&
              a.scansSeen < autoWorkOrder.afterScans,
          )
          .map((a) => String(a.assetId))
      : [],
  );

/** Owners, admins and the plant's maintenance technicians. */
const recipients = async (companyId, plantId) => {
  const users = await Model('users')
    .find({
      companyId,
      deleted: { $ne: true },
      $or: [
        { role: { $in: ['owner', 'admin'] } },
        { role: 'technician', department: 'Maintenance', ...(plantId ? { plantId } : {}) },
      ],
    })
    .select('_id')
    .lean();
  return users.map((u) => u._id);
};

const stamp = (id, $set) => Model('anomalies').updateOne({ _id: id }, { $set });
const reload = (id) => Model('anomalies').findById(id).lean();
/** `alerted` says whether people were notified about it (false for an anomaly found under `watch`). */
const announce = (companyId, anomaly, change, alerted) =>
  publish(companyId, 'anomaly', { anomaly, change, alerted }, plantAudience(anomaly.plantId));
const wasAlerted = (companyId, anomalyId) =>
  Model('notifications').exists({
    companyId,
    'details.module': 'anomalies',
    'details.recordId': String(anomalyId),
  });

/** Notification + investigation for a warning/critical anomaly on an asset judged anomalous. */
const alert = async ({ ctx, feature, anomaly, settings, stats }) => {
  await notifyUsers(records, ctx, {
    userIds: await recipients(ctx.companyId, anomaly.plantId),
    title: `${humanize(anomaly.severity)}: ${humanize(anomaly.type)} on ${feature.name}`,
    description: anomaly.summary,
    module: 'anomalies',
    recordId: anomaly._id,
    assetId: anomaly.assetId,
    plantId: anomaly.plantId,
    type: 'alert',
    priority: anomaly.severity === 'critical' ? 'high' : 'medium',
  });
  stats.notified += 1;
  if (!settings.investigate) return;
  try {
    await investigateAnomaly(ctx.companyId, anomaly._id);
  } catch (err) {
    logger.warn({ err, anomalyId: String(anomaly._id) }, 'investigation failed');
  }
};

/** Opens the automatic work order when the anomaly has earned it; a failure is logged, never fails the scan. */
const autoWorkOrder = async ({ ctx, feature, anomaly, decision, settings, stats }) => {
  if (!shouldOpenWorkOrder(anomaly, decision.state, settings.autoWorkOrder)) return;
  try {
    const opened = await openWorkOrderFor(ctx, anomaly, { feature, now: new Date() });
    if (opened && !opened.joined && !opened.linked) stats.workOrders += 1;
  } catch (err) {
    logger.warn({ err, anomalyId: String(anomaly._id) }, 'automatic work order failed');
  }
};

const writable = (a, feature) => ({
  severity: a.severity,
  confidence: a.confidence,
  summary: firstSentence(a.explanation) || `${humanize(a.type)} on ${feature.name}`,
  explanation: a.explanation,
  likelyCauses: a.likelyCauses,
  recommendedActions: a.recommendedActions,
  urgencyHours: a.urgencyHours,
});

/** Upserts one reported anomaly: update the open one, reopen a recent one, or create it. */
const upsertAnomaly = async ({ ctx, feature, decision, found, open, now, model, settings, stats }) => {
  const key = (doc) => `${doc.assetId}|${doc.type}`;
  const existing = open.find((o) => key(o) === `${feature.assetId}|${found.type}`);
  if (existing) {
    // The text is rewritten with the parameters, so the headline always quotes this scan's numbers.
    const { severity, ...text } = writable(found, feature);
    const escalated = SEVERITY_RANK[severity] > SEVERITY_RANK[existing.severity];
    await records.update(
      ctx,
      'anomalies',
      existing._id,
      { ...text, ...(escalated && { severity }) },
      { source: 'system' },
    );
    await Model('anomalies').updateOne(
      { _id: existing._id },
      {
        $set: { parameters: found.parameters, lastSeenAt: now, cleanScans: 0, model },
        $inc: { scansSeen: 1 },
      },
    );
    stats.updated += 1;
    // Alert on an escalation, or the first time an anomaly found under `watch` is judged anomalous.
    const level = escalated ? severity : existing.severity;
    const due =
      decision.state === 'anomalous' &&
      level !== 'info' &&
      (escalated || (existing.state === 'open' && !(await wasAlerted(ctx.companyId, existing._id))));
    const anomaly = await reload(existing._id);
    if (due) {
      announce(ctx.companyId, anomaly, escalated ? 'escalated' : 'alerted', true);
      await alert({ ctx, feature, anomaly, settings, stats });
    }
    await autoWorkOrder({ ctx, feature, anomaly, decision, settings, stats });
    return;
  }
  const recent = await Model('anomalies')
    .findOne({
      companyId: ctx.companyId,
      assetId: feature.assetId,
      type: found.type,
      state: { $in: ['resolved', 'false_positive'] },
      resolvedAt: { $gte: new Date(now.getTime() - REOPEN_WINDOW_MS) },
      deleted: { $ne: true },
    })
    .sort({ resolvedAt: -1 })
    .lean();
  // The user said so: stay quiet about the same evidence for a while, never about a new or worse finding.
  if (recent?.state === 'false_positive') {
    const sameEvidence =
      SEVERITY_RANK[found.severity] <= SEVERITY_RANK[recent.severity] &&
      found.parameters.every((p) => (recent.parameters ?? []).some((q) => q.field === p.field)) &&
      now - recent.resolvedAt < FALSE_POSITIVE_QUIET_MS;
    if (sameEvidence) return;
  }
  const reopen = recent?.state === 'resolved' ? recent : null;
  let id;
  let change;
  if (reopen) {
    await records.update(
      ctx,
      'anomalies',
      reopen._id,
      { state: 'open', ...writable(found, feature) },
      { source: 'system' },
    );
    // A fault back after its repair is a new job: forget the done work order so a new one can open.
    const repairedBefore = reopen.workOrderId && (await repaired(ctx.companyId, [reopen])).size > 0;
    // A reopen is a new detection (ground-truth scoring and the list order read detectedAt).
    await stamp(reopen._id, {
      ...(repairedBefore && { workOrderId: null, autoWorkOrderAt: null }),
      parameters: found.parameters,
      detectedAt: now,
      lastSeenAt: now,
      resolvedAt: null,
      cleanScans: 0,
      scansSeen: 1,
      model,
    });
    id = reopen._id;
    change = 'reopened';
    stats.reopened += 1;
  } else {
    const created = await records.create(
      ctx,
      'anomalies',
      { assetId: feature.assetId, type: found.type, state: 'open', ...writable(found, feature) },
      { source: 'system' },
    );
    await stamp(created._id, {
      parameters: found.parameters,
      detectedAt: now,
      lastSeenAt: now,
      model,
      cleanScans: 0,
      scansSeen: 1,
    });
    id = created._id;
    change = 'new';
    stats.created += 1;
  }
  const anomaly = await reload(id);
  // `watch` never notifies: only an asset judged anomalous with a warning or critical finding alerts people.
  const alerting = decision.state === 'anomalous' && anomaly.severity !== 'info';
  announce(ctx.companyId, anomaly, change, alerting);
  if (alerting) await alert({ ctx, feature, anomaly, settings, stats });
  await autoWorkOrder({ ctx, feature, anomaly, decision, settings, stats });
};

/**
 * Ids of the anomalies whose work order (linked either way) is completed or closed: repaired. An order
 * pointing at the anomaly counts only from its latest detection: the repair before a reopen does not.
 */
const repaired = async (companyId, anomalies) => {
  const orders = await Model('workorders')
    .find({
      companyId,
      workStatus: { $in: ['Completed', 'Closed'] },
      deleted: { $ne: true },
      $or: [
        { anomalyId: { $in: anomalies.map((a) => a._id) } },
        { _id: { $in: anomalies.map((a) => a.workOrderId).filter(Boolean) } },
      ],
    })
    .select('_id anomalyId createdAt')
    .lean();
  const fixes = (a) =>
    orders.some(
      (o) =>
        String(o._id) === String(a.workOrderId) ||
        (String(o.anomalyId) === String(a._id) && !(o.createdAt < a.detectedAt)),
    );
  return new Set(anomalies.filter(fixes).map((a) => String(a._id)));
};

/**
 * Open anomalies the model no longer sees resolve after 3 clean scans of a working machine, or after
 * one once their work order is completed or closed.
 */
const countCleanScans = async ({ ctx, feature, decision, open, now, stats }) => {
  const reported = new Set(decision.anomalies.map((a) => a.type));
  const working = (RUNNING_STATES.has(feature.status) || feature.status === 'Idle') && feature.inShift;
  const quiet = open.filter((o) => String(o.assetId) === feature.assetId && !reported.has(o.type));
  if (!working || !quiet.length) return;
  const fixed = await repaired(ctx.companyId, quiet);
  for (const anomaly of quiet) {
    const cleanScans = (anomaly.cleanScans ?? 0) + 1;
    if (cleanScans < CLEAN_SCANS_TO_RESOLVE && !fixed.has(String(anomaly._id))) {
      await stamp(anomaly._id, { cleanScans, scansSeen: 0 });
      continue;
    }
    await records.update(ctx, 'anomalies', anomaly._id, { state: 'resolved' }, { source: 'system' });
    await stamp(anomaly._id, { resolvedAt: now, cleanScans, scansSeen: 0 });
    announce(ctx.companyId, await reload(anomaly._id), 'resolved');
    stats.resolved += 1;
  }
};

/** Health caps while anomalies are still open: the score never contradicts an open finding. */
const HEALTH_CAP = { critical: 55, warning: 75 };

/** The decision's score and summary, capped by the asset's anomalies still open after this scan. */
const healthOf = async (companyId, assetId, decision) => {
  const still = await Model('anomalies')
    .find({
      companyId,
      assetId,
      state: { $in: ['open', 'acknowledged'] },
      severity: { $in: Object.keys(HEALTH_CAP) },
      deleted: { $ne: true },
    })
    .select('severity')
    .lean();
  const n = still.length;
  const cap = Math.min(100, ...still.map((a) => HEALTH_CAP[a.severity]));
  return {
    healthScore: Math.min(decision.healthScore, cap),
    healthSummary:
      n && decision.state === 'normal'
        ? `${n} open anomal${n === 1 ? 'y' : 'ies'} still being watched.`
        : decision.summary,
  };
};

/**
 * True once today's requests of the background model pass 70 % of what budget.js lets background work
 * use (rpd minus the chat reserve), so flagged and open-anomaly reviews keep the rest.
 */
const quotaTight = async (ai) => {
  const row = (await usageToday()).find((u) => u.model === ai.tiers?.background?.model);
  if (!row) return false;
  return row.calls >= QUOTA_STRETCH_AT * Math.floor(row.limits.rpd * (1 - (ai.chatReservePct ?? 0) / 100));
};

const runScan = async (companyId, { force, reason }) => {
  const now = new Date();
  const ai = await getAiSettings();
  const settings = ai.anomaly;
  const quotaStretched = await quotaTight(ai);
  const quietIntervalMin = settings.quietIntervalMin * (quotaStretched ? QUOTA_STRETCH : 1);
  const ctx = await systemContext(companyId);
  await ensureBaselines(companyId);
  const features = await computeFeatures(companyId, { now });
  const open = await Model('anomalies')
    .find({ companyId, state: { $in: ['open', 'acknowledged'] }, deleted: { $ne: true } })
    .lean();
  const memoryKey = (assetId) => `${companyId}:${assetId}`;
  const lastReviewedAt = new Map(
    features.map((f) => [
      f.assetId,
      lastReviewed.get(memoryKey(f.assetId)) ?? (f.healthUpdatedAt ? Date.parse(f.healthUpdatedAt) : 0),
    ]),
  );
  // Nothing to judge on a switched-off machine outside its shift, or without any readings.
  const judgeable = features.filter((f) => f.fields.length && !(f.status === 'OFF' && !f.inShift));
  const due = dueAssets(judgeable, {
    lastReviewedAt,
    lastEvidence: new Map(features.map((f) => [f.assetId, judgedEvidence.get(memoryKey(f.assetId))])),
    quietIntervalMin,
    confirming: confirmingAssets(open, settings.autoWorkOrder),
    force,
    alwaysAskAi: settings.alwaysAskAi,
    now: now.getTime(),
  });
  const stats = { created: 0, updated: 0, reopened: 0, resolved: 0, notified: 0, workOrders: 0 };
  const flagged = due.filter((f) => f.flags.length);
  const result = {
    reviewed: due.length,
    total: features.length,
    flagged: flagged.length,
    anomalies: 0,
    dropped: 0,
    skipped: features.length - due.length,
    skippedReasons: {
      off: features.length - judgeable.length,
      quiet: judgeable.length - due.length, // judged recently, same evidence
    },
    model: null,
    mock: null,
    reason,
    quietIntervalMin,
    quotaStretched,
    ...stats,
  };
  if (!due.length) return { ...result, summary: summarize(result) };

  const answer = await generate({
    tier: 'background',
    purpose: 'anomaly',
    companyId,
    system: SYSTEM_PROMPT,
    contents: buildPrompt(due, now),
    schema: RESPONSE_SCHEMA,
    mockInput: due,
  }).catch((err) => {
    // A failed call (quota, billing, outage) is retried after the quiet interval, not every tick.
    for (const f of due) lastReviewed.set(memoryKey(f.assetId), now.getTime());
    throw err;
  });
  const { assets: decisions, dropped } = applyGuardrails(answer.json, due);
  if (dropped.length) logger.warn({ companyId, dropped }, 'anomaly findings dropped by the guardrails');
  // Stored with the record, so every place that shows who decided says when it was the mock.
  const model = answer.mock ? `${answer.model} (mock)` : answer.model;
  for (const f of due) judgedEvidence.set(memoryKey(f.assetId), new Set(evidenceOf(f)));
  for (const decision of decisions) {
    const feature = due.find((f) => f.assetId === decision.assetId);
    lastReviewed.set(memoryKey(feature.assetId), now.getTime());
    for (const found of decision.anomalies) {
      await upsertAnomaly({ ctx, feature, decision, found, open, now, model, settings, stats });
    }
    await countCleanScans({ ctx, feature, decision, open, now, stats });
    await Model('assets').updateOne(
      { _id: feature.assetId },
      {
        $set: {
          ...(await healthOf(companyId, feature.assetId, decision)),
          healthUpdatedAt: now,
          healthModel: model,
        },
      },
    );
  }
  Object.assign(result, stats, {
    anomalies: stats.created + stats.updated + stats.reopened,
    dropped: dropped.length,
    model: answer.model,
    mock: answer.mock,
  });
  result.summary = summarize(result, dropped);
  const interesting = new Set(flagged.map((f) => f.assetId));
  await logScan({
    companyId,
    reason,
    model,
    reviewed: due.map((f) => f.assetId),
    flagged: flagged.map((f) => ({
      assetId: f.assetId,
      name: f.name,
      status: f.status,
      flags: f.flags,
      rows: f.fields.filter((x) => x.flags.length).map(fieldLine),
    })),
    decisions: (Array.isArray(answer.json?.assets) ? answer.json.assets : []).filter(
      (d) => interesting.has(d?.assetId) || d?.state !== 'normal' || d?.anomalies?.length,
    ),
    dropped,
    result: { ...result, summary: undefined },
  });
  return result;
};

const DROP_TEXT = {
  unknown_asset: 'a machine that was not in the review',
  unknown_field: 'a reading that was not in the table',
  observed_mismatch: 'a value that did not match the table',
  no_parameters: 'no readings cited',
  info_severity: 'only worth noting (info)',
  unconfident_other: 'an unsure "other" finding',
};

/** Plain words for the UI: what the scan looked at and what came of it. */
export const summarize = (r, dropped = []) => {
  const n = (count, one, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
  const skipped = [
    r.skippedReasons.quiet ? `${r.skippedReasons.quiet} judged recently` : null,
    r.skippedReasons.off ? `${r.skippedReasons.off} off outside the shift` : null,
  ].filter(Boolean);
  const looked = `Reviewed ${r.reviewed} of ${n(r.total, 'machine')}${skipped.length ? ` (${skipped.join(', ')})` : ''}, ${r.flagged} flagged by the screens.`;
  const changes = [
    r.created ? `${n(r.created, 'new anomaly', 'new anomalies')}` : null,
    r.reopened ? `${r.reopened} reopened` : null,
    r.updated ? `${r.updated} updated` : null,
    r.resolved ? `${r.resolved} resolved` : null,
  ].filter(Boolean);
  const outcome = changes.length
    ? `${changes.join(', ')}.`
    : r.reviewed
      ? 'Nothing out of the ordinary.'
      : '';
  const reasons = [...new Set(dropped.map((d) => DROP_TEXT[d.reason] ?? d.reason))].join('; ');
  const refused = dropped.length ? ` ${n(dropped.length, 'finding')} could not be verified: ${reasons}.` : '';
  return `${looked} ${outcome}${refused}`.trim();
};

/** One scan of a company; a scan already running for it is awaited instead of started twice. */
export const scanCompany = async (companyId, { force = false, reason = 'tick' } = {}) => {
  const key = String(companyId);
  if (inflight.has(key)) return inflight.get(key);
  const promise = runScan(key, { force, reason }).finally(() => inflight.delete(key));
  inflight.set(key, promise);
  return promise;
};

/** Companies worth scanning: every one with assets that send telemetry. */
const watchedCompanies = async () => {
  const withTelemetry = await Model('assets').distinct('companyId', {
    deleted: { $ne: true },
    $or: [{ isProductionAsset: true }, { isEnergyAsset: true }, { isSensorIntegration: true }],
  });
  const companies = await Model('companies')
    .find({ isPlatform: { $ne: true }, _id: { $in: withTelemetry } })
    .select('_id')
    .lean();
  return companies.map((c) => String(c._id));
};

const tickMs = async () => {
  const sec = await getAiSettings().then(
    (ai) => ai.anomaly?.tickSec,
    () => null,
  );
  return Math.max(10, sec || 60) * 1000;
};

/**
 * Runs the watch until the returned function is called. Companies are scanned one after another.
 * The first scan waits one full tick: `node --watch` restarts the server on every edit, and which
 * assets are due comes from Mongo (healthUpdatedAt), so a restart never scans everything.
 */
export const startAnomalyWatch = () => {
  let stopped = false;
  let timer = null;
  const schedule = async () => {
    const ms = await tickMs();
    if (!stopped) timer = setTimeout(tick, ms);
  };
  const tick = async () => {
    try {
      const { anomaly } = await getAiSettings();
      if (anomaly.enabled) {
        for (const companyId of await watchedCompanies()) {
          if (stopped) break;
          await scanCompany(companyId).catch((err) => logger.warn({ err, companyId }, 'anomaly scan failed'));
        }
      }
    } catch (err) {
      logger.warn({ err }, 'anomaly watch tick failed');
    } finally {
      await schedule();
    }
  };
  schedule();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
};

/** Makes an asset due at the next tick (e.g. its anomaly's work order was just completed). */
export const markDue = (companyId, assetId) => {
  lastReviewed.set(`${companyId}:${assetId}`, 0); // 0, not deleted: a missing entry falls back to healthUpdatedAt
  judgedEvidence.delete(`${companyId}:${assetId}`);
};

/** Forgets review times and judged evidence (tests). */
export const resetWatchState = () => {
  lastReviewed.clear();
  judgedEvidence.clear();
};
