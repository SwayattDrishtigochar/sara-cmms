import { BellRing, CircleAlert, CircleCheck, CircleDashed, CirclePause, Sparkles } from 'lucide-react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { useAssistant } from '../assistant/useAssistant.js';
import { useCan } from '../auth/useAuth.js';
import { cn, formatMoney, formatRelative, refLabel } from '../lib/format.js';
import { useSaveRecord } from '../modules/useModules.js';
import { Sparkline } from '../ui/charts.jsx';
import { Badge, Button, Card, CardHeader, EmptyState, Skeleton } from '../ui/core.jsx';
import { Switch } from '../ui/form.jsx';
import { useCheckAlert, useCostAlerts } from './useCosts.js';

const METRIC = {
  energy: 'Energy cost',
  spares: 'Spare parts cost',
  consumables: 'Consumables cost',
  labour: 'Labour cost',
  downtime: 'Downtime cost',
  maintenance: 'Maintenance cost',
  total: 'Total cost',
};
const COMPARE = {
  gt: { text: 'above', test: (v, t) => v > t },
  gte: { text: 'at or above', test: (v, t) => v >= t },
  lt: { text: 'below', test: (v, t) => v < t },
  lte: { text: 'at or below', test: (v, t) => v <= t },
};
const PER = { day: 'a day', week: 'a week', month: 'a month' };

/** Opens the assistant with the start of an alert request. */
export const askForAlert = () => useAssistant.getState().open({ text: 'Alert me if ' });

const scopeLabel = (a) =>
  a.scope === 'company'
    ? 'Whole company'
    : a.scope === 'plant'
      ? refLabel(a.plantId)
      : a.assetId
        ? refLabel(a.assetId)
        : 'Asset';

/** Paused, not checked yet, breached or within the limit; icon + label, never colour alone. */
export const alertStatus = (a) => {
  if (a.enabled === false) return { tone: 'off', icon: CirclePause, label: 'Paused' };
  if (a.lastValue == null) return { tone: 'neutral', icon: CircleDashed, label: 'Not checked yet' };
  const cmp = COMPARE[a.comparator ?? 'gt'] ?? COMPARE.gt;
  return cmp.test(a.lastValue, a.threshold)
    ? { tone: 'critical', icon: BellRing, label: 'Limit crossed', breached: true }
    : { tone: 'success', icon: CircleCheck, label: 'Within limit' };
};

/** Last value against the threshold: the scale runs to whichever is larger (+25 % headroom). */
const Meter = ({ alert, breached }) => {
  const value = alert.lastValue ?? 0;
  const max = Math.max(alert.threshold * 1.25, value) || 1;
  return (
    // biome-ignore lint/a11y/useSemanticElements: a native <meter> cannot draw the threshold mark
    <div
      role="meter"
      aria-label={`${alert.name}: last value against the limit`}
      aria-valuemin={0}
      aria-valuemax={Math.round(max)}
      aria-valuenow={Math.round(value)}
      aria-valuetext={`${formatMoney(alert.lastValue)} of a ${formatMoney(alert.threshold)} limit`}
      className="relative h-2 rounded-full bg-surface-3"
    >
      <div
        className={cn('h-full rounded-full', breached ? 'bg-critical' : 'bg-brand')}
        style={{ width: `${(value / max) * 100}%` }}
      />
      <div
        className="absolute -top-1 h-4 w-0.5 rounded bg-fg"
        style={{ left: `${(alert.threshold / max) * 100}%` }}
        aria-hidden
      />
    </div>
  );
};

const History = ({ history }) => {
  const rows = [...history].reverse();
  return (
    <details className="group mt-2">
      <summary className="cursor-pointer rounded text-xs font-medium text-muted hover:text-fg">
        History ({history.length})
      </summary>
      <ul className="mt-2 space-y-2">
        {rows.map((h) => (
          <li key={`${h.periodKey}-${h.triggeredAt}`} className="rounded-lg bg-surface-2 px-3 py-2 text-xs">
            <p className="flex flex-wrap gap-x-2 text-fg">
              <span className="font-medium tabular">{formatMoney(h.value)}</span>
              <span className="text-subtle">limit {formatMoney(h.threshold)}</span>
              <span className="text-subtle">· {h.periodKey}</span>
              <span className="text-subtle">· {formatRelative(h.triggeredAt)}</span>
            </p>
            {h.explanation && (
              <p className="mt-1 flex gap-1.5 text-muted">
                <Sparkles className="mt-0.5 size-3 shrink-0 text-ai" aria-hidden />
                <span>
                  {h.explanation}
                  {h.model && <span className="text-subtle"> · {h.model}</span>}
                </span>
              </p>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
};

const AlertRow = ({ alert, canToggle, canCheck, save, check }) => {
  const pending = save.isPending && save.variables?.id === alert._id;
  const enabled = pending ? save.variables.data.enabled : alert.enabled !== false;
  const status = alertStatus({ ...alert, enabled });
  const history = alert.history ?? [];
  const points = history.map((h) => [Date.parse(h.triggeredAt), h.value]).filter(([t]) => !Number.isNaN(t));
  const cmp = COMPARE[alert.comparator] ?? COMPARE.gt;

  const toggle = (next) =>
    save.mutate(
      { id: alert._id, data: { enabled: next } },
      {
        onSuccess: () => toast.success(next ? `${alert.name} is on` : `${alert.name} is paused`),
        onError: (err) => toast.error(`Couldn't change ${alert.name}: ${err.message}`),
      },
    );
  const checkNow = () =>
    check.mutate(alert._id, {
      onSuccess: (r) =>
        r.fired
          ? toast.warning(`${alert.name}: ${formatMoney(r.value)}, limit crossed. Notification sent.`)
          : r.breached
            ? toast.info(`${alert.name}: ${formatMoney(r.value)}, still past the limit (already notified).`)
            : toast.success(`${alert.name}: ${formatMoney(r.value)}, within the limit.`),
      onError: (err) => toast.error(`Couldn't check ${alert.name}: ${err.message}`),
    });

  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Link
              to={`/m/costalerts/${alert._id}`}
              className="truncate text-sm font-medium text-fg hover:underline"
            >
              {alert.name}
            </Link>
            <Badge tone={status.tone}>
              <status.icon className="size-3.5" aria-hidden />
              {status.label}
            </Badge>
          </div>
          <p className="mt-0.5 text-xs text-muted">
            {METRIC[alert.metric] ?? alert.metric} on {scopeLabel(alert)} {cmp.text}{' '}
            <span className="tabular">{formatMoney(alert.threshold)}</span> {PER[alert.period] ?? ''}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {canCheck && (
            <Button
              size="sm"
              variant="ghost"
              loading={check.isPending && check.variables === alert._id}
              onClick={checkNow}
            >
              Check now
            </Button>
          )}
          <Switch
            checked={enabled}
            disabled={!canToggle || pending}
            onChange={toggle}
            label={<span className="sr-only">{`Enable ${alert.name}`}</span>}
          />
        </div>
      </div>
      <div className="mt-2 grid gap-3 sm:grid-cols-[minmax(0,1fr)_8rem] sm:items-center">
        <div className="space-y-1.5">
          <Meter alert={alert} breached={status.breached} />
          <p className="flex flex-wrap gap-x-3 text-xs text-subtle">
            <span>
              Last value <span className="font-medium text-fg tabular">{formatMoney(alert.lastValue)}</span>
            </span>
            <span>Limit {formatMoney(alert.threshold)}</span>
            <span>Checked {alert.lastEvaluatedAt ? formatRelative(alert.lastEvaluatedAt) : 'never'}</span>
            <span>
              Last triggered {alert.lastTriggeredAt ? formatRelative(alert.lastTriggeredAt) : 'never'}
            </span>
          </p>
        </div>
        {points.length > 1 && (
          <Sparkline points={points} label={`${alert.name} value at each trigger`} unit="₹" />
        )}
      </div>
      {history.length > 0 && <History history={history} />}
    </li>
  );
};

/** Cost alerts: status, last value vs threshold, trigger history, enable toggle and "Check now". */
export const CostAlertsList = ({ canCheck }) => {
  const { data, isLoading, error, refetch } = useCostAlerts();
  const can = useCan('costalerts');
  const save = useSaveRecord('costalerts');
  const check = useCheckAlert();
  const alerts = data?.items ?? [];

  return (
    <Card>
      <CardHeader
        icon={BellRing}
        title="Cost alerts"
        subtitle="SARA checks these every 15 minutes and notifies you once per period."
        actions={
          alerts.length > 0 && (
            <Button size="sm" variant="ai" icon={Sparkles} onClick={askForAlert}>
              Create an alert with SARA
            </Button>
          )
        }
      />
      {isLoading ? (
        <div className="space-y-3 p-4">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : error ? (
        <div className="flex flex-wrap items-center justify-center gap-3 px-4 py-8 text-sm text-muted">
          <CircleAlert className="size-4 text-critical" aria-hidden />
          <span>Couldn't load the alerts: {error.message}</span>
          <Button size="sm" onClick={() => refetch()}>
            Retry
          </Button>
        </div>
      ) : !alerts.length ? (
        <EmptyState
          icon={BellRing}
          title="No cost alerts yet"
          action={
            <Button variant="ai" icon={Sparkles} onClick={askForAlert}>
              Create an alert with SARA
            </Button>
          }
        >
          Tell SARA what to watch, for example "Alert me if Compressor 2 energy cost goes over ₹3,000 a day".
        </EmptyState>
      ) : (
        <ul className="divide-y divide-border">
          {alerts.map((a) => (
            <AlertRow
              key={a._id}
              alert={a}
              canToggle={can.update}
              canCheck={canCheck}
              save={save}
              check={check}
            />
          ))}
        </ul>
      )}
    </Card>
  );
};
