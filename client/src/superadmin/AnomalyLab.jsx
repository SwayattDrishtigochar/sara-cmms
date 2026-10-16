import { Activity, Ban, CircleCheck, Eraser, FlaskConical, PowerOff, Zap } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import { cn } from '../lib/format.js';
import { Badge, Button, Card, CardHeader, EmptyState, Skeleton } from '../ui/core.jsx';
import { Field, Input, Select } from '../ui/form.jsx';
import { Detection, InjectionHistory } from './InjectionHistory.jsx';
import { Callout, ProgressBar, Section, Segmented } from './parts.jsx';
import {
  applies,
  byType,
  humanize,
  injectionState,
  phaseLabel,
  scenarioLabel,
  span,
  timeLeft,
} from './simUtils.js';
import { useEvents, useSimAction, useSimAssets } from './useSim.js';

const SEVERITIES = ['low', 'medium', 'high'].map((value) => ({ value, label: humanize(value) }));
const minutes = (text, min, max) => {
  const n = text.trim() === '' ? Number.NaN : Number(text);
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
};

const ScenarioCard = ({ scenario, asset, name, checked, onPick }) => {
  const ok = applies(scenario, asset);
  return (
    <label
      className={cn(
        'flex flex-col gap-1.5 rounded-xl border p-3 transition-colors has-focus-visible:ring-2 has-focus-visible:ring-ring',
        checked ? 'border-brand bg-brand-soft/60' : 'border-border',
        ok ? 'cursor-pointer hover:border-border-strong' : 'cursor-not-allowed bg-surface-2/60',
      )}
    >
      <input
        type="radio"
        name={name}
        value={scenario.id}
        checked={checked}
        disabled={!ok}
        onChange={onPick}
        className="sr-only"
      />
      <span className="flex items-start justify-between gap-2">
        <span className={cn('text-sm font-medium', ok ? 'text-fg' : 'text-muted')}>{scenario.label}</span>
        {checked && <CircleCheck className="size-4 shrink-0 text-brand" aria-hidden />}
      </span>
      {scenario.description && <span className="text-xs text-muted">{scenario.description}</span>}
      {scenario.affects?.length > 0 && (
        <span className="flex flex-wrap gap-1">
          {scenario.affects.map((f) => (
            <Badge key={f} tone="neutral" className="font-mono text-[11px]">
              {f}
            </Badge>
          ))}
        </span>
      )}
      {!ok && (
        <span className="flex items-start gap-1 text-xs text-muted">
          <Ban className="mt-0.5 size-3 shrink-0" aria-hidden />
          Doesn't apply to {asset.name} ({asset.type}). Works on: {scenario.appliesTo.join(', ')}.
        </span>
      )}
    </label>
  );
};

/** Machine → scenario → severity and timing → Inject. */
const InjectPanel = ({ scenarios, statuses, online }) => {
  const action = useSimAction();
  const radioName = useId();
  const assetsQuery = useSimAssets();
  const [assetId, setAssetId] = useState('');
  const [scenarioId, setScenarioId] = useState('');
  const [severity, setSeverity] = useState('medium');
  const [rampText, setRampText] = useState('10');
  const [holdText, setHoldText] = useState('30');

  const assets = assetsQuery.data;
  const groups = useMemo(() => byType(assets), [assets]);
  const asset = assets?.find((a) => a.id === assetId);
  const scenario = scenarios.find((s) => s.id === scenarioId && applies(s, asset));
  const rampMin = minutes(rampText, 1, 240);
  const holdMin = minutes(holdText, 0, 1440);
  const canInject = online && asset && scenario && rampMin != null && holdMin != null;

  const inject = () =>
    action.mutate({
      path: '/inject',
      body: { assetId: asset.id, scenario: scenario.id, severity, rampMin, holdMin },
      success: `${scenario.label} injected on ${asset.name}`,
    });

  return (
    <Card className="flex min-w-0 flex-col">
      <CardHeader
        icon={Zap}
        title="Inject an anomaly"
        subtitle="The machine drifts out of its normal band; SARA's job is to notice."
      />
      <div className="flex-1 space-y-5 p-4">
        <Field
          label="Machine"
          error={assetsQuery.isError ? assetsQuery.error.message : null}
          help={assets?.length === 0 ? 'No machines yet. They appear after the simulator first runs.' : null}
        >
          {(a11y) => (
            <Select {...a11y} value={assetId} disabled={!assets} onChange={(e) => setAssetId(e.target.value)}>
              <option value="">
                {assets
                  ? 'Choose a machine'
                  : assetsQuery.isError
                    ? "Couldn't load machines"
                    : 'Loading machines…'}
              </option>
              {groups.map(([type, list]) => (
                <optgroup key={type} label={type}>
                  {list.map((a) => {
                    const status = statuses?.[a.id] ?? a.status;
                    return (
                      <option key={a.id} value={a.id}>
                        {a.name}
                        {a.tag ? ` (${a.tag})` : ''}
                        {status ? ` — ${status}` : ''}
                      </option>
                    );
                  })}
                </optgroup>
              ))}
            </Select>
          )}
        </Field>

        <fieldset>
          <legend className="mb-1.5 text-xs font-medium text-muted">Scenario</legend>
          {scenarios.length ? (
            <div className="grid gap-2 sm:grid-cols-2 2xl:grid-cols-3">
              {scenarios.map((s) => (
                <ScenarioCard
                  key={s.id}
                  scenario={s}
                  asset={asset}
                  name={`${radioName}-scenario`}
                  checked={scenario?.id === s.id}
                  onPick={() => setScenarioId(s.id)}
                />
              ))}
            </div>
          ) : (
            <p className="rounded-lg border border-dashed border-border px-3 py-3 text-xs text-muted">
              The scenarios come from the simulator and show up while it is online.
            </p>
          )}
        </fieldset>

        <div className="grid gap-4 sm:grid-cols-[auto_minmax(0,1fr)_minmax(0,1fr)]">
          <Segmented legend="Severity" options={SEVERITIES} value={severity} onChange={setSeverity} />
          <Field
            label="Ramp"
            help={rampMin == null ? null : 'Minutes to reach full strength'}
            error={rampMin == null ? 'Whole minutes, 1 to 240' : null}
          >
            {(a11y) => (
              <Input
                {...a11y}
                type="number"
                inputMode="numeric"
                min={1}
                max={240}
                suffix="min"
                value={rampText}
                onChange={(e) => setRampText(e.target.value)}
              />
            )}
          </Field>
          <Field
            label="Hold"
            help={holdMin == null ? null : 'Minutes at full strength'}
            error={holdMin == null ? 'Whole minutes, 0 to 1440' : null}
          >
            {(a11y) => (
              <Input
                {...a11y}
                type="number"
                inputMode="numeric"
                min={0}
                max={1440}
                suffix="min"
                value={holdText}
                onChange={(e) => setHoldText(e.target.value)}
              />
            )}
          </Field>
        </div>
      </div>

      <div className="flex flex-col gap-3 border-t border-border px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs text-muted" aria-live="polite">
          {!online
            ? 'Start the simulator to inject anomalies.'
            : canInject
              ? `${scenario.label} on ${asset.name}: ${severity} severity, ${rampMin} min ramp, ${holdMin} min hold.`
              : !asset
                ? 'Choose a machine, then a scenario.'
                : !scenario
                  ? 'Choose a scenario that fits this machine.'
                  : 'Check the ramp and hold minutes.'}
        </p>
        <Button
          variant="primary"
          icon={Zap}
          loading={action.isPending}
          disabled={!canInject}
          onClick={inject}
        >
          Inject
        </Button>
      </div>
    </Card>
  );
};

/** Injections acting on machines now, by their own clock, with Clear / Clear all. */
const ActivePanel = ({ injections, events, catalogue, online, now }) => {
  const action = useSimAction();
  const clear = (body, success) => action.mutate({ path: '/clear', body, success });
  const pendingId = action.isPending ? (action.variables.body?.eventId ?? 'all') : null;

  return (
    <Card className="flex min-w-0 flex-col">
      <CardHeader
        icon={Activity}
        title="Active injections"
        subtitle="Each one ramps up, holds, then fades out over 2 minutes."
        actions={
          injections.length > 0 && (
            <Button
              size="sm"
              variant="ghost"
              icon={Eraser}
              loading={pendingId === 'all'}
              disabled={action.isPending}
              onClick={() =>
                clear(
                  { all: true },
                  'Cleared every injection. Readings settle back to normal within about 2 minutes.',
                )
              }
            >
              Clear all
            </Button>
          )
        }
      />
      {!online && injections.length > 0 && (
        <div className="px-4 pt-3">
          <Callout tone="warn" icon={PowerOff}>
            The simulator is offline, so these aren't being applied right now.
          </Callout>
        </div>
      )}
      {injections.length === 0 ? (
        <EmptyState icon={FlaskConical} title="Nothing injected right now">
          Inject a scenario and watch how quickly SARA notices.
        </EmptyState>
      ) : (
        <ul className="divide-y divide-border">
          {injections.map((e) => {
            const label = scenarioLabel(e.scenario, catalogue);
            const name = e.assetName ?? 'Unknown machine';
            const state = injectionState(e, now);
            const phase = phaseLabel(state.phase);
            const timing =
              state.phase === 'fade'
                ? 'settling back to normal'
                : state.phase === 'waiting'
                  ? 'until its repair work order is completed'
                  : [`${span(state.elapsedSec)} elapsed`, timeLeft(e.endsAt, now)]
                      .filter(Boolean)
                      .join(' · ');
            return (
              <li key={e.id} className="space-y-2 px-4 py-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-fg">{name}</p>
                    <p className="text-xs text-muted">{label}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    {e.severity && <Badge value={e.severity}>{humanize(e.severity)}</Badge>}
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={Eraser}
                      loading={pendingId === e.id}
                      disabled={action.isPending}
                      onClick={() =>
                        clear(
                          { eventId: e.id },
                          `Cleared ${label} on ${name}. Readings settle back to normal within about 2 minutes.`,
                        )
                      }
                      aria-label={`Clear ${label} on ${name}`}
                    >
                      Clear
                    </Button>
                  </div>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-x-2 text-xs">
                  <span className="font-medium text-fg">{phase}</span>
                  <span className="text-muted tabular">{timing}</span>
                </div>
                <ProgressBar
                  value={state.progress}
                  label={`${label} on ${name}: ${phase}, ${Math.round(state.progress * 100)}% of its time`}
                  tone={state.phase === 'fade' ? 'off' : 'warn'}
                />
                <Detection event={events?.find((ev) => ev.id === e.id) ?? e} now={now} />
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
};

/** Section (d): the superadmin's anomaly triggers — inject, watch, clear — and the ground-truth history. */
export const AnomalyLab = ({ status, statuses, online, now }) => {
  const events = useEvents();
  const scenarios = status?.scenarios ?? [];
  return (
    <Section
      id="sim-lab"
      icon={FlaskConical}
      title="Anomaly lab"
      description="Push one machine out of its normal band and see how quickly SARA's AI notices. The AI never sees what you inject here."
    >
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,400px)]">
        {status ? (
          <InjectPanel scenarios={scenarios} statuses={statuses} online={online} />
        ) : (
          <Card className="space-y-4 p-4">
            <Skeleton className="h-5 w-48" />
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-32 w-full" />
          </Card>
        )}
        <ActivePanel
          injections={status?.injections ?? []}
          events={events.data}
          catalogue={scenarios}
          online={online}
          now={now}
        />
      </div>
      <InjectionHistory query={events} catalogue={scenarios} now={now} />
    </Section>
  );
};
