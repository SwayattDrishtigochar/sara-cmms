import { z } from 'zod';
import { toJsonSchema } from '../agent/declarations.js';
import { money, plantName, zoneOf } from '../agent/tools/common.js';
import { AiUnavailableError, generate } from '../ai/gemini.js';
import { systemContext } from '../context/buildUserContext.js';
import { plantAudience, publish } from '../lib/events.js';
import { logger } from '../lib/logger.js';
import { notifyUsers } from '../modules/actions/notify.js';
import { records, scopeFilter } from '../modules/records.js';
import { getModule } from '../modules/registry.js';
import { COMPONENTS, costSummary } from './engine.js';
import { periodRange } from './periods.js';

/** Cost alerts (phase 5 §3.6): period-to-date cost vs threshold, fired at most once per period. */

const METRIC_COMPONENTS = { maintenance: ['spares', 'consumables', 'labour'], total: COMPONENTS };
const METRIC_LABELS = {
  energy: 'Energy cost',
  spares: 'Spare parts cost',
  consumables: 'Consumables cost',
  labour: 'Labour cost',
  downtime: 'Downtime cost',
  maintenance: 'Maintenance cost',
  total: 'Total cost',
};
const PERIOD_WORDS = {
  day: ['today', 'yesterday'],
  week: ['this week', 'last week'],
  month: ['this month', 'last month'],
};
const COMPARE = { gt: (v, t) => v > t, gte: (v, t) => v >= t, lt: (v, t) => v < t, lte: (v, t) => v <= t };
const HISTORY_MAX = 60;
const explanationSchema = z.object({ explanation: z.string().max(400) });
const SYSTEM = `You explain a breached cost alert of a manufacturing plant in exactly two short sentences: first the most likely cause, from the breakdown and the previous periods, then one concrete fix.
Use only the numbers in the input; amounts are in the given currency. Plain words, no markdown.`;

const CostAlert = () => getModule('costalerts').Model;
const isBelow = (alert) => alert.comparator === 'lt' || alert.comparator === 'lte';

const scopeLabelOf = async (ctx, alert) => {
  if (alert.scope === 'company') return ctx.company?.name ?? 'the company';
  if (alert.scope === 'plant') return plantName(ctx, alert.plantId) ?? 'the plant';
  const asset = await getModule('assets')
    .Model.findOne({ _id: alert.assetId, companyId: ctx.companyId })
    .select('name')
    .lean();
  return asset?.name ?? 'the asset';
};

/** Explicit recipients, else the owners plus the admins of the alert's plant (all admins without a plant). */
const recipientsOf = async (ctx, alert) => {
  if (alert.recipients?.length) return alert.recipients;
  const admins = alert.plantId
    ? { role: 'admin', plantId: { $in: [alert.plantId, null] } }
    : { role: 'admin' };
  const users = await getModule('users')
    .Model.find({ companyId: ctx.companyId, deleted: { $ne: true }, $or: [{ role: 'owner' }, admins] })
    .select('_id')
    .lean();
  return users.map((u) => u._id);
};

/** Two sentences from the background model; on any failure the deterministic sentence. */
const explain = async (ctx, alert, { value, summary }) => {
  const scopeLabel = await scopeLabelOf(ctx, alert);
  const below = isBelow(alert);
  const fallback = `${METRIC_LABELS[alert.metric]} on ${scopeLabel} reached ${money(ctx, value)} ${
    PERIOD_WORDS[alert.period ?? 'day'][below ? 1 : 0]
  }, ${below ? 'under' : 'past'} the ${money(ctx, alert.threshold)} ${below ? 'floor' : 'limit'}.`;
  const input = {
    alert: {
      name: alert.name,
      metric: alert.metric,
      scope: alert.scope,
      scopeLabel,
      period: alert.period,
      comparator: alert.comparator,
      threshold: alert.threshold,
    },
    value,
    currency: summary.currency,
    breakdown: summary.rows.slice(0, 5).map((r) => ({ label: r.label, amount: r.total })),
    previousPeriods: (alert.history ?? []).slice(-6).map((h) => h.value),
  };
  try {
    const res = await generate({
      tier: 'background',
      purpose: 'cost',
      companyId: ctx.companyId,
      system: SYSTEM,
      contents: JSON.stringify(input),
      schema: toJsonSchema(explanationSchema),
      mockInput: { kind: 'cost_alert', ...input },
    });
    const parsed = explanationSchema.safeParse(res.json);
    if (parsed.success && parsed.data.explanation.trim()) {
      return { text: parsed.data.explanation.trim(), model: res.model };
    }
  } catch (err) {
    if (!(err instanceof AiUnavailableError))
      logger.warn({ err, alertId: String(alert._id) }, 'cost alert text failed');
  }
  return { text: fallback, model: null };
};

/**
 * Evaluates one alert in `ctx` (the watch passes the system context). gt/gte compare the period-to-date
 * cost; lt/lte the previous complete period, so a day never "fires" at 00:15. Always stores lastValue;
 * a breach fires once per period key: AI text, history row, notification and a live record event.
 */
export const evaluateAlert = async (ctx, alert, { now = new Date(), fire = true } = {}) => {
  const period = alert.period ?? 'day';
  const range = periodRange(period, zoneOf(ctx), now, { previous: isBelow(alert) });
  const scope = alert.scope ?? 'asset';
  const summary = await costSummary(ctx, {
    start: range.start,
    stop: range.stop,
    now,
    groupBy: scope === 'asset' ? 'component' : 'asset',
    components: METRIC_COMPONENTS[alert.metric] ?? [alert.metric],
    ...(scope === 'asset' ? { assetIds: [String(alert.assetId)] } : {}),
    ...(scope === 'plant' ? { plantId: String(alert.plantId) } : {}),
  });
  const value = summary.totals[alert.metric] ?? null;
  const breached = value != null && COMPARE[alert.comparator ?? 'gt'](value, alert.threshold);
  const result = { value, periodKey: range.key, breached, fired: false };
  await CostAlert().updateOne({ _id: alert._id }, { $set: { lastValue: value, lastEvaluatedAt: now } });
  if (!breached || !fire || alert.lastPeriodKey === range.key) return result;

  // The claim makes "once per period" hold even when the watch and "Check now" race.
  const claimed = await CostAlert()
    .findOneAndUpdate(
      { _id: alert._id, lastPeriodKey: { $ne: range.key } },
      { $set: { lastPeriodKey: range.key, lastTriggeredAt: now } },
      { new: true },
    )
    .lean();
  if (!claimed) return result;
  const { text, model } = await explain(ctx, claimed, { value, summary });
  const notification = await notifyUsers(records, ctx, {
    userIds: await recipientsOf(ctx, claimed),
    title: `Cost alert: ${claimed.name}`,
    description: text,
    module: 'costalerts',
    recordId: claimed._id,
    assetId: claimed.assetId,
    plantId: claimed.plantId,
    type: 'alert',
    priority: 'high',
  });
  const row = {
    periodKey: range.key,
    value,
    threshold: claimed.threshold,
    triggeredAt: now,
    explanation: text,
    model,
    notificationId: String(notification._id),
  };
  await CostAlert().updateOne(
    { _id: claimed._id },
    { $push: { history: { $each: [row], $slice: -HISTORY_MAX } } },
  );
  publish(
    ctx.companyId,
    'record',
    { module: 'costalerts', id: String(claimed._id), change: 'triggered' },
    plantAudience(claimed.plantId),
  );
  return { ...result, fired: true };
};

/** Evaluates the enabled alerts of a company (or one of them) one after another, as the system. */
export const checkAlerts = async (companyId, { now = new Date(), alertId } = {}) => {
  const ctx = await systemContext(companyId);
  const alerts = await CostAlert()
    .find({
      ...scopeFilter(ctx, getModule('costalerts')),
      enabled: true,
      ...(alertId ? { _id: alertId } : {}),
    })
    .lean();
  let fired = 0;
  for (const alert of alerts) {
    try {
      if ((await evaluateAlert(ctx, alert, { now })).fired) fired += 1;
    } catch (err) {
      logger.warn({ err, alertId: String(alert._id) }, 'cost alert evaluation failed');
    }
  }
  return { evaluated: alerts.length, fired };
};
