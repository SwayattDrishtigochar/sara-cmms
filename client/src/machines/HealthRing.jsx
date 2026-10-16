import { CircleCheck, CircleDashed, OctagonAlert, TriangleAlert } from 'lucide-react';
import { ScanProvenance } from '../anomalies/parts.jsx';
import { cn } from '../lib/format.js';
import { AiProvenance } from '../ui/core.jsx';

const RING = 2 * Math.PI * 15;

/** Health band of a 0–100 score: colour, icon and word, so the state never rides on colour alone. */
export const healthBand = (score) => {
  if (score == null) return { label: 'Not scored', color: 'var(--border-strong)', icon: CircleDashed };
  if (score >= 80) return { label: 'Good', color: 'var(--running)', icon: CircleCheck };
  if (score >= 50) return { label: 'Watch', color: 'var(--warn)', icon: TriangleAlert };
  return { label: 'Poor', color: 'var(--critical)', icon: OctagonAlert };
};

/**
 * AI health score ring (0–100); a dashed ring until the AI has scored the machine. `label` adds the band
 * word beside it, with the AI's `summary`, the time (`at`) and `model` it came from; `rescan` adds Re-scan.
 */
export const HealthRing = ({ score, size = 40, label, summary, at, model, rescan, className }) => {
  const value = score == null ? null : Math.round(Math.min(100, Math.max(0, score)));
  const band = healthBand(value);
  const text =
    value == null ? 'AI health not scored yet' : `AI health ${value} out of 100, ${band.label.toLowerCase()}`;
  const ring = (
    <span
      className="relative grid shrink-0 place-items-center"
      style={{ width: size, height: size }}
      role="img"
      aria-label={text}
      title={text}
    >
      <svg viewBox="0 0 36 36" className="absolute inset-0 -rotate-90" aria-hidden>
        <circle
          cx="18"
          cy="18"
          r="15"
          fill="none"
          stroke={band.color}
          strokeOpacity={value == null ? 0.7 : 0.18}
          strokeWidth="3"
          strokeDasharray={value == null ? '2 3' : undefined}
        />
        {value != null && (
          <circle
            cx="18"
            cy="18"
            r="15"
            fill="none"
            stroke={band.color}
            strokeWidth="3"
            strokeLinecap="round"
            strokeDasharray={`${(RING * value) / 100} ${RING}`}
          />
        )}
      </svg>
      <span className={cn('font-semibold text-fg tabular', size >= 48 ? 'text-base' : 'text-xs')}>
        {value ?? '—'}
      </span>
    </span>
  );
  if (!label) return ring;
  return (
    <div className={cn('flex items-center gap-3', className)}>
      {ring}
      <div className="min-w-0">
        <p className="flex items-center gap-1.5 text-sm font-semibold text-fg">
          <band.icon className="size-4 shrink-0" style={{ color: band.color }} aria-hidden />
          {value == null ? 'Not scored yet' : band.label}
        </p>
        <p className="mt-0.5 line-clamp-2 text-xs text-muted">
          {summary ||
            (value == null
              ? 'A health score appears after the first AI scan of this machine.'
              : 'No summary for the latest score.')}
        </p>
        {at &&
          (rescan ? (
            <ScanProvenance model={model} at={at} className="mt-1" />
          ) : (
            <AiProvenance model={model} at={at} className="mt-1" />
          ))}
      </div>
    </div>
  );
};
