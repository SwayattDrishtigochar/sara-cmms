import { CircleDashed, CirclePause, CirclePlay, CircleStop, Power, Wrench } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  cn,
  formatDateTime,
  formatDuration,
  formatNumber,
  formatTime,
  getFormatPrefs,
} from '../lib/format.js';

const toMs = (value) => (typeof value === 'number' ? value : Date.parse(value));

// ── Colour roles ────────────────────────────────────────────────────────────

/**
 * Categorical series colours: the dataviz reference palette in its validated order (passes CVD and
 * normal-vision checks against SARA's #ffffff and #10161f surfaces). Put it on a chart wrapper and colour
 * series with `seriesColor(slot)`, slot 0–5 in the order series were added — never cycled, never re-ranked.
 */
export const SERIES_VARS =
  '[--series-1:#2a78d6] [--series-2:#eb6834] [--series-3:#1baf7a] [--series-4:#eda100] [--series-5:#e87ba4] [--series-6:#008300] dark:[--series-1:#3987e5] dark:[--series-2:#d95926] dark:[--series-3:#199e70] dark:[--series-4:#c98500] dark:[--series-5:#d55181]';
export const SERIES_MAX = 6;
export const seriesColor = (slot) => `var(--series-${slot + 1})`;

/**
 * Machine status marks. Running recedes and stops stay loud (calm control room); the opacities also keep
 * every status pair apart under protan/deutan simulation (ΔE ≥ 8), which the raw tokens alone do not.
 */
export const STATUS_STYLE = {
  Running: { color: 'var(--running)', opacity: 0.5, icon: CirclePlay },
  ON: { color: 'var(--running)', opacity: 0.5, icon: CirclePlay },
  Idle: { color: 'var(--idle)', opacity: 0.85, icon: CirclePause },
  Stopped: { color: 'var(--stopped)', opacity: 1, icon: CircleStop },
  OFF: { color: 'var(--off)', opacity: 1, icon: Power },
  Maintenance: { color: 'var(--maint)', opacity: 1, icon: Wrench },
};
const UNKNOWN_STATUS = { color: 'var(--border-strong)', opacity: 1, icon: CircleDashed };
export const statusStyle = (status) => STATUS_STYLE[status] ?? UNKNOWN_STATUS;

// ── Sparkline ───────────────────────────────────────────────────────────────

const sparkGeometry = (points) => {
  if (points.length < 2) return null;
  const t0 = points[0][0];
  const span = points[points.length - 1][0] - t0 || 1;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const [, v] of points) {
    min = Math.min(min, v);
    max = Math.max(max, v);
  }
  const y = (v) => (max > min ? 29 - ((v - min) / (max - min)) * 26 : 16);
  const xy = points.map(([t, v]) => `${(((t - t0) / span) * 100).toFixed(2)},${y(v).toFixed(2)}`);
  const end = xy[xy.length - 1];
  return { line: `M${xy.join('L')}`, dot: `M${end}h0`, min, max };
};

/** Tiny trend of `points` ([[ms, value]]) with the latest value dotted; stretches to its container width. */
export const Sparkline = ({ points = [], label, unit, tone, className }) => {
  const g = useMemo(() => sparkGeometry(points), [points]);
  const fmt = (v) => formatNumber(v, { unit });
  return (
    <svg
      role="img"
      aria-label={
        g
          ? `${label}: low ${fmt(g.min)}, high ${fmt(g.max)}, latest ${fmt(points[points.length - 1][1])}`
          : `${label}: not enough readings yet`
      }
      viewBox="0 0 100 32"
      preserveAspectRatio="none"
      className={cn('block h-7 w-full overflow-visible', className)}
    >
      {g ? (
        <>
          <path
            d={g.line}
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
            className="text-subtle"
          />
          <path
            d={g.dot}
            stroke="currentColor"
            strokeWidth={6}
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
            className={tone === 'warn' ? 'text-warn' : 'text-brand'}
          />
        </>
      ) : (
        <path d="M0,16H100" stroke="currentColor" vectorEffect="non-scaling-stroke" className="text-border" />
      )}
    </svg>
  );
};

// ── Telemetry line chart ────────────────────────────────────────────────────

const UNIT_MS = { ms: 1, s: 1e3, m: 6e4, h: 36e5, d: 864e5 };
/** "30s" → 30000 (aggregation window from the series API). */
export const parseEvery = (every) => {
  const m = /^(\d+)(ms|s|m|h|d)$/.exec(every ?? '');
  return m ? Number(m[1]) * UNIT_MS[m[2]] : null;
};

/**
 * Chart rows, one per timestamp. A series missing a sample briefly holds its last value; lines break where
 * the data has a real gap (longer than three steps), so a machine that was off is not drawn as a ramp.
 */
export const toChartRows = (series, stepMs) => {
  const times = [...new Set(series.flatMap((s) => s.points.map(([t]) => t)))].sort((a, b) => a - b);
  const step =
    stepMs || (times.length > 1 ? (times[times.length - 1] - times[0]) / (times.length - 1) : 60e3);
  const hold = 3 * step;
  const lookup = series.map((s) => new Map(s.points));
  const last = series.map(() => null);
  const rows = [];
  let prev = null;
  for (const t of times) {
    if (prev != null && t - prev > hold) rows.push({ t: prev + step }); // no values → the lines break here
    const row = { t };
    series.forEach((s, i) => {
      const v = lookup[i].get(t);
      if (v != null) last[i] = [t, v];
      row[s.key] = v ?? (last[i] && t - last[i][0] <= hold ? last[i][1] : null);
    });
    rows.push(row);
    prev = t;
  }
  return rows;
};

/** Round axis bounds, evenly spaced ticks on a 1/2/5 × 10ⁿ step, and a label format exact to that step. */
export const niceAxis = (lo, hi) => {
  const raw = (hi - lo) / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].find((n) => raw / mag <= n) * mag;
  const ticks = [];
  for (let v = Math.floor(lo / step) * step; v < hi + step; v += step) ticks.push(Number(v.toPrecision(12)));
  const digits = Math.max(0, -Math.floor(Math.log10(step) + 1e-9));
  const fmt = new Intl.NumberFormat(
    'en',
    step >= 1000
      ? { notation: 'compact', maximumFractionDigits: 1 }
      : { minimumFractionDigits: digits, maximumFractionDigits: digits },
  );
  return { domain: [ticks[0], ticks[ticks.length - 1]], ticks, format: (v) => fmt.format(v) };
};

const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
const timeTick = (spanMs) => {
  if (spanMs <= 36 * 36e5) return (ms) => formatTime(ms);
  const day = new Intl.DateTimeFormat('en-GB', {
    timeZone: getFormatPrefs().timeZone,
    day: 'numeric',
    month: 'short',
  });
  return (ms) => day.format(ms);
};

/** Keeps synced charts on the same moment even when their timestamps differ slightly. */
const nearestTick = (ticks, { activeLabel }) => {
  const t = Number(activeLabel);
  let best = 0;
  for (let i = 1; i < ticks.length; i += 1) {
    if (Math.abs(ticks[i].value - t) < Math.abs(ticks[best].value - t)) best = i;
  }
  return best;
};

const ChartTooltip = ({ active, payload, label, unit }) => {
  const rows = (payload ?? []).filter((p) => p.value != null);
  if (!active || !rows.length) return null;
  return (
    <div className="rounded-lg border border-border bg-surface px-3 py-2 text-xs shadow-pop">
      <p className="mb-1.5 text-subtle">{formatDateTime(label)}</p>
      <ul className="space-y-1">
        {rows.map((p) => (
          <li key={p.dataKey} className="flex items-center gap-2">
            <span className="h-0.5 w-3 shrink-0 rounded-full" style={{ background: p.color }} aria-hidden />
            <span className="font-semibold text-fg tabular">{formatNumber(p.value, { unit })}</span>
            <span className="text-muted">{p.name}</span>
          </li>
        ))}
      </ul>
    </div>
  );
};

/**
 * Recharts line chart for series that share one unit: `series` = [{ key, label, color, points: [[ms, v]] }].
 * One y-axis only — stack several charts with the same `syncId` for other units. `band` = { min, max }
 * shades the normal range; `domain` = [startMs, stopMs] keeps stacked charts aligned; `markers` = [{ at: ms,
 * label }] draws a vertical rule at a moment (when an anomaly was detected).
 */
export const TelemetryChart = ({
  series,
  unit,
  band,
  domain,
  every,
  syncId,
  markers,
  height = 200,
  className,
}) => {
  const rows = useMemo(() => toChartRows(series, parseEvery(every)), [series, every]);
  const [x0, x1] = domain ?? [rows[0]?.t ?? 0, rows[rows.length - 1]?.t ?? 0];
  // Fit data and band with some air (so the band's edges show), on round tick values.
  const yAxis = useMemo(() => {
    let lo = Number.POSITIVE_INFINITY;
    let hi = Number.NEGATIVE_INFINITY;
    for (const row of rows) {
      for (const s of series) {
        const v = row[s.key];
        if (v != null) {
          lo = Math.min(lo, v);
          hi = Math.max(hi, v);
        }
      }
    }
    if (band?.min != null) lo = Math.min(lo, band.min);
    if (band?.max != null) hi = Math.max(hi, band.max);
    if (!Number.isFinite(lo)) return { domain: ['auto', 'auto'], format: (v) => compact.format(v) };
    const pad = (hi - lo) * 0.1 || Math.abs(hi) * 0.1 || 1;
    // Readings that never go negative (vibration, temperature in °C above 0) keep a zero floor.
    return niceAxis(lo >= 0 ? Math.max(0, lo - pad) : lo - pad, hi + pad);
  }, [rows, series, band]);
  return (
    <div className={cn('relative', className)} style={{ height }}>
      {unit && (
        <span className="pointer-events-none absolute left-1 top-0 text-[11px] font-medium text-subtle">
          {unit}
        </span>
      )}
      <ResponsiveContainer width="100%" height="100%">
        <LineChart
          data={rows}
          syncId={syncId}
          syncMethod={nearestTick}
          margin={{ top: 20, right: 8, bottom: 0, left: 0 }}
        >
          <CartesianGrid vertical={false} stroke="var(--border)" />
          {band && (
            <ReferenceArea
              y1={band.min ?? undefined}
              y2={band.max ?? undefined}
              ifOverflow="hidden"
              fill="var(--fg)"
              fillOpacity={0.06}
              stroke="none"
            />
          )}
          {markers?.map((m) => (
            <ReferenceLine
              key={m.at}
              x={m.at}
              stroke="var(--critical)"
              strokeWidth={1}
              label={
                m.label ? { value: m.label, position: 'top', fill: 'var(--muted)', fontSize: 11 } : undefined
              }
            />
          ))}
          <XAxis
            dataKey="t"
            type="number"
            scale="time"
            domain={[x0, x1]}
            allowDataOverflow
            tickFormatter={timeTick(x1 - x0)}
            tick={{ fill: 'var(--subtle)', fontSize: 11 }}
            tickLine={false}
            axisLine={{ stroke: 'var(--border-strong)' }}
            minTickGap={48}
          />
          <YAxis
            width={44}
            domain={yAxis.domain}
            ticks={yAxis.ticks}
            tickFormatter={yAxis.format}
            tick={{ fill: 'var(--subtle)', fontSize: 11 }}
            tickLine={false}
            axisLine={false}
          />
          <Tooltip
            content={<ChartTooltip unit={unit} />}
            cursor={{ stroke: 'var(--border-strong)' }}
            isAnimationActive={false}
          />
          {series.map((s) => (
            <Line
              key={s.key}
              dataKey={s.key}
              name={s.label}
              stroke={s.color}
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4, stroke: 'var(--surface)', strokeWidth: 2 }}
              isAnimationActive={false}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
};

// ── Status timeline ─────────────────────────────────────────────────────────

const TICKS = [0, 0.25, 0.5, 0.75, 1];

/**
 * Status strip over [start, stop]: one segment per run (`runs` = [{ status, start, end }]). Hover or focus +
 * arrow keys show a run's details; a time axis and a text legend (icon, label, total, share) sit below.
 */
export const StatusTimelineBar = ({ runs = [], start, stop, className }) => {
  const id = useId();
  const [active, setActive] = useState(null); // { i, x: percent }
  const s0 = toMs(start);
  const s1 = toMs(stop);
  const span = Math.max(1, s1 - s0);
  const segs = useMemo(
    () =>
      runs
        .map((r) => ({ status: r.status, a: Math.max(s0, toMs(r.start)), b: Math.min(s1, toMs(r.end)) }))
        .filter((r) => r.b > r.a),
    [runs, s0, s1],
  );
  const totals = useMemo(() => {
    const byStatus = new Map();
    for (const r of segs) byStatus.set(r.status, (byStatus.get(r.status) ?? 0) + (r.b - r.a) / 1000);
    return [...byStatus].sort((a, b) => b[1] - a[1]);
  }, [segs]);
  const covered = totals.reduce((sum, [, sec]) => sum + sec, 0);
  const missing = Math.max(0, span / 1000 - covered);
  const pct = (sec) => `${Math.round((sec / (span / 1000)) * 100)}%`;
  const run = active ? segs[active.i] : null;
  const RunIcon = run ? statusStyle(run.status).icon : null;
  const describe = (r) =>
    `${r.status} from ${formatTime(r.a)} to ${formatTime(r.b)}, ${formatDuration((r.b - r.a) / 1000)}`;

  const pick = (i) => {
    const seg = segs[i];
    if (seg) setActive({ i, x: (((seg.a + seg.b) / 2 - s0) / span) * 100 });
  };
  const onPointerMove = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const t = s0 + x * span;
    const i = segs.findIndex((r) => t >= r.a && t < r.b);
    setActive(i === -1 ? null : { i, x: x * 100 });
  };
  const onKeyDown = (e) => {
    const last = segs.length - 1;
    const next = {
      ArrowRight: Math.min(last, (active?.i ?? last) + 1),
      ArrowLeft: Math.max(0, (active?.i ?? segs.length) - 1),
      Home: 0,
      End: last,
    }[e.key];
    if (next == null) return;
    e.preventDefault();
    pick(next);
  };

  const summary = totals.map(([status, sec]) => `${status} ${formatDuration(sec)}`).join(', ');
  return (
    <div className={className}>
      <div className="relative">
        {/* biome-ignore lint/a11y/useSemanticElements: a focusable group is the right role for an arrow-key strip */}
        <div
          role="group"
          tabIndex={segs.length ? 0 : -1}
          aria-roledescription="status timeline"
          aria-label={`Status from ${formatDateTime(s0)} to ${formatDateTime(s1)}${summary ? `: ${summary}` : ''}. Use the arrow keys to step through changes.`}
          aria-describedby={`${id}-live`}
          onPointerMove={onPointerMove}
          onPointerLeave={() => setActive(null)}
          onFocus={() => active || pick(segs.length - 1)}
          onBlur={() => setActive(null)}
          onKeyDown={onKeyDown}
          className="relative h-8 cursor-crosshair overflow-hidden rounded-md bg-surface-2"
        >
          {segs.map((r, i) => {
            const st = statusStyle(r.status);
            return (
              <div
                key={`${r.a}-${r.status}`}
                className="absolute inset-y-0 transition-opacity duration-150"
                style={{
                  left: `${((r.a - s0) / span) * 100}%`,
                  width: `max(1px, calc(${((r.b - r.a) / span) * 100}% - 2px))`,
                  background: st.color,
                  opacity: active && active.i !== i ? st.opacity * 0.45 : st.opacity,
                }}
              />
            );
          })}
          {active && (
            <div
              className="pointer-events-none absolute inset-y-0 w-px bg-fg"
              style={{ left: `${active.x}%` }}
            />
          )}
        </div>
        {run && (
          <div
            className="pointer-events-none absolute bottom-full z-10 mb-2 -translate-x-1/2 whitespace-nowrap rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs shadow-pop"
            style={{ left: `clamp(6rem, ${active.x}%, calc(100% - 6rem))` }}
            aria-hidden
          >
            <span className="flex items-center gap-1.5 font-semibold text-fg">
              <RunIcon className="size-3.5" aria-hidden />
              {run.status}
              <span className="font-normal text-muted">· {formatDuration((run.b - run.a) / 1000)}</span>
            </span>
            <span className="text-muted tabular">
              {formatTime(run.a)} – {formatTime(run.b)}
            </span>
          </div>
        )}
        <p id={`${id}-live`} className="sr-only" aria-live="polite">
          {run ? describe(run) : ''}
        </p>
      </div>

      <div className="relative mt-1.5 h-4 text-[11px] text-subtle tabular" aria-hidden>
        {TICKS.map((f) => (
          <span
            key={f}
            className={cn(
              'absolute top-0 whitespace-nowrap',
              f === 0 ? 'left-0' : f === 1 ? 'right-0' : '-translate-x-1/2',
              (f === 0.25 || f === 0.75) && 'hidden sm:block',
            )}
            style={f > 0 && f < 1 ? { left: `${f * 100}%` } : undefined}
          >
            {f === 1 && Date.now() - s1 < 120_000 ? 'Now' : formatTime(s0 + f * span)}
          </span>
        ))}
      </div>

      <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-xs">
        {totals.map(([status, sec]) => {
          const st = statusStyle(status);
          return (
            <li key={status} className="flex items-center gap-1.5">
              <span
                className="size-2.5 rounded-sm"
                style={{ background: st.color, opacity: st.opacity }}
                aria-hidden
              />
              <st.icon className="size-3.5 text-muted" aria-hidden />
              <span className="font-medium text-fg">{status}</span>
              <span className="text-muted tabular">
                {formatDuration(sec)} · {pct(sec)}
              </span>
            </li>
          );
        })}
        {missing >= 60 && (
          <li className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-sm border border-border bg-surface-2" aria-hidden />
            <span className="font-medium text-fg">No data</span>
            <span className="text-muted tabular">
              {formatDuration(missing)} · {pct(missing)}
            </span>
          </li>
        )}
      </ul>
    </div>
  );
};
