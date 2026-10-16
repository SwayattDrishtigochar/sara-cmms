import { useQuery } from '@tanstack/react-query';
import { Check, ChevronsUpDown, X } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { api } from '../api/client.js';
import { cn, refLabel } from '../lib/format.js';

const idOf = (v) => (v && typeof v === 'object' ? String(v._id) : v ? String(v) : null);

/**
 * Searchable picker for a ref/refs field. `value` is an id, an id array, or populated objects;
 * `onChange` always receives ids. Labels for pre-populated values are remembered.
 */
export const RefSelect = ({
  refModule,
  value,
  onChange,
  multiple = false,
  placeholder = 'Search…',
  id,
  ...aria
}) => {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [active, setActive] = useState(0);
  const [labels, setLabels] = useState({});
  const box = useRef(null);
  const listId = useId();

  // Remember labels of populated initial values.
  useEffect(() => {
    const items = (multiple ? (value ?? []) : [value]).filter((v) => v && typeof v === 'object');
    if (items.length)
      setLabels((l) => ({ ...l, ...Object.fromEntries(items.map((v) => [String(v._id), refLabel(v)])) }));
  }, [value, multiple]);

  const selected = useMemo(
    () => (multiple ? (value ?? []).map(idOf) : value ? [idOf(value)] : []),
    [value, multiple],
  );

  const { data, isFetching } = useQuery({
    queryKey: ['ref-options', refModule, text],
    queryFn: ({ signal }) => api(`/m/${refModule}`, { query: { q: text || undefined, limit: 8 }, signal }),
    enabled: open,
    staleTime: 30_000,
  });
  const options = data?.items ?? [];

  useEffect(() => {
    if (!open) return;
    const close = (e) => !box.current?.contains(e.target) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const pick = (item) => {
    const itemId = String(item._id);
    setLabels((l) => ({ ...l, [itemId]: refLabel(item) }));
    if (multiple) {
      onChange(selected.includes(itemId) ? selected.filter((s) => s !== itemId) : [...selected, itemId]);
    } else {
      onChange(itemId);
      setOpen(false);
    }
    setText('');
  };

  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setActive((a) => Math.min(a + 1, options.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Enter' && open && options[active]) {
      e.preventDefault();
      pick(options[active]);
    } else if (e.key === 'Escape') setOpen(false);
  };

  const labelFor = (sid) => labels[sid] ?? `…${sid.slice(-6)}`;

  return (
    <div ref={box} className="relative">
      <div
        className={cn(
          'flex min-h-9 w-full flex-wrap items-center gap-1 rounded-lg border border-border bg-surface px-2 py-1 shadow-card focus-within:border-brand focus-within:ring-2 focus-within:ring-brand/20',
        )}
      >
        {multiple &&
          selected.map((sid) => (
            <span
              key={sid}
              className="inline-flex items-center gap-1 rounded-md bg-brand-soft px-1.5 py-0.5 text-xs font-medium text-brand"
            >
              {labelFor(sid)}
              <button
                type="button"
                onClick={() => onChange(selected.filter((s) => s !== sid))}
                aria-label={`Remove ${labelFor(sid)}`}
              >
                <X className="size-3" />
              </button>
            </span>
          ))}
        <input
          id={id}
          {...aria}
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && options[active] ? `${listId}-${active}` : undefined}
          className="h-7 min-w-24 flex-1 bg-transparent px-1 text-sm text-fg outline-none placeholder:text-subtle"
          placeholder={!multiple && selected[0] ? labelFor(selected[0]) : placeholder}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setOpen(true);
            setActive(0);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
        />
        {!multiple && selected[0] ? (
          <button
            type="button"
            className="p-1 text-subtle hover:text-fg"
            onClick={() => onChange(null)}
            aria-label="Clear"
          >
            <X className="size-3.5" />
          </button>
        ) : (
          <ChevronsUpDown className="size-3.5 text-subtle" aria-hidden />
        )}
      </div>
      {open && (
        <div
          id={listId}
          role="listbox"
          className="absolute z-40 mt-1 max-h-64 w-full overflow-y-auto rounded-xl border border-border bg-surface p-1 shadow-pop scrollbar-thin"
        >
          {options.length === 0 && (
            <p className="px-3 py-2 text-sm text-subtle">{isFetching ? 'Searching…' : 'No matches'}</p>
          )}
          {options.map((item, i) => {
            const sid = String(item._id);
            const isSel = selected.includes(sid);
            return (
              // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard selection is handled by the combobox input (aria-activedescendant)
              <div
                key={sid}
                id={`${listId}-${i}`}
                role="option"
                tabIndex={-1}
                aria-selected={isSel}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(item)}
                onMouseEnter={() => setActive(i)}
                className={cn(
                  'flex cursor-pointer items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-sm',
                  i === active ? 'bg-surface-2' : '',
                )}
              >
                <span className="truncate">{refLabel(item)}</span>
                {isSel && <Check className="size-4 shrink-0 text-brand" />}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
