import { CircleCheck, OctagonAlert, TriangleAlert } from 'lucide-react';
import { formatDateTime, formatNumber, getFormatPrefs } from '../lib/format.js';

/** Human name of each viz type (aria summaries, the KPI definition summary). */
export const VIZ_LABEL = {
  number: 'Number',
  gauge: 'Gauge',
  line: 'Line chart',
  area: 'Area chart',
  bar: 'Bar chart',
  stackedBar: 'Stacked bar chart',
  combo: 'Combo chart',
  pie: 'Pie chart',
  scatter: 'Scatter plot',
  radar: 'Radar chart',
  funnel: 'Funnel',
  treemap: 'Treemap',
  heatmap: 'Heatmap',
  timeline: 'Status timeline',
  table: 'Table',
};

export const SERIES_TYPES = new Set(['line', 'area', 'bar', 'stackedBar', 'combo', 'scatter', 'radar']);
export const SLICE_TYPES = new Set(['pie', 'funnel', 'treemap']);

/** Tone of a KPI value: colour + icon + label, so state never rests on colour alone. */
export const TONE_META = {
  good: { label: 'On target', color: 'var(--success)', text: 'text-success', icon: CircleCheck },
  warn: { label: 'Warning', color: 'var(--warn)', text: 'text-warn', icon: TriangleAlert },
  critical: { label: 'Critical', color: 'var(--critical)', text: 'text-critical', icon: OctagonAlert },
};
export const toneColor = (tone) => TONE_META[tone]?.color ?? 'var(--brand)';

export const toMs = (v) => (typeof v === 'number' ? v : v == null || v === '' ? null : Date.parse(v));

/** Sequential single-hue scale: opacity of the series-1 hue, 0.1 near the minimum → 1 at the maximum. */
export const heatOpacity = (value, min, max) => {
  if (value == null) return 0;
  const t = max > min ? (value - min) / (max - min) : 1;
  return Number((0.1 + 0.9 * Math.min(1, Math.max(0, t))).toFixed(3));
};

/** Time-axis tick formatter in the company zone: times within 36 h, else "12 Oct". */
export const timeTick = (spanMs) => {
  const { timeZone, timeFormat } = getFormatPrefs();
  const fmt = new Intl.DateTimeFormat(
    'en-GB',
    spanMs <= 36 * 36e5
      ? { timeZone, hour: '2-digit', minute: '2-digit', hour12: timeFormat !== '24-hours' }
      : { timeZone, day: 'numeric', month: 'short' },
  );
  return (ms) => fmt.format(ms);
};

const compactFmt = new Intl.NumberFormat('en-IN', { notation: 'compact', maximumFractionDigits: 1 });
/** Axis tick: 0 / 950 / 1.2K. */
export const compactTick = (v) => (typeof v === 'number' ? compactFmt.format(v) : String(v ?? ''));

/** Does the result have anything to draw? */
export const hasData = (r) => {
  if (r.viz === 'number' || r.viz === 'gauge') return r.value != null;
  if (SLICE_TYPES.has(r.viz)) return Boolean(r.slices?.length);
  if (r.viz === 'heatmap') return Boolean(r.cells?.length);
  if (r.viz === 'timeline') return Boolean(r.lanes?.some((l) => l.runs?.length));
  if (r.viz === 'table') return Boolean(r.rows?.length);
  return Boolean(r.data?.length && r.series?.length);
};

/** The same numbers as a table (the accessible fallback of every chart). */
export const tableOf = (r) => {
  const unit = r.unit || undefined;
  if (SLICE_TYPES.has(r.viz)) {
    return {
      columns: [
        { key: 'label', label: 'Item' },
        { key: 'value', label: 'Value', unit },
      ],
      rows: r.slices ?? [],
    };
  }
  if (r.viz === 'heatmap') {
    return {
      columns: [
        { key: 'y', label: 'Row' },
        { key: 'x', label: 'Column' },
        { key: 'value', label: 'Value', unit },
      ],
      rows: r.cells ?? [],
    };
  }
  if (r.viz === 'timeline') {
    return {
      columns: [
        { key: 'lane', label: 'Lane' },
        { key: 'status', label: 'Status' },
        { key: 'start', label: 'From' },
        { key: 'end', label: 'To' },
      ],
      rows: (r.lanes ?? []).flatMap((l) => (l.runs ?? []).map((run) => ({ lane: l.label, ...run }))),
    };
  }
  if (r.viz === 'table') return { columns: r.columns, rows: r.rows ?? [] };
  const time = r.xType === 'time';
  return {
    columns: [
      { key: 'x', label: time ? 'Time' : 'Category' },
      ...(r.series ?? []).map((s) => ({ key: s.key, label: s.label ?? s.key, unit: s.unit ?? unit })),
    ],
    rows: (r.data ?? []).map((row) =>
      time && typeof row.x === 'number' ? { ...row, x: new Date(row.x).toISOString() } : row,
    ),
  };
};

/** One-sentence summary for screen readers (the chart's aria-label). */
export const vizSummary = (r) => {
  const title = r.title || 'KPI';
  if (r.error) return `${title}: ${r.error}`;
  const fmt = (v) => formatNumber(v, { unit: r.unit || undefined });
  const range = r.timeRange?.label ? ` for ${r.timeRange.label}` : '';
  if (r.viz === 'number' || r.viz === 'gauge') {
    const parts = [`${title}${range}: ${fmt(r.value)}`];
    if (r.target != null) parts.push(`target ${fmt(r.target)}`);
    if (TONE_META[r.tone]) parts.push(TONE_META[r.tone].label.toLowerCase());
    return parts.join(', ');
  }
  if (!hasData(r)) return `${title}: no data${range}`;
  if (r.viz === 'timeline') {
    const n = r.lanes.length;
    return `${title}: status timeline of ${n} ${n === 1 ? 'lane' : 'lanes'}${range}`;
  }
  const s = r.stats ?? {};
  const parts = [`${VIZ_LABEL[r.viz] ?? 'Chart'} of ${title}${range}`];
  if (s.count != null) parts.push(`${s.count} values`);
  if (s.min != null && s.max != null) parts.push(`low ${fmt(s.min)}, high ${fmt(s.max)}`);
  if (s.top?.[0]) parts.push(`largest ${s.top[0].label} at ${fmt(s.top[0].value)}`);
  else if (s.last != null) parts.push(`latest ${fmt(s.last)}`);
  return parts.join(', ');
};

/** Tooltip heading for an x value. */
export const xText = (x, xType) => (xType === 'time' ? formatDateTime(toMs(x)) : String(x ?? '—'));

/**
 * Y axis of a series chart on round 1/2/2.5/5 ticks from 0 (Recharts alone splits [0, max] into 9.5K, 19K…):
 * stacked bars by their stack height, `marks` (target, thresholds) kept inside. Null when flat.
 */
export const valueAxis = (rows, series, { stacked = false, marks = [] } = {}) => {
  const num = (v) => (Number.isFinite(v) ? v : 0);
  const values = rows.flatMap((d) =>
    stacked
      ? [
          series.reduce((sum, s) => sum + Math.max(0, num(d[s.key])), 0),
          series.reduce((sum, s) => sum + Math.min(0, num(d[s.key])), 0),
        ]
      : series.map((s) => d[s.key]).filter(Number.isFinite),
  );
  values.push(...marks.filter(Number.isFinite));
  const lo = Math.min(0, ...values);
  const hi = Math.max(0, ...values);
  if (!(hi > lo)) return null;
  const raw = (hi - lo) / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].find((n) => raw / mag <= n) * mag;
  const ticks = [];
  for (let v = Math.floor(lo / step) * step; v < hi + step; v += step) ticks.push(Number(v.toPrecision(12)));
  return { domain: [ticks[0], ticks.at(-1)], ticks };
};
