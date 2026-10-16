import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Factory } from 'lucide-react';
import { memo, useEffect, useMemo } from 'react';
import { Link } from 'react-router';
import { severityOf } from '../anomalies/parts.jsx';
import { useMachineAnomalies } from '../anomalies/useAnomalies.js';
import { api } from '../api/client.js';
import { useSession } from '../auth/useAuth.js';
import { cn } from '../lib/format.js';
import { seedLatest, useLiveAsset, useLiveEvent, useStatusCounts } from '../live/liveStore.js';
import { HealthRing } from '../machines/HealthRing.jsx';
import { cardFields, fieldLabel, formatValue } from '../machines/telemetry.js';
import { useRecords } from '../modules/useModules.js';
import { useUi } from '../store/ui.js';
import { Card, CardHeader, EmptyState, Skeleton, StatusPill } from '../ui/core.jsx';

const isMachine = (a) => a.isProductionAsset || a.isEnergyAsset || a.isSensorIntegration;
const BORDER = { Stopped: 'border-stopped/60', Maintenance: 'border-maint/60' };
const GRID = 'grid grid-cols-1 gap-2 min-[420px]:grid-cols-2 md:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5';

const AnomalyMark = ({ anomalies }) => {
  const worst = anomalies.reduce((w, a) =>
    severityOf(a.severity).rank > severityOf(w.severity).rank ? a : w,
  );
  const s = severityOf(worst.severity);
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] text-fg',
        s.soft,
      )}
      title={worst.summary}
    >
      <s.icon className={cn('size-3.5', s.text)} aria-hidden />
      {anomalies.length === 1 ? s.label : `${anomalies.length} anomalies`}
    </span>
  );
};

/** One compact machine tile: live status (icon + word), headline parameter, AI health, open anomalies. */
const Tile = memo(({ asset }) => {
  const live = useLiveAsset(asset._id);
  const status = live?.status ?? asset.assetStatus;
  const anomalies = useMachineAnomalies(asset._id);
  const key = cardFields(asset)[0];
  const value = key ? live?.values?.[key.field] : null;
  return (
    <li>
      <article
        className={cn(
          'relative flex h-full items-start gap-2 rounded-lg border bg-surface p-3 transition-colors hover:border-border-strong has-[a:focus-visible]:ring-2 has-[a:focus-visible]:ring-ring',
          BORDER[status] ?? 'border-border',
        )}
      >
        <div className="min-w-0 flex-1 space-y-1.5">
          <h3 className="truncate text-sm font-semibold text-fg">
            <Link
              to={`/machines/${asset._id}`}
              className="after:absolute after:inset-0 after:rounded-lg focus-visible:outline-none"
            >
              {asset.name}
            </Link>
          </h3>
          <div className="flex flex-wrap items-center gap-1.5">
            <StatusPill status={status} />
            {anomalies.length > 0 && <AnomalyMark anomalies={anomalies} />}
          </div>
          {key && (
            <p className="truncate text-xs text-muted">
              {fieldLabel(key.field)}{' '}
              <span className="font-semibold text-fg tabular">{formatValue(value)}</span>
              {value != null && key.unit && <span className="text-subtle"> {key.unit}</span>}
            </p>
          )}
        </div>
        <HealthRing score={asset.healthScore} size={34} />
      </article>
    </li>
  );
});

const COUNT_ORDER = ['Running', 'Idle', 'Stopped', 'Maintenance', 'OFF'];

/** The live floor: every connected machine of the picked plant as a tile, kept current by the live stream. */
export const LiveFloor = () => {
  const ctx = useSession();
  const plantId = useUi((s) => s.plantId);
  const filter = plantId && !ctx?.plantLocked ? { plantId } : undefined;
  // Same params as the Machines page, so both share one cached list.
  const assets = useRecords('assets', { limit: 100, sort: 'name', filter });
  const latest = useQuery({
    queryKey: ['telemetry', 'latest'],
    queryFn: ({ signal }) => api('/telemetry/latest', { signal }),
  });
  useEffect(() => {
    if (latest.data?.assets) seedLatest(latest.data.assets);
  }, [latest.data]);
  const qc = useQueryClient();
  useLiveEvent('status', () =>
    qc.invalidateQueries({ queryKey: ['m', 'assets', 'list'] }, { cancelRefetch: false }),
  );
  const machines = useMemo(() => (assets.data?.items ?? []).filter(isMachine), [assets.data]);
  const counts = useStatusCounts(machines);

  let body;
  if (assets.isLoading) {
    body = (
      <ul className={GRID} aria-label="Loading machines">
        {Array.from({ length: 10 }, (_, i) => (
          <li key={i}>
            <Skeleton className="h-[5.5rem] rounded-lg" />
          </li>
        ))}
      </ul>
    );
  } else if (assets.isError) {
    body = <p className="text-sm text-muted">Couldn't load your machines: {assets.error.message}</p>;
  } else if (!machines.length) {
    body = (
      <EmptyState icon={Factory} title="No connected machines" className="py-8">
        Machines with live data appear here.
      </EmptyState>
    );
  } else {
    body = (
      <ul className={GRID}>
        {machines.map((asset) => (
          <Tile key={asset._id} asset={asset} />
        ))}
      </ul>
    );
  }

  return (
    <Card className="min-w-0">
      <CardHeader
        icon={Factory}
        title="Live floor"
        subtitle={
          machines.length
            ? COUNT_ORDER.filter((s) => counts[s])
                .map((s) => `${counts[s]} ${s === 'OFF' ? 'off' : s.toLowerCase()}`)
                .join(' · ')
            : 'Machine status as it happens'
        }
        actions={
          <Link to="/machines" className="text-xs font-medium text-brand hover:underline">
            All machines
          </Link>
        }
      />
      <div className="p-3">{body}</div>
    </Card>
  );
};
