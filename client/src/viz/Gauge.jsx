import { formatNumber } from '../lib/format.js';
import { toneColor } from './vizData.js';

const R = 80;
const C = { x: 100, y: 100 };
const clamp01 = (f) => Math.min(1, Math.max(0, f));
/** Point on the half circle at fraction f (0 = left end, 1 = right end). */
const at = (f, r = R) => {
  const a = Math.PI * (1 - f);
  return [C.x + r * Math.cos(a), C.y - r * Math.sin(a)];
};
const arc = (f0, f1) => {
  const [x0, y0] = at(f0);
  const [x1, y1] = at(f1);
  return `M${x0.toFixed(2)},${y0.toFixed(2)}A${R},${R} 0 0 1 ${x1.toFixed(2)},${y1.toFixed(2)}`;
};

/**
 * Half-circle gauge: grey track, value arc in the tone colour, ticks at warn / critical / target. Purely
 * presentational (aria-hidden); Viz carries the accessible summary and the tone label.
 */
export const Gauge = ({ value, min = 0, max, unit, target, thresholds, tone }) => {
  const top = max ?? Math.max(100, value ?? 0);
  const frac = (v) => clamp01((v - min) / (top - min || 1));
  const marks = [
    thresholds?.warn != null && { v: thresholds.warn, color: 'var(--warn)' },
    thresholds?.critical != null && { v: thresholds.critical, color: 'var(--critical)' },
    target != null && { v: target, color: 'var(--fg)' },
  ].filter(Boolean);
  const fmt = (v) => formatNumber(v, { unit: unit === '%' ? '%' : undefined });
  return (
    <svg viewBox="0 0 200 124" className="mx-auto block w-full max-w-64" aria-hidden>
      <path d={arc(0, 1)} fill="none" stroke="var(--surface-3)" strokeWidth={14} />
      {value != null && (
        <path
          d={arc(0, Math.max(0.005, frac(value)))}
          fill="none"
          stroke={toneColor(tone)}
          strokeWidth={14}
          strokeLinecap="round"
        />
      )}
      {marks.map((m) => {
        const [x0, y0] = at(frac(m.v), R - 11);
        const [x1, y1] = at(frac(m.v), R + 11);
        return <line key={m.color} x1={x0} y1={y0} x2={x1} y2={y1} stroke={m.color} strokeWidth={2.5} />;
      })}
      <text
        x={C.x}
        y={C.y - 12}
        textAnchor="middle"
        fill="var(--fg)"
        fontSize={28}
        fontWeight={600}
        className="tabular"
      >
        {fmt(value)}
      </text>
      {unit && unit !== '%' && (
        <text x={C.x} y={C.y + 6} textAnchor="middle" fill="var(--muted)" fontSize={11}>
          {unit}
        </text>
      )}
      <text x={C.x - R} y={C.y + 20} textAnchor="middle" fill="var(--subtle)" fontSize={10}>
        {fmt(min)}
      </text>
      <text x={C.x + R} y={C.y + 20} textAnchor="middle" fill="var(--subtle)" fontSize={10}>
        {fmt(top)}
      </text>
    </svg>
  );
};
