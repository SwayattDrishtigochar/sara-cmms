import { X } from 'lucide-react';
import { Dialog as D, DropdownMenu as M, Tabs as T, Tooltip as TT } from 'radix-ui';
import { cn } from '../lib/format.js';

// ── Dialog ──────────────────────────────────────────────────────────────────

export const Dialog = ({ open, onOpenChange, title, description, children, footer, size = 'md' }) => (
  <D.Root open={open} onOpenChange={onOpenChange}>
    <D.Portal>
      <D.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-[2px] animate-fade-in" />
      <D.Content
        className={cn(
          'fixed left-1/2 top-1/2 z-50 w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-border bg-surface shadow-pop animate-fade-in focus:outline-none',
          { sm: 'max-w-sm', md: 'max-w-lg', lg: 'max-w-2xl', xl: 'max-w-4xl' }[size],
        )}
      >
        <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
          <div>
            <D.Title className="text-base font-semibold text-fg">{title}</D.Title>
            {description ? (
              <D.Description className="mt-1 text-sm text-muted">{description}</D.Description>
            ) : (
              <D.Description className="sr-only">{title}</D.Description>
            )}
          </div>
          <D.Close className="rounded-md p-1 text-muted hover:bg-surface-2 hover:text-fg" aria-label="Close">
            <X className="size-4" />
          </D.Close>
        </div>
        <div className="max-h-[70vh] overflow-y-auto px-5 py-4 scrollbar-thin">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-border px-5 py-3">{footer}</div>}
      </D.Content>
    </D.Portal>
  </D.Root>
);

/** Side panel (forms, the SARA assistant). */
export const Sheet = ({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  width = 'max-w-xl',
  side = 'right',
}) => (
  <D.Root open={open} onOpenChange={onOpenChange}>
    <D.Portal>
      <D.Overlay className="fixed inset-0 z-50 bg-black/30 animate-fade-in" />
      <D.Content
        className={cn(
          'fixed inset-y-0 z-50 flex w-full flex-col border-border bg-surface shadow-pop animate-slide-in focus:outline-none',
          side === 'right' ? 'right-0 border-l' : 'left-0 border-r',
          width,
        )}
      >
        <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
          <div className="min-w-0">
            <D.Title className="truncate text-base font-semibold text-fg">{title}</D.Title>
            {description ? (
              <D.Description className="mt-1 text-sm text-muted">{description}</D.Description>
            ) : (
              <D.Description className="sr-only">{title}</D.Description>
            )}
          </div>
          <D.Close className="rounded-md p-1 text-muted hover:bg-surface-2 hover:text-fg" aria-label="Close">
            <X className="size-4" />
          </D.Close>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 scrollbar-thin">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-border px-5 py-3">{footer}</div>}
      </D.Content>
    </D.Portal>
  </D.Root>
);

// ── Menu ────────────────────────────────────────────────────────────────────

export const Menu = ({ trigger, children, align = 'end' }) => (
  <M.Root>
    <M.Trigger asChild>{trigger}</M.Trigger>
    <M.Portal>
      <M.Content
        align={align}
        sideOffset={6}
        className="z-50 min-w-48 rounded-xl border border-border bg-surface p-1 shadow-pop animate-fade-in"
      >
        {children}
      </M.Content>
    </M.Portal>
  </M.Root>
);

export const MenuItem = ({ icon: Icon, children, danger, ...props }) => (
  <M.Item
    className={cn(
      'flex cursor-pointer select-none items-center gap-2 rounded-lg px-2.5 py-2 text-sm outline-none data-[highlighted]:bg-surface-2',
      danger ? 'text-critical' : 'text-fg',
    )}
    {...props}
  >
    {Icon && <Icon className="size-4 text-muted" aria-hidden />}
    {children}
  </M.Item>
);

export const MenuLabel = ({ children }) => (
  <M.Label className="px-2.5 py-1.5 text-xs text-subtle">{children}</M.Label>
);
export const MenuSeparator = () => <M.Separator className="my-1 h-px bg-border" />;

// ── Tabs ────────────────────────────────────────────────────────────────────

export const Tabs = ({ value, onValueChange, tabs, children, className }) => (
  <T.Root value={value} onValueChange={onValueChange} className={className}>
    <T.List className="mb-4 flex gap-1 overflow-x-auto border-b border-border" aria-label="Sections">
      {tabs.map((t) => (
        <T.Trigger
          key={t.value}
          value={t.value}
          className="-mb-px flex items-center gap-2 border-b-2 border-transparent px-3 py-2 text-sm font-medium whitespace-nowrap text-muted hover:text-fg data-[state=active]:border-brand data-[state=active]:text-fg"
        >
          {t.icon && <t.icon className="size-4" aria-hidden />}
          {t.label}
          {t.badge}
        </T.Trigger>
      ))}
    </T.List>
    {children}
  </T.Root>
);
export const TabPanel = T.Content;

// ── Tooltip ─────────────────────────────────────────────────────────────────

export const TooltipProvider = TT.Provider;
export const Tooltip = ({ content, children, side = 'top' }) =>
  content ? (
    <TT.Root delayDuration={250}>
      <TT.Trigger asChild>{children}</TT.Trigger>
      <TT.Portal>
        <TT.Content
          side={side}
          sideOffset={6}
          className="z-[60] max-w-xs rounded-lg bg-fg px-2.5 py-1.5 text-xs text-bg shadow-pop animate-fade-in"
        >
          {content}
        </TT.Content>
      </TT.Portal>
    </TT.Root>
  ) : (
    children
  );
