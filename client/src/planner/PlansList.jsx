import { ListChecks, RefreshCw } from 'lucide-react';
import { cn, formatRelative } from '../lib/format.js';
import { Button, Card, CardHeader, EmptyState, Skeleton } from '../ui/core.jsx';
import { FeasibilityBadge, KindIcon, ProposalStatusBadge } from './PlanBlock.jsx';
import { useProposals } from './usePlanning.js';

const idOf = (p) => String(p._id ?? p.id);

/** Recent plan proposals; clicking one shows it on the Gantt. */
export const PlansList = ({ selectedId, onSelect }) => {
  const query = useProposals({ limit: 20 });
  const items = query.data?.items ?? [];
  return (
    <Card>
      <CardHeader icon={ListChecks} title="Plans" subtitle="SARA's proposals, newest first" />
      {query.isLoading ? (
        <div className="space-y-2 p-4">
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
        </div>
      ) : query.isError ? (
        <div className="flex items-center justify-between gap-3 p-4 text-sm text-muted">
          Couldn't load the plans.
          <Button size="sm" icon={RefreshCw} onClick={() => query.refetch()}>
            Retry
          </Button>
        </div>
      ) : !items.length ? (
        <EmptyState icon={ListChecks} title="No plans yet" className="py-8">
          Auto-plan production or find a maintenance window, and SARA's proposals appear here.
        </EmptyState>
      ) : (
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
                    <FeasibilityBadge feasibility={p.feasibility} kind={p.kind} />
                    <span className="text-xs text-subtle">{formatRelative(p.createdAt)}</span>
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
};
