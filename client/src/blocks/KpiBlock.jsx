import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react';
import { cn, formatNumber } from '../lib/format.js';

const TONE = {
  good: 'text-success',
  success: 'text-success',
  bad: 'text-critical',
  critical: 'text-critical',
  warn: 'text-warn',
  warning: 'text-warn',
  neutral: 'text-muted',
};

/** Sign of a delta given as a number or a string like "+12%" / "-3 h". */
const signOf = (delta) => {
  const n = typeof delta === 'number' ? delta : Number.parseFloat(String(delta).replace(/[^\d.+-]/g, ''));
  return Number.isNaN(n) || n === 0 ? 0 : Math.sign(n);
};

const deltaText = (delta) =>
  typeof delta === 'number' ? `${delta > 0 ? '+' : ''}${formatNumber(delta)}` : String(delta);

const valueText = (item) =>
  typeof item.value === 'number'
    ? formatNumber(item.value, { unit: item.unit })
    : [item.value ?? '—', item.unit].filter(Boolean).join(' ');

/** `kpis` block: a row of stat tiles. Direction shows with an arrow; colour only when the tool sets a tone. */
export const KpiBlock = ({ title, items = [], className }) => (
  <section
    aria-label={title ?? 'Key figures'}
    className={cn('rounded-xl border border-border bg-surface p-3', className)}
  >
    {title && <h4 className="mb-2 text-sm font-semibold text-fg">{title}</h4>}
    <dl className="grid grid-cols-[repeat(auto-fit,minmax(8.5rem,1fr))] gap-px overflow-hidden rounded-lg border border-border bg-border">
      {items.map((item, i) => {
        const sign = item.delta == null ? null : signOf(item.delta);
        const Icon = sign > 0 ? ArrowUpRight : sign < 0 ? ArrowDownRight : Minus;
        return (
          <div key={`${item.label}-${i}`} className="min-w-0 bg-surface px-3 py-2.5">
            <dt className="truncate text-[11px] font-medium text-subtle" title={item.label}>
              {item.label}
            </dt>
            <dd
              className="mt-0.5 truncate text-xl font-semibold tracking-tight text-fg tabular"
              title={valueText(item)}
            >
              {valueText(item)}
            </dd>
            {item.delta != null && (
              <dd className={cn('mt-0.5 flex items-center gap-1 text-xs', TONE[item.tone] ?? TONE.neutral)}>
                <Icon className="size-3.5 shrink-0" aria-hidden />
                <span className="truncate">{deltaText(item.delta)}</span>
              </dd>
            )}
          </div>
        );
      })}
    </dl>
  </section>
);
