import { Activity, CircleCheck, Eraser, EyeOff, History, Hourglass, Radar, Wrench } from 'lucide-react';
import { Link } from 'react-router';
import { anomalyPath } from '../anomalies/parts.jsx';
import { formatDateTime } from '../lib/format.js';
import { Badge, Card, CardHeader, EmptyState, Skeleton } from '../ui/core.jsx';
import { QueryError } from './parts.jsx';
import { ago, humanize, injectionState, outcomeOf, phaseLabel, scenarioLabel, span } from './simUtils.js';

const LOOK = {
  active: { tone: 'warn', icon: Activity },
  repair: { tone: 'success', icon: Wrench },
  superadmin: { tone: 'off', icon: Eraser },
  ended: { tone: 'neutral', icon: CircleCheck },
};
const th = 'px-4 py-2.5 font-medium whitespace-nowrap';
/** Server-side grace (ai/anomaly/scoring.js): after this, an ended injection counts as missed. */
const GRACE_MS = 30 * 60_000;

/** Did SARA's AI catch it: the first matching anomaly with its latency and matched fields, or how long it has waited. */
export const Detection = ({ event, now }) => {
  const d = event.detection;
  if (d) {
    return (
      <div className="min-w-0 space-y-1">
        <Badge tone="success">
          <Radar className="size-3.5" aria-hidden />
          Detected in {span(d.latencySec)}
        </Badge>
        <p className="flex flex-wrap items-center gap-1 text-xs text-muted">
          <Link to={anomalyPath(d.anomalyId)} className="font-mono font-medium text-brand hover:underline">
            {d.code ?? 'Anomaly'}
          </Link>
          {d.matchedFields?.length > 0 && (
            <>
              <span>flagged</span>
              {d.matchedFields.map((f) => (
                <Badge key={f} tone="neutral" className="font-mono text-[11px]">
                  {f}
                </Badge>
              ))}
            </>
          )}
        </p>
      </div>
    );
  }
  const endedAt = new Date(event.clearedAt ?? event.endsAt ?? now).getTime();
  if (event.active || now - endedAt < GRACE_MS) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-muted tabular" aria-live="off">
        <Hourglass className="size-3.5 motion-safe:animate-pulse" aria-hidden />
        Waiting for SARA · {span((now - new Date(event.startedAt).getTime()) / 1000)}
      </span>
    );
  }
  return (
    <Badge tone="neutral">
      <EyeOff className="size-3.5" aria-hidden />
      Not detected
    </Badge>
  );
};

/**
 * Injection ground truth (simevents), newest first, with how each one ended.
 * The detection column scores the AI: first matching anomaly, latency and the fields it matched.
 */
export const InjectionHistory = ({ query, catalogue, now }) => {
  const events = query.data;
  return (
    <Card className="overflow-hidden">
      <CardHeader
        icon={History}
        title="Recent injections"
        subtitle="Ground truth for scoring detection. Only superadmins see this list, never the AI."
      />
      {query.isError && !events ? (
        <QueryError what="injections" error={query.error} onRetry={query.refetch} />
      ) : events?.length === 0 ? (
        <EmptyState icon={History} title="No injections yet">
          Everything you inject is recorded here, so SARA's detection can be checked against it.
        </EmptyState>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-surface-2 text-left text-xs text-muted">
              <tr>
                <th scope="col" className={th}>
                  Machine
                </th>
                <th scope="col" className={`${th} hidden sm:table-cell`}>
                  Scenario
                </th>
                <th scope="col" className={`${th} hidden sm:table-cell`}>
                  Severity
                </th>
                <th scope="col" className={`${th} hidden lg:table-cell`}>
                  Ramp · hold
                </th>
                <th scope="col" className={`${th} hidden md:table-cell`}>
                  Started
                </th>
                <th scope="col" className={th}>
                  Outcome
                </th>
                <th scope="col" className={th}>
                  AI detection
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {!events &&
                [0, 1, 2].map((i) => (
                  <tr key={i}>
                    <td className="px-4 py-3" colSpan={7}>
                      <Skeleton className="h-5 w-full" />
                    </td>
                  </tr>
                ))}
              {events?.map((e) => {
                const outcome = outcomeOf(e);
                const look = LOOK[outcome.kind];
                const label = scenarioLabel(e.scenario, catalogue);
                const text =
                  outcome.kind === 'active'
                    ? `${outcome.label} · ${phaseLabel(injectionState(e, now).phase).toLowerCase()}`
                    : outcome.label;
                return (
                  <tr key={e.id}>
                    <td className="px-4 py-3">
                      <p className="font-medium text-fg">{e.assetName ?? 'Unknown machine'}</p>
                      <p className="mt-0.5 text-xs text-muted sm:hidden">
                        {label} · {humanize(e.severity)} · {ago(e.startedAt, now)}
                      </p>
                    </td>
                    <td className="hidden px-4 py-3 sm:table-cell">
                      <p className="text-fg">{label}</p>
                      {e.affects?.length > 0 && (
                        <p className="mt-1 flex flex-wrap gap-1">
                          {e.affects.map((f) => (
                            <Badge key={f} tone="neutral" className="font-mono text-[11px]">
                              {f}
                            </Badge>
                          ))}
                        </p>
                      )}
                    </td>
                    <td className="hidden px-4 py-3 sm:table-cell">
                      <Badge value={e.severity}>{humanize(e.severity)}</Badge>
                    </td>
                    <td className="hidden px-4 py-3 whitespace-nowrap text-muted tabular lg:table-cell">
                      {e.rampMin ?? '—'} min · {e.holdMin ?? '—'} min
                    </td>
                    <td
                      className="hidden px-4 py-3 whitespace-nowrap text-muted tabular md:table-cell"
                      title={formatDateTime(e.startedAt)}
                    >
                      {ago(e.startedAt, now)}
                    </td>
                    <td className="px-4 py-3">
                      <Badge tone={look.tone}>
                        <look.icon className="size-3.5" aria-hidden />
                        {text}
                      </Badge>
                      {e.clearedAt && (
                        <p className="mt-1 text-xs text-subtle tabular" title={formatDateTime(e.clearedAt)}>
                          {ago(e.clearedAt, now)}
                        </p>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <Detection event={e} now={now} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
};
