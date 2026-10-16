import { z } from 'zod';
import { toJsonSchema } from '../agent/declarations.js';
import { round, zoneOf } from '../agent/tools/common.js';
import { AiUnavailableError, generate } from '../ai/gemini.js';
import { getAiSettings } from '../ai/settings.js';
import { AiText } from '../db/models/AiText.js';
import { getModule } from '../modules/registry.js';
import { COMPONENTS, costSummary } from './engine.js';
import { periodRange } from './periods.js';

/** The Costs page overview (phase 5 §4 cost_overview): live numbers, an AI text cached per scope and period. */

const overviewSchema = z.object({
  headline: z.string().max(160),
  summary: z.string().max(600),
  drivers: z
    .array(z.object({ key: z.string(), explanation: z.string().max(300), action: z.string().max(200) }))
    .max(5),
});
const SYSTEM = `You are the cost analyst of a manufacturing plant. From the period totals, the previous period (same elapsed length), the top cost drivers and the monthly budgets, write a headline, a short summary of what drives the cost and how it moved, and for each driver key one explanation and one concrete action.
Use only the numbers in the input; amounts are in the given currency. Plain words, no markdown.`;
const HOUR = 3_600_000;
const inflight = new Map(); // companyId|key → running AI call

const scopeKey = (ctx) => (ctx.plantLock ? `plant:${ctx.plantLock}` : 'all');

/** Rows with the biggest totals, their largest component and the change against the previous period. */
const driversOf = (summary, previous) => {
  const before = new Map(previous.rows.map((r) => [r.key, r.total]));
  return summary.rows
    .filter((r) => r.total > 0)
    .slice(0, 5)
    .map((r) => {
      const prev = before.get(r.key);
      return {
        key: r.key,
        label: r.label,
        component: COMPONENTS.reduce((best, c) => ((r[c] ?? 0) > (r[best] ?? 0) ? c : best)),
        amount: r.total,
        deltaPct: prev ? round(((r.total - prev) / prev) * 100, 1) : null,
      };
    });
};

const writeText = async (ctx, key, input, now) => {
  const res = await generate({
    tier: 'background',
    purpose: 'cost',
    companyId: ctx.companyId,
    system: SYSTEM,
    contents: JSON.stringify(input),
    schema: toJsonSchema(overviewSchema),
    mockInput: { kind: 'cost_overview', ...input },
  });
  const parsed = overviewSchema.safeParse(res.json);
  if (!parsed.success)
    throw new AiUnavailableError('AI_ERROR', 'The AI overview was not in the expected shape');
  const keys = new Set(input.topDrivers.map((d) => d.key));
  const json = { ...parsed.data, drivers: parsed.data.drivers.filter((d) => keys.has(d.key)) };
  return AiText.findOneAndUpdate(
    { companyId: ctx.companyId, kind: 'cost_overview', key },
    { $set: { json, evidence: input, model: res.model, mock: Boolean(res.mock), at: now } },
    { upsert: true, new: true },
  ).lean();
};

/**
 * Period-to-date summary by asset, the previous period cut to the same elapsed time, deterministic top
 * drivers and the AI text. The text is regenerated when older than `briefingTtlHours` or on `refresh`;
 * when the AI is unavailable the last text comes back with `stale: true` and `aiError`.
 */
export const getCostOverview = async (ctx, { period = 'month', refresh = false, now = new Date() } = {}) => {
  const zone = zoneOf(ctx);
  const range = periodRange(period, zone, now);
  const prev = periodRange(period, zone, now, { previous: true });
  const prevStop = new Date(Math.min(prev.stop.getTime(), prev.start.getTime() + (range.stop - range.start)));
  const [summary, previous, settings] = await Promise.all([
    costSummary(ctx, { start: range.start, stop: range.stop, groupBy: 'asset', now }),
    costSummary(ctx, { start: prev.start, stop: prevStop, groupBy: 'asset', now }),
    getModule('costsettings').Model.findOne({ companyId: ctx.companyId }).lean(),
  ]);
  const topDrivers = driversOf(summary, previous);
  const base = {
    period: { key: range.key, label: range.label },
    summary,
    previous: { totals: previous.totals },
    topDrivers,
  };
  const key = `${scopeKey(ctx)}|${range.key}`;
  const cached = await AiText.findOne({ companyId: ctx.companyId, kind: 'cost_overview', key }).lean();
  const ttlMs = ((await getAiSettings()).briefingTtlHours ?? 4) * HOUR;
  const answer = (doc, extra = {}) => ({
    ...base,
    ai: doc?.json ?? null,
    model: doc?.model ?? null,
    at: doc?.at ?? null,
    mock: Boolean(doc?.mock),
    stale: false,
    ...extra,
  });
  if (cached && !refresh && now - cached.at < ttlMs) return answer(cached);

  const input = {
    period: base.period,
    currency: summary.currency,
    totals: summary.totals,
    previous: previous.totals,
    topDrivers,
    budgets: {
      maintenance: settings?.monthlyMaintenanceBudget ?? null,
      energy: settings?.monthlyEnergyBudget ?? null,
    },
  };
  const flightKey = `${ctx.companyId}|${key}`;
  try {
    if (!inflight.has(flightKey)) {
      inflight.set(
        flightKey,
        writeText(ctx, key, input, now).finally(() => inflight.delete(flightKey)),
      );
    }
    return answer(await inflight.get(flightKey));
  } catch (err) {
    if (!(err instanceof AiUnavailableError)) throw err;
    return answer(cached, { stale: Boolean(cached), aiError: { code: err.code, message: err.message } });
  }
};
