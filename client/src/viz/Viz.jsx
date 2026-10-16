import { ChartColumn, CircleAlert, Table2, Target } from 'lucide-react';
import { useMemo, useState } from 'react';
import {
  Area,
  Bar,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  Pie,
  PieChart,
  PolarAngleAxis,
  PolarGrid,
  Radar,
  RadarChart,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  Tooltip,
  Treemap,
  XAxis,
  YAxis,
} from 'recharts';
import { DataTable } from '../blocks/DataTable.jsx';
import { cn, formatNumber } from '../lib/format.js';
import { SERIES_MAX, SERIES_VARS, StatusTimelineBar, seriesColor } from '../ui/charts.jsx';
import { Button } from '../ui/core.jsx';
import { Gauge } from './Gauge.jsx';
import { Heatmap } from './Heatmap.jsx';
import {
  compactTick,
  hasData,
  SERIES_TYPES,
  TONE_META,
  tableOf,
  timeTick,
  toMs,
  valueAxis,
  vizSummary,
  xText,
} from './vizData.js';

const AXIS_TICK = { fill: 'var(--subtle)', fontSize: 11 };
const PIE_MAX = 6;
const ACTIVE_DOT = { r: 4, stroke: 'var(--surface)', strokeWidth: 2 };

const TipBox = ({ active, payload, label, xType, unitOf }) => {
  const rows = (payload ?? []).filter((p) => p.value != null);
  if (!active || !rows.length) return null;
  return (
    <div className="rounded-lg border border-border bg-surface px-3 py-2 text-xs shadow-pop">
      {label != null && label !== '' && <p className="mb-1.5 text-subtle">{xText(label, xType)}</p>}
      <ul className="space-y-1">
        {rows.map((p) => (
          <li key={p.name} className="flex items-center gap-2">
            <span
              className="size-2 shrink-0 rounded-sm"
              style={{ background: p.color ?? p.payload?.fill }}
              aria-hidden
            />
            <span className="font-semibold text-fg tabular">
              {formatNumber(p.value, { unit: unitOf(p.name) })}
            </span>
            <span className="text-muted">{p.name}</span>
          </li>
        ))}
      </ul>
    </div>
  );
};

const Legend = ({ items }) => (
  <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
    {items.map((s, i) => (
      <li key={s.key} className="flex items-center gap-1.5">
        <span className="size-2.5 shrink-0 rounded-sm" style={{ background: seriesColor(i) }} aria-hidden />
        {s.label ?? s.key}
        {s.unit && <span className="text-subtle">({s.unit})</span>}
      </li>
    ))}
  </ul>
);

/** Target and threshold rules on a value axis, labelled in text ink. */
const referenceLines = (r) =>
  [
    r.target != null && { y: r.target, label: 'Target', stroke: 'var(--fg)' },
    r.thresholds?.warn != null && { y: r.thresholds.warn, label: 'Warn', stroke: 'var(--warn)' },
    r.thresholds?.critical != null && {
      y: r.thresholds.critical,
      label: 'Critical',
      stroke: 'var(--critical)',
    },
  ]
    .filter(Boolean)
    .map((l) => (
      <ReferenceLine
        key={l.label}
        y={l.y}
        stroke={l.stroke}
        strokeDasharray="4 3"
        ifOverflow="extendDomain"
        label={{ value: l.label, position: 'insideTopRight', fill: 'var(--muted)', fontSize: 10 }}
      />
    ));

const markOf = (kind, s, slot, stacked, top) => {
  const color = seriesColor(slot);
  // React wants `key` passed directly, not inside a spread object.
  const common = { dataKey: s.key, name: s.label ?? s.key, isAnimationActive: false };
  if (kind === 'scatter') return <Scatter key={s.key} {...common} fill={color} />;
  if (kind === 'line') {
    return (
      <Line
        key={s.key}
        {...common}
        stroke={color}
        strokeWidth={2}
        dot={false}
        connectNulls
        activeDot={ACTIVE_DOT}
      />
    );
  }
  if (kind === 'area') {
    return (
      <Area
        key={s.key}
        {...common}
        stroke={color}
        strokeWidth={2}
        fill={color}
        fillOpacity={0.1}
        connectNulls
        stackId={stacked ? 'stack' : undefined}
        activeDot={ACTIVE_DOT}
      />
    );
  }
  return (
    <Bar
      key={s.key}
      {...common}
      fill={color}
      stackId={stacked ? 'stack' : undefined}
      radius={top ? [4, 4, 0, 0] : 0}
      stroke={stacked ? 'var(--surface)' : undefined}
      strokeWidth={stacked ? 2 : 0}
      maxBarSize={24}
    />
  );
};

/** The mark kind of each series: combo = bars on the left, lines on the right (or `series.type`). */
const kindOf = (viz, s, i) => {
  if (viz === 'combo') return s.type ?? (s.axis === 'right' || i > 0 ? 'line' : 'bar');
  if (viz === 'stackedBar') return 'bar';
  return viz;
};

const CartesianPanel = ({ r, series, slots, height, compact, unit, refs }) => {
  const time = r.xType === 'time';
  const numeric = time || r.xType === 'number' || r.viz === 'scatter';
  const rows = useMemo(() => r.data.map((d) => ({ ...d, __x: time ? toMs(d.x) : d.x })), [r.data, time]);
  const span = time && rows.length > 1 ? rows[rows.length - 1].__x - rows[0].__x : 0;
  const bars = series.some((s, i) => kindOf(r.viz, s, i) === 'bar');
  const unitOf = (name) => series.find((s) => (s.label ?? s.key) === name)?.unit ?? r.unit;
  const barSeries = series.filter((s, i) => kindOf(r.viz, s, i) === 'bar');
  const yAxis = valueAxis(rows, series, {
    stacked: r.viz === 'stackedBar',
    marks: refs ? [r.target, r.thresholds?.warn, r.thresholds?.critical] : [],
  });
  return (
    <div className="relative" style={{ height }}>
      {unit && !compact && (
        <span className="pointer-events-none absolute left-1 top-0 text-[11px] font-medium text-subtle">
          {unit}
        </span>
      )}
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart
          data={rows}
          margin={{ top: compact ? 4 : 20, right: 12, bottom: 0, left: 0 }}
          barCategoryGap="20%"
          barGap={2}
        >
          <CartesianGrid vertical={false} stroke="var(--border)" />
          <XAxis
            dataKey="__x"
            type={numeric ? 'number' : 'category'}
            scale={time ? 'time' : 'auto'}
            domain={numeric ? ['dataMin', 'dataMax'] : undefined}
            tickFormatter={time ? timeTick(span) : numeric ? compactTick : undefined}
            tick={AXIS_TICK}
            tickLine={false}
            axisLine={{ stroke: 'var(--border-strong)' }}
            minTickGap={time ? 48 : 8}
            hide={compact && numeric}
          />
          <YAxis
            width={compact ? 32 : 44}
            domain={yAxis?.domain}
            ticks={yAxis?.ticks}
            tickFormatter={compactTick}
            tick={AXIS_TICK}
            tickLine={false}
            axisLine={false}
          />
          <Tooltip
            content={<TipBox xType={time ? 'time' : r.xType} unitOf={unitOf} />}
            cursor={bars ? { fill: 'var(--surface-2)' } : { stroke: 'var(--border-strong)' }}
            isAnimationActive={false}
          />
          {refs && referenceLines(r)}
          {series.map((s, i) => {
            const kind = kindOf(r.viz, s, i);
            const stacked = r.viz === 'stackedBar';
            return markOf(kind, s, slots[i], stacked, !stacked || s === barSeries[barSeries.length - 1]);
          })}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
};

/**
 * Series charts. A combo whose right-axis series carry another unit draws as two stacked panels on the
 * same x (never two y-scales on one plot).
 */
const SeriesView = ({ r, height, compact }) => {
  const series = r.series.slice(0, SERIES_MAX);
  const slots = series.map((_, i) => i);
  if (r.viz === 'radar') return <RadarView r={r} series={series} height={height} />;
  const unitOf = (s) => s.unit ?? r.unit;
  const right = series.filter((s) => s.axis === 'right');
  const split = r.viz === 'combo' && right.length && right.some((s) => unitOf(s) !== unitOf(series[0]));
  if (!split) {
    return (
      <CartesianPanel
        r={r}
        series={series}
        slots={slots}
        height={height}
        compact={compact}
        unit={r.unit}
        refs
      />
    );
  }
  const left = series.filter((s) => s.axis !== 'right');
  const slotOf = (s) => series.indexOf(s);
  return (
    <div className="space-y-2">
      <CartesianPanel
        r={r}
        series={left}
        slots={left.map(slotOf)}
        height={Math.round(height * 0.55)}
        compact={compact}
        unit={unitOf(left[0])}
        refs
      />
      <CartesianPanel
        r={r}
        series={right}
        slots={right.map(slotOf)}
        height={Math.round(height * 0.45)}
        compact={compact}
        unit={unitOf(right[0])}
      />
    </div>
  );
};

const RadarView = ({ r, series, height }) => (
  <div style={{ height }}>
    <ResponsiveContainer width="100%" height="100%">
      <RadarChart data={r.data} outerRadius="72%">
        <PolarGrid stroke="var(--border)" />
        <PolarAngleAxis dataKey="x" tick={AXIS_TICK} />
        <Tooltip
          content={
            <TipBox
              xType="category"
              unitOf={(name) => series.find((s) => s.label === name)?.unit ?? r.unit}
            />
          }
          isAnimationActive={false}
        />
        {series.map((s, i) => (
          <Radar
            key={s.key}
            dataKey={s.key}
            name={s.label ?? s.key}
            stroke={seriesColor(i)}
            strokeWidth={2}
            fill={seriesColor(i)}
            fillOpacity={0.1}
            isAnimationActive={false}
          />
        ))}
      </RadarChart>
    </ResponsiveContainer>
  </div>
);

/** Largest slices first; beyond six the smallest fold into "Other". */
const foldSlices = (slices) => {
  const sorted = slices.filter((s) => s.value > 0).sort((a, b) => b.value - a.value);
  if (sorted.length <= PIE_MAX) return sorted;
  const rest = sorted.slice(PIE_MAX - 1).reduce((t, s) => t + s.value, 0);
  return [...sorted.slice(0, PIE_MAX - 1), { label: 'Other', value: rest }];
};

const PieView = ({ r, height, compact }) => {
  const slices = useMemo(() => foldSlices(r.slices), [r.slices]);
  const total = slices.reduce((t, s) => t + s.value, 0) || 1;
  return (
    <div className={cn('grid items-center gap-3', !compact && 'sm:grid-cols-2')}>
      <div style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={slices}
              dataKey="value"
              nameKey="label"
              innerRadius="58%"
              outerRadius="88%"
              paddingAngle={1}
              stroke="var(--surface)"
              strokeWidth={2}
              isAnimationActive={false}
            >
              {slices.map((s, i) => (
                <Cell key={s.label} fill={seriesColor(i)} />
              ))}
            </Pie>
            <Tooltip content={<TipBox unitOf={() => r.unit} />} isAnimationActive={false} />
          </PieChart>
        </ResponsiveContainer>
      </div>
      <ul className="space-y-1.5 text-xs">
        {slices.map((s, i) => (
          <li key={s.label} className="flex items-center gap-2">
            <span
              className="size-2.5 shrink-0 rounded-sm"
              style={{ background: seriesColor(i) }}
              aria-hidden
            />
            <span className="min-w-0 flex-1 truncate text-fg">{s.label}</span>
            <span className="font-medium text-fg tabular">
              {formatNumber(s.value, { unit: r.unit || undefined })}
            </span>
            <span className="w-9 text-right text-subtle tabular">{Math.round((s.value / total) * 100)}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
};

/** Funnel: centred bars in stage order, each with its value and share of the first stage. */
const FunnelView = ({ r, compact }) => {
  const stages = r.slices.slice(0, compact ? 5 : 12);
  const first = stages[0]?.value || 1;
  const max = Math.max(...stages.map((s) => s.value ?? 0)) || 1;
  return (
    <ol className="space-y-1.5">
      {stages.map((s, i) => (
        <li
          key={`${s.label}-${i}`}
          className="grid grid-cols-[minmax(0,7rem)_minmax(0,1fr)] items-center gap-3 text-xs"
        >
          <span className="truncate text-fg" title={s.label}>
            {s.label}
          </span>
          <span className="relative flex h-6 items-center justify-center">
            <span
              className="absolute inset-y-0 rounded"
              style={{
                width: `${Math.max(2, ((s.value ?? 0) / max) * 100)}%`,
                background: seriesColor(0),
                opacity: 1 - (i / stages.length) * 0.5,
              }}
              aria-hidden
            />
            <span className="relative rounded bg-surface/85 px-1.5 font-medium text-fg tabular">
              {formatNumber(s.value, { unit: r.unit || undefined })}
              {i > 0 && (
                <span className="ml-1 text-muted">· {Math.round(((s.value ?? 0) / first) * 100)}%</span>
              )}
            </span>
          </span>
        </li>
      ))}
    </ol>
  );
};

const TreemapCell = ({ x, y, width, height, depth, name }) =>
  depth === 1 ? (
    <g>
      <rect
        x={x}
        y={y}
        width={width}
        height={height}
        rx={4}
        fill={seriesColor(0)}
        stroke="var(--surface)"
        strokeWidth={2}
      />
      {width > 56 && height > 24 && (
        <text x={x + 6} y={y + 16} fill="#fff" fontSize={11} fontWeight={500}>
          {String(name).slice(0, Math.floor(width / 7))}
        </text>
      )}
    </g>
  ) : null;

const TreemapView = ({ r, height }) => {
  const data = useMemo(
    () => r.slices.filter((s) => s.value > 0).map((s) => ({ name: s.label, size: s.value })),
    [r.slices],
  );
  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <Treemap data={data} dataKey="size" isAnimationActive={false} content={<TreemapCell />}>
          <Tooltip content={<TipBox unitOf={() => r.unit} />} isAnimationActive={false} />
        </Treemap>
      </ResponsiveContainer>
    </div>
  );
};

const TimelineView = ({ r, compact }) => (
  <div className="space-y-3">
    {r.lanes.slice(0, compact ? 4 : 20).map((lane) => (
      <div key={lane.label}>
        <p className="mb-1 truncate text-xs font-medium text-fg">{lane.label}</p>
        <StatusTimelineBar runs={lane.runs} start={r.timeRange.start} stop={r.timeRange.stop} />
      </div>
    ))}
  </div>
);

const ToneChip = ({ tone }) => {
  const meta = TONE_META[tone];
  if (!meta) return null;
  return (
    <span className={cn('inline-flex items-center gap-1 text-xs font-medium', meta.text)}>
      <meta.icon className="size-3.5" aria-hidden />
      {meta.label}
    </span>
  );
};

const NumberView = ({ r, compact }) => (
  <div className={cn('flex flex-col items-start gap-1.5', compact ? 'py-1' : 'py-4')}>
    <p className={cn('font-semibold tracking-tight text-fg', compact ? 'text-2xl' : 'text-4xl')}>
      {formatNumber(r.value)}
      {r.unit && <span className="ml-1.5 text-base font-medium text-muted">{r.unit}</span>}
    </p>
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <ToneChip tone={r.tone} />
      {r.target != null && (
        <span className="inline-flex items-center gap-1 text-xs text-muted tabular">
          <Target className="size-3.5" aria-hidden />
          Target {formatNumber(r.target, { unit: r.unit || undefined })}
        </span>
      )}
    </div>
  </div>
);

const GaugeView = ({ r }) => (
  <div className="flex flex-col items-center gap-1">
    <Gauge
      value={r.value}
      min={r.min ?? 0}
      max={r.max}
      unit={r.unit}
      target={r.target}
      thresholds={r.thresholds}
      tone={r.tone}
    />
    <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1">
      <ToneChip tone={r.tone} />
      {r.target != null && (
        <span className="text-xs text-muted tabular">
          Target {formatNumber(r.target, { unit: r.unit || undefined })}
        </span>
      )}
    </div>
  </div>
);

const chartOf = (r, height, compact) => {
  if (SERIES_TYPES.has(r.viz)) return <SeriesView r={r} height={height} compact={compact} />;
  switch (r.viz) {
    case 'pie':
      return <PieView r={r} height={compact ? height : Math.min(height, 200)} compact={compact} />;
    case 'funnel':
      return <FunnelView r={r} compact={compact} />;
    case 'treemap':
      return <TreemapView r={r} height={height} />;
    case 'heatmap':
      return <Heatmap {...r} unit={r.unit} compact={compact} />;
    case 'timeline':
      return <TimelineView r={r} compact={compact} />;
    case 'gauge':
      return <GaugeView r={r} />;
    default:
      return <NumberView r={r} compact={compact} />;
  }
};

/**
 * Renders a KPI runner result (`KpiResult`) of any of the 15 viz types. The drawing is one role="img" with a
 * spoken summary; charts also offer the same numbers as a table. Errors and empty ranges show inline.
 */
export const Viz = ({ result, height = 220, compact = false, className }) => {
  const [asTable, setAsTable] = useState(false);
  if (!result) return null;
  const r = result;
  if (r.error) {
    return (
      <div className={cn('flex items-start gap-2 rounded-lg bg-critical/5 px-3 py-3 text-sm', className)}>
        <CircleAlert className="mt-0.5 size-4 shrink-0 text-critical" aria-hidden />
        <div className="min-w-0">
          <p className="font-medium text-fg">This KPI couldn't be computed</p>
          <p className="mt-0.5 break-words text-muted">{r.error}</p>
        </div>
      </div>
    );
  }
  if (!hasData(r)) {
    return (
      <p
        className={cn('grid place-items-center px-3 text-center text-sm text-muted', className)}
        style={{ minHeight: compact ? 64 : Math.min(height, 140) }}
      >
        No data in {r.timeRange?.label ?? 'this range'}
      </p>
    );
  }
  if (r.viz === 'table') {
    return <DataTable title={r.title} columns={r.columns} rows={r.rows} className={className} />;
  }
  const tableable = !compact && r.viz !== 'number' && r.viz !== 'gauge';
  const legend = SERIES_TYPES.has(r.viz) && r.series.length > 1 ? r.series.slice(0, SERIES_MAX) : null;
  const view = tableOf(r);
  return (
    <figure className={cn('min-w-0', SERIES_VARS, className)}>
      {(tableable || legend) && (
        <div className="mb-2 flex items-start justify-between gap-2">
          {legend && !asTable ? <Legend items={legend} /> : <span />}
          {tableable && (
            <Button
              size="iconSm"
              variant="ghost"
              icon={asTable ? ChartColumn : Table2}
              aria-label={asTable ? 'Show chart' : 'Show as table'}
              title={asTable ? 'Show chart' : 'Show as table'}
              aria-pressed={asTable}
              onClick={() => setAsTable((v) => !v)}
            />
          )}
        </div>
      )}
      {asTable ? (
        <DataTable title={r.title} columns={view.columns} rows={view.rows} />
      ) : r.viz === 'timeline' ? (
        // The strips are focusable, so the timeline is a labelled region rather than one image.
        <section aria-label={vizSummary(r)}>{chartOf(r, height, compact)}</section>
      ) : (
        <div role="img" aria-label={vizSummary(r)}>
          {chartOf(r, height, compact)}
        </div>
      )}
      {!compact && r.warnings?.length > 0 && (
        <figcaption className="mt-2 text-[11px] text-subtle">{r.warnings.join(' · ')}</figcaption>
      )}
    </figure>
  );
};
