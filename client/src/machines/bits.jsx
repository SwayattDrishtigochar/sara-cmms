import { Loader2, RefreshCw, WifiOff } from 'lucide-react';
import { useEffect, useState } from 'react';
import { cn, formatDuration } from '../lib/format.js';
import { useLiveStore } from '../live/liveStore.js';
import { StatusPill } from '../ui/core.jsx';

/** A react-router Link styled like a secondary Button (a button inside a link is invalid HTML). */
export const LINK_BUTTON =
  'inline-flex h-9 items-center gap-2 rounded-lg border border-border bg-surface px-3.5 text-sm font-medium whitespace-nowrap text-fg shadow-card transition-colors hover:bg-surface-2';

/** Current time, refreshed every `ms` so relative labels stay true. */
export const useNow = (ms = 30_000) => {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
};

/** "for 12 m" since a status change ("just now" in the first minute); nothing when unknown. */
export const SinceText = ({ since, className }) => {
  const now = useNow();
  if (!since) return null;
  const seconds = Math.max(0, (now - new Date(since).getTime()) / 1000);
  return (
    <span className={cn('text-xs text-muted tabular', className)}>
      {seconds < 60 ? 'just now' : `for ${formatDuration(seconds)}`}
    </span>
  );
};

export const StatusLine = ({ status, since, className }) => (
  <div className={cn('flex flex-wrap items-center gap-2', className)}>
    <StatusPill status={status} />
    <SinceText since={since} />
  </div>
);

const RING = 2 * Math.PI * 15;

/** AI health score ring (0–100); a dash until the AI has scored the machine. */
export const HealthRing = ({ score, size = 40 }) => {
  if (score == null) {
    return (
      <span
        className="grid shrink-0 place-items-center rounded-full border border-dashed border-border-strong text-xs text-subtle"
        style={{ width: size, height: size }}
        title="AI health: not scored yet"
      >
        <span aria-hidden>—</span>
        <span className="sr-only">AI health not scored yet</span>
      </span>
    );
  }
  const value = Math.round(Math.min(100, Math.max(0, score)));
  const tone = value >= 80 ? 'var(--running)' : value >= 50 ? 'var(--warn)' : 'var(--critical)';
  return (
    <span
      className="relative grid shrink-0 place-items-center"
      style={{ width: size, height: size }}
      role="img"
      aria-label={`AI health ${value} out of 100`}
      title={`AI health ${value} / 100`}
    >
      <svg viewBox="0 0 36 36" className="absolute inset-0 -rotate-90" aria-hidden>
        <circle cx="18" cy="18" r="15" fill="none" stroke={tone} strokeOpacity={0.18} strokeWidth="3" />
        <circle
          cx="18"
          cy="18"
          r="15"
          fill="none"
          stroke={tone}
          strokeWidth="3"
          strokeLinecap="round"
          strokeDasharray={`${(RING * value) / 100} ${RING}`}
        />
      </svg>
      <span className="text-xs font-semibold text-fg tabular">{value}</span>
    </span>
  );
};

const CONNECTION = {
  connecting: { icon: Loader2, text: 'Connecting…', spin: true },
  reconnecting: { icon: RefreshCw, text: 'Reconnecting…', spin: true },
  offline: { icon: WifiOff, text: 'Live updates paused' },
  idle: { icon: WifiOff, text: 'Live updates off' },
};

/** Live-stream state: a pulsing "Live" dot, or what is wrong with words. */
export const LiveBadge = ({ className }) => {
  const connection = useLiveStore((s) => s.connection);
  const state = CONNECTION[connection];
  return (
    <span
      className={cn('inline-flex items-center gap-1.5 text-xs font-medium text-muted', className)}
      role="status"
    >
      {state ? (
        <>
          <state.icon className={cn('size-3.5', state.spin && 'animate-spin')} aria-hidden />
          {state.text}
        </>
      ) : (
        <>
          <span className="relative flex size-2" aria-hidden>
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-running opacity-60" />
            <span className="relative inline-flex size-2 rounded-full bg-running" />
          </span>
          Live
        </>
      )}
    </span>
  );
};
