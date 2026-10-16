import { humanize } from '../lib/format.js';
import { evaluate } from './expr.js';

/**
 * Source values → the KpiResult the client `Viz` renders (docs/phase5-contracts.md §3.7). Pure: the runner
 * fetches, this maps. `values` = { key: number | rows[] | null }, `columns` = { key: [{ key, label }] }.
 */

const MAX_POINTS = 2000;
const MAX_CELLS = 400;
const MAX_TABLE_ROWS = 1000;
const SERIES_VIZ = new Set(['line', 'area', 'bar', 'stackedBar', 'combo', 'scatter', 'radar']);
const SLICE_VIZ = new Set(['pie', 'funnel', 'treemap']);
const HOUR_BUCKET = /^(\d{4}-\d{2}-\d{2}) (\d{2}:00)$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T/;

const getPath = (obj, path) =>
  String(path)
    .split('.')
    .reduce((v, k) => (v == null || !Object.hasOwn(Object(v), k) ? undefined : v[k]), obj);
const numOf = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
};
/** A display value: populated refs `{ id, label }` show their label, dates stay ISO. */
const labelOf = (v) => {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') return v.label ?? v.name ?? JSON.stringify(v);
  return v;
};
const cell = (row, path) => labelOf(getPath(row, path));
const round = (n, dp = 3) => (n == null ? null : Math.round(n * 10 ** dp) / 10 ** dp);

/** The first numeric (or first non-numeric) column of the rows: the default value (or x / label). */
const firstKey = (rows, numeric) => {
  const sample = rows[0] ?? {};
  return Object.keys(sample).find((k) => (numOf(sample[k]) != null) === numeric);
};

/** Summary numbers of the primary numeric series (the insight call reads them). */
export const statsOf = (points) => {
  const values = points.filter((p) => p.value != null);
  if (!values.length)
    return {
      count: 0,
      sum: 0,
      min: null,
      max: null,
      mean: null,
      first: null,
      last: null,
      changePct: null,
      top: [],
    };
  const nums = values.map((p) => p.value);
  const sum = nums.reduce((s, v) => s + v, 0);
  const [first, last] = [nums[0], nums.at(-1)];
  return {
    count: nums.length,
    sum: round(sum),
    min: round(nums.reduce((m, v) => (v < m ? v : m))),
    max: round(nums.reduce((m, v) => (v > m ? v : m))),
    mean: round(sum / nums.length),
    first: round(first),
    last: round(last),
    changePct: nums.length > 1 && first !== 0 ? round(((last - first) / Math.abs(first)) * 100, 1) : null,
    top: values
      .filter((p) => p.label != null)
      .sort((a, b) => b.value - a.value)
      .slice(0, 3)
      .map((p) => ({ label: String(p.label), value: round(p.value) })),
  };
};

/** good | warn | critical | neutral from thresholds (direction aware), else target (≥ target is good). */
export const toneOf = (value, { thresholds, target } = {}) => {
  if (value == null) return 'neutral';
  const lower = thresholds?.direction === 'lower_is_better';
  const worse = (limit) => limit != null && (lower ? value > limit : value < limit);
  if (thresholds && (thresholds.warn != null || thresholds.critical != null)) {
    if (worse(thresholds.critical)) return 'critical';
    return worse(thresholds.warn) ? 'warn' : 'good';
  }
  if (target == null) return 'neutral';
  return (lower ? value <= target : value >= target) ? 'good' : 'warn';
};

const sortRows = (rows, encoding, valueKey) => {
  const dir = encoding?.sort;
  const sorted =
    dir === 'asc' || dir === 'desc'
      ? [...rows].sort((a, b) => {
          const [x, y] = [numOf(getPath(a, valueKey)) ?? -Infinity, numOf(getPath(b, valueKey)) ?? -Infinity];
          return dir === 'asc' ? x - y : y - x;
        })
      : rows;
  return encoding?.limit ? sorted.slice(0, encoding.limit) : sorted;
};

const xTypeOf = (xs) => {
  const present = xs.filter((x) => x != null);
  if (present.length && present.every((x) => typeof x === 'number')) return 'number';
  if (present.length && present.every((x) => typeof x === 'string' && ISO_TIME.test(x))) return 'time';
  return 'category';
};

const capped = (list, max, what, warnings) => {
  if (list.length <= max) return list;
  warnings.push(`Showing the first ${max} ${what} of ${list.length}`);
  return list.slice(0, max);
};

/**
 * @param def KPI definition (title, viz, unit, target, thresholds, sources, formula, encoding)
 * @param values { [sourceKey]: number | rows[] | null }
 * @param range { start, stop, label, timeZone } from resolveTimeRange
 * @param columns { [sourceKey]: [{ key, label }] } columns the source tool reported
 */
export const normalize = (def, values, range, columns = {}) => {
  const enc = def.encoding ?? {};
  const key = enc.source ?? def.sources?.[0]?.key;
  const raw = values?.[key];
  const warnings = [];
  const result = {
    viz: def.viz,
    title: def.title,
    unit: def.unit ?? null,
    ...(def.target != null ? { target: def.target } : {}),
    ...(def.thresholds ? { thresholds: def.thresholds } : {}),
    timeRange: range,
    ranAt: new Date().toISOString(),
    warnings,
  };
  const rows = Array.isArray(raw) ? raw.filter((r) => r && typeof r === 'object') : null;
  const scalar = rows ? null : numOf(raw);
  const valueKey = enc.value ?? enc.series?.[0]?.key ?? (rows ? firstKey(rows, true) : undefined);
  const list = rows ? sortRows(rows, enc, valueKey) : [];
  let formulaValue;
  if (def.formula) formulaValue = evaluate(def.formula, values);
  let points = [];

  if (def.viz === 'number' || def.viz === 'gauge') {
    let value = formulaValue;
    if (value === undefined) value = scalar;
    if (value == null && rows && enc.value)
      value = list.reduce((s, r) => s + (numOf(getPath(r, enc.value)) ?? 0), 0);
    if (value == null && rows && !def.formula) value = list.length;
    result.value = value == null ? null : round(value, 4);
    result.tone = toneOf(result.value, def);
    const limits = [def.thresholds?.warn, def.thresholds?.critical, def.target].filter((v) => v != null);
    result.min = 0;
    result.max =
      def.unit === '%'
        ? 100
        : limits.length
          ? Math.max(...limits) * 1.25
          : Math.max(1, (result.value ?? 0) * 1.25);
    points =
      rows && enc.value
        ? list.map((r) => ({ label: cell(r, enc.label ?? enc.x), value: numOf(getPath(r, enc.value)) }))
        : [{ value: result.value }];
  } else if (SERIES_VIZ.has(def.viz)) {
    const x = enc.x ?? firstKey(list, false);
    const series = (enc.series?.length ? enc.series : [{ key: valueKey }]).filter((s) => s.key);
    result.xKey = 'x';
    result.series = series.map((s) => ({
      key: s.key,
      label: s.label ?? humanize(s.key.split('.').at(-1)),
      ...((s.unit ?? def.unit) ? { unit: s.unit ?? def.unit } : {}),
      axis: s.axis ?? 'left',
      ...(s.type ? { type: s.type } : {}),
    }));
    result.data = capped(list, MAX_POINTS, 'points', warnings).map((r) => ({
      x: x ? cell(r, x) : null,
      ...Object.fromEntries(series.map((s) => [s.key, numOf(getPath(r, s.key))])),
    }));
    result.xType = xTypeOf(result.data.map((d) => d.x));
    // A stacked bar is read by its stack height, so rank and summarise the per-row total.
    const pointValue =
      def.viz === 'stackedBar'
        ? (d) =>
            series.some((s) => d[s.key] != null) ? series.reduce((sum, s) => sum + (d[s.key] ?? 0), 0) : null
        : (d) => d[series[0].key];
    if (series[0]) points = result.data.map((d) => ({ label: d.x, value: pointValue(d) }));
  } else if (SLICE_VIZ.has(def.viz)) {
    const label = enc.label ?? enc.x ?? firstKey(list, false);
    result.slices = capped(list, MAX_POINTS, 'slices', warnings).map((r) => ({
      label: String(label ? (cell(r, label) ?? '—') : '—'),
      value: numOf(getPath(r, valueKey)),
    }));
    points = result.slices;
  } else if (def.viz === 'heatmap') {
    const sums = new Map();
    for (const r of list) {
      let [x, y] = [cell(r, enc.x ?? firstKey(list, false)), enc.y ? cell(r, enc.y) : null];
      const hour = !enc.y && typeof x === 'string' ? HOUR_BUCKET.exec(x) : null;
      if (hour) [y, x] = [hour[1], hour[2]];
      const id = JSON.stringify([String(x), String(y ?? '')]);
      const prev = sums.get(id);
      const v = numOf(getPath(r, valueKey));
      sums.set(id, {
        x: String(x),
        y: String(y ?? ''),
        value: v == null ? (prev?.value ?? null) : (prev?.value ?? 0) + v,
      });
    }
    result.cells = capped([...sums.values()], MAX_CELLS, 'cells', warnings);
    result.xLabels = [...new Set(result.cells.map((c) => c.x))].sort();
    result.yLabels = [...new Set(result.cells.map((c) => c.y))].sort();
    const nums = result.cells.map((c) => c.value).filter((v) => v != null);
    result.cellMin = nums.length ? round(nums.reduce((m, v) => (v < m ? v : m))) : null;
    result.cellMax = nums.length ? round(nums.reduce((m, v) => (v > m ? v : m))) : null;
    points = result.cells.map((c) => ({ label: c.y ? `${c.y} ${c.x}` : c.x, value: c.value }));
  } else if (def.viz === 'timeline') {
    const lanes = new Map();
    for (const r of capped(list, MAX_POINTS, 'runs', warnings)) {
      const lane = String(cell(r, enc.label ?? 'asset') ?? def.title);
      if (!lanes.has(lane)) lanes.set(lane, []);
      lanes.get(lane).push({
        start: cell(r, enc.start ?? 'start'),
        end: cell(r, enc.end ?? 'end'),
        status: String(cell(r, enc.value ?? 'status') ?? 'unknown'),
      });
    }
    result.lanes = [...lanes].map(([label, runs]) => ({ label, runs }));
    points = list.map((r) => ({ label: cell(r, enc.value ?? 'status'), value: numOf(r.minutes) }));
  } else if (def.viz === 'table') {
    const cols = columns[key]?.length
      ? columns[key]
      : Object.keys(list[0] ?? {}).map((k) => ({ key: k, label: humanize(k) }));
    result.columns = cols.map((c) => ({
      key: c.key,
      label: c.label ?? humanize(c.key),
      ...(c.unit ? { unit: c.unit } : {}),
    }));
    result.rows = capped(list, MAX_TABLE_ROWS, 'rows', warnings).map((r) =>
      Object.fromEntries(result.columns.map((c) => [c.key, cell(r, c.key)])),
    );
    if (valueKey)
      points = list.map((r) => ({ label: cell(r, enc.label ?? enc.x), value: numOf(getPath(r, valueKey)) }));
  }

  if (formulaValue !== undefined && result.value === undefined) result.value = formulaValue;
  if (raw == null && !def.formula) warnings.push(`No data in ${range?.label ?? 'this range'}`);
  result.stats = statsOf(points.map((p) => ({ label: p.label ?? null, value: numOf(p.value) })));
  return result;
};
