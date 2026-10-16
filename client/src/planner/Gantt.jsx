import { CalendarRange, Info, OctagonAlert, Settings2, Sparkles, TriangleAlert, Wrench } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { cn, formatDateTime, getFormatPrefs } from '../lib/format.js';
import { useLiveAsset } from '../live/liveStore.js';
import { HealthRing } from '../machines/HealthRing.jsx';
import { EmptyState, StatusPill } from '../ui/core.jsx';
import { layoutGantt, shiftBands, ticks, timeScale } from './ganttLayout.js';

const KIND_LABEL = { jobcard: 'Job card', maintenance: 'Maintenance', setup: 'Mould changeover' };
const CHANGE_LABEL = { new: 'new', moved: 'moved', extended: 'extended' };
const MARKER_ICON = { critical: OctagonAlert, warning: TriangleAlert, info: Info };
const MARKER_TEXT = { critical: 'text-critical', warning: 'text-warn', info: 'text-info' };
const STRIPES = (color) => ({
  backgroundImage: `repeating-linear-gradient(135deg, color-mix(in oklab, ${color} 30%, transparent) 0 4px, transparent 4px 8px)`,
});

/** `+2.0 h` */
export const delayText = (hours) => `+${Number(hours ?? 0).toFixed(1)} h`;

const delayOf = (bar, delays) =>
  bar.ghost ? delays?.find((d) => d.jobCardId === bar.id || (bar.code && d.code === bar.code)) : null;

/** Everything a bar says, as one sentence (screen readers and the tooltip). */
export const describeBar = (bar, delay) =>
  [
    [bar.code, bar.label].filter(Boolean).join(' · ') || KIND_LABEL[bar.kind ?? 'jobcard'],
    `${KIND_LABEL[bar.kind ?? 'jobcard']}, ${formatDateTime(bar.start)} to ${formatDateTime(bar.end)}`,
    bar.status,
    bar.progress != null && `${Math.round(bar.progress * 100)}% done`,
    bar.ghost && `Proposed by SARA${bar.change ? ` (${CHANGE_LABEL[bar.change] ?? bar.change})` : ''}`,
    bar.from && `was ${formatDateTime(bar.from.start)} to ${formatDateTime(bar.from.end)}`,
    delay && `${delayText(delay.hours)} later${delay.late ? ', late for its plan' : ''}`,
    bar.late && !delay?.late && 'Late for its due date',
    bar.conflict && 'Conflicts with another booking',
    bar.tooltip,
  ]
    .filter(Boolean)
    .join('. ');

const barClass = (bar) => {
  if (bar.ghost) return 'border-dashed border-ai bg-ai/15';
  if (bar.kind === 'maintenance') return 'border-maint/60 bg-maint/15';
  if (bar.kind === 'setup') return 'border-off/50 bg-surface-2';
  if (bar.status === 'In Progress') return 'border-brand/70 bg-brand/25';
  if (bar.status === 'On Hold') return 'border-idle/60 bg-idle/15';
  return 'border-brand/45 bg-brand/10';
};

const BarIcon = ({ bar }) => {
  const Icon =
    bar.late || bar.conflict
      ? TriangleAlert
      : bar.kind === 'maintenance'
        ? Wrench
        : bar.kind === 'setup'
          ? Settings2
          : bar.ghost
            ? Sparkles
            : null;
  if (!Icon) return null;
  return (
    <Icon
      className={cn(
        'size-3 shrink-0',
        bar.late || bar.conflict ? 'text-critical' : bar.ghost ? 'text-ai' : 'text-muted',
      )}
      aria-hidden
    />
  );
};

const Bar = ({ bar, delay, selected, onHover, onClick }) => {
  const progressX = bar.progress != null && !bar.ghost ? bar.x + bar.w * Math.min(1, bar.progress) : null;
  const stripes =
    bar.kind === 'maintenance'
      ? STRIPES('var(--maint)')
      : bar.kind === 'setup'
        ? STRIPES('var(--off)')
        : undefined;
  return (
    <>
      {bar.outline && (
        <div
          className="pointer-events-none absolute rounded-md border border-dashed border-border-strong"
          style={{ left: bar.outline.x, width: bar.outline.w, top: bar.y, height: bar.h }}
          aria-hidden
        />
      )}
      <button
        type="button"
        aria-label={describeBar(bar, delay)}
        onClick={() => onClick(bar)}
        onMouseEnter={() => onHover(bar)}
        onMouseLeave={() => onHover(null)}
        onFocus={() => onHover(bar)}
        onBlur={() => onHover(null)}
        className={cn(
          'absolute rounded-md focus-visible:z-10',
          bar.kind === 'maintenance' ? 'z-[2]' : 'z-[1]',
          (bar.late || bar.conflict) && 'ring-2 ring-critical',
          selected && 'ring-2 ring-brand ring-offset-1 ring-offset-surface',
        )}
        style={{ left: bar.x, width: bar.w, top: bar.y, height: bar.h }}
      >
        {bar.segments.map((seg, i) => (
          <span
            key={i}
            className={cn(
              'absolute inset-y-0 flex items-center gap-1 overflow-hidden border px-1 text-left',
              barClass(bar),
              bar.clipStart && i === 0 ? 'rounded-l-none border-l-0' : 'rounded-l-md',
              bar.clipEnd && i === bar.segments.length - 1 ? 'rounded-r-none border-r-0' : 'rounded-r-md',
            )}
            style={{ left: seg.x - bar.x, width: seg.w, ...stripes }}
          >
            {progressX != null && progressX > seg.x && (
              <span
                className="absolute inset-y-0 left-0 bg-brand/30"
                style={{ width: Math.min(seg.w, progressX - seg.x) }}
                aria-hidden
              />
            )}
            {i === 0 && seg.w >= 18 && <BarIcon bar={bar} />}
            {i === 0 && seg.w >= 44 && (
              <span className="relative truncate text-[11px] font-medium leading-none text-fg">
                {bar.code ?? bar.label}
              </span>
            )}
          </span>
        ))}
      </button>
      {delay && (
        <span
          className={cn(
            'pointer-events-none absolute z-[3] flex items-center gap-0.5 rounded border bg-surface px-1 text-[10px] font-semibold leading-4 tabular',
            delay.late ? 'border-critical/40 text-critical' : 'border-border text-muted',
          )}
          style={{ left: bar.x + bar.w + 3, top: bar.y + bar.h / 2 - 8 }}
          aria-hidden
        >
          {delay.late && <TriangleAlert className="size-2.5" />}
          {delayText(delay.hours)}
        </span>
      )}
    </>
  );
};

const RowLabel = ({ row, box, compact }) => {
  const live = useLiveAsset(row.id);
  const status = live?.status ?? row.status;
  return (
    <div
      className="absolute inset-x-0 flex items-center gap-2 border-b border-border px-2"
      style={{ top: box.y, height: box.h }}
    >
      {!compact && row.health !== undefined && <HealthRing score={row.health} size={20} />}
      <div className="min-w-0 flex-1">
        <p className={cn('truncate font-medium text-fg', compact ? 'text-[11px]' : 'text-xs')}>{row.label}</p>
        {!compact && (
          <div className="mt-0.5 flex min-w-0 items-center gap-1.5">
            {status && <StatusPill status={status} className="px-1 py-0 text-[10px]" />}
            {row.sub && <span className="truncate text-[10px] text-subtle tabular">{row.sub}</span>}
          </div>
        )}
      </div>
    </div>
  );
};

const useWidth = () => {
  const ref = useRef(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const measure = () => setWidth(el.clientWidth);
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
};

const useClock = (fixed) => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (fixed != null) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, [fixed]);
  return fixed ?? now;
};

const LegendSwatch = ({ className, style, children }) => (
  <span className={cn('inline-block h-3 w-5 rounded-sm border', className)} style={style} aria-hidden>
    {children}
  </span>
);

const Legend = ({ bars, markers }) => {
  const has = (fn) => bars.some(fn);
  const items = [
    { key: 'jc', label: 'Job card', swatch: <LegendSwatch className="border-brand/45 bg-brand/10" /> },
    has((b) => b.progress != null) && {
      key: 'progress',
      label: 'Done so far',
      swatch: (
        <LegendSwatch className="border-brand/45 bg-[linear-gradient(90deg,var(--brand)_50%,transparent_50%)] opacity-60" />
      ),
    },
    {
      key: 'maint',
      label: 'Maintenance',
      swatch: <LegendSwatch className="border-maint/60 bg-maint/15" style={STRIPES('var(--maint)')} />,
    },
    has((b) => b.kind === 'setup') && {
      key: 'setup',
      label: 'Mould changeover',
      swatch: <LegendSwatch className="border-off/50 bg-surface-2" style={STRIPES('var(--off)')} />,
    },
    has((b) => b.ghost) && {
      key: 'ghost',
      label: 'Proposed by SARA',
      swatch: <LegendSwatch className="border-dashed border-ai bg-ai/15" />,
    },
    has((b) => b.from) && {
      key: 'from',
      label: 'Current slot',
      swatch: <LegendSwatch className="border-dashed border-border-strong" />,
    },
    has((b) => b.late || b.conflict) && {
      key: 'late',
      label: 'Late or conflict',
      swatch: <TriangleAlert className="size-3.5 text-critical" aria-hidden />,
    },
    markers.length > 0 && {
      key: 'anomaly',
      label: 'Open anomaly',
      swatch: <OctagonAlert className="size-3.5 text-critical" aria-hidden />,
    },
    { key: 'now', label: 'Now', swatch: <span className="inline-block h-3 w-0.5 bg-critical" aria-hidden /> },
  ].filter(Boolean);
  return (
    <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 text-[11px] text-muted">
      {items.map((it) => (
        <li key={it.key} className="flex items-center gap-1.5">
          {it.swatch}
          {it.label}
        </li>
      ))}
    </ul>
  );
};

/**
 * Machine Gantt of `data` (GanttData, optionally with `delays`): rows grouped by machine type, shift
 * bands, a now-line, anomaly markers, job card / maintenance / changeover bars and SARA's ghost bars.
 * Bars are buttons: focus or hover shows details, Enter calls `onBarClick` (default: open its record).
 * `compact` drops row details, group headers and the legend (chat block, Command Center).
 */
export const Gantt = ({ data, compact = false, now, selectedId, onBarClick, className }) => {
  const navigate = useNavigate();
  const [ref, measured] = useWidth();
  const [hover, setHover] = useState(null);
  const nowMs = useClock(now == null ? null : new Date(now).getTime());
  const width = measured || 720;
  const timeZone = data?.timeZone ?? getFormatPrefs().timeZone;
  const axisH = compact ? 20 : 34;

  const layout = useMemo(
    () =>
      data?.range
        ? layoutGantt({
            rows: data.rows ?? [],
            bars: data.bars ?? [],
            markers: data.markers ?? [],
            range: data.range,
            width,
            rowHeight: compact ? 26 : 44,
            barHeight: compact ? 16 : 24,
            groupHeight: compact ? 0 : 22,
            now: nowMs,
          })
        : null,
    [data, width, compact, nowMs],
  );
  const axis = useMemo(
    () => (data?.range ? ticks(data.range, timeZone, width) : []),
    [data, timeZone, width],
  );
  const bands = useMemo(() => {
    if (!data?.range) return [];
    const { x } = timeScale(data.range, width);
    return shiftBands(data.shifts, data.range, timeZone).map((b) => ({
      ...b,
      x: x(b.start),
      w: x(b.end) - x(b.start),
    }));
  }, [data, timeZone, width]);

  if (!layout || !data.rows?.length) {
    return (
      <EmptyState icon={CalendarRange} title="No machines to show" className={cn('py-8', className)}>
        Machines appear here once the plant has production assets.
      </EmptyState>
    );
  }

  const rowsById = new Map(data.rows.map((r) => [r.id, r]));
  const click = (bar) => {
    if (onBarClick) onBarClick(bar);
    else if (bar.href) navigate(bar.href);
  };
  const hoverDelay = hover && delayOf(hover, data.delays);

  return (
    <div className={className}>
      <div className="overflow-x-auto rounded-lg border border-border scrollbar-thin">
        <div className="flex" style={{ minWidth: compact ? 420 : 680 }}>
          <div
            className={cn(
              'sticky left-0 z-20 shrink-0 border-r border-border bg-surface',
              compact ? 'w-20' : 'w-32 sm:w-48',
            )}
          >
            <div className="border-b border-border" style={{ height: axisH }} />
            <div className="relative" style={{ height: layout.height }}>
              {layout.groups.map((g) => (
                <p
                  key={g.label}
                  className="absolute inset-x-0 flex items-center border-b border-border bg-surface-2 px-2 text-[10px] font-semibold uppercase tracking-wide text-subtle"
                  style={{ top: g.y, height: g.h }}
                >
                  {g.label}
                </p>
              ))}
              {layout.rows.map((box) => (
                <RowLabel key={box.id} row={rowsById.get(box.id)} box={box} compact={compact} />
              ))}
            </div>
          </div>

          <div ref={ref} className="relative min-w-0 flex-1 bg-surface">
            <div className="relative border-b border-border" style={{ height: axisH }} aria-hidden>
              {axis.map((t) => (
                <span
                  key={t.t}
                  className={cn(
                    'absolute top-1 -translate-x-1/2 whitespace-nowrap text-[10px] tabular',
                    t.major ? 'font-semibold text-muted' : 'text-subtle',
                    t.x < 16 && 'translate-x-0',
                    t.x > width - 16 && '-translate-x-full',
                  )}
                  style={{ left: t.x }}
                >
                  {t.label}
                </span>
              ))}
              {!compact &&
                bands
                  // A label the Now pill would cover starts just right of the pill.
                  .map((b) => {
                    const n = layout.nowX;
                    const left = n != null && n > b.x - 16 && n < b.x + 52 ? Math.max(b.x, n + 16) : b.x;
                    return { ...b, left, w: b.w - (left - b.x) };
                  })
                  .filter((b) => b.w >= 36)
                  .map((b) => (
                    <span
                      key={`${b.name}-${b.start}`}
                      className="absolute bottom-0.5 truncate px-1 text-[10px] text-subtle"
                      style={{ left: b.left, width: b.w }}
                    >
                      Shift {b.name}
                    </span>
                  ))}
              {layout.nowX != null && (
                <span
                  className="absolute bottom-0 -translate-x-1/2 rounded-sm bg-critical px-1 text-[9px] font-semibold leading-3 text-white"
                  style={{ left: layout.nowX }}
                >
                  Now
                </span>
              )}
            </div>

            <div className="relative" style={{ height: layout.height }}>
              {bands.map((b, i) => (
                <div
                  key={`${b.name}-${b.start}`}
                  className={cn('absolute inset-y-0', i % 2 ? 'bg-fg/[0.03]' : '')}
                  style={{ left: b.x, width: b.w }}
                  aria-hidden
                />
              ))}
              {axis.map((t) => (
                <div
                  key={t.t}
                  className={cn(
                    'absolute inset-y-0 border-l',
                    t.major ? 'border-border-strong' : 'border-border',
                  )}
                  style={{ left: t.x }}
                  aria-hidden
                />
              ))}
              {layout.groups.map((g) => (
                <div
                  key={g.label}
                  className="absolute inset-x-0 border-b border-border bg-surface-2"
                  style={{ top: g.y, height: g.h }}
                  aria-hidden
                />
              ))}
              {layout.rows.map((box) => (
                <div
                  key={box.id}
                  className="absolute inset-x-0 border-b border-border"
                  style={{ top: box.y, height: box.h }}
                  aria-hidden
                />
              ))}
              {layout.bars.map((bar) => (
                <Bar
                  key={`${bar.id}-${bar.ghost ? 'g' : 'b'}`}
                  bar={bar}
                  delay={delayOf(bar, data.delays)}
                  selected={selectedId != null && bar.id === selectedId}
                  onHover={setHover}
                  onClick={click}
                />
              ))}
              {layout.markers.map((m) => {
                const Icon = MARKER_ICON[m.severity] ?? Info;
                const label = `${m.severity ?? 'Open'} anomaly: ${m.label ?? ''}`;
                const cls = cn(
                  'absolute z-[4] grid size-4 -translate-x-1/2 place-items-center rounded-full bg-surface shadow-card',
                  MARKER_TEXT[m.severity] ?? 'text-info',
                  m.severity === 'critical' && 'animate-pulse-ring',
                );
                const style = { left: m.x, top: m.y + 1 };
                return m.href ? (
                  <Link key={m.id} to={m.href} className={cls} style={style} aria-label={label} title={label}>
                    <Icon className="size-3" aria-hidden />
                  </Link>
                ) : (
                  <span key={m.id} className={cls} style={style} role="img" aria-label={label} title={label}>
                    <Icon className="size-3" aria-hidden />
                  </span>
                );
              })}
              {layout.nowX != null && (
                <div
                  className="pointer-events-none absolute inset-y-0 z-[5] w-0.5 -translate-x-1/2 bg-critical/80"
                  style={{ left: layout.nowX }}
                  aria-hidden
                />
              )}
              {hover && (
                <div
                  className={cn(
                    'pointer-events-none absolute z-30 w-64 rounded-lg border border-border bg-surface px-2.5 py-2 text-xs shadow-pop',
                    hover.y < 70 ? 'translate-y-1' : '-translate-y-full',
                  )}
                  style={{
                    left: Math.max(0, Math.min(width - 256, hover.x)),
                    top: hover.y < 70 ? hover.y + hover.h : hover.y - 4,
                  }}
                  aria-hidden
                >
                  <p className="font-semibold text-fg">
                    {[hover.code, hover.label].filter(Boolean).join(' · ') || KIND_LABEL[hover.kind]}
                  </p>
                  <p className="mt-0.5 text-muted tabular">
                    {formatDateTime(hover.start)} – {formatDateTime(hover.end)}
                  </p>
                  {hover.ghost && (
                    <p className="mt-1 flex items-center gap-1 text-ai">
                      <Sparkles className="size-3" /> Proposed
                      {hover.change ? ` · ${CHANGE_LABEL[hover.change] ?? hover.change}` : ''}
                    </p>
                  )}
                  {hover.from && (
                    <p className="text-subtle tabular">
                      Was {formatDateTime(hover.from.start)} – {formatDateTime(hover.from.end)}
                    </p>
                  )}
                  {hoverDelay && (
                    <p className={cn('tabular', hoverDelay.late ? 'text-critical' : 'text-muted')}>
                      {delayText(hoverDelay.hours)} later{hoverDelay.late ? ' · late for its plan' : ''}
                    </p>
                  )}
                  {hover.status && <p className="text-muted">{hover.status}</p>}
                  {hover.tooltip && <p className="mt-1 text-muted">{hover.tooltip}</p>}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
      {!compact && <Legend bars={data.bars ?? []} markers={layout.markers} />}
    </div>
  );
};
