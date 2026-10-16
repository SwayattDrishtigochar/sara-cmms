import { ClipboardCheck, Clock } from 'lucide-react';
import { memo, useMemo } from 'react';
import { Link } from 'react-router';
import { deviationOf, severityOf } from '../anomalies/parts.jsx';
import { useMachineAnomalies } from '../anomalies/useAnomalies.js';
import { cn, formatRelative } from '../lib/format.js';
import { STALE_MS, useLiveAsset } from '../live/liveStore.js';
import { Sparkline } from '../ui/charts.jsx';
import { Skeleton } from '../ui/core.jsx';
import { flaggedParameters } from './AnomalyCard.jsx';
import { StatusLine, useNow } from './bits.jsx';
import { HealthRing } from './HealthRing.jsx';
import { cardFields, fieldLabel, formatValue } from './telemetry.js';

const BORDER = { Stopped: 'border-stopped/60', Maintenance: 'border-maint/60' };

const KeyParam = ({ field, unit, value, points, flag }) => {
  const label = fieldLabel(field);
  const s = flag && severityOf(flag.anomaly.severity);
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto_4.5rem] items-center gap-3">
      <dt className={cn('flex min-w-0 items-center gap-1 text-xs', s ? 'font-medium text-fg' : 'text-muted')}>
        {s && (
          <s.icon className={cn('size-3.5 shrink-0', s.text)} aria-label={`Flagged by SARA, ${s.label}`} />
        )}
        <span className="truncate">{label}</span>
      </dt>
      <dd className="text-right text-sm font-semibold whitespace-nowrap text-fg tabular">
        {formatValue(value)}
        {value != null && unit && <span className="ml-1 text-xs font-normal text-subtle">{unit}</span>}
      </dd>
      <dd>
        <Sparkline points={points} label={`${label}, last 15 minutes`} unit={unit} className="h-6" />
      </dd>
    </div>
  );
};

const Footer = ({ asset, valuesAt, hasFields }) => {
  const now = useNow();
  const stale = valuesAt && now - valuesAt > STALE_MS;
  const job = asset.jobCard;
  if (!asset.isProductionAsset && !stale && (valuesAt || !hasFields)) return null;
  return (
    <div className="mt-auto space-y-1.5 border-t border-border px-4 py-2.5 text-xs">
      {asset.isProductionAsset && (
        <p className={cn('flex items-center gap-1.5', job ? 'text-fg' : 'text-subtle')}>
          <ClipboardCheck className="size-3.5 shrink-0 text-muted" aria-hidden />
          <span className="truncate">
            {job ? [job.jobCardId, job.jobName].filter(Boolean).join(' · ') : 'No job running'}
          </span>
        </p>
      )}
      {(stale || (!valuesAt && hasFields)) && (
        <p className="flex items-center gap-1.5 text-muted">
          <Clock className="size-3.5 shrink-0" aria-hidden />
          {valuesAt ? `Last reading ${formatRelative(valuesAt)}` : 'No readings yet'}
        </p>
      )}
    </div>
  );
};

/** Worst open anomaly's severity, and which parameter is off ("Vibration +4.1σ"), or how many anomalies. */
const AnomalyBadge = ({ anomalies, flagged }) => {
  const worst = anomalies.reduce((w, a) =>
    severityOf(a.severity).rank > severityOf(w.severity).rank ? a : w,
  );
  const s = severityOf(worst.severity);
  const top = flagged.find((f) => f.anomaly._id === worst._id)?.param ?? flagged[0]?.param;
  const more = anomalies.length - 1;
  return (
    <p
      className={cn(
        'mt-2 inline-flex max-w-full items-center gap-1.5 rounded-md border px-1.5 py-0.5 text-xs text-fg',
        s.soft,
      )}
      title={worst.summary}
    >
      <s.icon className={cn('size-3.5 shrink-0', s.text)} aria-hidden />
      <span className="sr-only">{s.label} anomaly:</span>
      {top ? (
        <span className="truncate">
          {fieldLabel(top.field)}
          {deviationOf(top) && <span className="ml-1 font-semibold tabular">{deviationOf(top)}</span>}
        </span>
      ) : (
        <span className="truncate">{s.label} anomaly</span>
      )}
      {more > 0 && <span className="shrink-0 text-muted">+{more} more</span>}
    </p>
  );
};

/** One machine on the floor grid. The name link stretches over the card, so the whole card opens Machine 360. */
export const MachineCard = memo(({ asset }) => {
  const live = useLiveAsset(asset._id);
  const status = live?.status ?? asset.assetStatus;
  const anomalies = useMachineAnomalies(asset._id);
  const flagged = useMemo(() => flaggedParameters(anomalies), [anomalies]);
  const fields = cardFields(asset);
  return (
    <article
      className={cn(
        'relative flex h-full flex-col rounded-xl border bg-surface shadow-card transition-colors hover:border-border-strong has-[a:focus-visible]:ring-2 has-[a:focus-visible]:ring-ring',
        BORDER[status] ?? 'border-border',
      )}
    >
      <div className="flex items-start gap-3 p-4 pb-3">
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-semibold text-fg">
            <Link
              to={`/machines/${asset._id}`}
              className="after:absolute after:inset-0 after:z-10 after:rounded-xl focus-visible:outline-none"
            >
              {asset.name}
            </Link>
          </h3>
          <p className="mt-0.5 truncate text-xs text-muted">
            {asset.assetTag && <span className="font-mono">{asset.assetTag} · </span>}
            {asset.typeOfAsset}
          </p>
          <StatusLine status={status} since={live?.since ?? asset.assetStatusSince} className="mt-2.5" />
          {anomalies.length > 0 && <AnomalyBadge anomalies={anomalies} flagged={flagged} />}
        </div>
        <HealthRing score={asset.healthScore} />
      </div>
      {fields.length > 0 && (
        <dl className="space-y-2 border-t border-border px-4 py-3">
          {fields.map(({ field, unit }) => (
            <KeyParam
              key={field}
              field={field}
              unit={unit}
              value={live?.values?.[field]}
              points={live?.history?.[field]}
              flag={flagged.find((f) => f.param.field === field)}
            />
          ))}
        </dl>
      )}
      <Footer asset={asset} valuesAt={live?.valuesAt} hasFields={fields.length > 0} />
    </article>
  );
});

export const MachineCardSkeleton = () => (
  <div className="rounded-xl border border-border bg-surface p-4 shadow-card">
    <Skeleton className="h-4 w-28" />
    <Skeleton className="mt-2 h-3 w-40" />
    <Skeleton className="mt-3 h-5 w-24" />
    <div className="mt-4 space-y-2.5 border-t border-border pt-3">
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-full" />
    </div>
  </div>
);
