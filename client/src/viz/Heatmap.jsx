import { useMemo, useState } from 'react';
import { cn, formatNumber } from '../lib/format.js';
import { heatOpacity } from './vizData.js';

const fill = (o) =>
  o ? `color-mix(in oklab, var(--series-1) ${Math.round(o * 100)}%, var(--surface))` : 'var(--surface-2)';

/**
 * Hour × day heatmap: columns = `xLabels` (hours), rows = `yLabels` (days), one sequential hue (darker =
 * more). Every cell carries a title; hovering names the cell under the grid. Viz adds the aria summary.
 */
export const Heatmap = ({ xLabels = [], yLabels = [], cells = [], cellMin, cellMax, unit, compact }) => {
  const [hover, setHover] = useState(null);
  const byKey = useMemo(() => new Map(cells.map((c) => [`${c.y}|${c.x}`, c.value])), [cells]);
  const values = cells.map((c) => c.value).filter((v) => v != null);
  const lo = cellMin ?? Math.min(...values);
  const hi = cellMax ?? Math.max(...values);
  // A column is ~1 character wide on a card: label every 6th hour as "06h" and let it run over its neighbours.
  const every = xLabels.length > 12 ? 6 : 1;
  const fmt = (v) => formatNumber(v, { unit: unit || undefined });
  const h = compact ? 'h-3.5' : 'h-5';
  return (
    <div onPointerLeave={() => setHover(null)}>
      <div
        className="grid gap-0.5 text-[10px] text-subtle tabular"
        style={{ gridTemplateColumns: `auto repeat(${xLabels.length}, minmax(0, 1fr))` }}
      >
        <span />
        {xLabels.map((x, i) => (
          <span key={x} className="whitespace-nowrap" aria-hidden>
            {i % every === 0 ? String(x).replace(/^(\d{2}):00$/, '$1h') : ''}
          </span>
        ))}
        {yLabels.map((y) => [
          <span key={`${y}-label`} className="truncate pr-1.5 leading-5 whitespace-nowrap">
            {y}
          </span>,
          ...xLabels.map((x) => {
            const v = byKey.get(`${y}|${x}`);
            const text = `${y} · ${x}: ${fmt(v)}`;
            return (
              <span
                key={`${y}|${x}`}
                title={text}
                onPointerEnter={() => setHover(text)}
                className={cn('rounded-[3px]', h, hover === text && 'outline-2 outline-fg')}
                style={{ background: fill(heatOpacity(v, lo, hi)) }}
              />
            );
          }),
        ])}
      </div>
      {!compact && (
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted">
          <span className="min-h-4 tabular">{hover ?? 'Hover a cell for its value'}</span>
          <span className="flex items-center gap-1.5 tabular" aria-hidden>
            {fmt(lo)}
            <span
              className="h-2.5 w-20 rounded-sm"
              style={{ background: `linear-gradient(90deg, ${fill(0.1)}, ${fill(1)})` }}
            />
            {fmt(hi)}
          </span>
        </div>
      )}
    </div>
  );
};
