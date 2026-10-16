import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, CalendarClock, ClipboardCheck, FileText, Hammer, SearchX } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router';
import { AnomalyDetail } from '../anomalies/AnomalyDetail.jsx';
import { assetIdOf, useHealth } from '../anomalies/useAnomalies.js';
import { api } from '../api/client.js';
import { useCan, useSession } from '../auth/useAuth.js';
import { formatRelative } from '../lib/format.js';
import { seedHistory, seedLatest, useLiveAsset, useLiveEvent } from '../live/liveStore.js';
import { useRecord } from '../modules/useModules.js';
import { EmptyState, Skeleton } from '../ui/core.jsx';
import { AnomalyCard, FlaggedParameters, flaggedParameters } from './AnomalyCard.jsx';
import { LINK_BUTTON, LiveBadge, StatusLine } from './bits.jsx';
import { HealthRing } from './HealthRing.jsx';
import { ParameterTiles } from './ParameterTiles.jsx';
import { DowntimesCard, EnergyCard, JobCard, useCurrentJob, WorkOrdersCard } from './SideCards.jsx';
import { TimelineCard } from './TimelineCard.jsx';
import { TrendsCard } from './TrendsCard.jsx';
import { isNumericField } from './telemetry.js';

const BackLink = () => (
  <Link
    to="/machines"
    className="inline-flex items-center gap-1.5 rounded-md text-sm text-muted transition-colors hover:text-fg"
  >
    <ArrowLeft className="size-4" aria-hidden />
    Machines
  </Link>
);

const PageSkeleton = () => (
  <div className="mx-auto max-w-[1600px] px-4 py-6 sm:px-6" aria-busy="true">
    <BackLink />
    <Skeleton className="mt-4 h-8 w-56" />
    <Skeleton className="mt-2 h-4 w-80 max-w-full" />
    <div className="mt-6 grid gap-5 xl:grid-cols-[minmax(0,1fr)_22rem]">
      <Skeleton className="h-96" />
      <Skeleton className="h-96" />
    </div>
  </div>
);

/** Name, place, live status, job, mould and AI health; the only part of the page that re-renders on every reading. */
const Header = ({ asset, job, health, model }) => {
  const live = useLiveAsset(asset._id);
  const canPlan = useCan('workorders').create;
  const toolName = live?.values?.toolName;
  const scoredAt = health?.healthUpdatedAt ?? asset.healthUpdatedAt;
  return (
    <header className="mt-3 mb-6 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h1 className="text-2xl font-semibold tracking-tight text-fg">{asset.name}</h1>
          {asset.assetTag && (
            <span className="rounded-md border border-border bg-surface-2 px-1.5 py-0.5 font-mono text-xs text-muted">
              {asset.assetTag}
            </span>
          )}
        </div>
        <p className="mt-1 text-sm text-muted">
          {[asset.typeOfAsset, asset.location, asset.plantId?.name].filter(Boolean).join(' · ')}
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
          <StatusLine
            status={live?.status ?? asset.assetStatus}
            since={live?.since ?? asset.assetStatusSince}
          />
          {job && (
            <span className="inline-flex min-w-0 items-center gap-1.5 text-fg">
              <ClipboardCheck className="size-4 shrink-0 text-muted" aria-hidden />
              <span className="truncate">{[job.jobCardId, job.jobName].filter(Boolean).join(' · ')}</span>
            </span>
          )}
          {typeof toolName === 'string' && toolName && (
            <span className="inline-flex min-w-0 items-center gap-1.5 text-muted">
              <Hammer className="size-4 shrink-0" aria-hidden />
              <span className="truncate">{toolName}</span>
            </span>
          )}
        </div>
      </div>
      <div className="flex shrink-0 flex-col gap-3 lg:items-end">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <LiveBadge />
          <Link to={`/m/assets/${asset._id}`} className={LINK_BUTTON}>
            <FileText className="size-4" aria-hidden />
            Asset record
          </Link>
          {canPlan && (
            <Link to={`/planner?maintenance=${asset._id}`} className={LINK_BUTTON}>
              <CalendarClock className="size-4" aria-hidden />
              Plan maintenance
            </Link>
          )}
        </div>
        <HealthRing
          score={health?.healthScore ?? asset.healthScore}
          summary={health?.healthSummary ?? asset.healthSummary}
          at={scoredAt ? formatRelative(scoredAt) : undefined}
          model={model}
          rescan
          size={48}
          label
          className="max-w-sm rounded-xl border border-border bg-surface px-3 py-2 shadow-card"
        />
      </div>
    </header>
  );
};

/** Every live and recent signal of one machine (Machine 360). */
const Machine360 = ({ asset }) => {
  const id = asset._id;
  const ctx = useSession();
  const can = (name) => Boolean(ctx?.modules?.includes(name));
  const qc = useQueryClient();
  const showJob = asset.isProductionAsset && can('jobcards');
  const current = useCurrentJob(id, showJob);
  const job = current.job ?? asset.jobCard;
  const health = useHealth(can('anomalies') ? id : null);
  const flagged = useMemo(
    () => new Map(flaggedParameters(health.data?.anomalies).map((f) => [f.param.field, f])),
    [health.data],
  );
  const [openAnomaly, setOpenAnomaly] = useState(null);

  const fieldsQuery = useQuery({
    queryKey: ['telemetry', 'fields', id],
    queryFn: ({ signal }) =>
      api('/telemetry/fields', { query: { assetId: id }, signal }).then((r) => r.fields),
    staleTime: 5 * 60_000,
  });
  // Same field name in two measurements (cycleTime) is one live value: keep the first spec.
  const numeric = useMemo(() => {
    const byField = new Map();
    for (const f of fieldsQuery.data ?? []) {
      if (isNumericField(f) && !byField.has(f.field)) byField.set(f.field, f);
    }
    return [...byField.values()];
  }, [fieldsQuery.data]);

  const latest = useQuery({
    queryKey: ['telemetry', 'latest', id],
    queryFn: ({ signal }) => api('/telemetry/latest', { query: { assetIds: id }, signal }),
  });
  useEffect(() => {
    if (latest.data?.assets) seedLatest(latest.data.assets);
  }, [latest.data]);

  const fieldList = numeric.map((f) => f.field).join(',');
  const recent = useQuery({
    queryKey: ['telemetry', 'series', id, fieldList, '15m'],
    queryFn: ({ signal }) =>
      api('/telemetry/series', { query: { assetId: id, fields: fieldList, range: '15m' }, signal }),
    enabled: Boolean(fieldList), // seeds the sparklines; live points take over from there
  });
  useEffect(() => {
    if (recent.data?.series) seedHistory(id, recent.data.series);
  }, [id, recent.data]);

  // Job card and work order changes arrive as `record` events, which the app shell turns into refetches.
  const mine = (data) => String(data?.assetId) === id;
  useLiveEvent('status', (d) => mine(d) && qc.invalidateQueries({ queryKey: ['telemetry', 'timeline', id] }));
  useLiveEvent('downtime', (d) => mine(d) && qc.invalidateQueries({ queryKey: ['m', 'downtimes'] }));
  useLiveEvent(
    'anomaly',
    (d) => assetIdOf(d?.anomaly) === id && qc.invalidateQueries({ queryKey: ['ai', 'health', id] }),
  );

  return (
    <div className="mx-auto max-w-[1600px] px-4 py-6 sm:px-6">
      <BackLink />
      <Header
        asset={asset}
        job={job}
        health={health.data?.asset}
        model={health.data?.asset?.healthModel ?? health.data?.anomalies?.find((a) => a.model)?.model}
      />

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="min-w-0 space-y-5">
          {can('anomalies') && <FlaggedParameters assetId={id} onOpen={setOpenAnomaly} />}
          <ParameterTiles
            assetId={id}
            fields={numeric}
            loading={fieldsQuery.isLoading}
            error={fieldsQuery.error}
            flagged={flagged}
          />
          {numeric.length > 0 && <TrendsCard assetId={id} fields={numeric} />}
          <TimelineCard assetId={id} />
        </div>
        <aside className="min-w-0 space-y-5" aria-label="Machine details">
          {can('anomalies') && <AnomalyCard assetId={id} onOpen={setOpenAnomaly} />}
          {asset.isEnergyAsset && <EnergyCard assetId={id} />}
          {showJob && <JobCard job={current.job} loading={current.isLoading} error={current.error} />}
          {can('workorders') && <WorkOrdersCard assetId={id} />}
          {can('downtimes') && <DowntimesCard assetId={id} />}
        </aside>
      </div>
      <AnomalyDetail id={openAnomaly} onClose={() => setOpenAnomaly(null)} />
    </div>
  );
};

/** /machines/:id */
export const MachinePage = () => {
  const { id } = useParams();
  const asset = useRecord('assets', id);
  if (asset.isLoading) return <PageSkeleton />;
  if (asset.isError || !asset.data) {
    const missing = asset.error?.status === 404 || asset.error?.status === 400;
    return (
      <EmptyState
        icon={SearchX}
        title={missing ? 'Machine not found' : "Couldn't load this machine"}
        action={
          <Link to="/machines" className={LINK_BUTTON}>
            <ArrowLeft className="size-4" aria-hidden />
            Back to machines
          </Link>
        }
      >
        {missing ? "It may have been removed, or it's in a plant you can't see." : asset.error?.message}
      </EmptyState>
    );
  }
  return <Machine360 key={id} asset={asset.data} />;
};
