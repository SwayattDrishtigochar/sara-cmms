import { flux } from '@influxdata/influxdb-client';
import { bucketFor, influxEnabled, queryRows } from '../../config/influx.js';
import { systemContext } from '../../context/buildUserContext.js';
import { isWorkingTime } from '../../lib/shifts.js';
import { getModule } from '../../modules/registry.js';
import { RUNNING_STATES } from '../../telemetry/catalog.js';
import {
  baselineFor,
  EXCLUDED_FIELDS,
  loadSpecs,
  MEASUREMENTS,
  resolveBaseline,
  unitOf,
} from './baselines.js';

/**
 * Deterministic screens over the last few minutes of telemetry, one Flux query per company per tick.
 * They never decide anything: they produce the table Gemini judges and the flags that make an asset
 * due for review sooner.
 */

const MIN = 60_000;
/** A status younger than this makes z unreliable (warm-up, spin-down). */
const TRANSITION_MS = 3 * MIN;
export const Z_FLAG = 3;
export const SPIKE_SIGMA = 4;
export const IDLE_POWER_FLAG = 1.5;
/** Parts a window needs before its rejection rate means anything. */
export const MIN_PARTS = 200;
/** Rejection windows tried in turn (hours back from now) until one holds MIN_PARTS parts. */
const REJECT_WINDOWS_H = [1, 2, 3, 4];
/** A reference rate of zero (a clean week) is read as this, so one reject is not infinitely unlikely. */
const REJECT_RATE_FLOOR = 0.005;
const POWER = 'POWER TOTAL';
const Model = (name) => getModule(name).Model;

const anyOf = (column, values) =>
  values.map((value) => flux`r[${column}] == ${value}`).reduce((a, b) => flux`${a} or ${b}`);

/** 1-minute means of every numeric field, per asset, measurement, field and status tag. */
const windowRows = async (companyId, start, stop) => {
  if (!influxEnabled) return [];
  const query = flux`import "types"
from(bucket: ${bucketFor(companyId)})
  |> range(start: ${start}, stop: ${stop})
  |> filter(fn: (r) => r.companyId == ${String(companyId)})
  |> filter(fn: (r) => ${anyOf('_measurement', MEASUREMENTS)})
  |> filter(fn: (r) => types.isType(v: r._value, type: "float") or types.isType(v: r._value, type: "int"))
  |> group(columns: ["assetId", "_measurement", "_field", "status"])
  |> aggregateWindow(every: 1m, fn: mean, createEmpty: false)
  |> keep(columns: ["assetId", "_measurement", "_field", "status", "_time", "_value"])`;
  try {
    return await queryRows(query);
  } catch (err) {
    if (err?.statusCode === 404) return [];
    throw err;
  }
};

const round = (v, places = 3) => (v == null || !Number.isFinite(v) ? null : Number(v.toFixed(places)));

// ponytail: copy of client/src/machines/telemetry.js fieldLabel; move both to telemetry/catalog.js.
const LABELS = {
  oilTempPv: 'Oil temperature',
  load_monitor: 'Press load',
  'POWER TOTAL': 'Power',
  'POWER FACTOR TOTAL': 'Power factor',
  'VOLTAGE AVERAGE': 'Voltage',
  'CURRENT AVERAGE': 'Current',
  'ENERGY CONSUMPTION': 'Energy used',
  'ENERGY READING': 'Energy meter',
  rejectionRate: 'Rejection rate',
};
const KEEP_UPPER = new Set(['PV', 'SV', 'PH', 'RPM', 'CO2', 'PF']);

/** Plain name of a field for people: "oilTempPv" → "Oil temperature", "POWER PH-1" → "Power PH-1". */
export const fieldLabel = (field) => {
  if (LABELS[field]) return LABELS[field];
  return String(field)
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([a-zA-Z])(\d)/g, '$1 $2')
    .split(/\s+/)
    .filter(Boolean)
    .map((w, i) => {
      if (/\d/.test(w) || KEEP_UPPER.has(w.toUpperCase())) return w.toUpperCase();
      const lower = w.toLowerCase();
      return i === 0 ? lower[0].toUpperCase() + lower.slice(1) : lower;
    })
    .join(' ');
};

/** Least-squares slope of [t (ms), value] points, per hour. */
export const slopePerHour = (points) => {
  const n = points.length;
  if (n < 2) return 0;
  const t0 = points[0][0];
  const xs = points.map(([t]) => (t - t0) / 3_600_000);
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = points.reduce((a, [, v]) => a + v, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i += 1) {
    num += (xs[i] - mx) * (points[i][1] - my);
    den += (xs[i] - mx) ** 2;
  }
  return den ? num / den : 0;
};

/**
 * Statistics and screens of one field's 1-minute means against its baseline, whose std resolveBaseline
 * has already floored at the field's real noise (z, spikes and the band pad all use it).
 */
export const fieldFeatures = ({ measurement, field, points, baseline, status, transition, unit }) => {
  const values = points.map(([, v]) => v);
  const n = values.length;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const std = Math.sqrt(values.reduce((a, v) => a + (v - mean) ** 2, 0) / n);
  const last = values[n - 1];
  const b = baseline;
  const sd = b?.std ?? 0;
  const z = b ? (sd > 0 ? (mean - b.mean) / sd : mean === b.mean ? 0 : 99) : null;
  // The band is judged on the window mean (one partial minute is noise), no tighter than the floored
  // sigma's 5–95 % (±1.645σ, a flat history has a hairline band) and widened by 10 % or 1σ.
  const pad = b ? Math.max(0.1 * (b.p95 - b.p5), sd) : 0;
  const hi = b ? Math.max(b.p95, b.mean + 1.645 * sd) + pad : 0;
  const lo = b ? Math.min(b.p5, b.mean - 1.645 * sd) - pad : 0;
  const band = !b ? null : mean > hi ? 'above' : mean < lo ? 'below' : null;
  const spikes = sd > 0 ? values.filter((v) => Math.abs(v - b.mean) > SPIKE_SIGMA * sd).length : 0;
  const spread = b?.spread ?? b?.std ?? 0; // the measured spread: flatline asks whether the noise vanished
  const flatline = Boolean(spread > 0 && RUNNING_STATES.has(status) && n >= 5 && std <= spread * 0.01);
  const flags = [];
  if (!transition) {
    if (z != null && Math.abs(z) >= Z_FLAG) flags.push('z');
    if (band) flags.push('band');
    if (flatline) flags.push('flatline');
    if (spikes >= 2) flags.push('spikes'); // one odd minute is a blip, not a pattern
  }
  return {
    measurement,
    field,
    label: fieldLabel(field),
    unit: unit ?? null,
    last: round(last),
    mean: round(mean),
    min: round(Math.min(...values)),
    max: round(Math.max(...values)),
    std: round(std, 4),
    slopePerHour: round(slopePerHour(points)),
    n,
    baseline: b
      ? { mean: round(b.mean), std: round(sd, 4), p5: round(b.p5), p95: round(b.p95), source: b.source }
      : null,
    z: z == null ? null : round(Math.max(-99, Math.min(99, z)), 2),
    band,
    spikes,
    flatline,
    flags,
  };
};

const DAY_MS = 24 * 60 * MIN;
const sum = (docs, pick) => docs.reduce((a, d) => a + (pick(d) ?? 0), 0);

/**
 * Parts and rejects of one asset from its shift rows (partcounts: `date` = shift start) and rejections:
 * the window is the last hour, or the last 2, 3 or 4 h when a shorter one holds fewer than MIN_PARTS
 * parts, and the reference is everything before it. Rejects are counted exactly; a shift row's parts
 * are spread evenly from its start to the next row (or now).
 * ponytail: even spread over a row also spans breaks and off hours; fine for a rate over 1-4 h.
 */
export const rejectionCounts = (rows, rejections, now) => {
  const byStart = new Map();
  for (const r of rows) {
    const t = new Date(r.date).getTime();
    if (t <= now.getTime()) byStart.set(t, (byStart.get(t) ?? 0) + (r.produced ?? 0));
  }
  const shifts = [...byStart].sort((a, b) => a[0] - b[0]);
  if (!shifts.length || now - shifts.at(-1)[0] > DAY_MS) return null;
  const partsSince = (from) =>
    shifts.reduce((total, [t, produced], i) => {
      const end = shifts[i + 1]?.[0] ?? now.getTime();
      return end > t ? total + (produced * Math.max(0, end - Math.max(t, from))) / (end - t) : total;
    }, 0);
  const hours =
    REJECT_WINDOWS_H.find((h) => partsSince(now - h * 60 * MIN) >= MIN_PARTS) ?? REJECT_WINDOWS_H.at(-1);
  const start = now.getTime() - hours * 60 * MIN;
  const parts = Math.round(partsSince(start));
  const inWindow = (r) => new Date(r.createdAt).getTime() >= start;
  return {
    windowStart: new Date(start).toISOString(),
    windowHours: hours,
    parts,
    rejected: sum(rejections.filter(inWindow), (r) => r.rejectedCount),
    refParts: sum(shifts, ([, produced]) => produced) - parts,
    refRejected: sum(
      rejections.filter((r) => !inWindow(r)),
      (r) => r.rejectedCount,
    ),
  };
};

/**
 * The rejection rate the model sees: counts, percentages and a binomial z of the window against the
 * asset's own 7 days (or, with too little of it, the same machine type's), null z when the window holds
 * fewer than MIN_PARTS parts. `fleet` = { parts, rejected } of that type.
 */
export const rejectionRate = (counts, fleet) => {
  if (!counts) return null;
  const pct = (rej, parts) => (parts > 0 ? round((100 * rej) / parts, 2) : null);
  const own = counts.refParts >= 5 * MIN_PARTS;
  const ref = own
    ? { parts: counts.refParts, rejected: counts.refRejected, source: 'history' }
    : fleet?.parts >= 5 * MIN_PARTS
      ? { ...fleet, source: 'fleet' }
      : null;
  const enoughParts = counts.parts >= MIN_PARTS;
  const p0 = ref ? Math.max(ref.rejected / ref.parts, REJECT_RATE_FLOOR) : null;
  const z =
    enoughParts && p0 != null
      ? round((counts.rejected - counts.parts * p0) / Math.sqrt(counts.parts * p0 * (1 - p0)), 1)
      : null;
  return {
    windowStart: counts.windowStart,
    windowHours: counts.windowHours,
    parts: counts.parts,
    rejected: counts.rejected,
    recentPct: pct(counts.rejected, counts.parts),
    baselinePct: ref ? pct(ref.rejected, ref.parts) : null,
    baselineSource: ref?.source ?? null,
    z,
    enoughParts,
  };
};

/** Rejection rates of the company's production assets (see rejectionCounts / rejectionRate). */
const rejectionRates = async (companyId, now, assets) => {
  const weekAgo = new Date(now.getTime() - 7 * DAY_MS);
  const [rejections, rows] = await Promise.all([
    Model('rejections')
      .find({ companyId, createdAt: { $gte: weekAgo, $lte: now }, deleted: { $ne: true } })
      .select('assetId rejectedCount createdAt')
      .lean(),
    Model('partcounts')
      .find({ companyId, date: { $gte: weekAgo, $lte: now } })
      .select('assetId date produced')
      .lean(),
  ]);
  const of = (docs, assetId) => docs.filter((d) => String(d.assetId) === assetId);
  const counts = new Map(
    assets
      .filter((a) => a.isProductionAsset)
      .map((a) => [
        String(a._id),
        rejectionCounts(of(rows, String(a._id)), of(rejections, String(a._id)), now),
      ]),
  );
  const fleets = new Map();
  for (const a of assets) {
    const c = counts.get(String(a._id));
    if (!c) continue;
    const f = fleets.get(a.typeOfAsset) ?? { parts: 0, rejected: 0 };
    fleets.set(a.typeOfAsset, { parts: f.parts + c.refParts, rejected: f.rejected + c.refRejected });
  }
  return (assetId, type) => rejectionRate(counts.get(assetId), fleets.get(type));
};

const currentJobs = async (ctx) => {
  if (!ctx.modules.includes('jobcards')) return new Map();
  const cards = await Model('jobcards')
    .find({ companyId: ctx.companyId, jobStatus: 'In Progress', deleted: { $ne: true } })
    .select('asset jobCardId tool')
    .populate('tool', 'name')
    .lean();
  return new Map(
    cards.map((jc) => [String(jc.asset), { jobCardId: jc.jobCardId, toolName: jc.tool?.name ?? null }]),
  );
};

/** Screens of every telemetry asset of the company for the last `windowMin` minutes. */
export const computeFeatures = async (companyId, { now = new Date(), windowMin = 10 } = {}) => {
  const ctx = await systemContext(companyId);
  const assets = await Model('assets')
    .find({
      companyId,
      deleted: { $ne: true },
      $or: [{ isProductionAsset: true }, { isEnergyAsset: true }, { isSensorIntegration: true }],
    })
    .select(
      'name assetTag typeOfAsset plantId assetStatus assetStatusSince isProductionAsset isEnergyAsset healthScore healthUpdatedAt',
    )
    .sort({ name: 1 })
    .lean();
  if (!assets.length) return [];
  const [rows, baselines, specs, jobs, rejectionOf] = await Promise.all([
    windowRows(companyId, new Date(now.getTime() - windowMin * MIN), new Date(now.getTime() + MIN)),
    baselineFor(companyId),
    loadSpecs(),
    currentJobs(ctx),
    ctx.modules.includes('rejections') ? rejectionRates(companyId, now, assets) : () => null,
  ]);
  const plants = new Map(ctx.plants.map((p) => [String(p._id), p]));
  const series = new Map(); // assetId|status → Map(measurement|field → points)
  for (const r of rows) {
    if (EXCLUDED_FIELDS.has(r._field)) continue;
    const key = `${r.assetId}|${r.status}`;
    if (!series.has(key)) series.set(key, new Map());
    const byField = series.get(key);
    const fieldKey = `${r._measurement}|${r._field}`;
    if (!byField.has(fieldKey)) byField.set(fieldKey, []);
    byField.get(fieldKey).push([Date.parse(r._time), Number(r._value)]);
  }

  return assets.map((asset) => {
    const assetId = String(asset._id);
    const status = asset.assetStatus ?? 'OFF';
    const since = asset.assetStatusSince ? new Date(asset.assetStatusSince) : null;
    const transition = Boolean(since && now - since < TRANSITION_MS);
    const plant = plants.get(String(asset.plantId));
    const inShift = plant ? isWorkingTime(plant, now, ctx.company.timeZone) : true;
    const type = asset.typeOfAsset;
    // Data hygiene: a window stamped after `now` is a partial minute, and once the status has settled,
    // the minutes of its first 3 min (warm-up, spin-down) say nothing about the steady state.
    const settledFrom = !transition && since ? since.getTime() + TRANSITION_MS : Number.NEGATIVE_INFINITY;
    const fields = [];
    for (const [fieldKey, all] of series.get(`${assetId}|${status}`) ?? []) {
      const [measurement, field] = fieldKey.split('|');
      const points = all.filter(([t]) => t <= now.getTime() && t > settledFrom).sort((a, b) => a[0] - b[0]);
      if (!points.length) continue;
      const baseline = resolveBaseline(baselines, specs, { assetId, type, field, status });
      const spec = specs.get(`${type}|${field}`);
      const unit = unitOf(spec, field);
      fields.push(fieldFeatures({ measurement, field, points, baseline, status, transition, unit }));
    }
    const power = fields.find((f) => f.field === POWER);
    const idlePowerRatio =
      asset.isEnergyAsset && power?.baseline?.source === 'history' && power.baseline.mean > 0
        ? round(power.mean / power.baseline.mean, 2)
        : null;
    const rejectionRate = asset.isProductionAsset ? rejectionOf(assetId, type) : null;
    const flags = [...new Set(fields.flatMap((f) => f.flags))];
    if (rejectionRate?.z >= Z_FLAG && rejectionRate.recentPct - rejectionRate.baselinePct >= 1) {
      flags.push('rejects');
    }
    if (idlePowerRatio != null && !RUNNING_STATES.has(status) && idlePowerRatio >= IDLE_POWER_FLAG) {
      flags.push('idle_power');
    }
    return {
      assetId,
      name: asset.name,
      tag: asset.assetTag ?? null,
      type,
      plantId: asset.plantId ? String(asset.plantId) : null,
      status,
      statusSince: since ? since.toISOString() : null,
      healthScore: asset.healthScore ?? null,
      healthUpdatedAt: asset.healthUpdatedAt ? new Date(asset.healthUpdatedAt).toISOString() : null,
      inShift,
      job: jobs.get(assetId) ?? null,
      transition,
      fields,
      rejectionRate,
      idlePowerRatio,
      flags,
    };
  });
};
