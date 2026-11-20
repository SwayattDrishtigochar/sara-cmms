import { ArrowRight, CircleAlert, CircleCheck, RefreshCw, Sparkles, TriangleAlert } from 'lucide-react';
import { cn, formatNumber, formatRelative } from '../lib/format.js';
import { fieldLabel, formatValue } from '../machines/telemetry.js';
import { AiProvenance, Badge, Button, Card, CardHeader, Skeleton } from '../ui/core.jsx';
import { isAiDown, OPTIMIZER_TYPES, useOptimizer } from './useOptimizer.js';

const finite = Number.isFinite;

/** "+4.0" / "-4.0" with fixed decimals; "—" when unknown. */
export const signed = (n, digits = 1) =>
  finite(n)
    ? new Intl.NumberFormat('en-IN', {
        signDisplay: 'exceptZero',
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      }).format(n)
    : '—';

/** % change from a to b; null when either is unknown or a is 0. */
const pctChange = (a, b) => (finite(a) && finite(b) && a !== 0 ? ((b - a) / a) * 100 : null);

/** Where a value sits on a track spanning the normal band and both values, with a little air: 0–100. */
export const bandScale = ({ normalMin, normalMax, current, recommended }) => {
  const values = [normalMin, normalMax, current, recommended].filter(finite);
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const pad = (hi - lo) * 0.1 || 1;
  return (v) => ((v - lo + pad) / (hi - lo + 2 * pad)) * 100;
};

const FromTo = ({ from, to, unit, className }) => (
  <p className={cn('flex flex-wrap items-center gap-x-1.5 tabular', className)}>
    <span className="text-sm text-muted">{from}</span>
    <ArrowRight className="size-3.5 shrink-0 text-subtle" aria-hidden />
    <span className="sr-only">to</span>
    {to}
    {unit && <span className="text-xs text-subtle">{unit}</span>}
  </p>
);

const Metric = ({ label, from, to, unit, change, good }) => (
  <div className="min-w-0 rounded-lg border border-border bg-surface-2/60 p-3">
    <p className="text-xs text-muted">{label}</p>
    <FromTo
      className="mt-1"
      from={from}
      to={<span className="text-lg font-semibold text-fg">{to}</span>}
      unit={unit}
    />
    {finite(change) && (
      <Badge tone={good ? 'success' : 'warn'} className="mt-1.5 tabular">
        {signed(change)} %
      </Badge>
    )}
  </div>
);

const Gain = ({ extra, shiftHours, className }) => (
  <div className={cn('min-w-0 rounded-lg border border-success/30 bg-success/5 p-3', className)}>
    <p className="flex flex-wrap items-baseline gap-x-1.5">
      <span className="text-3xl font-semibold tracking-tight text-success tabular">
        {signed(finite(extra) ? Math.round(extra) : null, 0)}
      </span>
      <span className="text-sm font-medium text-fg">parts per shift</span>
    </p>
    {finite(shiftHours) && (
      <p className="mt-0.5 text-xs text-muted">{shiftHours} h shift at SARA's settings</p>
    )}
  </div>
);

const TICK = 'absolute top-1/2 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-surface';

/** Normal band shaded, a grey tick at the current value and a teal one at SARA's. The caption says it in words. */
const BandBar = ({ rec }) => {
  const { normalMin: min, normalMax: max, current, recommended } = rec;
  if (!finite(min) || !finite(max)) return null;
  const pos = bandScale(rec);
  const unit = rec.unit ? ` ${rec.unit}` : '';
  return (
    <>
      <div className="relative mt-3 h-1.5 rounded-full bg-surface-3" aria-hidden>
        <div
          className="absolute inset-y-0 rounded-full bg-fg/20"
          style={{ left: `${pos(min)}%`, width: `${pos(max) - pos(min)}%` }}
        />
        {finite(current) && (
          <div
            className={cn(TICK, 'h-3 bg-muted')}
            style={{ left: `${pos(current)}%` }}
            title={`Now ${formatValue(current)}${unit}`}
          />
        )}
        {finite(recommended) && (
          <div
            className={cn(TICK, 'h-4 bg-ai')}
            style={{ left: `${pos(recommended)}%` }}
            title={`SARA ${formatValue(recommended)}${unit}`}
          />
        )}
      </div>
      <p className="mt-1.5 text-[11px] text-subtle tabular">
        Normal {formatValue(min)}–{formatValue(max)}
        {unit}
      </p>
    </>
  );
};

const Recommendation = ({ rec }) => {
  const effect = rec.effectOnCycleTimePct;
  return (
    <li className="min-w-0 rounded-lg border border-border bg-surface p-3">
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 text-sm font-medium text-fg">{rec.label || fieldLabel(rec.field)}</p>
        {finite(effect) && (
          <Badge tone={effect <= 0 ? 'success' : 'warn'} className="tabular">
            {signed(effect)} % cycle
          </Badge>
        )}
      </div>
      <FromTo
        className="mt-1"
        from={formatValue(rec.current)}
        to={
          <span className="rounded-md bg-ai/10 px-1.5 py-0.5 text-sm font-semibold text-ai">
            {formatValue(rec.recommended)}
          </span>
        }
        unit={rec.unit}
      />
      <BandBar rec={rec} />
      {rec.reason && <p className="mt-2 text-xs leading-relaxed text-muted">{rec.reason}</p>}
      {rec.risk && (
        <p className="mt-1.5 flex items-start gap-1.5 text-[11px] text-muted">
          <TriangleAlert className="mt-px size-3 shrink-0 text-warn" aria-hidden />
          <span>
            <span className="sr-only">Risk: </span>
            {rec.risk}
          </span>
        </p>
      )}
    </li>
  );
};

const Result = ({ data, compact }) => {
  const now = data.current ?? {};
  const next = data.predicted ?? {};
  return (
    <div className="space-y-4 p-4">
      {data.headline && <p className="text-sm font-medium text-balance text-fg">{data.headline}</p>}
      <div className={cn('grid gap-2', compact ? 'grid-cols-2' : 'sm:grid-cols-3 sm:gap-3')}>
        <Metric
          label="Cycle time"
          from={formatValue(now.cycleTimeSec)}
          to={formatValue(next.cycleTimeSec)}
          unit="s"
          change={next.cycleTimeChangePct}
          good={next.cycleTimeChangePct <= 0}
        />
        <Metric
          label="Parts per hour"
          from={formatNumber(now.partsPerHour, { digits: 0 })}
          to={formatNumber(next.partsPerHour, { digits: 0 })}
          change={pctChange(now.partsPerHour, next.partsPerHour)}
          good={next.partsPerHour >= now.partsPerHour}
        />
        <Gain
          extra={next.extraPartsPerShift}
          shiftHours={data.shiftHours}
          className={compact && 'col-span-2'}
        />
      </div>
      <section aria-label="Settings to change">
        <h4 className="mb-2 text-xs font-semibold tracking-wide text-subtle uppercase">
          Change these settings
        </h4>
        <ul className={cn('grid gap-2', !compact && 'md:grid-cols-2 2xl:grid-cols-3')}>
          {data.recommendations.map((rec, i) => (
            <Recommendation key={`${rec.field}-${i}`} rec={rec} />
          ))}
        </ul>
      </section>
    </div>
  );
};

const Best = ({ data }) => (
  <div className="flex items-start gap-3 p-4 text-sm">
    <span className="grid size-8 shrink-0 place-items-center rounded-full bg-success/10 text-success">
      <CircleCheck className="size-4" aria-hidden />
    </span>
    <div className="min-w-0">
      <p className="font-medium text-fg">Already running close to its best settings</p>
      {data.headline && <p className="mt-0.5 text-muted">{data.headline}</p>}
      {finite(data.current?.cycleTimeSec) && (
        <p className="mt-1 text-xs text-muted tabular">
          Now {formatValue(data.current.cycleTimeSec)} s per cycle ·{' '}
          {formatNumber(data.current.partsPerHour, { digits: 0 })} parts per hour
        </p>
      )}
    </div>
  </div>
);

const Failed = ({ error, onRetry, retrying }) => (
  <div className="flex items-start gap-3 p-4 text-sm">
    <CircleAlert className="mt-0.5 size-4 shrink-0 text-critical" aria-hidden />
    <div className="min-w-0">
      <p className="font-medium text-fg">Couldn't get SARA's estimate</p>
      <p className="mt-0.5 text-muted">
        {isAiDown(error) ? "SARA's AI is unavailable right now. Try again in a minute." : error.message}
      </p>
      <Button size="sm" className="mt-3" onClick={onRetry} loading={retrying}>
        Try again
      </Button>
    </div>
  </div>
);

const Loading = ({ compact }) => (
  <div className="space-y-4 p-4" role="status" aria-label="SARA is working out better settings">
    <Skeleton className="h-4 w-3/4" />
    <div className={cn('grid gap-2', compact ? 'grid-cols-2' : 'sm:grid-cols-3 sm:gap-3')}>
      <Skeleton className="h-20" />
      <Skeleton className="h-20" />
      <Skeleton className={cn('h-20', compact && 'col-span-2')} />
    </div>
    <div className={cn('grid gap-2', !compact && 'md:grid-cols-2 2xl:grid-cols-3')}>
      <Skeleton className="h-32" />
      <Skeleton className="h-32" />
    </div>
  </div>
);

/**
 * SARA's settings to make more parts on one machine: cycle time and parts/hour now vs predicted, the extra parts
 * per shift, then each setting to change, inside its normal band. Nothing for machine types the optimizer
 * doesn't know. `compact`: narrow layout (3D shopfloor side panel).
 */
export const OptimizerCard = ({ assetId, assetType, compact = false }) => {
  const known = OPTIMIZER_TYPES.includes(assetType);
  const { query, refresh, refreshing } = useOptimizer(assetId, known);
  const data = query.data;
  if (!assetId || !known || data?.supported === false || query.error?.status === 403) return null;

  const job = data?.job;
  const jobText =
    job && [job.jobCardId, job.partName || job.jobName, job.toolName].filter(Boolean).join(' · ');
  let body;
  if (data)
    body = data.recommendations?.length ? <Result data={data} compact={compact} /> : <Best data={data} />;
  else if (query.isError)
    body = <Failed error={query.error} onRetry={() => query.refetch()} retrying={query.isFetching} />;
  else body = <Loading compact={compact} />;

  return (
    <Card ai className="min-w-0" aria-busy={refreshing || undefined}>
      <CardHeader
        icon={Sparkles}
        title="AI production boost"
        subtitle={
          <span className="mt-1 flex flex-wrap items-center gap-1.5">
            <Badge tone="ai">AI estimate</Badge>
            {data?.mock && <Badge>mock</Badge>}
            {jobText && <span className="min-w-0 truncate">{jobText}</span>}
          </span>
        }
        actions={
          data && (
            <Button
              variant="ghost"
              size="iconSm"
              icon={RefreshCw}
              loading={refreshing}
              onClick={refresh}
              aria-label="Ask SARA again"
              title="Ask SARA again"
            />
          )
        }
      />
      {body}
      {data?.notes?.length > 0 && (
        <ul className="list-disc space-y-0.5 pr-4 pb-3 pl-8 text-xs text-muted">
          {data.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}
      {data && (
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t border-border px-4 py-2">
          <AiProvenance
            model={data.model}
            at={data.generatedAt ? formatRelative(data.generatedAt) : undefined}
          />
          <span className="text-[11px] text-subtle">Values stay inside each parameter's normal band.</span>
        </div>
      )}
    </Card>
  );
};
