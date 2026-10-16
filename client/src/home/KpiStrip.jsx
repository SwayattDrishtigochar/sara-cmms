import { Gauge, Sparkles, Star } from 'lucide-react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { useAssistant } from '../assistant/useAssistant.js';
import { useCan } from '../auth/useAuth.js';
import { insightProvenance } from '../kpis/KpiCard.jsx';
import { useExplainKpi, useKpiRun, useKpis } from '../kpis/useKpis.js';
import { AiProvenance, Button, Card, Skeleton } from '../ui/core.jsx';
import { Viz } from '../viz/Viz.jsx';

export const KPI_PROMPT =
  'Suggest the 4 KPIs that matter most for my plant today and pin them to the Command Center';
const MAX = 4;

/** Pinned KPIs first, then the most recently changed, four at most. */
export const stripKpis = (items = []) =>
  [...items.filter((k) => k.pinned), ...items.filter((k) => !k.pinned)].slice(0, MAX);

const KpiTile = ({ kpi, canExplain }) => {
  const run = useKpiRun(kpi._id, kpi.updatedAt);
  const explain = useExplainKpi(kpi._id);
  const insight = kpi.insight?.text ? kpi.insight : null;
  const prov = insightProvenance(insight);
  return (
    <li className="min-w-0">
      <Card className="flex h-full min-w-0 flex-col p-3">
        <h3 className="flex items-center gap-1.5 truncate text-xs font-medium text-muted">
          {kpi.pinned && <Star className="size-3 shrink-0 fill-current text-warn" aria-label="Pinned" />}
          <span className="truncate" title={kpi.title}>
            {kpi.title}
          </span>
        </h3>
        <div className="mt-1 min-h-16 flex-1">
          {run.isLoading ? (
            <Skeleton className="h-16" />
          ) : run.isError ? (
            <p className="text-xs text-muted">Couldn't run this KPI.</p>
          ) : (
            <Viz result={run.data} height={96} compact />
          )}
        </div>
        {insight && (
          <div className="mt-2 border-t border-border pt-2">
            <p className="line-clamp-2 text-xs text-fg" title={insight.text}>
              {insight.text}
            </p>
            <AiProvenance
              className="mt-1"
              model={prov.model}
              at={prov.at}
              onRegenerate={
                canExplain && !explain.isPending
                  ? () =>
                      explain.mutate(undefined, {
                        onError: () => toast.error("SARA can't write a new insight right now"),
                      })
                  : undefined
              }
            />
          </div>
        )}
      </Card>
    </li>
  );
};

/** The AI-built KPI strip: pinned KPI cards from the KPI Builder, or an invitation to ask SARA for some. */
export const KpiStrip = () => {
  const kpis = useKpis();
  const canExplain = useCan('kpis').update;
  const shown = stripKpis(kpis.data?.items);

  if (kpis.isLoading) {
    return (
      <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label="Loading KPIs">
        {Array.from({ length: MAX }, (_, i) => (
          <li key={i}>
            <Skeleton className="h-32 rounded-xl" />
          </li>
        ))}
      </ul>
    );
  }
  if (!shown.length) {
    return (
      <Card className="flex flex-wrap items-center gap-3 px-4 py-3">
        <Gauge className="size-5 shrink-0 text-ai" aria-hidden />
        <p className="min-w-0 flex-1 text-sm text-muted">
          {kpis.isError ? "KPIs couldn't be loaded." : 'No KPIs yet. SARA builds them from a sentence.'}
        </p>
        <Button
          variant="ai"
          size="sm"
          icon={Sparkles}
          onClick={() => useAssistant.getState().open({ text: KPI_PROMPT, send: true })}
        >
          Ask SARA for KPIs
        </Button>
        <Link to="/kpis" className="text-xs font-medium text-brand hover:underline">
          KPI Builder
        </Link>
      </Card>
    );
  }
  return (
    <section aria-label="Key KPIs">
      <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {shown.map((kpi) => (
          <KpiTile key={kpi._id} kpi={kpi} canExplain={canExplain} />
        ))}
      </ul>
    </section>
  );
};
