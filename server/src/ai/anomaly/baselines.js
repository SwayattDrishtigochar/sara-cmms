import { flux, fluxDuration, fluxExpression } from '@influxdata/influxdb-client';
import { bucketFor, influxEnabled, queryRows } from '../../config/influx.js';
import { Baseline } from '../../db/models/Baseline.js';
import { ParameterSpec } from '../../db/models/Sim.js';
import { ENERGY_FIELDS, RUNNING_STATES } from '../../telemetry/catalog.js';

/**
 * What "normal" looks like per asset, field and machine status: mean, spread and the 5–95 % band of
 * the last 7 days of 1-minute means. Deterministic statistics only; Gemini does the judging.
 */

/** Measurements with process values (counters and totals are left out, see EXCLUDED_FIELDS). */
export const MEASUREMENTS = ['machineParams', 'sensorData', 'energy', 'shotCountDetails'];
export const EXCLUDED_FIELDS = new Set([
  'shotCount',
  'shotsProduced',
  'totalCycleTime',
  'runningTime',
  'idleTime',
  'stoppedTime',
  'ENERGY READING',
  'ENERGY CONSUMPTION',
  'counter1_present_value', // a press's batch counter (a sawtooth) and its target, not process values
  'counter1_set_value',
]);
/** Fewer 1-minute means than this (2 h) is not a history: fall back to the spec band. */
export const MIN_HISTORY = 120;
export const BASELINE_MAX_AGE_MS = 6 * 60 * 60_000;
/** An empty result (no telemetry yet) is retried sooner. */
const EMPTY_RETRY_MS = 10 * 60_000;

const STATS = {
  mean: 'mean()',
  std: 'stddev()',
  p5: 'quantile(q: 0.05)',
  p95: 'quantile(q: 0.95)',
  n: 'count()',
};

const cache = new Map(); // companyId → { computedAt (ms), map }

export const baselineKey = (assetId, field, status) => `${assetId}|${field}|${status}`;

const anyOf = (column, values) =>
  values.map((value) => flux`r[${column}] == ${value}`).reduce((a, b) => flux`${a} or ${b}`);

/** The 1-minute means of one asset every statistic is computed from. */
const minuteMeans = (companyId, assetId, days, excludeLastMin) => flux`import "types"
from(bucket: ${bucketFor(companyId)})
  |> range(start: ${fluxDuration(`-${days}d`)}, stop: ${fluxDuration(`-${excludeLastMin}m`)})
  |> filter(fn: (r) => r.companyId == ${String(companyId)} and r.assetId == ${assetId})
  |> filter(fn: (r) => ${anyOf('_measurement', MEASUREMENTS)})
  |> filter(fn: (r) => types.isType(v: r._value, type: "float") or types.isType(v: r._value, type: "int"))
  |> group(columns: ["assetId", "_measurement", "_field", "status"])
  |> aggregateWindow(every: 1m, fn: mean, createEmpty: false)`;

const rows = async (query) => {
  if (!influxEnabled) return [];
  try {
    return await queryRows(query);
  } catch (err) {
    if (err?.statusCode === 404) return []; // no bucket yet: no telemetry
    throw err;
  }
};

const toMap = (docs) => {
  const map = new Map();
  for (const row of docs) {
    const key = baselineKey(row.assetId, row.field, row.status);
    // A field name can live in two measurements (cycleTime); the better-known series wins.
    if (!map.has(key) || map.get(key).n < row.n) map.set(key, row);
  }
  return map;
};

/** Assets with telemetry in the window (the tag index answers this fast). */
const assetsWithData = async (companyId, days) =>
  (
    await rows(flux`import "influxdata/influxdb/schema"
schema.tagValues(bucket: ${bucketFor(companyId)}, tag: "assetId", start: ${fluxDuration(`-${days}d`)})`)
  ).map((r) => r._value);

/**
 * Recomputes the company's baselines from InfluxDB (one small query per asset and statistic, joined
 * here) and replaces the stored rows. Returns the rows written. One asset at a time: a single query
 * over every asset and 7 days takes minutes on a remote InfluxDB and hits the client timeout.
 * ponytail: sequential per asset; run a few assets in parallel if a company meters hundreds of them.
 */
export const refreshBaselines = async (companyId, { days = 7, excludeLastMin = 60 } = {}) => {
  const results = [];
  for (const assetId of await assetsWithData(companyId, days)) {
    const base = minuteMeans(companyId, assetId, days, excludeLastMin);
    results.push(
      ...(await Promise.all(
        Object.entries(STATS).map(async ([stat, fn]) => [
          stat,
          await rows(flux`${base}
  |> ${fluxExpression(fn)}
  |> keep(columns: ["assetId", "_measurement", "_field", "status", "_value"])`),
        ]),
      )),
    );
  }
  const computedAt = new Date();
  const joined = new Map();
  for (const [stat, list] of results) {
    for (const r of list) {
      if (EXCLUDED_FIELDS.has(r._field)) continue;
      const key = `${r.assetId}|${r._measurement}|${r._field}|${r.status}`;
      if (!joined.has(key)) {
        joined.set(key, {
          companyId,
          assetId: r.assetId,
          measurement: r._measurement,
          field: r._field,
          status: r.status,
          computedAt,
        });
      }
      joined.get(key)[stat] = Number(r._value);
    }
  }
  const docs = [...joined.values()].filter((d) => Number.isFinite(d.mean) && d.n > 0);
  for (const d of docs) d.std = Number.isFinite(d.std) ? d.std : 0; // stddev() of one point is null
  if (docs.length) {
    await Baseline.bulkWrite(
      docs.map((d) => ({
        updateOne: {
          filter: {
            companyId: d.companyId,
            assetId: d.assetId,
            measurement: d.measurement,
            field: d.field,
            status: d.status,
          },
          update: { $set: d },
          upsert: true,
        },
      })),
      { ordered: false },
    );
  }
  await Baseline.deleteMany({ companyId, computedAt: { $lt: computedAt } });
  cache.set(String(companyId), { computedAt: computedAt.getTime(), map: toMap(docs) });
  return { rows: docs };
};

/** Baselines of a company keyed by `${assetId}|${field}|${status}`, from memory or the stored rows. */
export const baselineFor = async (companyId) => {
  const key = String(companyId);
  if (!cache.has(key)) {
    const docs = await Baseline.find({ companyId }).lean();
    const computedAt = Math.max(0, ...docs.map((d) => new Date(d.computedAt).getTime()));
    cache.set(key, { computedAt, map: toMap(docs) });
  }
  return cache.get(key).map;
};

/** Baselines no older than `maxAgeMs` (recomputed when stale, missing, or empty for 10 minutes). */
export const ensureBaselines = async (companyId, { maxAgeMs = BASELINE_MAX_AGE_MS } = {}) => {
  const map = await baselineFor(companyId);
  const entry = cache.get(String(companyId));
  const age = Date.now() - entry.computedAt;
  if (age < (map.size ? maxAgeMs : EMPTY_RETRY_MS)) return map;
  await refreshBaselines(companyId);
  return cache.get(String(companyId)).map;
};

/** Forgets cached baselines (tests, or after a company is removed). */
export const clearBaselineCache = (companyId) =>
  companyId === undefined ? cache.clear() : cache.delete(String(companyId));

/** Spec bands per asset type keyed by `${assetType}|${field}` (the simulator or an OEM manual writes them). */
export const loadSpecs = async () => {
  const specs = await ParameterSpec.find({ valueType: { $ne: 'string' } }).lean();
  return new Map(specs.map((s) => [`${s.assetType}|${s.field}`, s]));
};

const ENERGY_UNITS = new Map(ENERGY_FIELDS.map((f) => [f.field, f.unit]));

/** A field's unit: its spec's, else the energy catalogue's, else null. */
export const unitOf = (spec, field) => spec?.unit ?? ENERGY_UNITS.get(field) ?? null;

/** Without a spec band, no 1-minute mean is honestly steadier than this share of its level. */
export const REL_FLOOR = 0.025;
/**
 * Share of the spec's own sigma (band / 6) a history spread never undercuts: one machine in one state is
 * steadier than the whole normal band, but not 50 times steadier.
 */
export const SPEC_FLOOR = 0.5;
/** Smallest real change per unit (typical industrial sensor resolution and repeatability). */
export const UNIT_FLOOR = {
  '°C': 0.2,
  bar: 0.02,
  kN: 2,
  rpm: 2,
  spm: 0.2,
  ton: 0.5,
  A: 0.2,
  'mm/s': 0.05,
  '%': 0.5,
  kW: 0.05,
  V: 1,
  Hz: 0.02,
  '': 0.005, // power factor
};

/**
 * The smallest spread a baseline may claim, so z counts real noise, not a near-flat simulated history
 * (which turned a 2.5 °C wobble into 17σ): SPEC_FLOOR of the spec band's sigma when the type has a band
 * (its scale beats a share of the level, which means nothing for 620 °C), else REL_FLOOR of |mean|,
 * and never less than the unit's floor.
 * ponytail: fixed floors per unit; make them spec fields if an OEM states sensor accuracy.
 */
export const noiseFloor = (mean, spec, unit) =>
  Math.max(
    spec?.normalMin != null && spec?.normalMax != null
      ? (SPEC_FLOOR * (spec.normalMax - spec.normalMin)) / 6
      : REL_FLOOR * Math.abs(mean),
    UNIT_FLOOR[unit] ?? 0,
  );

/**
 * The baseline a field is judged against: 7 days of history for that status when there is enough of
 * it, else the type's spec band (which describes a running machine, so only while Running), else null.
 * Its std is never below noiseFloor; `spread` keeps the measured one (a constant setpoint is no flatline).
 */
export const resolveBaseline = (map, specs, { assetId, type, field, status }) => {
  const row = map.get(baselineKey(assetId, field, status));
  const spec = specs.get(`${type}|${field}`);
  const floor = (mean) => noiseFloor(mean, spec, unitOf(spec, field));
  if (row && row.n >= MIN_HISTORY) {
    const std = Math.max(row.std, floor(row.mean));
    return { mean: row.mean, std, spread: row.std, p5: row.p5, p95: row.p95, n: row.n, source: 'history' };
  }
  if (!spec || spec.normalMin == null || spec.normalMax == null || !RUNNING_STATES.has(status)) return null;
  const { normalMin: min, normalMax: max } = spec;
  const mean = (min + max) / 2;
  return {
    mean,
    std: Math.max((max - min) / 6, floor(mean), 1e-9),
    spread: (max - min) / 6,
    p5: min,
    p95: max,
    n: 0,
    source: 'spec',
  };
};
