import { ArrowRight, CircleAlert, MessageSquareText, Sparkles, TriangleAlert } from 'lucide-react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { useAssistant } from '../assistant/useAssistant.js';
import { useSession } from '../auth/useAuth.js';
import { ChartBlock } from '../blocks/ChartBlock.jsx';
import { DataTable } from '../blocks/DataTable.jsx';
import { KpiBlock } from '../blocks/KpiBlock.jsx';
import { formatRelative } from '../lib/format.js';
import { AiProvenance, Badge, Button, Card, CardHeader, Skeleton } from '../ui/core.jsx';
import { useBriefing, useRefreshBriefing } from './useBriefing.js';

const ask = (text) => useAssistant.getState().open({ text, send: true });

/** One evidence section's ready block (phase-4 shapes). */
export const EvidenceBlock = ({ block }) => {
  if (!block?.payload) return null;
  if (block.type === 'chart') return <ChartBlock {...block.payload} />;
  if (block.type === 'table') return <DataTable {...block.payload} />;
  return <KpiBlock {...block.payload} />;
};

const Action = ({ action, index }) => {
  const navigate = useNavigate();
  const primary = () => (action.link ? navigate(action.link) : action.ask && ask(action.ask));
  const clickable = Boolean(action.link || action.ask);
  return (
    <li className="flex min-w-0 items-stretch gap-1 rounded-lg border border-border bg-surface">
      <button
        type="button"
        onClick={primary}
        disabled={!clickable}
        className="flex min-w-0 flex-1 items-start gap-3 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:hover:bg-transparent"
      >
        <span className="grid size-6 shrink-0 place-items-center rounded-full bg-ai/10 text-xs font-semibold text-ai tabular">
          {index + 1}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-fg">{action.title}</span>
          {action.why && <span className="mt-0.5 block text-xs text-muted">{action.why}</span>}
        </span>
        {clickable &&
          (action.link ? (
            <ArrowRight className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
          ) : (
            <MessageSquareText className="mt-0.5 size-4 shrink-0 text-muted" aria-label="Asks SARA" />
          ))}
      </button>
      {action.link && action.ask && (
        <Button
          variant="ghost"
          size="iconSm"
          icon={MessageSquareText}
          className="m-1"
          aria-label={`Ask SARA: ${action.ask}`}
          title={action.ask}
          onClick={() => ask(action.ask)}
        />
      )}
    </li>
  );
};

const Loading = () => (
  <div className="space-y-3 p-4" role="status" aria-label="Loading the briefing">
    <Skeleton className="h-6 w-2/3" />
    <Skeleton className="h-4 w-full" />
    <Skeleton className="h-4 w-5/6" />
    <div className="grid gap-2 pt-2 sm:grid-cols-3">
      {[0, 1, 2].map((i) => (
        <Skeleton key={i} className="h-16" />
      ))}
    </div>
  </div>
);

/** SARA's briefing of today: headline, narrative, three actions and the evidence that backs them. */
export const BriefingCard = () => {
  const ctx = useSession();
  const query = useBriefing();
  const refresh = useRefreshBriefing();
  const canRefresh = ['owner', 'admin'].includes(ctx?.role);
  const data = query.data;
  const b = data?.briefing;

  const onRegenerate = () =>
    refresh.mutate(undefined, {
      onSuccess: (r) =>
        r?.aiError
          ? toast.warning("SARA couldn't write a new briefing right now", {
              description: 'The last briefing stays; the numbers are live.',
            })
          : toast.success('Briefing updated'),
      onError: (err) => toast.error(err.message),
    });

  let body;
  if (query.isLoading) body = <Loading />;
  else if (query.isError) {
    body = (
      <div className="flex items-start gap-3 p-4 text-sm">
        <CircleAlert className="mt-0.5 size-4 shrink-0 text-critical" aria-hidden />
        <div className="min-w-0">
          <p className="font-medium text-fg">Couldn't load the briefing</p>
          <p className="mt-0.5 text-muted">{query.error.message}</p>
          <Button size="sm" className="mt-3" onClick={() => query.refetch()} loading={query.isFetching}>
            Try again
          </Button>
        </div>
      </div>
    );
  } else {
    const blocks = (b?.evidence ?? []).map((k) => [k, data.evidence?.[k]?.block]).filter(([, bl]) => bl);
    body = (
      <div className="space-y-4 p-4">
        <div>
          <h2 className="text-lg font-semibold tracking-tight text-balance text-fg">{b?.headline}</h2>
          {b?.narrative ? (
            <p className="mt-1.5 max-w-3xl text-sm leading-relaxed text-muted">{b.narrative}</p>
          ) : (
            <p className="mt-1.5 text-sm text-muted">
              SARA can't write the briefing right now. The live numbers are below.
            </p>
          )}
          {data.stale && (
            <Badge tone="warn" className="mt-2">
              <TriangleAlert className="size-3.5" aria-hidden />
              Written {formatRelative(data.at)}; SARA couldn't refresh it
            </Badge>
          )}
        </div>
        {b?.actions?.length > 0 && (
          <section aria-label="Recommended actions">
            <h3 className="mb-2 text-xs font-semibold tracking-wide text-subtle uppercase">Do next</h3>
            <ol className="grid gap-2 lg:grid-cols-3">
              {b.actions.map((a, i) => (
                <Action key={`${a.title}-${i}`} action={a} index={i} />
              ))}
            </ol>
          </section>
        )}
        {blocks.length > 0 && (
          <section aria-label="Evidence" className="grid items-start gap-3 xl:grid-cols-2">
            {blocks.map(([k, block]) => (
              <EvidenceBlock key={k} block={block} />
            ))}
          </section>
        )}
        {data.model && (
          <AiProvenance
            model={data.mock ? `${data.model} (mock)` : data.model}
            at={data.at ? formatRelative(data.at) : undefined}
            onRegenerate={canRefresh && !refresh.isPending ? onRegenerate : undefined}
          />
        )}
      </div>
    );
  }

  return (
    <Card ai className="min-w-0" aria-busy={refresh.isPending || undefined}>
      <CardHeader
        icon={Sparkles}
        title="SARA briefing"
        subtitle="Today so far, written by SARA from live plant data"
        actions={
          canRefresh &&
          data &&
          !data.model && (
            <Button size="sm" variant="ghost" onClick={onRegenerate} loading={refresh.isPending}>
              Try again
            </Button>
          )
        }
      />
      {body}
    </Card>
  );
};
