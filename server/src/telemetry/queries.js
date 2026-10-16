import { flux, fluxDuration, fluxExpression } from '@influxdata/influxdb-client';
import { bucketFor, influxEnabled, queryRows } from '../config/influx.js';
import { badRequest } from '../lib/errors.js';
import { ASSET_ID, FIELD_NAME, MEASUREMENTS, RUNNING_STATES } from './catalog.js';

/**
 * Read side of machine telemetry. Every query is built with the client's `flux` template, so each
 * interpolated value is escaped; `fluxExpression` only wraps code written here (aggregate names).
 * The `status` tag splits a field into one series per status, so queries regroup by
 * asset/measurement/field before aggregating, sorting or picking a last value.
 */

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const RANGES = { '15m': 15 * MIN, '1h': HOUR, '6h': 6 * HOUR, '24h': DAY, '7d': 7 * DAY, '30d': 30 * DAY };
const MAX_SPAN = 92 * DAY;
const WINDOWS = {
  '10s': 10 * SEC,
  '30s': 30 * SEC,
  '1m': MIN,
  '5m': 5 * MIN,
  '15m': 15 * MIN,
  '30m': 30 * MIN,
  '1h': HOUR,
  '3h': 3 * HOUR,
  '6h': 6 * HOUR,
  '12h': 12 * HOUR,
  '1d': DAY,
};
const AGGREGATES = new Set(['mean', 'median', 'sum', 'min', 'max', 'count', 'first', 'last']);
const MAX_ASSETS = 100;
const MAX_FIELDS = 20;
/** How far back statusTimeline looks for the state the asset was already in at `start`. */
const PRIOR_LOOKBACK = 7 * DAY;

/** The finest window that keeps a chart at or under `maxPoints` points (+1 for a partial window). */
export const pickWindow = (startMs, stopMs, maxPoints = 300) => {
  const span = Math.max(0, stopMs - startMs);
  const fit = Object.entries(WINDOWS).find(([, ms]) => Math.ceil(span / ms) + 1 <= maxPoints);
  return fit ? fit[0] : '1d';
};

const toDate = (value, name) => {
  const date = value instanceof Date ? value : new Date(/^\d+$/.test(value) ? Number(value) : String(value));
  if (Number.isNaN(date.getTime())) throw badRequest(`"${name}" is not a valid date`);
  return date;
};

/** Query params → { start, stop }: a quick range ending now (or at `stop`), or an explicit start/stop. */
export const parseRange = ({ range, start, stop } = {}) => {
  const stopDate = stop ? toDate(stop, 'stop') : new Date();
  let startDate;
  if (start) startDate = toDate(start, 'start');
  else {
    const key = range ?? '24h';
    if (!Object.hasOwn(RANGES, key))
      throw badRequest(`Range must be one of ${Object.keys(RANGES).join(', ')}`);
    startDate = new Date(stopDate.getTime() - RANGES[key]);
  }
  if (startDate >= stopDate) throw badRequest('The start must be before the stop');
  if (stopDate - startDate > MAX_SPAN) throw badRequest('Pick a range of 92 days or less');
  return { start: startDate, stop: stopDate };
};

const assetIdList = (assetIds) => {
  const ids = [...new Set([assetIds].flat().map(String))];
  if (ids.length > MAX_ASSETS) throw badRequest(`Ask for ${MAX_ASSETS} assets or fewer`);
  for (const id of ids) if (!ASSET_ID.test(id)) throw badRequest('That asset id is not valid');
  return ids;
};

const fieldList = (fields) => {
  const names = [...new Set([fields].flat().filter(Boolean).map(String))];
  if (!names.length) throw badRequest('Pick at least one field');
  if (names.length > MAX_FIELDS) throw badRequest(`Ask for ${MAX_FIELDS} fields or fewer`);
  for (const name of names) {
    if (!FIELD_NAME.test(name)) throw badRequest(`"${name.slice(0, 64)}" is not a valid field name`);
  }
  return names;
};

/**
 * `r["col"] == "a" or r["col"] == "b"`, every value escaped by `flux`. Used instead of contains():
 * InfluxDB pushes equality chains down to storage, while contains() makes it read every series of
 * the company and filter in Flux (checked with the profiler on 2.7).
 */
const anyOf = (column, values) =>
  values.map((value) => flux`r[${column}] == ${value}`).reduce((a, b) => flux`${a} or ${b}`);

const source = (companyId, ids, start, stop) => flux`from(bucket: ${bucketFor(companyId)})
  |> range(start: ${start}, stop: ${stop})
  |> filter(fn: (r) => r.companyId == ${String(companyId)} and (${anyOf('assetId', ids)}))`;

/** Runs a query. A company's bucket only exists once data arrives, so a missing bucket reads as no rows. */
const rows = async (query) => {
  if (!influxEnabled) return [];
  try {
    return await queryRows(query);
  } catch (err) {
    if (err?.statusCode === 404) return [];
    throw err;
  }
};

/** Latest reading of every field per asset (all measurements except timelineData). */
export const latestValues = async (companyId, assetIds, { lookback = '-7d' } = {}) => {
  const ids = assetIdList(assetIds);
  const latest = new Map(ids.map((id) => [id, {}]));
  if (!ids.length) return latest;
  // last() per series pushes down (one block per series); then the newest across status series.
  // Stop a minute ahead: the simulator stamps points with MongoDB's clock, which may run a little ahead.
  const query = flux`${source(companyId, ids, fluxDuration(lookback), new Date(Date.now() + MIN))}
  |> filter(fn: (r) => r._measurement != "timelineData")
  |> last()
  |> group(columns: ["assetId", "_measurement", "_field"])
  |> sort(columns: ["_time"])
  |> last()
  |> keep(columns: ["assetId", "_measurement", "_field", "_time", "_value"])`;
  for (const row of await rows(query)) {
    const values = latest.get(row.assetId);
    const time = new Date(row._time).toISOString();
    const known = values[row._field];
    // A field name can exist in two measurements (cycleTime); the newer reading wins.
    if (!known || known.time < time)
      values[row._field] = { value: row._value, time, measurement: row._measurement };
  }
  return latest;
};

/** Windowed numeric series, one per asset/measurement/field (string fields are skipped). */
export const seriesFor = async (companyId, assetIds, fields, { start, stop, every, fn = 'mean' } = {}) => {
  const ids = assetIdList(assetIds);
  const names = fieldList(fields);
  const range = parseRange({ start, stop });
  const window = every ?? pickWindow(range.start, range.stop);
  if (!Object.hasOwn(WINDOWS, window))
    throw badRequest(`Window must be one of ${Object.keys(WINDOWS).join(', ')}`);
  if (!AGGREGATES.has(fn)) throw badRequest(`Aggregate must be one of ${[...AGGREGATES].join(', ')}`);
  if (!ids.length) return { ...range, every: window, series: [] };
  // first/last pick by position, and merged status tables are not in time order.
  const sortStep = fn === 'first' || fn === 'last' ? flux`|> sort(columns: ["_time"])` : flux``;
  const query = flux`import "types"
${source(companyId, ids, range.start, range.stop)}
  |> filter(fn: (r) => ${anyOf('_field', names)})
  |> filter(fn: (r) => types.isType(v: r._value, type: "float") or types.isType(v: r._value, type: "int"))
  |> group(columns: ["assetId", "_measurement", "_field"])
  ${sortStep}
  |> aggregateWindow(every: ${fluxDuration(window)}, fn: ${fluxExpression(fn)}, createEmpty: false)
  |> keep(columns: ["assetId", "_measurement", "_field", "_time", "_value"])`;
  const byKey = new Map();
  for (const row of await rows(query)) {
    const key = `${row.assetId}\u0000${row._measurement}\u0000${row._field}`;
    if (!byKey.has(key)) {
      byKey.set(key, { assetId: row.assetId, field: row._field, measurement: row._measurement, points: [] });
    }
    byKey.get(key).points.push([Date.parse(row._time), row._value]);
  }
  const series = [...byKey.values()];
  for (const s of series) s.points.sort((a, b) => a[0] - b[0]);
  return { ...range, every: window, series };
};

/** Status runs from timelineData events, clipped to [start, min(stop, now)], with totals and availability. */
export const statusTimeline = async (companyId, assetId, { start, stop } = {}) => {
  const ids = assetIdList(String(assetId));
  const range = parseRange({ start, stop });
  const query = flux`${source(companyId, ids, new Date(range.start.getTime() - PRIOR_LOOKBACK), range.stop)}
  |> filter(fn: (r) => r._measurement == "timelineData" and r._field == "assetStatus")
  |> group(columns: ["assetId"])
  |> sort(columns: ["_time"])
  |> keep(columns: ["_time", "_value"])`;
  const events = (await rows(query)).map((row) => ({ t: Date.parse(row._time), status: String(row._value) }));

  const from = range.start.getTime();
  const to = Math.min(range.stop.getTime(), Date.now());
  const runs = [];
  const totals = { Running: 0, Idle: 0, Stopped: 0, OFF: 0 };
  let current = null; // { status, since }; events before `start` leave the prior state here
  const close = (end) => {
    const seconds = Math.round((end - current.since) / SEC);
    if (seconds <= 0) return;
    const { status, since } = current;
    runs.push({ status, start: new Date(since).toISOString(), end: new Date(end).toISOString(), seconds });
    totals[status] = (totals[status] ?? 0) + seconds;
  };
  for (const { t, status } of events) {
    if (t >= to) break;
    if (current?.status === status) continue;
    if (current) close(t);
    current = { status, since: Math.max(t, from) };
  }
  if (current) close(to);

  const coverageSec = runs.reduce((sum, run) => sum + run.seconds, 0);
  const runningSec = [...RUNNING_STATES].reduce((sum, status) => sum + (totals[status] ?? 0), 0);
  const scheduledSec = coverageSec - totals.OFF; // OFF = not scheduled
  const availability = scheduledSec > 0 ? Math.round((runningSec / scheduledSec) * 1000) / 1000 : 0;
  return { ...range, runs, totals, availability, coverageSec };
};

/**
 * Measurement/field pairs an asset reported within the lookback. Uses schema.fieldKeys per
 * measurement (storage metadata, no data scan) rather than distinct() over the raw points.
 */
export const discoverFields = async (companyId, assetId, { lookback = '-2d' } = {}) => {
  const [id] = assetIdList(String(assetId));
  const query = flux`import "influxdata/influxdb/schema"
keys = (m) => schema.fieldKeys(
    bucket: ${bucketFor(companyId)},
    predicate: (r) => r._measurement == m and r.companyId == ${String(companyId)} and r.assetId == ${id},
    start: ${fluxDuration(lookback)},
  )
  |> map(fn: (r) => ({ measurement: m, field: r._value }))
union(tables: ${MEASUREMENTS.map((m) => flux`keys(m: ${m})`)})`;
  return (await rows(query))
    .map(({ measurement, field }) => ({ measurement, field }))
    .sort((a, b) => a.measurement.localeCompare(b.measurement) || a.field.localeCompare(b.field));
};
