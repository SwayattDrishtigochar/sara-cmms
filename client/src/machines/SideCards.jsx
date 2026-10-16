import { useQuery } from '@tanstack/react-query';
import { AlarmClock, CircleCheck, ClipboardCheck, Sparkles, TimerOff, Wrench, Zap } from 'lucide-react';
import { Link } from 'react-router';
import { api } from '../api/client.js';
import {
  formatDateTime,
  formatDuration,
  formatNumber,
  formatRelative,
  getFormatPrefs,
} from '../lib/format.js';
import { useLiveAsset } from '../live/liveStore.js';
import { useRecords } from '../modules/useModules.js';
import { Sparkline } from '../ui/charts.jsx';
import { AiProvenance, Badge, Card, CardHeader, Skeleton } from '../ui/core.jsx';
import { HealthRing, useNow } from './bits.jsx';
import { startOfDay } from './telemetry.js';

const OPEN_WORK = ['Open', 'In Progress', 'On Hold', 'Re Open'];
const ROW = 'block px-4 py-3 transition-colors hover:bg-surface-2/70 focus-visible:bg-surface-2';

/** The machine's job card that is In Progress, if any. */
export const useCurrentJob = (assetId, enabled = true) => {
  const query = useRecords(
    'jobcards',
    { filter: { asset: assetId, jobStatus: 'In Progress' }, limit: 1 },
    { enabled, placeholderData: undefined },
  );
  return { ...query, job: query.data?.items?.[0] ?? null };
};

const ListSkeleton = () => (
  <div className="space-y-3 p-4">
    <Skeleton className="h-4 w-3/4" />
    <Skeleton className="h-4 w-1/2" />
  </div>
);

const Empty = ({ icon: Icon = CircleCheck, children }) => (
  <p className="flex items-center gap-2 px-4 py-5 text-sm text-muted">
    <Icon className="size-4 shrink-0 text-subtle" aria-hidden />
    {children}
  </p>
);

const Failed = ({ error }) => (
  <p className="px-4 py-5 text-sm text-critical">Couldn't load this: {error.message}</p>
);

export const AiHealthCard = ({ asset }) => (
  <Card ai={asset.healthScore != null} className="p-4">
    <div className="flex items-start gap-3">
      <HealthRing score={asset.healthScore} size={48} />
      <div className="min-w-0">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold text-fg">
          <Sparkles className="size-4 text-ai" aria-hidden />
          AI health
        </h3>
        <p className="mt-1 text-sm text-muted">
          {asset.healthSummary ||
            (asset.healthScore == null
              ? "SARA hasn't reviewed this machine yet. A health score appears after its first anomaly scan."
              : 'No summary for the latest score.')}
        </p>
        {asset.healthUpdatedAt && (
          <AiProvenance at={formatRelative(asset.healthUpdatedAt)} className="mt-2" />
        )}
      </div>
    </div>
  </Card>
);

/** kWh in a `fn=sum` ENERGY CONSUMPTION series (each point is one window's total); null without points. */
export const energyUsed = (series = []) => {
  const points = series.find((s) => s.field === 'ENERGY CONSUMPTION')?.points ?? [];
  return points.length ? points.reduce((sum, [, kwh]) => sum + kwh, 0) : null;
};

/**
 * Live power draw and today's energy: the interval consumption summed since midnight in the company time
 * zone (never ENERGY READING differences, which break when a meter resets or a gap opens).
 */
export const EnergyCard = ({ assetId }) => {
  const live = useLiveAsset(assetId);
  const now = useNow(60_000);
  const dayStart = startOfDay(getFormatPrefs().timeZone, now);
  const today = useQuery({
    queryKey: ['telemetry', 'energy-today', assetId, dayStart],
    queryFn: ({ signal }) =>
      api('/telemetry/series', {
        query: {
          assetId,
          fields: 'ENERGY CONSUMPTION',
          fn: 'sum',
          start: new Date(dayStart).toISOString(),
          stop: new Date().toISOString(),
        },
        signal,
      }),
    refetchInterval: 5 * 60_000,
  });
  const kwh = energyUsed(today.data?.series);
  const power = live?.values?.['POWER TOTAL'];

  return (
    <Card>
      <CardHeader icon={Zap} title="Energy now" />
      <div className="p-4">
        <p className="flex items-baseline gap-1.5">
          <span className="text-3xl font-semibold tracking-tight text-fg">
            {typeof power === 'number' ? formatNumber(power, { digits: 1 }) : '—'}
          </span>
          <span className="text-sm text-muted">kW</span>
        </p>
        <Sparkline
          points={live?.history?.['POWER TOTAL']}
          label="Power, last 15 minutes"
          unit="kW"
          className="mt-3 h-9"
        />
        <div className="mt-4 flex items-baseline justify-between border-t border-border pt-3 text-sm">
          <span className="text-muted">Used today</span>
          {today.isLoading ? (
            <Skeleton className="h-4 w-16" />
          ) : (
            <span className="font-semibold text-fg tabular">
              {kwh == null ? '—' : formatNumber(kwh, { digits: 1, unit: 'kWh' })}
            </span>
          )}
        </div>
      </div>
    </Card>
  );
};

const JobProgress = ({ done, target }) => {
  const pct = target ? Math.min(100, Math.round((done / target) * 100)) : 0;
  return (
    <div className="mt-3">
      <div className="flex items-baseline justify-between text-xs">
        <span className="text-muted">
          <span className="font-semibold text-fg tabular">{formatNumber(done)}</span> of{' '}
          <span className="tabular">{formatNumber(target)}</span> parts
        </span>
        <span className="font-medium text-fg tabular">{pct}%</span>
      </div>
      <div
        role="progressbar"
        aria-label="Job progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        className="mt-1.5 h-2 overflow-hidden rounded-full bg-brand/15"
      >
        <div
          className="h-full rounded-full bg-brand transition-[width] duration-200"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
};

export const JobCard = ({ job, loading, error }) => {
  const progress = job?.operations?.[0]?.progress ?? {};
  return (
    <Card>
      <CardHeader
        icon={ClipboardCheck}
        title="Current job"
        actions={job && <Badge value={job.jobStatus} />}
      />
      {loading ? (
        <ListSkeleton />
      ) : error ? (
        <Failed error={error} />
      ) : !job ? (
        <Empty icon={ClipboardCheck}>No job is running on this machine.</Empty>
      ) : (
        <Link to={`/m/jobcards/${job._id}`} className={ROW}>
          <p className="truncate text-sm font-medium text-fg">
            {[job.jobCardId, job.jobName].filter(Boolean).join(' · ')}
          </p>
          <p className="mt-0.5 truncate text-xs text-muted">
            {[job.partName, job.tool?.name].filter(Boolean).join(' · ') || 'No part or mould set'}
          </p>
          <JobProgress done={progress.partsOut ?? 0} target={job.target ?? 0} />
          {job.endDate && (
            <p className="mt-2 text-xs text-subtle">Planned to finish {formatDateTime(job.endDate)}</p>
          )}
        </Link>
      )}
    </Card>
  );
};

const Due = ({ date }) => {
  const now = useNow();
  if (!date) return <span className="text-subtle">No due date</span>;
  const overdue = new Date(date).getTime() < now;
  return overdue ? (
    <span className="inline-flex items-center gap-1 font-medium text-critical">
      <AlarmClock className="size-3.5" aria-hidden />
      Overdue · due {formatRelative(date)}
    </span>
  ) : (
    <span className="text-muted">Due {formatRelative(date)}</span>
  );
};

export const WorkOrdersCard = ({ assetId }) => {
  const query = useRecords('workorders', { filter: { asset: assetId, workStatus: OPEN_WORK }, limit: 5 });
  const items = query.data?.items ?? [];
  const total = query.data?.total ?? 0;
  return (
    <Card>
      <CardHeader
        icon={Wrench}
        title="Open work orders"
        actions={total > 0 && <Badge tone="neutral">{total}</Badge>}
      />
      {query.isLoading ? (
        <ListSkeleton />
      ) : query.isError ? (
        <Failed error={query.error} />
      ) : !items.length ? (
        <Empty>No open work orders for this machine.</Empty>
      ) : (
        <ul className="divide-y divide-border">
          {items.map((wo) => (
            <li key={wo._id}>
              <Link to={`/m/workorders/${wo._id}`} className={ROW}>
                <div className="flex items-start justify-between gap-2">
                  <p className="min-w-0 truncate text-sm font-medium text-fg">{wo.name}</p>
                  <Badge value={wo.workStatus} />
                </div>
                <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                  <span className="font-mono text-subtle">{wo.workOrderId}</span>
                  <Badge value={wo.priority} />
                  <Due date={wo.dueDate} />
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {total > items.length && (
        <p className="border-t border-border px-4 py-2 text-xs text-subtle">
          Showing {items.length} of {total} open work orders
        </p>
      )}
    </Card>
  );
};

const Ongoing = ({ since }) => {
  const now = useNow();
  return (
    <Badge tone="stopped" dot>
      Ongoing · {formatDuration((now - new Date(since).getTime()) / 1000)}
    </Badge>
  );
};

export const DowntimesCard = ({ assetId }) => {
  const query = useRecords('downtimes', { filter: { assetId }, limit: 5 });
  const items = query.data?.items ?? [];
  return (
    <Card>
      <CardHeader icon={TimerOff} title="Recent downtime" />
      {query.isLoading ? (
        <ListSkeleton />
      ) : query.isError ? (
        <Failed error={query.error} />
      ) : !items.length ? (
        <Empty>No downtime recorded for this machine.</Empty>
      ) : (
        <ul className="divide-y divide-border">
          {items.map((d) => {
            const reasons = d.reason?.length ? d.reason.join(', ') : null;
            return (
              <li key={d._id}>
                <Link to={`/m/downtimes/${d._id}`} className={ROW}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs text-muted tabular">{formatDateTime(d.startedAt)}</span>
                    {d.endedAt ? (
                      <span className="text-sm font-semibold text-fg tabular">
                        {formatDuration(d.totalDowntimeInSeconds)}
                      </span>
                    ) : (
                      <Ongoing since={d.startedAt} />
                    )}
                  </div>
                  <p className="mt-1 flex items-center gap-2 text-xs">
                    {reasons ? (
                      <span className="truncate text-fg">{reasons}</span>
                    ) : (
                      <span className="text-subtle">No reason given yet</span>
                    )}
                    {!reasons && d.requiresVerification && <Badge tone="warn">Needs a reason</Badge>}
                  </p>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
};
