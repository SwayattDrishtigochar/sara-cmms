import {
  CircleCheck,
  CircleDashed,
  CirclePause,
  CirclePlay,
  CircleStop,
  Loader2,
  Power,
  Sparkles,
  Wrench,
} from 'lucide-react';
import { cn, initials } from '../lib/format.js';

// ── Button ──────────────────────────────────────────────────────────────────

const BUTTON = {
  base: 'inline-flex items-center justify-center gap-2 rounded-lg font-medium whitespace-nowrap transition-colors duration-150 disabled:pointer-events-none disabled:opacity-50 select-none',
  variant: {
    primary: 'bg-brand text-brand-fg hover:bg-brand-strong shadow-card',
    secondary: 'bg-surface text-fg border border-border hover:bg-surface-2 shadow-card',
    ghost: 'text-muted hover:text-fg hover:bg-surface-2',
    danger: 'bg-critical text-brand-fg hover:opacity-90 shadow-card',
    ai: 'text-brand-fg shadow-card bg-[linear-gradient(135deg,var(--brand),var(--ai))] hover:opacity-95',
    soft: 'bg-brand-soft text-brand hover:bg-surface-3',
  },
  size: {
    sm: 'h-8 px-3 text-xs',
    md: 'h-9 px-3.5 text-sm',
    lg: 'h-11 px-5 text-sm',
    icon: 'h-9 w-9',
    iconSm: 'h-8 w-8',
  },
};

export const Button = ({
  variant = 'secondary',
  size = 'md',
  loading,
  className,
  children,
  icon: Icon,
  ...props
}) => (
  <button
    type="button"
    className={cn(BUTTON.base, BUTTON.variant[variant], BUTTON.size[size], className)}
    disabled={loading || props.disabled}
    {...props}
  >
    {loading ? (
      <Loader2 className="size-4 animate-spin" aria-hidden />
    ) : Icon ? (
      <Icon className="size-4" aria-hidden />
    ) : null}
    {children}
  </button>
);

// ── Card ────────────────────────────────────────────────────────────────────

export const Card = ({ className, ai, children, ...props }) => (
  <div
    className={cn('rounded-xl shadow-card', ai ? 'ai-edge' : 'border border-border bg-surface', className)}
    {...props}
  >
    {children}
  </div>
);

export const CardHeader = ({ title, subtitle, icon: Icon, actions, className }) => (
  <div className={cn('flex items-start justify-between gap-3 border-b border-border px-4 py-3', className)}>
    <div className="flex min-w-0 items-start gap-2.5">
      {Icon && <Icon className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />}
      <div className="min-w-0">
        <h3 className="truncate text-sm font-semibold text-fg">{title}</h3>
        {subtitle && <p className="mt-0.5 text-xs text-muted">{subtitle}</p>}
      </div>
    </div>
    {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
  </div>
);

// ── Badges & status ─────────────────────────────────────────────────────────

const TONES = {
  neutral: 'bg-surface-2 text-muted border-border',
  brand: 'bg-brand/10 text-brand border-brand/25',
  ai: 'bg-ai/10 text-ai border-ai/25',
  running: 'bg-running/10 text-running border-running/25',
  idle: 'bg-idle/10 text-idle border-idle/25',
  stopped: 'bg-stopped/10 text-stopped border-stopped/25',
  off: 'bg-off/10 text-off border-off/25',
  maint: 'bg-maint/10 text-maint border-maint/25',
  info: 'bg-info/10 text-info border-info/25',
  warn: 'bg-warn/10 text-warn border-warn/25',
  critical: 'bg-critical/10 text-critical border-critical/25',
  success: 'bg-success/10 text-success border-success/25',
};

/** Colour for well-known enum values (statuses, priorities, severities, roles). */
const VALUE_TONES = {
  running: 'running',
  on: 'running',
  idle: 'idle',
  stopped: 'stopped',
  off: 'off',
  maintenance: 'maint',
  open: 'info',
  'in progress': 'brand',
  'on hold': 'idle',
  completed: 'running',
  closed: 'off',
  're open': 'warn',
  pending: 'neutral',
  planned: 'info',
  close: 'off',
  high: 'critical',
  medium: 'warn',
  low: 'off',
  critical: 'critical',
  warning: 'warn',
  info: 'info',
  acknowledged: 'warn',
  resolved: 'running',
  false_positive: 'off',
  important: 'critical',
  'in service': 'running',
  'needs repair': 'warn',
  'out of service': 'stopped',
  owner: 'brand',
  admin: 'ai',
  technician: 'info',
  view: 'off',
  superadmin: 'critical',
  alert: 'critical',
  success: 'success',
  true: 'running',
  false: 'off',
};
export const toneFor = (value) => VALUE_TONES[String(value).toLowerCase()] ?? 'neutral';

export const Badge = ({ tone, value, children, className, dot }) => {
  const t = tone ?? toneFor(value ?? children);
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md border px-1.5 py-0.5 text-xs font-medium whitespace-nowrap',
        TONES[t] ?? TONES.neutral,
        className,
      )}
    >
      {dot && <span className="size-1.5 rounded-full bg-current" aria-hidden />}
      {children ?? value}
    </span>
  );
};

const STATUS_ICON = {
  Running: CirclePlay,
  ON: CirclePlay,
  Idle: CirclePause,
  Stopped: CircleStop,
  OFF: Power,
  Maintenance: Wrench,
  Completed: CircleCheck,
};

/** Machine status: colour + icon + label (never colour alone). */
export const StatusPill = ({ status, className }) => {
  const Icon = STATUS_ICON[status] ?? CircleDashed;
  return (
    <Badge value={status} className={className}>
      <Icon className="size-3.5" aria-hidden />
      {status ?? 'Unknown'}
    </Badge>
  );
};

// ── Misc ────────────────────────────────────────────────────────────────────

export const Spinner = ({ className }) => (
  <Loader2 className={cn('size-4 animate-spin text-muted', className)} aria-label="Loading" />
);

export const Skeleton = ({ className }) => <div className={cn('skeleton h-4', className)} aria-hidden />;

export const Avatar = ({ name, size = 'md', className }) => (
  <span
    className={cn(
      'inline-grid shrink-0 place-items-center rounded-full bg-brand-soft font-semibold text-brand',
      size === 'sm' ? 'size-6 text-[10px]' : 'size-8 text-xs',
      className,
    )}
    title={name}
    aria-hidden
  >
    {initials(name) || '?'}
  </span>
);

export const Kbd = ({ children }) => (
  <kbd className="rounded border border-border bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] text-muted">
    {children}
  </kbd>
);

export const EmptyState = ({ icon: Icon = Sparkles, title, children, action, className }) => (
  <div className={cn('flex flex-col items-center justify-center px-6 py-14 text-center', className)}>
    <div className="mb-4 grid size-12 place-items-center rounded-2xl bg-brand-soft text-brand">
      <Icon className="size-6" aria-hidden />
    </div>
    <h3 className="text-base font-semibold text-fg">{title}</h3>
    {children && <div className="mt-1.5 max-w-md text-sm text-muted">{children}</div>}
    {action && <div className="mt-5">{action}</div>}
  </div>
);

export const PageHeader = ({ icon: Icon, title, description, actions, children }) => (
  <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
    <div className="flex min-w-0 items-start gap-3">
      {Icon && (
        <div className="grid size-10 shrink-0 place-items-center rounded-xl border border-border bg-surface text-brand shadow-card">
          <Icon className="size-5" aria-hidden />
        </div>
      )}
      <div className="min-w-0">
        <h1 className="truncate text-xl font-semibold tracking-tight text-fg">{title}</h1>
        {description && <p className="mt-0.5 line-clamp-2 max-w-3xl text-sm text-muted">{description}</p>}
        {children}
      </div>
    </div>
    {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
  </div>
);

/** "Generated by <model> · 2 m ago" line for AI output. */
export const AiProvenance = ({ model, at, onRegenerate, className }) => (
  <div className={cn('flex items-center gap-1.5 text-[11px] text-subtle', className)}>
    <Sparkles className="size-3 text-ai" aria-hidden />
    <span>
      {model ? `Generated by ${model}` : 'AI generated'}
      {at ? ` · ${at}` : ''}
    </span>
    {onRegenerate && (
      <button type="button" onClick={onRegenerate} className="ml-1 font-medium text-ai hover:underline">
        Regenerate
      </button>
    )}
  </div>
);
