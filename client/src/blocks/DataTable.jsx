import { ArrowDown, ArrowUp, ArrowUpDown, Download, Table2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import {
  cn,
  downloadText,
  formatDateTime,
  formatNumber,
  humanize,
  refLabel,
  slugify,
  toDelimited,
} from '../lib/format.js';
import { CopyButton } from '../superadmin/parts.jsx';
import { Button } from '../ui/core.jsx';

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const isDateLike = (v) => typeof v === 'string' && ISO.test(v) && !Number.isNaN(Date.parse(v));

/** Display text of one cell: numbers with the column unit, dates in the company zone, refs by label. */
export const cellText = (value, col) => {
  if (value == null || value === '') return '—';
  if (typeof value === 'number') return formatNumber(value, { unit: col?.unit });
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (isDateLike(value)) return formatDateTime(value);
  if (Array.isArray(value)) return value.map((v) => cellText(v)).join(', ');
  if (typeof value === 'object') return refLabel(value);
  return String(value);
};

/** Raw value for CSV and copy: numbers and dates untouched, refs by label. */
const rawCell = (value) => {
  if (value == null) return '';
  if (Array.isArray(value)) return value.map(rawCell).join('; ');
  if (typeof value === 'object') return refLabel(value);
  return value;
};

const sortKey = (v) => (v != null && typeof v === 'object' ? refLabel(v) : v);
const compare = (a, b) => {
  if (a == null || a === '') return b == null || b === '' ? 0 : 1;
  if (b == null || b === '') return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b), 'en', { numeric: true });
};

/** Columns from the block, or from the first row when the tool sent rows only. */
export const columnsOf = (columns, rows) =>
  columns?.length
    ? columns
    : Object.keys(rows[0] ?? {})
        .filter((k) => k !== '_id' && k !== '__v')
        .map((key) => ({ key, label: humanize(key) }));

/**
 * `table` block: sortable columns (click a header), sticky header in a scrolling body, copy as TSV and
 * download as CSV built from the rows shown.
 */
export const DataTable = ({ title, columns, rows = [], className }) => {
  const cols = useMemo(() => columnsOf(columns, rows), [columns, rows]);
  const [sort, setSort] = useState(null); // { key, dir: 'asc' | 'desc' }
  const sorted = useMemo(() => {
    if (!sort) return rows;
    const sign = sort.dir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => sign * compare(sortKey(a[sort.key]), sortKey(b[sort.key])));
  }, [rows, sort]);
  const numeric = useMemo(
    () => new Set(cols.filter((c) => rows.some((r) => typeof r[c.key] === 'number')).map((c) => c.key)),
    [cols, rows],
  );
  const toggle = (key) =>
    setSort((s) => (s?.key !== key ? { key, dir: 'asc' } : s.dir === 'asc' ? { key, dir: 'desc' } : null));

  const grid = () => [
    cols.map((c) => c.label ?? c.key),
    ...sorted.map((r) => cols.map((c) => rawCell(r[c.key]))),
  ];
  const name = title ?? 'Table';
  return (
    <figure className={cn('overflow-hidden rounded-xl border border-border bg-surface', className)}>
      <figcaption className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <span className="flex min-w-0 items-center gap-2 text-sm font-semibold text-fg">
          <Table2 className="size-4 shrink-0 text-muted" aria-hidden />
          <span className="truncate">{name}</span>
          <span className="shrink-0 text-xs font-normal text-subtle tabular">
            {rows.length} {rows.length === 1 ? 'row' : 'rows'}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-0.5">
          <CopyButton text={toDelimited(grid(), '\t')} label="Copy table" iconOnly variant="ghost" />
          <Button
            size="iconSm"
            variant="ghost"
            icon={Download}
            aria-label="Download CSV"
            title="Download CSV"
            onClick={() => downloadText(`${slugify(name)}.csv`, toDelimited(grid()))}
          />
        </span>
      </figcaption>
      <div className="max-h-96 overflow-auto scrollbar-thin">
        <table className="w-full text-sm">
          <thead className="sticky top-0 z-10 bg-surface-2 text-xs text-muted shadow-[0_1px_0_var(--border)]">
            <tr>
              {cols.map((c) => {
                const active = sort?.key === c.key;
                const Icon = active ? (sort.dir === 'asc' ? ArrowUp : ArrowDown) : ArrowUpDown;
                return (
                  <th
                    key={c.key}
                    scope="col"
                    aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
                    className={cn('px-1 py-1 font-medium', numeric.has(c.key) && 'text-right')}
                  >
                    <button
                      type="button"
                      onClick={() => toggle(c.key)}
                      className={cn(
                        'group inline-flex max-w-full items-center gap-1 rounded px-2 py-0.5 whitespace-nowrap hover:bg-surface-3 hover:text-fg',
                        active && 'text-fg',
                      )}
                    >
                      <span className="truncate">{c.label ?? c.key}</span>
                      {c.unit && <span className="text-subtle">({c.unit})</span>}
                      <Icon
                        className={cn(
                          'size-3 shrink-0',
                          active ? 'text-brand' : 'opacity-0 group-hover:opacity-60',
                        )}
                        aria-hidden
                      />
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {sorted.map((row, i) => (
              <tr key={row._id ?? i} className="hover:bg-surface-2/60">
                {cols.map((c) => (
                  <td
                    key={c.key}
                    className={cn(
                      'px-3 py-1.5 align-top',
                      numeric.has(c.key) && 'text-right tabular whitespace-nowrap',
                    )}
                  >
                    {cellText(row[c.key], c)}
                  </td>
                ))}
              </tr>
            ))}
            {!rows.length && (
              <tr>
                <td colSpan={cols.length || 1} className="px-3 py-6 text-center text-muted">
                  No rows.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </figure>
  );
};
