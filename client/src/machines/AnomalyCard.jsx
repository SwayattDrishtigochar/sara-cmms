import { Activity, ScanSearch, ShieldCheck } from 'lucide-react';
import { useMemo } from 'react';
import { Link } from 'react-router';
import {
  deviationOf,
  ParamChip,
  ScanProvenance,
  StateBadge,
  severityOf,
  typeLabel,
} from '../anomalies/parts.jsx';
import { isActive, useHealth, useScan } from '../anomalies/useAnomalies.js';
import { useSession } from '../auth/useAuth.js';
import { cn, formatRelative } from '../lib/format.js';
import { useLiveAsset } from '../live/liveStore.js';
import { Button, Card, CardHeader, Skeleton } from '../ui/core.jsx';
import { Tooltip } from '../ui/overlay.jsx';
import { fieldLabel, formatValue } from './telemetry.js';

const RECENT = 5;

/** "rising" / "falling" when the last 5 minutes moved more than 2 %; null when flat or unknown. */
export const trendOf = (points = [], windowMs = 5 * 60_000) => {
  if (points.length < 2) return null;
  const [tEnd, vEnd] = points[points.length - 1];
  const from = points.find(([t]) => t >= tEnd - windowMs) ?? points[0];
  if (from[0] >= tEnd) return null;
  const delta = vEnd - from[1];
  if (Math.abs(delta) <= Math.abs(from[1]) * 0.02) return null;
  return delta > 0 ? 'rising' : 'falling';
};

/** "Scan now" for owners and admins; nothing for everyone else. */
export const ScanButton = ({ size = 'sm' }) => {
  const ctx = useSession();
  const scan = useScan();
  if (!['owner', 'admin'].includes(ctx?.role)) return null;
  return (
    <Button size={size} icon={ScanSearch} loading={scan.isPending} onClick={() => scan.mutate()}>
      Scan now
    </Button>
  );
};

const Row = ({ anomaly, onOpen }) => {
  const s = severityOf(anomaly.severity);
  return (
    <li>
      <button
        type="button"
        onClick={() => onOpen?.(anomaly._id)}
        className="block w-full px-4 py-3 text-left transition-colors hover:bg-surface-2/70 focus-visible:bg-surface-2 focus-visible:outline-none"
      >
        <span className="flex items-center justify-between gap-2">
          <span className="flex min-w-0 items-center gap-1.5 text-sm font-medium text-fg">
            <s.icon className={cn('size-4 shrink-0', s.text)} aria-hidden />
            <span className="sr-only">{s.label}: </span>
            <span className="truncate">{typeLabel(anomaly.type)}</span>
          </span>
          <StateBadge state={anomaly.state} />
        </span>
        {anomaly.summary && (
          <span className="mt-1 line-clamp-2 block text-xs text-muted">{anomaly.summary}</span>
        )}
        {isActive(anomaly) && anomaly.parameters?.length > 0 && (
          <span className="mt-1.5 flex flex-wrap gap-1">
            {anomaly.parameters.map((p) => (
              <ParamChip key={p.field} param={p} severity={anomaly.severity} />
            ))}
          </span>
        )}
        <span className="mt-1 block text-[11px] text-subtle">
          {isActive(anomaly) ? 'Detected' : 'Resolved'}{' '}
          {formatRelative(anomaly.resolvedAt ?? anomaly.detectedAt)}
        </span>
      </button>
    </li>
  );
};

/** Open anomalies first, then the last few resolved ones; "Scan now" for owners and admins. */
export const AnomalyCard = ({ assetId, onOpen }) => {
  const health = useHealth(assetId);
  const items = health.data?.anomalies ?? [];
  const open = items.filter(isActive);
  const recent = items.filter((a) => !isActive(a)).slice(0, RECENT);
  return (
    <Card>
      <CardHeader
        icon={Activity}
        title="Anomalies"
        subtitle={open.length ? `${open.length} open` : 'Nothing open'}
        actions={<ScanButton />}
      />
      {health.isLoading ? (
        <div className="space-y-3 p-4">
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-4 w-1/2" />
        </div>
      ) : health.isError ? (
        <p className="px-4 py-5 text-sm text-critical">Couldn't load anomalies: {health.error.message}</p>
      ) : !items.length ? (
        <p className="flex items-center gap-2 px-4 py-5 text-sm text-muted">
          <ShieldCheck className="size-4 shrink-0 text-subtle" aria-hidden />
          SARA hasn't flagged anything on this machine.
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {[...open, ...recent].map((a) => (
            <Row key={a._id} anomaly={a} onOpen={onOpen} />
          ))}
        </ul>
      )}
      <Link
        to="/anomalies"
        className="block border-t border-border px-4 py-2 text-xs font-medium text-brand hover:underline"
      >
        All anomalies
      </Link>
    </Card>
  );
};

/** Parameters of open anomalies, worst severity first per field. */
export const flaggedParameters = (anomalies = []) => {
  const byField = new Map();
  for (const anomaly of anomalies.filter(isActive)) {
    for (const param of anomaly.parameters ?? []) {
      const prev = byField.get(param.field);
      if (!prev || severityOf(anomaly.severity).rank > severityOf(prev.anomaly.severity).rank) {
        byField.set(param.field, { param, anomaly });
      }
    }
  }
  return [...byField.values()];
};

/**
 * The parameters SARA flagged, grouped by anomaly: the reason (its summary) in words, a tile per parameter
 * with the live value, the AI's deviation ("+4.2σ, rising") and the expected value, and who decided it when.
 * Sits above the live parameter tiles; renders nothing when all is well.
 */
export const FlaggedParameters = ({ assetId, onOpen }) => {
  const health = useHealth(assetId);
  const live = useLiveAsset(assetId);
  const groups = useMemo(() => {
    const byAnomaly = new Map();
    for (const item of flaggedParameters(health.data?.anomalies)) {
      const group = byAnomaly.get(item.anomaly._id) ?? { anomaly: item.anomaly, params: [] };
      group.params.push(item.param);
      byAnomaly.set(item.anomaly._id, group);
    }
    return [...byAnomaly.values()];
  }, [health.data]);
  if (!groups.length) return null;
  const worst = severityOf(
    groups.reduce(
      (w, g) => (severityOf(g.anomaly.severity).rank > severityOf(w).rank ? g.anomaly.severity : w),
      'info',
    ),
  );
  const count = groups.reduce((n, g) => n + g.params.length, 0);
  return (
    <section
      aria-label="Parameters flagged by SARA"
      className={cn('rounded-xl border p-3 sm:p-4', worst.soft)}
    >
      <h3 className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-semibold text-fg">
        <worst.icon className={cn('size-4', worst.text)} aria-hidden />
        Flagged by SARA
        <span className="text-xs font-normal text-muted">
          {count} {count === 1 ? 'parameter' : 'parameters'} out of normal
        </span>
      </h3>
      <div className="mt-3 space-y-4">
        {groups.map(({ anomaly, params }) => {
          const s = severityOf(anomaly.severity);
          return (
            <div key={anomaly._id}>
              <p className="text-sm text-fg">
                <span className="font-medium">{typeLabel(anomaly.type)}:</span>{' '}
                <span className="text-muted">{anomaly.summary}</span>
              </p>
              <div className="mt-2 grid grid-cols-[repeat(auto-fill,minmax(min(100%,8.5rem),1fr))] gap-3">
                {params.map((param) => {
                  const value = live?.values?.[param.field];
                  const deviation = [deviationOf(param), trendOf(live?.history?.[param.field])]
                    .filter(Boolean)
                    .join(', ');
                  return (
                    <Tooltip key={param.field} content={anomaly.explanation || anomaly.summary}>
                      <button
                        type="button"
                        onClick={() => onOpen?.(anomaly._id)}
                        aria-label={`${fieldLabel(param.field)}: ${s.label.toLowerCase()}, ${deviation || typeLabel(anomaly.type)}. Open ${anomaly.anomalyCode ?? 'the anomaly'}`}
                        className={cn(
                          'rounded-lg border bg-surface p-3 text-left shadow-card ring-2 transition-colors hover:bg-surface-2',
                          s.ring,
                        )}
                      >
                        <span className="flex items-center justify-between gap-2 text-xs text-muted">
                          <span className="truncate" title={param.field}>
                            {fieldLabel(param.field)}
                          </span>
                          <s.icon className={cn('size-3.5 shrink-0', s.text)} aria-hidden />
                        </span>
                        <span className="mt-1 flex items-baseline gap-1 whitespace-nowrap">
                          <span className="text-lg font-semibold text-fg tabular">
                            {formatValue(typeof value === 'number' ? value : param.observed)}
                          </span>
                          {param.unit && <span className="text-xs text-subtle">{param.unit}</span>}
                        </span>
                        <span className="mt-1 block text-xs font-medium text-fg tabular">
                          {deviation || typeLabel(anomaly.type)}
                          <span className="font-normal text-muted"> · {s.label}</span>
                        </span>
                        {typeof param.expected === 'number' && (
                          <span className="mt-0.5 block text-[11px] text-subtle tabular">
                            Expected {formatValue(param.expected)}
                            {param.unit ? ` ${param.unit}` : ''}
                          </span>
                        )}
                      </button>
                    </Tooltip>
                  );
                })}
              </div>
              <ScanProvenance
                model={anomaly.model}
                at={formatRelative(anomaly.lastSeenAt ?? anomaly.detectedAt)}
                className="mt-2"
              />
            </div>
          );
        })}
      </div>
    </section>
  );
};
