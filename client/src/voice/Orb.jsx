import { useEffect, useRef, useState } from 'react';
import { cn } from '../lib/format.js';
import { voiceLevels } from './useVoice.js';

/** Calibration knob: RMS of normal speech sits around 0.02–0.2, so lift it before it drives the orb. */
export const LEVEL_GAIN = 1.6;
export const shownLevel = (level) => Math.min(1, Math.sqrt(Math.max(0, level || 0)) * LEVEL_GAIN);

const RING = {
  listening: 'ring-ai/70',
  thinking: 'ring-brand/70 animate-pulse [animation-duration:2.4s]',
  speaking: 'ring-ai',
  connecting: 'ring-border-strong animate-pulse',
  error: 'ring-critical',
};
const BARS = [0.45, 0.75, 1, 0.75, 0.45];
const STEPS = [0.35, 0.65, 1];

const reducedMotion = () =>
  typeof window !== 'undefined' && Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);

const levelFor = (phase) => {
  const { mic, sara } = voiceLevels();
  if (phase === 'speaking') return shownLevel(sara);
  if (phase === 'listening') return shownLevel(mic);
  return 0;
};

/**
 * SARA's orb: a brand → ai gradient that swells with the mic level while listening and SARA's level while
 * speaking (a CSS variable written in requestAnimationFrame, no re-render), with a five-bar level meter on the
 * large size. Reduced motion: no rAF and no scaling; the level shows as three ring-opacity steps.
 */
export const Orb = ({ phase = 'idle', size = 'sm', className }) => {
  const ref = useRef(null);
  const [still] = useState(reducedMotion);
  const lg = size === 'lg';

  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    if (still) {
      const tick = () => {
        const level = levelFor(phase);
        const step = STEPS.findIndex((s) => level <= s);
        el.style.setProperty('--orb-ring', String(STEPS[step < 0 ? 2 : step]));
      };
      tick();
      const timer = setInterval(tick, 250);
      return () => clearInterval(timer);
    }
    let frame = 0;
    let smooth = 0;
    const draw = () => {
      smooth += (levelFor(phase) - smooth) * 0.35;
      el.style.setProperty('--orb-level', smooth.toFixed(3));
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [phase, still]);

  return (
    <span
      ref={ref}
      aria-hidden
      data-motion={still ? 'reduced' : 'full'}
      className={cn(
        'relative inline-grid shrink-0 place-items-center rounded-full ring-2 ring-offset-2 ring-offset-surface',
        'bg-[linear-gradient(135deg,var(--brand),var(--ai))] shadow-card',
        lg ? 'size-16' : 'size-7',
        RING[phase] ?? 'ring-border',
        !still && 'transition-transform duration-75 scale-[calc(1+var(--orb-level,0)*0.18)]',
        className,
      )}
    >
      {still && (
        <span
          className="absolute -inset-1.5 rounded-full border-2 border-ai"
          style={{ opacity: 'var(--orb-ring, 0.35)' }}
        />
      )}
      {lg && (
        <span className="flex h-7 items-center gap-0.5">
          {BARS.map((w, i) => (
            <span
              key={i}
              className="w-0.75 rounded-full bg-white/90"
              style={{
                height: still
                  ? `calc(20% + var(--orb-ring, 0.35) * ${w * 60}%)`
                  : `calc(20% + var(--orb-level, 0) * ${w * 80}%)`,
              }}
            />
          ))}
        </span>
      )}
    </span>
  );
};
