import { CircleAlert, Clock, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { formatRelative } from '../lib/format.js';
import { AiProvenance, Badge, Button, Card, CardHeader, Skeleton } from '../ui/core.jsx';
import { useCostOverview, useRefreshOverview } from './useCosts.js';

/** Friendly text for a failed AI refresh (quota, outage) or any other error. */
export const aiErrorText = (err) =>
  err?.status === 429 || err?.code === 'RATE_LIMITED'
    ? 'SARA has reached its AI limit for now. Try again in a minute.'
    : (err?.message ?? 'SARA could not write the overview right now.');

/**
 * SARA's explanation of the period's costs (`Card ai`). The numbers on the page are live either way; when the
 * AI is unavailable the last text is shown as out of date, or a friendly note when there is none.
 */
export const CostOverviewCard = ({ period, canRefresh }) => {
  const { data, isLoading, error, refetch } = useCostOverview(period);
  const refresh = useRefreshOverview();
  const regenerate = () =>
    refresh.mutate(period, {
      onSuccess: (r) => (r.aiError ? toast.error(aiErrorText(r.aiError)) : toast.success('Overview updated')),
      onError: (err) => toast.error(aiErrorText(err)),
    });
  const ai = data?.ai;

  return (
    <Card ai className="mb-5" aria-busy={isLoading || refresh.isPending}>
      <CardHeader
        icon={Sparkles}
        title="SARA's cost overview"
        subtitle={data?.period?.label}
        actions={
          data?.stale && (
            <Badge tone="warn">
              <Clock className="size-3.5" aria-hidden />
              Out of date
            </Badge>
          )
        }
      />
      <div className="space-y-2 px-4 py-3">
        {isLoading ? (
          <>
            <Skeleton className="h-5 w-2/3" />
            <Skeleton className="w-full" />
            <Skeleton className="w-5/6" />
          </>
        ) : error ? (
          <div className="flex flex-wrap items-center gap-3 text-sm text-muted">
            <CircleAlert className="size-4 text-critical" aria-hidden />
            <span>Couldn't load the overview: {error.message}</span>
            <Button size="sm" onClick={() => refetch()}>
              Retry
            </Button>
          </div>
        ) : ai ? (
          <>
            <h2 className="text-base font-semibold text-fg">{ai.headline}</h2>
            <p className="text-sm leading-relaxed text-muted">{ai.summary}</p>
            {data.aiError && (
              <p className="text-xs text-warn">
                Couldn't refresh just now ({aiErrorText(data.aiError)}). Showing the last overview.
              </p>
            )}
            <AiProvenance
              model={data.mock ? `${data.model ?? 'SARA'} (mock)` : data.model}
              at={data.at ? formatRelative(data.at) : null}
              onRegenerate={canRefresh && !refresh.isPending ? regenerate : undefined}
            />
          </>
        ) : (
          <div className="flex flex-wrap items-center gap-3 text-sm text-muted">
            <CircleAlert className="size-4 shrink-0 text-warn" aria-hidden />
            <span className="min-w-0 flex-1">
              SARA's explanation is unavailable right now
              {data?.aiError ? ` (${aiErrorText(data.aiError)})` : ''}. The totals, breakdowns and drivers
              below are live numbers.
            </span>
            {canRefresh && (
              <Button size="sm" variant="soft" loading={refresh.isPending} onClick={regenerate}>
                Try again
              </Button>
            )}
          </div>
        )}
      </div>
    </Card>
  );
};
