import { useId } from 'react';
import { cn } from '../lib/format.js';

const control =
  'rounded-lg border border-border bg-surface px-3 text-sm text-fg shadow-card placeholder:text-subtle transition-colors focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/20 disabled:cursor-not-allowed disabled:opacity-60 aria-[invalid=true]:border-critical aria-[invalid=true]:ring-critical/15';

/** Full width unless the caller sets a width class. */
const width = (className) => (/(^|\s)w-/.test(className ?? '') ? '' : 'w-full');

export const Input = ({ className, suffix, ...props }) =>
  suffix ? (
    <div className="relative">
      <input className={cn(control, 'h-9 w-full pr-12', className)} {...props} />
      <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-subtle">
        {suffix}
      </span>
    </div>
  ) : (
    <input className={cn(control, 'h-9', width(className), className)} {...props} />
  );

export const Textarea = ({ className, ...props }) => (
  <textarea
    className={cn(control, 'min-h-20 py-2 leading-relaxed', width(className), className)}
    {...props}
  />
);

export const Select = ({ className, children, ...props }) => (
  <select className={cn(control, 'h-9 cursor-pointer pr-8', width(className), className)} {...props}>
    {children}
  </select>
);

export const Switch = ({ checked, onChange, label, id, disabled }) => (
  <label htmlFor={id} className="inline-flex cursor-pointer items-center gap-2.5 text-sm text-fg">
    <span className="relative inline-flex">
      <input
        id={id}
        type="checkbox"
        role="switch"
        aria-checked={Boolean(checked)}
        className="peer sr-only"
        checked={Boolean(checked)}
        disabled={disabled}
        onChange={(e) => onChange?.(e.target.checked)}
      />
      <span className="h-5 w-9 rounded-full bg-surface-3 transition-colors peer-checked:bg-brand peer-focus-visible:ring-2 peer-focus-visible:ring-ring" />
      <span className="absolute left-0.5 top-0.5 size-4 rounded-full bg-white shadow transition-transform peer-checked:translate-x-4" />
    </span>
    {label}
  </label>
);

/** Label + control + help/error text, wired for screen readers. */
export const Field = ({ label, required, help, error, children, className }) => {
  const id = useId();
  const describedBy = error ? `${id}-error` : help ? `${id}-help` : undefined;
  return (
    <div className={cn('space-y-1.5', className)}>
      {label && (
        <label htmlFor={id} className="block text-xs font-medium text-muted">
          {label}
          {required && <span className="ml-0.5 text-critical">*</span>}
        </label>
      )}
      {typeof children === 'function'
        ? children({ id, 'aria-describedby': describedBy, 'aria-invalid': Boolean(error) })
        : children}
      {error ? (
        <p id={`${id}-error`} className="text-xs text-critical">
          {error}
        </p>
      ) : help ? (
        <p id={`${id}-help`} className="text-xs text-subtle">
          {help}
        </p>
      ) : null}
    </div>
  );
};
