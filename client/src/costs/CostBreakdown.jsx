import { ArrowDownRight, ArrowUpRight, CircleAlert, Lightbulb, Minus, Sparkles } from 'lucide-react';
import { ChartBlock } from '../blocks/ChartBlock.jsx';
import { cn, formatMoney, formatNumber } from '../lib/format.js';
import { Badge, Button, Card, CardHeader, Skeleton } from '../ui/core.jsx';

export const COMPONENT_LABELS = {
  energy: 'Energy',
  spares: 'Spare parts',
  consumables: 'Consumables',
  labour: 'Labour',
  downtime: 'Downtime',
};
const SERIES = Object.entries(COMPONENT_LABELS).map(([key, label]) => ({ key, label, unit: '₹' }));
const ASSET_MAX = 10;
const dayLabel = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });

/** The biggest `max - 1` rows, the rest summed into "Other" so the bar chart stays readable. */
export const foldRows = (rows, max = ASSET_MAX) => {
  if (rows.length <= max) return rows;
  const other = { key: 'other', label: 'Other' };
  for (const r of rows.slice(max - 1)) {
    for (const s of [...SERIES.map((x) => x.key), 'total']) other[s] = (other[s] ?? 0) + (r[s] ?? 0);
  }
  return [...rows.slice(0, max - 1), other];
};

/** Day keys ('2026-10-16', already in the company zone) as short category labels. */
const byDay = (rows) => rows.map((r) => ({ ...r, label: dayLabel.format(Date.parse(r.key)) }));

const ChartState = ({ query, title, children }) => {
  if (query.isLoading) return <Skeleton className="h-72 w-full rounded-xl" />;
  if (query.error) {
    return (
      <div className="flex h-72 flex-col items-center justify-center gap-3 rounded-xl border border-border bg-surface px-4 text-center text-sm text-muted">
        <CircleAlert className="size-5 text-critical" aria-hidden />
        <p>
          Couldn't load {title.toLowerCase()}: {query.error.message}
        </p>
        <Button size="sm" onClick={() => query.refetch()}>
          Retry
        </Button>
      </div>
    );
  }
  if (!query.data?.totals?.total) {
    return (
      <div className="flex h-72 items-center justify-center rounded-xl border border-border bg-surface px-4 text-center text-sm text-muted">
        No costs recorded in this period.
      </div>
    );
  }
  return children(query.data.rows ?? []);
};

/** Cost by asset (stacked by component), by category (donut) and by day (stacked), each with a table view. */
export const CostBreakdown = ({ asset, category, day }) => (
  <section aria-label="Cost breakdown" className="mb-5 grid gap-4 lg:grid-cols-2">
    <div className="lg:col-span-2">
      <ChartState query={asset} title="Cost by asset">
        {(rows) => (
          <ChartBlock
            title="Cost by asset"
            type="stackedBar"
            xKey="label"
            series={SERIES}
            data={foldRows(rows)}
          />
        )}
      </ChartState>
    </div>
    <ChartState query={category} title="Cost by category">
      {(rows) => (
        <ChartBlock
          title="Cost by category"
          type="pie"
          xKey="label"
          series={[{ key: 'total', label: 'Total', unit: '₹' }]}
          data={rows}
        />
      )}
    </ChartState>
    <ChartState query={day} title="Cost by day">
      {(rows) => (
        <ChartBlock title="Cost by day" type="stackedBar" xKey="label" series={SERIES} data={byDay(rows)} />
      )}
    </ChartState>
  </section>
);

const Delta = ({ pct }) => {
  if (pct == null) return <span className="text-xs text-subtle">No earlier data</span>;
  // Above +300% the earlier period barely had this cost: a four-digit % reads as noise.
  if (pct > 300) return <span className="text-xs text-subtle">Little earlier data</span>;
  const Icon = pct > 0 ? ArrowUpRight : pct < 0 ? ArrowDownRight : Minus;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 text-xs tabular',
        pct > 0 ? 'text-critical' : pct < 0 ? 'text-success' : 'text-muted',
      )}
    >
      <Icon className="size-3.5" aria-hidden />
      {`${pct > 0 ? '+' : ''}${formatNumber(pct, { digits: 1 })}% vs before`}
    </span>
  );
};

/**
 * The biggest cost drivers (deterministic, from the server) with SARA's explanation and action per driver
 * when the AI overview has one; the change shows when `deltaPct` is given (null = no earlier data). `drivers`: [{ key, label, component, amount, deltaPct, explanation?, action? }].
 */
export const TopDrivers = ({ drivers, loading }) => (
  <Card className="mb-5">
    <CardHeader
      icon={Lightbulb}
      title="Top cost drivers"
      subtitle={
        drivers.some((d) => d.explanation) ? 'Ranked by cost; explanations by SARA' : 'Ranked by cost'
      }
    />
    {loading ? (
      <div className="space-y-2 p-4">
        <Skeleton className="w-full" />
        <Skeleton className="w-4/5" />
      </div>
    ) : !drivers.length ? (
      <p className="px-4 py-6 text-center text-sm text-muted">No cost drivers in this period.</p>
    ) : (
      <ol className="divide-y divide-border">
        {drivers.map((d, i) => (
          <li key={d.key} className="px-4 py-3">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="w-5 text-xs text-subtle tabular">{i + 1}.</span>
              <span className="min-w-0 flex-1 basis-32 truncate text-sm font-medium text-fg">{d.label}</span>
              <Badge tone="neutral">
                mostly {(COMPONENT_LABELS[d.component] ?? d.component).toLowerCase()}
              </Badge>
              <span className="text-sm font-semibold text-fg tabular">{formatMoney(d.amount)}</span>
              {d.deltaPct !== undefined && <Delta pct={d.deltaPct} />}
            </div>
            {d.explanation && (
              <div className="ai-edge mt-2 ml-8 rounded-lg px-3 py-2 text-sm">
                <p className="flex gap-1.5 text-muted">
                  <Sparkles className="mt-0.5 size-3.5 shrink-0 text-ai" aria-hidden />
                  <span>{d.explanation}</span>
                </p>
                {d.action && (
                  <p className="mt-1 text-fg">
                    <span className="font-medium">Next step: </span>
                    {d.action}
                  </p>
                )}
              </div>
            )}
          </li>
        ))}
      </ol>
    )}
  </Card>
);
