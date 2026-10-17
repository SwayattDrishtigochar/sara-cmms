import { ClipboardList, ExternalLink, ListChecks, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { cn, formatDate, formatRelative } from '../lib/format.js';
import { useRecords } from '../modules/useModules.js';
import { Badge, Button, Card, CardHeader, EmptyState, Skeleton } from '../ui/core.jsx';
import { FeasibilityBadge, hoursText, KindIcon, ProposalStatusBadge, VerdictBadge } from './PlanBlock.jsx';
import { useProposals } from './usePlanning.js';

const idOf = (p) => String(p._id ?? p.id);

/** Proposals still in play or created; discarded and expired drafts show on request. */
export const LIVE_STATUSES = 'draft,applying,applied,failed,stale';

const ListShell = ({ icon, title, subtitle, actions, query, empty, children }) => (
  <Card>
    <CardHeader icon={icon} title={title} subtitle={subtitle} actions={actions} />
    {query.isLoading ? (
      <div
        className="space-y-2 p-4"
        role="status"
        aria-busy="true"
        aria-label={`Loading ${title.toLowerCase()}`}
      >
        <Skeleton className="h-10" />
        <Skeleton className="h-10" />
        <Skeleton className="h-10" />
      </div>
    ) : query.isError ? (
      <div className="flex items-center justify-between gap-3 p-4 text-sm text-muted">
        Couldn't load {title.toLowerCase()}.
        <Button size="sm" icon={RefreshCw} onClick={() => query.refetch()}>
          Retry
        </Button>
      </div>
    ) : (
      (children ?? empty)
    )}
  </Card>
);

/** SARA's proposals of `kind` (comma list allowed), newest first; clicking one opens it. */
export const PlansList = ({ kind, selectedId, onSelect }) => {
  const [all, setAll] = useState(false);
  const query = useProposals({
    limit: 20,
    ...(kind ? { kind } : {}),
    ...(all ? {} : { status: LIVE_STATUSES }),
  });
  const items = query.data?.items ?? [];
  return (
    <ListShell
      icon={ListChecks}
      title="Suggested plans"
      subtitle={all ? 'Every draft SARA made, newest first' : 'Open and created drafts, newest first'}
      actions={
        <Button size="sm" variant="ghost" aria-pressed={all} onClick={() => setAll((v) => !v)}>
          {all ? 'Hide discarded' : 'Show discarded'}
        </Button>
      }
      query={query}
      empty={
        <EmptyState icon={ListChecks} title="No suggested plans yet" className="py-8">
          Plan with SARA above and the draft appears here until you create or discard it.
        </EmptyState>
      }
    >
      {items.length ? (
        <ul className="divide-y divide-border">
          {items.map((p) => (
            <li key={idOf(p)}>
              <button
                type="button"
                aria-current={selectedId === idOf(p) ? 'true' : undefined}
                onClick={() => onSelect(idOf(p))}
                className={cn(
                  'flex w-full items-start gap-2.5 px-4 py-2.5 text-left transition-colors hover:bg-surface-2',
                  selectedId === idOf(p) && 'bg-brand-soft',
                )}
              >
                <KindIcon kind={p.kind} className="mt-0.5" />
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-2">
                    <span className="text-xs font-semibold text-subtle tabular">{p.proposalCode}</span>
                    <span className="truncate text-sm font-medium text-fg">{p.title}</span>
                  </span>
                  <span className="mt-1 flex flex-wrap items-center gap-1.5">
                    <ProposalStatusBadge status={p.status} />
                    {p.feasibility?.verdict ? (
                      <VerdictBadge verdict={p.feasibility.verdict} />
                    ) : (
                      <FeasibilityBadge feasibility={p.feasibility} kind={p.kind} />
                    )}
                    <span className="text-xs text-subtle">{formatRelative(p.createdAt)}</span>
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </ListShell>
  );
};

const RECORD = {
  productionplans: {
    title: 'Production plans',
    code: (r) => r.reqId,
    name: (r) => r.partName,
    line: (r) =>
      [
        r.quantity != null && `${Number(r.quantity).toLocaleString('en-IN')} pcs`,
        r.dueDate && `due ${formatDate(r.dueDate)}`,
        r.feasibility?.slackHours != null &&
          (r.feasibility.slackHours < 0
            ? `late ${hoursText(r.feasibility.slackHours)}`
            : `${hoursText(r.feasibility.slackHours)} slack`),
      ]
        .filter(Boolean)
        .join(' · '),
    verdict: (r) => r.feasibility?.verdict,
  },
  maintenanceplans: {
    title: 'Maintenance plans',
    code: (r) => r.planCode,
    name: (r) => r.name,
    line: (r) =>
      r.metrics
        ? `${r.metrics.tasks ?? 0} tasks · ${r.metrics.zeroImpactTasks ?? 0} zero-impact · ${hoursText(r.metrics.productionHoursLost)} moved`
        : [r.scope === 'assets' ? 'Selected machines' : 'Whole plant', r.objective?.replace(/_/g, ' ')]
            .filter(Boolean)
            .join(' · '),
    verdict: () => null,
  },
};

/** The latest production or maintenance plan records with status, a summary line and a link. */
export const PlanRecordsList = ({ module }) => {
  const query = useRecords(module, { limit: 20, sort: '-createdAt' });
  const cfg = RECORD[module];
  const items = query.data?.items ?? [];
  return (
    <ListShell
      icon={ClipboardList}
      title={cfg.title}
      subtitle="Created plans, newest first"
      query={query}
      empty={
        <EmptyState icon={ClipboardList} title={`No ${cfg.title.toLowerCase()} yet`} className="py-8">
          Created plans show here with their status.
        </EmptyState>
      }
    >
      {items.length ? (
        <ul className="divide-y divide-border">
          {items.map((r) => (
            <li key={r._id}>
              <Link
                to={`/m/${module}/${r._id}`}
                className="flex items-start gap-2.5 px-4 py-2.5 transition-colors hover:bg-surface-2"
              >
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-2">
                    <span className="text-xs font-semibold text-subtle tabular">{cfg.code(r)}</span>
                    <span className="truncate text-sm font-medium text-fg">{cfg.name(r)}</span>
                  </span>
                  <span className="mt-1 flex flex-wrap items-center gap-1.5">
                    {r.status && <Badge value={r.status} />}
                    <VerdictBadge verdict={cfg.verdict(r)} />
                    <span className="text-xs text-subtle tabular">{cfg.line(r)}</span>
                  </span>
                </span>
                <ExternalLink className="mt-1 size-3.5 shrink-0 text-subtle" aria-hidden />
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </ListShell>
  );
};
