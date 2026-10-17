import { ChartColumn, Table2 } from 'lucide-react';
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
  ResponsiveContainer,
  Scatter,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { cn, formatDateTime, formatNumber, formatTime, getFormatPrefs, humanize } from '../lib/format.js';
import { SERIES_MAX, SERIES_VARS, seriesColor } from '../ui/charts.jsx';
import { Button } from '../ui/core.jsx';
import { valueAxis } from '../viz/vizData.js';
import { DataTable } from './DataTable.jsx';

const ISO = /^\d{4}-\d{2}-\d{2}(T|$)/;
const HEIGHT = 260;
const PIE_MAX = 6;
const BAR_TYPES = new Set(['bar', 'stackedBar', 'combo']);
const AXIS_TICK = { fill: 'var(--subtle)', fontSize: 11 };

const toNumber = (v) => (typeof v === 'number' ? v : v == null || v === '' ? null : Number(v));

/** True when every x value is an ISO date, so the axis becomes a time scale in the company zone. */
export const isTimeAxis = (data, xKey) =>
  data.length > 0 && data.every((r) => typeof r[xKey] === 'string' && ISO.test(r[xKey]));

const timeTick = (spanMs) => {
  if (spanMs <= 36 * 36e5) return (ms) => formatTime(ms);
  const day = new Intl.DateTimeFormat('en-GB', {
    timeZone: getFormatPrefs().timeZone,
    day: 'numeric',
    month: 'short',
  });
  return (ms) => day.format(ms);
};

const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });

/** Rows with numeric series values and, on a time axis, `__x` in epoch ms. */
const prepare = (data, xKey, series, time) =>
  data.map((row) => {
    const out = { ...row, __x: time ? Date.parse(row[xKey]) : row[xKey] };
    for (const s of series) out[s.key] = toNumber(row[s.key]);
    return out;
  });

const Legend = ({ series }) => (
  <ul className="flex flex-wrap gap-x-4 gap-y-1 px-3 pb-1 text-xs text-muted">
    {series.map((s, i) => (
      <li key={s.key} className="flex items-center gap-1.5">
        <span className="size-2.5 shrink-0 rounded-sm" style={{ background: seriesColor(i) }} aria-hidden />
        {s.label ?? s.key}
        {s.unit && <span className="text-subtle">({s.unit})</span>}
      </li>
    ))}
  </ul>
);

const TooltipBox = ({ active, payload, label, time, series }) => {
  const rows = (payload ?? []).filter((p) => p.value != null);
  if (!active || !rows.length) return null;
  const unitOf = (name) => series.find((s) => (s.label ?? s.key) === name)?.unit;
  return (
    <div className="rounded-lg border border-border bg-surface px-3 py-2 text-xs shadow-pop">
      {label != null && label !== '' && (
        <p className="mb-1.5 text-subtle">{time ? formatDateTime(label) : String(label)}</p>
      )}
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

/** One mark per series. Combo: `axis: 'right'` series (or every series after the first) draw as lines. */
const markFor = (type, s, i, count) => {
  const color = seriesColor(i);
  const name = s.label ?? s.key;
  const common = { dataKey: s.key, name, isAnimationActive: false };
  const asLine = type === 'line' || (type === 'combo' && (s.axis === 'right' || (i > 0 && !s.axis)));
  if (type === 'scatter') return <Scatter key={s.key} {...common} fill={color} />;
  if (asLine) {
    return (
      <Line
        key={s.key}
        {...common}
        stroke={color}
        strokeWidth={2}
        dot={false}
        connectNulls
        activeDot={{ r: 4, stroke: 'var(--surface)', strokeWidth: 2 }}
      />
    );
  }
  if (type === 'area') {
    return (
      <Area
        key={s.key}
        {...common}
        stroke={color}
        strokeWidth={2}
        fill={color}
        fillOpacity={0.12}
        connectNulls
        activeDot={{ r: 4, stroke: 'var(--surface)', strokeWidth: 2 }}
      />
    );
  }
  const stacked = type === 'stackedBar';
  const top = !stacked || i === count - 1;
  return (
    <Bar
      key={s.key}
      {...common}
      fill={color}
      stackId={stacked ? 'stack' : undefined}
      radius={top ? [4, 4, 0, 0] : 0}
      stroke={stacked ? 'var(--surface)' : undefined}
      strokeWidth={stacked ? 1 : 0}
      maxBarSize={48}
    />
  );
};

const Cartesian = ({ type, xKey, series, data }) => {
  const time = isTimeAxis(data, xKey);
  const rows = useMemo(() => prepare(data, xKey, series, time), [data, xKey, series, time]);
  const numericX = time || (type === 'scatter' && rows.every((r) => typeof toNumber(r[xKey]) === 'number'));
  const span = time && rows.length ? rows[rows.length - 1].__x - rows[0].__x : 0;
  const units = [...new Set(series.map((s) => s.unit).filter(Boolean))];
  const integers = rows.every((r) => series.every((s) => r[s.key] == null || Number.isInteger(r[s.key])));
  const axis = valueAxis(rows, series, { stacked: type === 'stackedBar' });
  // Whole-number data keeps Recharts' own integer ticks when the round steps would be fractional.
  const yAxis = axis && !(integers && axis.ticks[1] - axis.ticks[0] < 1) ? axis : null;
  return (
    <div className="relative" style={{ height: HEIGHT }}>
      {units.length === 1 && (
        <span className="pointer-events-none absolute left-1 top-0 text-[11px] font-medium text-subtle">
          {units[0]}
        </span>
      )}
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart
          data={rows}
          margin={{ top: 24, right: 24, bottom: 0, left: 0 }}
          barCategoryGap="20%"
          barGap={2}
        >
          <CartesianGrid vertical={false} stroke="var(--border)" />
          <XAxis
            dataKey="__x"
            type={numericX ? 'number' : 'category'}
            scale={time ? 'time' : 'auto'}
            domain={numericX ? ['dataMin', 'dataMax'] : undefined}
            tickFormatter={time ? timeTick(span) : numericX ? (v) => compact.format(v) : undefined}
            tick={AXIS_TICK}
            tickLine={false}
            axisLine={{ stroke: 'var(--border-strong)' }}
            minTickGap={time ? 48 : 8}
            interval={time || numericX ? 'preserveStartEnd' : 'equidistantPreserveStart'}
          />
          <YAxis
            width={44}
            allowDecimals={!integers}
            domain={yAxis?.domain}
            ticks={yAxis?.ticks}
            tickFormatter={(v) => compact.format(v)}
            tick={AXIS_TICK}
            tickLine={false}
            axisLine={false}
          />
          <Tooltip
            content={<TooltipBox time={time} series={series} />}
            cursor={BAR_TYPES.has(type) ? { fill: 'var(--surface-2)' } : { stroke: 'var(--border-strong)' }}
            isAnimationActive={false}
          />
          {series.map((s, i) => markFor(type, s, i, series.length))}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
};

/** Slices of the first series by x label; beyond six the smallest fold into "Other". */
export const pieSlices = (data, xKey, key) => {
  const slices = data
    .map((r) => ({ name: String(r[xKey] ?? '—'), value: toNumber(r[key]) ?? 0 }))
    .filter((s) => s.value > 0)
    .sort((a, b) => b.value - a.value);
  if (slices.length <= PIE_MAX) return slices;
  const rest = slices.slice(PIE_MAX - 1).reduce((t, s) => t + s.value, 0);
  return [...slices.slice(0, PIE_MAX - 1), { name: 'Other', value: rest }];
};

const PieView = ({ xKey, series, data }) => {
  const s = series[0];
  const slices = useMemo(() => pieSlices(data, xKey, s.key), [data, xKey, s.key]);
  const total = slices.reduce((t, x) => t + x.value, 0) || 1;
  return (
    <div
      className="grid items-center gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]"
      style={{ minHeight: HEIGHT }}
    >
      <div style={{ height: HEIGHT }}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={slices}
              dataKey="value"
              nameKey="name"
              innerRadius="55%"
              outerRadius="85%"
              paddingAngle={1}
              stroke="var(--surface)"
              strokeWidth={2}
              isAnimationActive={false}
            >
              {slices.map((slice, i) => (
                <Cell key={slice.name} fill={seriesColor(i)} />
              ))}
            </Pie>
            <Tooltip content={<TooltipBox series={slices.map((x) => ({ key: x.name, unit: s.unit }))} />} />
          </PieChart>
        </ResponsiveContainer>
      </div>
      <ul className="space-y-1.5 px-3 pb-3 text-xs">
        {slices.map((slice, i) => (
          <li key={slice.name} className="flex items-center gap-2">
            <span
              className="size-2.5 shrink-0 rounded-sm"
              style={{ background: seriesColor(i) }}
              aria-hidden
            />
            <span className="min-w-0 flex-1 truncate text-fg">{slice.name}</span>
            <span className="font-medium text-fg tabular">{formatNumber(slice.value, { unit: s.unit })}</span>
            <span className="w-10 text-right text-subtle tabular">
              {Math.round((slice.value / total) * 100)}%
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
};

/**
 * `chart` block: { title, type: line|bar|area|stackedBar|combo|pie|scatter, xKey, series, data }. One y-axis
 * (series of other units share it; the tooltip names each unit), ISO x values become a time axis in the company
 * zone, at most six series in the fixed palette order, and a table view of the same rows.
 */
export const ChartBlock = ({ title, type = 'line', xKey, series = [], data = [], className }) => {
  const [asTable, setAsTable] = useState(false);
  const shown = series.slice(0, SERIES_MAX);
  const hidden = series.length - shown.length;
  const empty = !data.length || !shown.length;
  return (
    <figure
      className={cn('overflow-hidden rounded-xl border border-border bg-surface', SERIES_VARS, className)}
    >
      <figcaption className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <span className="flex min-w-0 items-center gap-2 text-sm font-semibold text-fg">
          <ChartColumn className="size-4 shrink-0 text-muted" aria-hidden />
          <span className="truncate">{title ?? 'Chart'}</span>
        </span>
        {!empty && (
          <Button
            size="iconSm"
            variant="ghost"
            icon={asTable ? ChartColumn : Table2}
            aria-label={asTable ? 'Show chart' : 'Show as table'}
            title={asTable ? 'Show chart' : 'Show as table'}
            onClick={() => setAsTable((v) => !v)}
          />
        )}
      </figcaption>
      {empty ? (
        <p className="px-3 py-10 text-center text-sm text-muted">No data to chart.</p>
      ) : asTable ? (
        <DataTable
          title={title}
          columns={[
            { key: xKey, label: isTimeAxis(data, xKey) ? 'Time' : humanize(xKey) },
            ...series.map((s) => ({ key: s.key, label: s.label ?? s.key, unit: s.unit })),
          ]}
          rows={data}
          className="rounded-none border-0"
        />
      ) : (
        <div className="pt-2">
          {type !== 'pie' && shown.length > 1 && <Legend series={shown} />}
          {type === 'pie' ? (
            <PieView xKey={xKey} series={shown} data={data} />
          ) : (
            <Cartesian type={type} xKey={xKey} series={shown} data={data} />
          )}
          {hidden > 0 && (
            <p className="px-3 pb-2 text-[11px] text-subtle">
              {hidden} more series not drawn; the table view has them all.
            </p>
          )}
        </div>
      )}
    </figure>
  );
};
