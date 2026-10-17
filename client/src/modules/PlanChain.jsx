import { ArrowRight, CalendarCheck, ClipboardCheck, Sparkles } from 'lucide-react';
import { useMemo } from 'react';
import { Link } from 'react-router';
import { cn, formatDateTime, formatMoney, formatNumber, formatRelative, refLabel } from '../lib/format.js';
import { Gantt } from '../planner/Gantt.jsx';
import { AiProvenance, Badge, Card, CardHeader, EmptyState, Skeleton } from '../ui/core.jsx';
import { AddChild } from './RelatedRecords.jsx';
import { useRelated, useRelatedCounts } from './useRelated.js';

const VERDICT = {
  doable: { label: 'Doable', tone: 'success' },
  adjust: { label: 'Needs adjustment', tone: 'warn' },
  not_doable: { label: 'Not doable', tone: 'critical' },
};
const HOUR = 36e5;
const idOf = (v) => (v && typeof v === 'object' ? String(v._id) : v ? String(v) : null);
const nameOf = (v) => (v && typeof v === 'object' ? refLabel(v) : null);
const partsOut = (jc) => jc.operations?.[0]?.progress?.partsOut ?? 0;

/** "Add <child>" for a plan's own child relation (Related hides that tab, see EXTRA_CHILDREN). */
const AddToPlan = ({ parent, record, module }) => {
  const { data } = useRelatedCounts(parent, record._id);
  const child = data?.children?.find((c) => c.module === module);
  return child ? <AddChild record={record} child={child} /> : null;
};

/** Gantt rows (one per machine, in first-use order) and the time range padded by 5 %. */
const ganttData = (bars, machines) => {
  const times = bars.flatMap((b) => [Date.parse(b.start), Date.parse(b.end)]).filter(Number.isFinite);
  if (!times.length) return null;
  const min = Math.min(...times);
  const max = Math.max(...times);
  const pad = Math.max(HOUR, (max - min) * 0.05);
  return {
    range: { start: min - pad, end: max + pad },
    rows: [...machines.values()].map((m) => ({ id: m.id, label: m.label })),
    bars,
  };
};

/** Cards grouped per machine, ordered by start inside each chain. */
export const chainsOf = (items, assetOf) => {
  const chains = new Map();
  for (const item of [...items].sort((a, b) => Date.parse(a.start) - Date.parse(b.start))) {
    const asset = assetOf(item);
    const id = idOf(asset) ?? 'none';
    if (!chains.has(id)) chains.set(id, { id, label: nameOf(asset) ?? 'Unassigned', items: [] });
    chains.get(id).items.push(item);
  }
  return chains;
};

const AiSummary = ({ summary }) =>
  summary?.text ? (
    <div className="ai-edge rounded-xl p-3">
      <p className="flex items-center gap-1.5 text-xs font-medium text-ai">
        <Sparkles className="size-3.5" aria-hidden /> SARA says
      </p>
      <p className="mt-1 whitespace-pre-wrap text-sm text-fg">{summary.text}</p>
      <AiProvenance
        model={summary.mock ? `${summary.model} (mock)` : summary.model}
        at={formatRelative(summary.at)}
        className="mt-2"
      />
    </div>
  ) : null;

const Stat = ({ label, value, hint }) => (
  <div className="min-w-0 rounded-lg border border-border bg-surface-2/50 px-3 py-2">
    <p className="text-[11px] text-subtle">{label}</p>
    <p className="text-sm font-semibold text-fg tabular">{value}</p>
    {hint && <p className="text-[11px] text-muted">{hint}</p>}
  </div>
);

const Chip = ({ href, code, title, status, children }) => (
  <li className="flex min-w-0 items-center gap-1.5">
    <Link
      to={href}
      className="block min-w-0 rounded-lg border border-border bg-surface px-2.5 py-1.5 shadow-card hover:border-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
    >
      <span className="flex items-center gap-2">
        <span className="font-mono text-xs font-semibold text-fg">{code}</span>
        {status && <Badge value={status} className="px-1 py-0 text-[10px]" />}
      </span>
      {title && <span className="block truncate text-xs text-muted">{title}</span>}
      <span className="mt-0.5 block text-[11px] text-subtle tabular">{children}</span>
    </Link>
  </li>
);

const Arrow = () => <ArrowRight className="size-4 shrink-0 text-subtle" aria-hidden />;

/** The chains of a plan: one row per machine, items attached in start order with arrows. */
const Chains = ({ chains, children: renderChip }) => (
  <div className="space-y-3">
    {[...chains.values()].map((chain) => (
      <div key={chain.id}>
        <p className="mb-1.5 text-xs font-medium text-muted">{chain.label}</p>
        <ol
          aria-label={`Chain on ${chain.label}`}
          className="flex flex-wrap items-center gap-1.5 [&>li:not(:last-child)]:after:content-none"
        >
          {chain.items.flatMap((item, i) => [
            i > 0 && (
              <li key={`arrow-${item._id}`} aria-hidden className="flex items-center">
                <Arrow />
              </li>
            ),
            renderChip(item),
          ])}
        </ol>
      </div>
    ))}
  </div>
);

/** Job cards of a production plan: compact Gantt, the chain per machine, totals and SARA's summary. */
export const ProductionPlanChain = ({ record }) => {
  const { data, isLoading } = useRelated('productionplans', record._id, 'jobcards', {
    limit: 100,
    sort: 'startDate',
  });
  const items = data?.items ?? [];
  const chains = useMemo(
    () =>
      chainsOf(
        items.map((jc) => ({ ...jc, start: jc.startDate })),
        (jc) => jc.asset,
      ),
    [items],
  );
  const gantt = useMemo(
    () =>
      ganttData(
        items
          .filter((jc) => jc.startDate && jc.endDate)
          .map((jc) => ({
            id: jc._id,
            code: jc.jobCardId,
            rowId: idOf(jc.asset) ?? 'none',
            start: jc.startDate,
            end: jc.endDate,
            label: jc.jobName,
            kind: 'jobcard',
            status: jc.jobStatus,
            href: `/m/jobcards/${jc._id}`,
            progress: jc.target ? Math.min(1, partsOut(jc) / jc.target) : undefined,
            tooltip: (jc.assignedTo ?? []).map(nameOf).filter(Boolean).join(', ') || undefined,
          })),
        chains,
      ),
    [items, chains],
  );
  const verdict = VERDICT[record.feasibility?.verdict];
  const planned = items.reduce((s, jc) => s + (jc.target ?? 0), 0);
  const made = items.reduce((s, jc) => s + partsOut(jc), 0);

  return (
    <Card>
      <CardHeader
        title="Job cards"
        icon={ClipboardCheck}
        subtitle={items.length ? `${items.length} job cards on ${chains.size} machines` : undefined}
        actions={
          <>
            {verdict && <Badge tone={verdict.tone}>{verdict.label}</Badge>}
            <AddToPlan parent="productionplans" record={record} module="jobcards" />
          </>
        }
      />
      <div className="space-y-4 p-4">
        {isLoading && <Skeleton className="h-24 w-full" />}
        {!isLoading && !items.length && (
          <EmptyState icon={ClipboardCheck} title="No job cards yet" className="py-8">
            <Link to="/planner?tab=production" className="font-medium text-brand hover:underline">
              Plan it in the Planner
            </Link>
          </EmptyState>
        )}
        {items.length > 0 && (
          <>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Stat
                label="Planned"
                value={`${formatNumber(planned)} of ${formatNumber(record.quantity)} pcs`}
                hint={
                  planned < (record.quantity ?? 0)
                    ? `${formatNumber(record.quantity - planned)} short`
                    : undefined
                }
              />
              <Stat label="Produced" value={`${formatNumber(made)} pcs`} />
              <Stat label="First start" value={formatDateTime(chainFirst(items))} />
              <Stat label="Last end" value={formatDateTime(chainLast(items))} />
            </div>
            {gantt && <Gantt data={gantt} compact />}
            <Chains chains={chains}>
              {(jc) => (
                <Chip
                  key={jc._id}
                  href={`/m/jobcards/${jc._id}`}
                  code={jc.jobCardId}
                  title={jc.jobName}
                  status={jc.jobStatus}
                >
                  {formatDateTime(jc.startDate)} → {formatDateTime(jc.endDate)} · {formatNumber(jc.target)}{' '}
                  pcs
                  {jc.assignedTo?.length ? ` · ${jc.assignedTo.map(nameOf).filter(Boolean).join(', ')}` : ''}
                </Chip>
              )}
            </Chains>
          </>
        )}
        <AiSummary summary={record.aiSummary} />
      </div>
    </Card>
  );
};

const chainFirst = (items) =>
  items
    .map((jc) => jc.startDate)
    .filter(Boolean)
    .sort((a, b) => Date.parse(a) - Date.parse(b))[0];
const chainLast = (items) =>
  items
    .map((jc) => jc.endDate)
    .filter(Boolean)
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0];

/** Work orders of a maintenance plan: metrics tiles, compact Gantt and the technician per work order. */
export const MaintenancePlanChain = ({ record }) => {
  const { data, isLoading } = useRelated('maintenanceplans', record._id, 'workorders', {
    limit: 100,
    sort: 'plannedStart',
  });
  const items = data?.items ?? [];
  const chains = useMemo(
    () =>
      chainsOf(
        items.map((wo) => ({ ...wo, start: wo.plannedStart })),
        (wo) => wo.asset,
      ),
    [items],
  );
  const gantt = useMemo(
    () =>
      ganttData(
        items
          .filter((wo) => wo.plannedStart && wo.plannedEnd)
          .map((wo) => ({
            id: wo._id,
            code: wo.workOrderId,
            rowId: idOf(wo.asset) ?? 'none',
            start: wo.plannedStart,
            end: wo.plannedEnd,
            label: wo.name,
            kind: 'maintenance',
            status: wo.workStatus,
            href: `/m/workorders/${wo._id}`,
            tooltip: (wo.people ?? []).map(nameOf).filter(Boolean).join(', ') || undefined,
          })),
        chains,
      ),
    [items, chains],
  );
  const m = record.metrics;

  return (
    <Card>
      <CardHeader
        title="Work orders"
        icon={CalendarCheck}
        subtitle={items.length ? `${items.length} work orders on ${chains.size} assets` : undefined}
        actions={<AddToPlan parent="maintenanceplans" record={record} module="workorders" />}
      />
      <div className="space-y-4 p-4">
        {m && (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat
              label="Tasks"
              value={formatNumber(m.tasks)}
              hint={`${formatNumber(m.zeroImpactTasks)} with no impact`}
            />
            <Stat
              label="Production moved"
              value={`${formatNumber(m.productionHoursLost)} h`}
              hint={`instead of ${formatNumber(m.naiveProductionHoursLost)} h`}
            />
            <Stat label="Production impact" value={formatMoney(m.productionImpactCost)} />
            <Stat label="Downtime cost avoided" value={formatMoney(m.downtimeCostAvoided)} />
          </div>
        )}
        {isLoading && <Skeleton className="h-24 w-full" />}
        {!isLoading && !items.length && (
          <EmptyState icon={CalendarCheck} title="No work orders yet" className="py-8">
            <Link to="/planner?tab=maintenance" className="font-medium text-brand hover:underline">
              Plan it in the Planner
            </Link>
          </EmptyState>
        )}
        {items.length > 0 && (
          <>
            {gantt && <Gantt data={gantt} compact />}
            <Chains chains={chains}>
              {(wo) => (
                <Chip
                  key={wo._id}
                  href={`/m/workorders/${wo._id}`}
                  code={wo.workOrderId}
                  title={wo.name}
                  status={wo.workStatus}
                >
                  {wo.plannedStart
                    ? `${formatDateTime(wo.plannedStart)} → ${formatDateTime(wo.plannedEnd)}`
                    : 'No window yet'}
                  <span className={cn('block', !wo.people?.length && 'text-warn')}>
                    {wo.people?.length ? wo.people.map(nameOf).filter(Boolean).join(', ') : 'No technician'}
                  </span>
                </Chip>
              )}
            </Chains>
          </>
        )}
        <AiSummary summary={record.aiSummary} />
      </div>
    </Card>
  );
};
