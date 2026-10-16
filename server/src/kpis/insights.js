import { z } from 'zod';
import { toJsonSchema } from '../agent/declarations.js';
import { generate } from '../ai/gemini.js';
import { getAiSettings } from '../ai/settings.js';
import { systemContext } from '../context/buildUserContext.js';
import { plantAudience, publish } from '../lib/events.js';
import { getModule } from '../modules/registry.js';
import { runKpi } from './runner.js';

/**
 * KPI insight lines (docs/phase5-contracts.md §3.9, §4 `kpi_insights`): KPIs whose insight is older than
 * `kpiInsightTtlMin` run in a ctx limited to the KPI's plant, then one background call writes every line.
 */

const MAX_PER_CALL = 20;
export const INSIGHTS_SCHEMA = z.object({
  insights: z.array(z.object({ id: z.string(), text: z.string().max(200) })).max(MAX_PER_CALL),
});
const SYSTEM =
  'You are SARA, the maintenance and production assistant of a manufacturing plant. For each KPI, write one plain, specific sentence (at most 200 characters) that says what the numbers show and, when it matters, what to look at next. Use only the given stats; never invent numbers. Return JSON { "insights": [{ "id", "text" }] } with the same ids.';
const inFlight = new Map();

const refresh = async (companyId, { kpiIds, force, now }) => {
  const Kpi = getModule('kpis').Model;
  const { kpiInsightTtlMin } = await getAiSettings();
  const cutoff = new Date(now.getTime() - (kpiInsightTtlMin ?? 60) * 60_000);
  const where = { companyId, deleted: { $ne: true } };
  if (kpiIds?.length) where._id = { $in: kpiIds };
  else if (!force) where.$or = [{ 'insight.at': { $exists: false } }, { 'insight.at': { $lt: cutoff } }];
  const kpis = await Kpi.find(where).sort({ 'insight.at': 1, updatedAt: -1 }).limit(MAX_PER_CALL).lean();
  if (!kpis.length) return { refreshed: 0 };

  const base = await systemContext(companyId);
  const runs = await Promise.all(
    kpis.map((kpi) => runKpi({ ...base, plantLock: kpi.plantId ?? null }, kpi, { now })),
  );
  const items = kpis
    .map((kpi, i) => ({ kpi, result: runs[i] }))
    .filter(({ result }) => !result.error)
    .map(({ kpi, result }) => ({
      id: String(kpi._id),
      kpi: {
        title: kpi.title,
        viz: kpi.viz,
        unit: kpi.unit ?? null,
        target: kpi.target ?? null,
        thresholds: kpi.thresholds ?? null,
        timeRangeLabel: result.timeRange?.label ?? null,
      },
      stats: { ...result.stats, ...(result.value !== undefined ? { value: result.value } : {}) },
    }));
  if (!items.length) return { refreshed: 0 };

  const input = { items };
  const { json, model, mock } = await generate({
    tier: 'background',
    purpose: 'kpi',
    companyId,
    system: SYSTEM,
    contents: JSON.stringify(input),
    schema: toJsonSchema(INSIGHTS_SCHEMA),
    mockInput: { kind: 'kpi_insights', ...input },
  });
  const parsed = INSIGHTS_SCHEMA.safeParse(json);
  if (!parsed.success) return { refreshed: 0 };
  const byId = new Map(kpis.map((k) => [String(k._id), k]));
  const asked = new Set(items.map((x) => x.id));
  let refreshed = 0;
  for (const { id, text } of parsed.data.insights) {
    if (!asked.has(id) || !text.trim()) continue;
    asked.delete(id);
    const kpi = byId.get(id);
    await Kpi.updateOne(
      { _id: kpi._id, companyId },
      { $set: { insight: { text: text.trim(), model, at: now, mock: Boolean(mock) } } },
      // Not a definition change: the KPI Builder sorts by updatedAt and re-runs a card when it moves.
      { timestamps: false },
    );
    publish(companyId, 'record', { module: 'kpis', id, change: 'insight' }, plantAudience(kpi.plantId));
    refreshed++;
  }
  return { refreshed };
};

/**
 * Refreshes stale insights of a company (or exactly `kpiIds` / every KPI with `force`); one in-flight run per
 * company and request shape. Throws AiUnavailableError when the AI can't answer (old insights stay).
 */
export const refreshInsights = (companyId, { kpiIds, force = false, now = new Date() } = {}) => {
  const ids = kpiIds?.map(String).sort();
  const key = `${companyId}|${force}|${ids?.join(',') ?? ''}`;
  if (!inFlight.has(key)) {
    inFlight.set(
      key,
      refresh(companyId, { kpiIds: ids, force, now }).finally(() => inFlight.delete(key)),
    );
  }
  return inFlight.get(key);
};
