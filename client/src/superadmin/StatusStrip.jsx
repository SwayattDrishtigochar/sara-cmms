import { Cpu, History, Pause, PowerOff, Radio, TriangleAlert } from 'lucide-react';
import { cn, formatDuration, formatNumber } from '../lib/format.js';
import { Badge, Card, EmptyState, Skeleton } from '../ui/core.jsx';
import { Callout, Section, Stat } from './parts.jsx';
import { ago, splitError } from './simUtils.js';

/** An error older than this on a streaming simulator is shown as recovered, not as a warning. */
const STALE_ERROR_MS = 10 * 60_000;

/** What the simulator is doing right now, in words (never colour alone). */
const runState = (instance) => {
  if (!instance.online) return { label: 'Offline', tone: 'off', icon: PowerOff };
  if (instance.stats?.backfill?.active) {
    const pct = Math.round((instance.stats.backfill.progress ?? 0) * 100);
    return { label: `Backfilling · ${pct}%`, tone: 'info', icon: History };
  }
  return instance.stats?.running
    ? { label: 'Streaming', tone: 'running', icon: Radio }
    : { label: 'Paused', tone: 'idle', icon: Pause };
};

const InstanceCard = ({ instance, now }) => {
  const s = instance.stats ?? {};
  const people = s.people ?? {};
  const state = runState(instance);
  const seen = ago(instance.lastSeenAt, now);
  const hot = s.cpuTempC >= 75;
  const error = s.lastError ? splitError(s.lastError) : null;
  const errorAgo = error && ago(error.at, now);
  const recovered = errorAgo && state.tone === 'running' && now - new Date(error.at) > STALE_ERROR_MS;
  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold text-fg">{instance.name || instance.id}</h3>
          <p className="mt-1 flex flex-wrap items-center gap-x-1.5 text-xs text-muted">
            <span className="relative flex size-2" aria-hidden>
              {instance.online && (
                <span className="absolute inset-0 animate-ping rounded-full bg-running opacity-60" />
              )}
              <span
                className={cn('relative size-2 rounded-full', instance.online ? 'bg-running' : 'bg-off')}
              />
            </span>
            <span className={cn('font-medium', instance.online ? 'text-running' : 'text-fg')}>
              {instance.online ? 'Online' : 'Offline'}
            </span>
            <span className="tabular">· {seen ? `last seen ${seen}` : 'never seen'}</span>
          </p>
          <p className="mt-1 truncate text-xs text-subtle">
            {[instance.version && `v${instance.version}`, instance.platform, instance.hostname]
              .filter(Boolean)
              .join(' · ') || 'No version reported'}
          </p>
        </div>
        <Badge tone={state.tone}>
          <state.icon className="size-3.5" aria-hidden />
          {state.label}
        </Badge>
      </div>
      {instance.online && (
        <dl className="grid grid-cols-2 gap-px border-t border-border bg-border min-[480px]:grid-cols-4 xl:grid-cols-8">
          <Stat label="Uptime">{s.uptimeSec == null ? '—' : formatDuration(s.uptimeSec)}</Stat>
          <Stat label="Points / s">{formatNumber(s.pointsPerSec, { digits: 1 })}</Stat>
          <Stat label="Buffered">
            {formatNumber(s.bufferSize, { digits: 0 })}
            {s.droppedPoints > 0 && (
              <span className="text-warn"> · {formatNumber(s.droppedPoints, { digits: 0 })} dropped</span>
            )}
          </Stat>
          <Stat label="CPU temp">
            <span className={cn(hot && 'text-warn')}>
              {formatNumber(s.cpuTempC, { digits: 1, unit: '°C' })}
              {hot && ' · hot'}
            </span>
          </Stat>
          <Stat label="People on shift">{formatNumber(people.onShift, { digits: 0 })}</Stat>
          <Stat label="Busy now">{formatNumber(people.busy, { digits: 0 })}</Stat>
          <Stat label="Actions today">{formatNumber(people.actionsToday, { digits: 0 })}</Stat>
          <Stat label="Activity speed">{s.humanSpeed == null ? '—' : `${s.humanSpeed}×`}</Stat>
        </dl>
      )}
      {recovered ? (
        <p className="wrap-break-word border-t border-border px-4 py-2 text-xs text-subtle">
          Recovered · last error {errorAgo}: {error.message}
        </p>
      ) : (
        error && (
          <div className="border-t border-border p-3">
            <Callout tone="warn" icon={TriangleAlert}>
              <span className="font-medium">Last error{errorAgo ? ` (${errorAgo})` : ''}:</span>{' '}
              <span className="wrap-break-word text-muted">{error.message}</span>
            </Callout>
          </div>
        )
      )}
    </Card>
  );
};

/** Section (a): every simulator that has reported, newest heartbeat first. */
export const StatusStrip = ({ instances, now }) => (
  <Section
    id="sim-status"
    icon={Cpu}
    title="Simulator"
    description="The plant simulator writes machine readings and people's work straight into MongoDB and InfluxDB."
  >
    {!instances ? (
      <Card className="space-y-3 p-4">
        <Skeleton className="h-5 w-48" />
        <Skeleton className="h-12 w-full" />
      </Card>
    ) : instances.length === 0 ? (
      <Card>
        <EmptyState icon={Cpu} title="No simulator has reported yet">
          Start sara-simulator with the same MongoDB and InfluxDB as this server. It checks in here every few
          seconds.
        </EmptyState>
      </Card>
    ) : (
      <div className="space-y-3">
        {instances.map((i) => (
          <InstanceCard key={i.id ?? i._id} instance={i} now={now} />
        ))}
      </div>
    )}
  </Section>
);
