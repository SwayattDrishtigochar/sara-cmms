import { Check, Copy, RefreshCw } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { toast } from 'sonner';
import { cn } from '../lib/format.js';
import { Button } from '../ui/core.jsx';
import { copyText } from './simUtils.js';

/** Re-renders every `ms` so relative times ("last seen 3 s ago") stay true between polls. */
export const useNow = (ms = 1000) => {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
};

export const Section = ({ id, icon: Icon, title, description, actions, children }) => (
  <section aria-labelledby={id} className="space-y-3">
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h2 id={id} className="flex items-center gap-2 text-base font-semibold tracking-tight text-fg">
          <Icon className="size-4 text-brand" aria-hidden />
          {title}
        </h2>
        {description && <p className="mt-0.5 max-w-3xl text-sm text-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
    {children}
  </section>
);

const CALLOUT = {
  warn: 'border-warn/30 bg-warn/10 [&>svg]:text-warn',
  info: 'border-info/30 bg-info/10 [&>svg]:text-info',
  success: 'border-success/30 bg-success/10 [&>svg]:text-success',
  critical: 'border-critical/30 bg-critical/10 [&>svg]:text-critical',
};

/** Inline notice: icon + text, so meaning never rides on colour alone. */
export const Callout = ({ tone = 'info', icon: Icon, children, className }) => (
  <div className={cn('flex gap-2.5 rounded-lg border px-3 py-2.5 text-sm text-fg', CALLOUT[tone], className)}>
    <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
    <div className="min-w-0">{children}</div>
  </div>
);

/** One figure in a stats grid (`<dl>`). */
export const Stat = ({ label, children }) => (
  <div className="min-w-0 bg-surface px-3 py-2">
    <dt className="truncate text-[11px] font-medium text-subtle">{label}</dt>
    <dd className="mt-0.5 truncate text-sm font-semibold text-fg tabular">{children}</dd>
  </div>
);

/** Radio buttons that look like a segmented control; arrow keys move between options. */
export const Segmented = ({ legend, help, options, value, onChange, className }) => {
  const name = useId();
  return (
    <fieldset className={className}>
      <legend className="mb-1.5 text-xs font-medium text-muted">{legend}</legend>
      <div className="inline-flex max-w-full flex-wrap rounded-lg border border-border bg-surface-2 p-0.5">
        {options.map((o) => (
          <label
            key={o.value}
            className={cn(
              'cursor-pointer rounded-md px-3 py-1.5 text-sm font-medium transition-colors has-focus-visible:ring-2 has-focus-visible:ring-ring',
              value === o.value ? 'bg-surface text-fg shadow-card' : 'text-muted hover:text-fg',
            )}
          >
            <input
              type="radio"
              name={name}
              value={o.value}
              checked={value === o.value}
              onChange={() => onChange(o.value)}
              className="sr-only"
            />
            {o.label}
          </label>
        ))}
      </div>
      {help && <p className="mt-1.5 text-xs text-subtle">{help}</p>}
    </fieldset>
  );
};

export const CopyButton = ({ text, label = 'Copy', iconOnly, variant = 'secondary' }) => {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(timer);
  }, [copied]);
  const copy = async () => {
    try {
      await copyText(text);
      setCopied(true);
    } catch {
      toast.error("Couldn't copy", { description: 'Select the text and copy it by hand.' });
    }
  };
  return (
    <>
      <Button
        size={iconOnly ? 'iconSm' : 'sm'}
        variant={variant}
        icon={copied ? Check : Copy}
        onClick={copy}
        aria-label={iconOnly ? label : undefined}
        title={iconOnly ? label : undefined}
      >
        {iconOnly ? null : copied ? 'Copied' : label}
      </Button>
      <span className="sr-only" aria-live="polite">
        {copied ? 'Copied to the clipboard' : ''}
      </span>
    </>
  );
};

const BAR = {
  brand: '[&::-webkit-progress-value]:bg-brand [&::-moz-progress-bar]:bg-brand',
  warn: '[&::-webkit-progress-value]:bg-warn [&::-moz-progress-bar]:bg-warn',
  off: '[&::-webkit-progress-value]:bg-off [&::-moz-progress-bar]:bg-off',
};

/** Native <progress> (0–1 in), styled as a thin bar. */
export const ProgressBar = ({ value, label, tone = 'brand' }) => (
  <progress
    value={Math.round(Math.min(1, Math.max(0, value ?? 0)) * 100)}
    max={100}
    aria-label={label}
    className={cn(
      'block h-1.5 w-full appearance-none overflow-hidden rounded-full border-0 bg-surface-3',
      '[&::-webkit-progress-bar]:bg-surface-3 [&::-webkit-progress-value]:rounded-full [&::-webkit-progress-value]:transition-[width] [&::-webkit-progress-value]:duration-500 [&::-moz-progress-bar]:rounded-full',
      BAR[tone],
    )}
  />
);

/** Something that failed to load, with a retry. */
export const QueryError = ({ what, error, onRetry }) => (
  <div className="flex flex-col items-center gap-3 px-6 py-10 text-center">
    <p className="text-sm text-fg">
      Couldn't load {what}. <span className="text-muted">{error?.message}</span>
    </p>
    <Button size="sm" icon={RefreshCw} onClick={onRetry}>
      Try again
    </Button>
  </div>
);
