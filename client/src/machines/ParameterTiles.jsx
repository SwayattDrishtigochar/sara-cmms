import { Activity, TriangleAlert } from 'lucide-react';
import { deviationOf, severityOf, typeLabel } from '../anomalies/parts.jsx';
import { cn, formatRelative } from '../lib/format.js';
import { useLiveAsset } from '../live/liveStore.js';
import { Sparkline } from '../ui/charts.jsx';
import { Card, CardHeader, Skeleton } from '../ui/core.jsx';
import { useNow } from './bits.jsx';
import {
  bandApplies,
  bandOf,
  bandState,
  bandText,
  fieldGroup,
  fieldLabel,
  formatValue,
  GROUP_ORDER,
} from './telemetry.js';

const TILE_GRID = 'grid grid-cols-[repeat(auto-fill,minmax(min(100%,8.25rem),1fr))] gap-3';

/** Meter domain around the normal band (open sides get a sensible edge), widened to fit the value. */
const meterScale = (band, value) => {
  let lo = band.min;
  let hi = band.max;
  if (lo == null) lo = hi > 0 ? 0 : hi - Math.abs(hi || 1);
  if (hi == null) hi = lo > 0 ? lo * 2 : lo + Math.abs(lo || 1);
  const pad = (hi - lo) * 0.35 || 1;
  const d0 = Math.min(lo - pad, value ?? lo);
  const d1 = Math.max(hi + pad, value ?? hi);
  const pos = (v) => ((v - d0) / (d1 - d0)) * 100;
  return { from: band.min == null ? 0 : pos(lo), to: band.max == null ? 100 : pos(hi), pos };
};

/** Track with the normal zone shaded and a tick at the value. Decorative: the caption says the same in words. */
const BandMeter = ({ value, band, out }) => {
  const { from, to, pos } = meterScale(band, value);
  return (
    <div className="relative mt-2.5 h-1.5 rounded-full bg-surface-3" aria-hidden>
      <div
        className="absolute inset-y-0 rounded-full bg-fg/20"
        style={{ left: `${from}%`, width: `${to - from}%` }}
      />
      {typeof value === 'number' && (
        <div
          className={cn(
            'absolute top-1/2 h-3.5 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-surface',
            out ? 'bg-warn' : 'bg-fg',
          )}
          style={{ left: `${pos(value)}%` }}
        />
      )}
    </div>
  );
};

/**
 * `value` is the current reading only: the live store drops readings older than 2 minutes, so a quiet field
 * shows "—". `flag` = { param, anomaly } when an open anomaly names this field: ring in its severity + reason.
 * `running`: the band is judged only then; on an idle or stopped machine it is shown as reference.
 */
const ParamTile = ({ spec, value, points, flag, running }) => {
  const label = fieldLabel(spec.field);
  const band = bandOf(spec);
  const state = bandState(value, band);
  const out = running && (state === 'low' || state === 'high');
  const s = flag && severityOf(flag.anomaly.severity);
  return (
    <div
      className={cn(
        'flex flex-col rounded-lg border p-3',
        s ? cn('ring-2', s.ring) : out ? 'border-warn/60 bg-warn/5' : 'border-border',
      )}
    >
      <p className="truncate text-xs text-muted" title={spec.field}>
        {label}
      </p>
      <p className="mt-1 flex items-baseline gap-1 whitespace-nowrap">
        <span key={points?.at(-1)?.[0]} className="animate-fade-in text-lg font-semibold text-fg tabular">
          {formatValue(value)}
        </span>
        {value != null && spec.unit && <span className="text-xs text-subtle">{spec.unit}</span>}
      </p>
      <Sparkline
        points={points}
        label={`${label}, last 15 minutes`}
        unit={spec.unit}
        tone={out ? 'warn' : undefined}
        className="mt-2"
      />
      {band && (
        <>
          <BandMeter value={value} band={band} out={out} />
          <p className="mt-1.5 text-[11px] leading-snug">
            {out && (
              <span className="flex items-center gap-1 font-medium text-fg">
                <TriangleAlert className="size-3.5 shrink-0 text-warn" aria-hidden />
                {state === 'high' ? 'Above normal' : 'Below normal'}
              </span>
            )}
            <span className="text-subtle">
              Normal{running ? '' : ' when running'} {bandText(band, spec.unit)}
            </span>
          </p>
        </>
      )}
      {s && (
        <p className="mt-1.5 flex items-start gap-1 text-[11px] leading-snug" title={flag.anomaly.summary}>
          <s.icon className={cn('mt-px size-3.5 shrink-0', s.text)} aria-hidden />
          <span className="min-w-0 text-fg">
            <span className="font-medium">
              {s.label}: {typeLabel(flag.anomaly.type)}
            </span>
            {deviationOf(flag.param) && (
              <span className="text-muted tabular"> · {deviationOf(flag.param)}</span>
            )}
          </span>
        </p>
      )}
    </div>
  );
};

/** Key fields first, then totals, then per-phase readings; otherwise the API order. */
const tileOrder = (a, b) =>
  Number(Boolean(b.key)) - Number(Boolean(a.key)) ||
  Number(/PH-\d/.test(a.field)) - Number(/PH-\d/.test(b.field));

/**
 * Live tiles for every numeric field of a machine, grouped into Machine / Energy / Production. `flagged`:
 * Map field → { param, anomaly } of the open anomalies (AnomalyCard's flaggedParameters).
 */
export const ParameterTiles = ({ assetId, fields, loading, error, flagged }) => {
  const live = useLiveAsset(assetId);
  useNow(15_000);
  const running = bandApplies(live?.status);
  const groups = GROUP_ORDER.map((name) => ({
    name,
    items: fields.filter((f) => fieldGroup(f.measurement) === name).sort(tileOrder),
  })).filter((g) => g.items.length);

  return (
    <Card>
      <CardHeader
        icon={Activity}
        title="Live parameters"
        subtitle={
          live?.valuesAt
            ? `Updated ${formatRelative(live.valuesAt)} · last 15 minutes`
            : 'Waiting for the first reading'
        }
      />
      <div className="space-y-5 p-3 sm:p-4">
        {loading && (
          <div className={TILE_GRID}>
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-28" />
            ))}
          </div>
        )}
        {error && (
          <p className="text-sm text-critical">Couldn't load this machine's parameters: {error.message}</p>
        )}
        {!loading && !error && !groups.length && (
          <p className="text-sm text-muted">This machine hasn't reported any numeric readings yet.</p>
        )}
        {groups.map((g) => (
          <section key={g.name} aria-label={`${g.name} readings`}>
            {groups.length > 1 && (
              <h4 className="mb-2 text-[11px] font-semibold tracking-wide text-subtle uppercase">{g.name}</h4>
            )}
            <div className={TILE_GRID}>
              {g.items.map((spec) => (
                <ParamTile
                  key={`${spec.measurement}:${spec.field}`}
                  spec={spec}
                  value={live?.values?.[spec.field]}
                  points={live?.history?.[spec.field]}
                  flag={flagged?.get(spec.field)}
                  running={running}
                />
              ))}
            </div>
          </section>
        ))}
      </div>
    </Card>
  );
};
