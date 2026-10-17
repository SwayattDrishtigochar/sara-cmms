import { CircleAlert, IndianRupee, Info, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { useSession } from '../auth/useAuth.js';
import { KpiBlock } from '../blocks/KpiBlock.jsx';
import { cn, formatMoney, formatNumber, getFormatPrefs } from '../lib/format.js';
import { Button, Card, PageHeader, Skeleton } from '../ui/core.jsx';
import { Field, Input } from '../ui/form.jsx';
import { askForAlert, CostAlertsList } from './CostAlertsList.jsx';
import { COMPONENT_LABELS, CostBreakdown, TopDrivers } from './CostBreakdown.jsx';
import { CostOverviewCard } from './CostOverviewCard.jsx';
import { useCostOverview, useCostSummary } from './useCosts.js';

export const PERIODS = [
  { id: 'day', label: 'Today', text: 'today' },
  { id: 'week', label: 'This week', text: 'this week' },
  { id: 'month', label: 'This month', text: 'this month' },
  { id: 'custom', label: 'Custom' },
];

/** Today as YYYY-MM-DD in the company time zone. */
const todayIso = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: getFormatPrefs().timeZone }).format(new Date());

const PeriodPicker = ({ value, onChange }) => (
  <fieldset className="inline-flex flex-wrap rounded-lg border border-border bg-surface p-0.5 shadow-card">
    <legend className="sr-only">Period</legend>
    {PERIODS.map((p) => (
      <button
        key={p.id}
        type="button"
        aria-pressed={value === p.id}
        onClick={() => onChange(p.id)}
        className={cn(
          'rounded-md px-3 py-1.5 text-sm font-medium whitespace-nowrap transition-colors',
          value === p.id ? 'bg-brand text-brand-fg' : 'text-muted hover:bg-surface-2 hover:text-fg',
        )}
      >
        {p.label}
      </button>
    ))}
  </fieldset>
);

/** "+12%" against the previous period cut to the same elapsed time; more cost reads as bad. */
const deltaOf = (now, before) => {
  if (now == null || !before) return {};
  const pct = ((now - before) / before) * 100;
  return {
    delta: `${pct > 0 ? '+' : ''}${formatNumber(pct, { digits: 1 })}%`,
    tone: pct > 0 ? 'bad' : 'good',
  };
};

const Totals = ({ query, previous }) => {
  if (query.isLoading) return <Skeleton className="mb-5 h-24 w-full rounded-xl" />;
  if (query.error) {
    return (
      <Card className="mb-5 flex flex-wrap items-center gap-3 px-4 py-4 text-sm text-muted">
        <CircleAlert className="size-4 text-critical" aria-hidden />
        <span>Couldn't load the costs: {query.error.message}</span>
        <Button size="sm" onClick={() => query.refetch()}>
          Retry
        </Button>
      </Card>
    );
  }
  const { totals = {}, notes = [] } = query.data ?? {};
  const item = (key, label) => ({
    label,
    value: formatMoney(totals[key]),
    ...deltaOf(totals[key], previous?.[key]),
  });
  return (
    <div className="mb-5 space-y-2">
      <KpiBlock
        title="Totals"
        items={[
          item('total', 'Total'),
          ...Object.entries(COMPONENT_LABELS).map(([k, label]) => item(k, label)),
        ]}
      />
      <p className="flex flex-wrap gap-x-4 px-1 text-xs text-subtle tabular">
        <span>{formatNumber(totals.kwh, { unit: 'kWh' })} energy</span>
        <span>{formatNumber(totals.downtimeHours, { unit: 'h' })} downtime</span>
        <span>{formatNumber(totals.labourHours, { unit: 'h' })} labour</span>
        {previous && <span>Changes compare with the same stretch of the previous period.</span>}
      </p>
      {notes.map((n) => (
        <p key={n} className="flex items-center gap-1.5 px-1 text-xs text-warn">
          <CircleAlert className="size-3.5 shrink-0" aria-hidden />
          {n}
        </p>
      ))}
    </div>
  );
};

/** Overview drivers merged with SARA's explanation per key; custom ranges rank the asset rows instead. */
const driversOf = (overview, assetRows) => {
  if (overview) {
    const ai = new Map((overview.ai?.drivers ?? []).map((d) => [d.key, d]));
    return (overview.topDrivers ?? []).map((d) => ({ ...d, ...ai.get(d.key) }));
  }
  return (assetRows ?? [])
    .filter((r) => r.total > 0)
    .slice(0, 5)
    .map((r) => ({
      key: r.key,
      label: r.label,
      amount: r.total,
      component: Object.keys(COMPONENT_LABELS).reduce((best, c) => ((r[c] ?? 0) > (r[best] ?? 0) ? c : best)),
    }));
};

/** /costs: SARA's overview, live totals, breakdowns, top drivers and cost alerts. */
export const CostsPage = () => {
  const ctx = useSession();
  const manager = ['owner', 'admin'].includes(ctx?.role);
  // `?period=week` (e.g. from the assistant's open_page tool) picks the starting preset.
  const [search] = useSearchParams();
  const [period, setPeriod] = useState(() =>
    PERIODS.some((p) => p.id === search.get('period')) ? search.get('period') : 'month',
  );
  const [custom, setCustom] = useState(() => {
    const today = todayIso();
    return { start: `${today.slice(0, 8)}01`, stop: today };
  });
  const preset = PERIODS.find((p) => p.id === period && p.text);
  const customError =
    !preset && (!custom.start || !custom.stop || custom.start > custom.stop)
      ? 'Pick a start on or before the end.'
      : null;
  const range = preset ? { text: preset.text } : customError ? null : custom;
  const params = (groupBy) => range && { ...range, groupBy };

  const asset = useCostSummary(params('asset'));
  const category = useCostSummary(params('category'));
  const day = useCostSummary(params('day'));
  const overview = useCostOverview(preset?.id ?? null);

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
      <PageHeader
        icon={IndianRupee}
        title="Costs"
        description="Energy, spare parts, consumables, labour and downtime, computed live and explained by SARA."
        actions={
          <Button variant="ai" icon={Sparkles} onClick={askForAlert}>
            Create an alert with SARA
          </Button>
        }
      />

      <div className="mb-5 flex flex-wrap items-end gap-3">
        <PeriodPicker value={period} onChange={setPeriod} />
        {!preset && (
          <div className="flex flex-wrap items-start gap-3">
            {[
              ['start', 'From'],
              ['stop', 'To'],
            ].map(([key, label]) => (
              <Field key={key} label={label} error={key === 'stop' ? customError : null} className="w-40">
                {(props) => (
                  <Input
                    {...props}
                    type="date"
                    value={custom[key]}
                    max={todayIso()}
                    onChange={(e) => setCustom((c) => ({ ...c, [key]: e.target.value }))}
                  />
                )}
              </Field>
            ))}
          </div>
        )}
      </div>

      {preset ? (
        <CostOverviewCard period={preset.id} canRefresh={manager} />
      ) : (
        <div className="ai-edge mb-5 flex gap-3 rounded-xl px-4 py-3 text-sm text-muted">
          <Info className="mt-0.5 size-4 shrink-0 text-ai" aria-hidden />
          <p>
            SARA's overview covers today, this week and this month. The numbers below are live for your dates.
          </p>
        </div>
      )}

      {range && (
        <>
          <Totals query={asset} previous={preset ? overview.data?.previous?.totals : null} />
          <CostBreakdown asset={asset} category={category} day={day} />
          <TopDrivers
            drivers={driversOf(preset ? overview.data : null, asset.data?.rows)}
            loading={preset ? overview.isLoading : asset.isLoading}
          />
        </>
      )}

      <CostAlertsList canCheck={manager} />
    </div>
  );
};
