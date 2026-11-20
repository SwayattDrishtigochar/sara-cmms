import { flux } from '@influxdata/influxdb-client';
import { toJsonSchema } from '../agent/declarations.js';
import { fieldLabel } from '../ai/anomaly/features.js';
import { generate } from '../ai/gemini.js';
import { bucketFor, influxEnabled, queryRows } from '../config/influx.js';
import { ParameterSpec } from '../db/models/ParameterSpec.js';
import { can } from '../modules/permissions.js';
import { scopeFilter } from '../modules/records.js';
import { getModule } from '../modules/registry.js';
import { RUNNING_STATES } from '../telemetry/catalog.js';
import { applyGuardrails, OPTIMIZER_SCHEMA, roundTo, SHIFT_HOURS } from './guardrails.js';

/**
 * AI production optimizer (GET /api/optimizer/:assetId): for one production machine the model proposes
 * setting changes that shorten the cycle; guardrails.js keeps them inside the normal bands and computes
 * every number. One answer per company and machine is kept for 10 minutes.
 */

export const SUPPORTED_TYPES = new Set(['Injection Moulding Machine', 'Power Press', 'CNC Machine']);
const MIN = 60_000;
const WINDOW_MS = 120 * MIN; // settings = running mean of the last 2 h …
const LOOKBACK_MS = 7 * 24 * 60 * MIN; // … else the last running reading of the week
const CACHE_MS = 10 * MIN;
const SHOT_CYCLE = 'shotCountDetails|cycleTime';
const NO_DATA = 'No recent running data to suggest changes from';
// ponytail: in-memory cache of one server process; move to Mongo if SARA ever runs several instances.
const cache = new Map();

const keyOf = (measurement, field) => `${measurement}|${field}`;
const anyOf = (column, values) =>
  values.map((value) => flux`r[${column}] == ${value}`).reduce((a, b) => flux`${a} or ${b}`);

const systemFor = (type) =>
  `You are an experienced process engineer for the machine type "${type}". From the machine's current settings, propose at most 4 parameter changes that shorten the cycle time (on a press: raise the strokes per minute) without hurting part quality or safety. Use only fields from "parameters", and keep every recommended value inside that field's normalMin..normalMax band. Prefer small, proven steps. Estimate effectOnCycleTimePct conservatively for each change on its own (negative = faster, never below -8). Write short, plain reasons and risks a shop-floor operator understands. headline: one short sentence naming the main lever, without numbers. notes: at most 3 short practical tips. If nothing can be improved safely, return an empty recommendations list. Return JSON { "headline", "recommendations": [{ "field", "recommended", "effectOnCycleTimePct", "reason", "risk" }], "notes" }.`;

/**
 * Mean (or last value) per measurement and field since `start`. Machine fields count only while it runs
 * (idle readings are not its settings); shot cycle times always do.
 */
const readValues = async (companyId, assetId, fields, { start, now, pick }) => {
  if (!influxEnabled) return new Map();
  const reduce =
    pick === 'mean'
      ? flux`|> group(columns: ["_measurement", "_field"])
  |> mean()`
      : flux`|> last()
  |> group(columns: ["_measurement", "_field"])
  |> sort(columns: ["_time"])
  |> last()`;
  // Stop a minute ahead: points carry MongoDB's clock, which may run a little ahead (as in queries.js).
  const query = flux`import "types"
from(bucket: ${bucketFor(companyId)})
  |> range(start: ${start}, stop: ${new Date(now.getTime() + MIN)})
  |> filter(fn: (r) => r.companyId == ${String(companyId)} and r.assetId == ${assetId})
  |> filter(fn: (r) => ${anyOf('_field', fields)})
  |> filter(fn: (r) => r._measurement == "shotCountDetails" or ${anyOf('status', [...RUNNING_STATES])})
  |> filter(fn: (r) => types.isType(v: r._value, type: "float") or types.isType(v: r._value, type: "int"))
  ${reduce}`;
  let rows;
  try {
    rows = await queryRows(query);
  } catch (err) {
    if (err?.statusCode === 404) return new Map(); // a company's bucket appears with its first data
    throw err;
  }
  return new Map(rows.map((r) => [keyOf(r._measurement, r._field), r._value]));
};

/** Running means of the last 2 h; keys without one fall back to their last running reading of the week. */
const readings = async (companyId, assetId, keys, now) => {
  const fields = [...new Set(keys.map((k) => k.split('|')[1]))];
  const recent = await readValues(companyId, assetId, fields, {
    start: new Date(now.getTime() - WINDOW_MS),
    now,
    pick: 'mean',
  });
  const missing = keys.filter((k) => !recent.has(k));
  if (!missing.length) return { values: recent, older: false };
  const week = await readValues(companyId, assetId, fields, {
    start: new Date(now.getTime() - LOOKBACK_MS),
    now,
    pick: 'last',
  });
  return { values: new Map([...week, ...recent]), older: missing.some((k) => week.has(k)) };
};

/** The machine's In Progress job card in the viewer's scope, with its tool's cavities and ideal cycle. */
const currentJob = async (ctx, assetId) => {
  const mod = getModule('jobcards');
  const jc = await mod.Model.findOne({ asset: assetId, jobStatus: 'In Progress', ...scopeFilter(ctx, mod) })
    .sort({ actualStart: -1 })
    .select('jobCardId jobName partName idealCycleTime mouldParts tool')
    .populate('tool', 'name mouldParts idealCycleTimeSec')
    .lean();
  if (!jc) return null;
  return {
    jobCardId: jc.jobCardId ?? null,
    jobName: jc.jobName ?? null,
    partName: jc.partName ?? null,
    toolName: jc.tool?.name ?? null,
    partsPerShot: jc.mouldParts?.[0]?.assignedPartPerShot || jc.tool?.mouldParts?.[0]?.partPerShot || 1,
    idealCycleTimeSec: jc.idealCycleTime || jc.tool?.idealCycleTimeSec || null,
  };
};

const build = async (ctx, asset, { jobs, now }) => {
  const type = asset.typeOfAsset;
  const assetId = String(asset._id);
  const [specs, job] = await Promise.all([
    ParameterSpec.find({ assetType: type }).sort({ _id: 1 }).lean(),
    jobs ? currentJob(ctx, asset._id) : null,
  ]);
  // Only numeric fields with a normal band can be tuned inside guardrails.
  const banded = specs.filter(
    (s) => Number.isFinite(s.normalMin) && Number.isFinite(s.normalMax) && s.normalMax > s.normalMin,
  );
  const { values, older } = await readings(
    ctx.companyId,
    assetId,
    [...banded.map((s) => keyOf(s.measurement, s.field)), SHOT_CYCLE],
    now,
  );
  const parameters = banded
    .filter((s) => values.has(keyOf(s.measurement, s.field)))
    .map((s) => ({
      field: s.field,
      label: fieldLabel(s.field),
      unit: s.unit ?? null,
      current: roundTo(values.get(keyOf(s.measurement, s.field)), s.normalMax - s.normalMin),
      normalMin: s.normalMin,
      normalMax: s.normalMax,
    }));
  const measured = values.get(SHOT_CYCLE);
  const cycleTimeSec = measured > 0 ? measured : (job?.idealCycleTimeSec ?? null);
  const partsPerShot = job?.partsPerShot ?? 1;

  const input = {
    machine: { name: asset.name, type, status: asset.assetStatus ?? null },
    job: job && { jobName: job.jobName, partName: job.partName, toolName: job.toolName, partsPerShot },
    cycleTimeSec: cycleTimeSec && Math.round(cycleTimeSec * 10) / 10,
    parameters,
  };
  const ai = parameters.length
    ? await generate({
        tier: 'fast',
        purpose: 'optimizer',
        companyId: ctx.companyId,
        system: systemFor(type),
        contents: JSON.stringify(input),
        schema: toJsonSchema(OPTIMIZER_SCHEMA),
        mockInput: input,
      })
    : null;
  const result = applyGuardrails(ai?.json, { parameters, cycleTimeSec, partsPerShot });

  const notes = [];
  if (older) notes.push('No running data in the last 2 hours: based on the last readings while it ran.');
  if (!(measured > 0) && cycleTimeSec)
    notes.push("Cycle time is the job's ideal cycle time; no measured cycle time was found.");
  return {
    supported: true,
    assetId,
    assetName: asset.name ?? null,
    assetType: type,
    generatedAt: now.toISOString(),
    mock: Boolean(ai?.mock),
    model: ai?.model ?? null,
    job: job && { jobCardId: job.jobCardId, ...input.job },
    current: result.current,
    predicted: result.predicted,
    shiftHours: SHIFT_HOURS,
    headline: parameters.length ? result.headline : NO_DATA,
    recommendations: result.recommendations,
    notes: [...notes, ...result.notes],
  };
};

/**
 * Suggestions for one machine the caller may already see (the route checks access). `refresh` skips the
 * 10-minute cache; AI failures throw AiUnavailableError and are not cached.
 */
export const optimize = async (ctx, asset, { refresh = false, now = new Date() } = {}) => {
  const assetId = String(asset._id);
  const type = asset.typeOfAsset ?? null;
  if (!SUPPORTED_TYPES.has(type)) {
    return {
      supported: false,
      assetId,
      assetType: type,
      reason: 'The optimizer covers injection moulding machines, power presses and CNC machines.',
    };
  }
  // Job details are part of the answer: viewers who can't read job cards get an entry of their own.
  const jobs = ctx.modules.includes('jobcards') && can(ctx, getModule('jobcards'), 'read');
  const key = `${ctx.companyId}|${assetId}|${jobs}`;
  let entry = cache.get(key);
  const cached = Boolean(entry) && !refresh && now.getTime() - entry.at < CACHE_MS;
  if (!cached) {
    entry = { at: now.getTime(), result: build(ctx, asset, { jobs, now }) };
    cache.set(key, entry);
    entry.result.catch(() => cache.get(key) === entry && cache.delete(key));
  }
  const result = await entry.result;
  // The status is read fresh on every request; the rest may be up to 10 minutes old.
  return { ...result, cached, current: { status: asset.assetStatus ?? null, ...result.current } };
};
