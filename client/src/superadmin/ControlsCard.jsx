import { CircleCheck, History, LoaderCircle, SlidersHorizontal, TriangleAlert } from 'lucide-react';
import { useId, useState } from 'react';
import { Button, Card, CardHeader, Skeleton } from '../ui/core.jsx';
import { Select, Switch } from '../ui/form.jsx';
import { Callout, ProgressBar, Segmented } from './parts.jsx';
import { ago, plural } from './simUtils.js';
import { useSimAction } from './useSim.js';

const TICKS = [1000, 2000, 5000, 10000];
const SPEEDS = [1, 2, 5, 10, 30, 60];
const BACKFILL_DAYS = [1, 3, 7, 14];

/** The fixed choices, plus the current value when it was set elsewhere (the simulator's .env). */
const withCurrent = (choices, current) =>
  current == null || choices.includes(current) ? choices : [...choices, current].sort((a, b) => a - b);
const lastDays = (days) => (days ? `the last ${plural(days, 'day')}` : 'the history');

const ToggleRow = ({ label, help, checked, onChange }) => {
  const id = useId();
  return (
    <div className="px-4 py-3.5">
      <Switch
        id={id}
        checked={checked}
        onChange={onChange}
        label={<span className="font-medium">{label}</span>}
      />
      {/* Indented to line up with the label: 36 px switch + 10 px gap. */}
      <p className="mt-1 pl-11.5 text-xs text-subtle">{help}</p>
    </div>
  );
};

const BackfillStatus = ({ backfill, online, now }) => {
  const { status, days, progress, error, finishedAt, note } = backfill ?? {};
  if (status === 'requested') {
    return (
      <p className="flex items-center gap-1.5 text-xs text-muted">
        <LoaderCircle className="size-3.5 animate-spin" aria-hidden />
        {online ? 'Waiting for the simulator to start it…' : 'It starts once the simulator is online.'}
      </p>
    );
  }
  if (status === 'running') {
    return (
      <div className="space-y-1.5">
        <div className="flex justify-between gap-2 text-xs">
          <span className="font-medium text-fg">Backfilling {lastDays(days)}…</span>
          <span className="text-muted tabular">{Math.round((progress ?? 0) * 100)}%</span>
        </div>
        <ProgressBar value={progress} label="Backfill progress" />
      </div>
    );
  }
  if (status === 'error') {
    return (
      <Callout tone="warn" icon={TriangleAlert}>
        The last backfill failed: <span className="text-muted">{error || 'no reason given'}</span>
      </Callout>
    );
  }
  if (status === 'done') {
    return (
      <p className="flex items-center gap-1.5 text-xs text-muted">
        <CircleCheck className="size-3.5 text-success" aria-hidden />
        Backfilled {lastDays(days)}
        {finishedAt && ` · finished ${ago(finishedAt, now)}`}
        {note && ` · ${note}`}
      </p>
    );
  }
  return null;
};

const BackfillRow = ({ backfill, online, now }) => {
  const action = useSimAction();
  const id = useId();
  const [days, setDays] = useState(7);
  const busy = backfill?.status === 'requested' || backfill?.status === 'running';
  return (
    <div className="space-y-2 px-4 py-3.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label htmlFor={id} className="text-sm font-medium text-fg">
          Backfill history
        </label>
        <div className="flex items-center gap-2">
          <Select
            id={id}
            className="w-auto"
            value={days}
            disabled={busy}
            onChange={(e) => setDays(Number(e.target.value))}
          >
            {BACKFILL_DAYS.map((d) => (
              <option key={d} value={d}>
                Last {plural(d, 'day')}
              </option>
            ))}
          </Select>
          <Button
            icon={History}
            loading={action.isPending}
            disabled={busy}
            onClick={() =>
              action.mutate({
                path: '/backfill',
                body: { days },
                success: `Backfill of ${lastDays(days)} requested. Progress shows under Controls.`,
              })
            }
          >
            Backfill
          </Button>
        </div>
      </div>
      <p className="text-xs text-subtle">
        Writes 1-minute machine history only where there is no data yet; time already recorded is skipped.
      </p>
      <BackfillStatus backfill={backfill} online={online} now={now} />
    </div>
  );
};

/** Section (c): the runtime switches in `simcontrol`; the simulator reads them every 3 s. */
export const ControlsCard = ({ control, online, now }) => {
  const action = useSimAction();
  const tickId = useId();
  if (!control) {
    return (
      <Card className="space-y-4 p-4">
        <Skeleton className="h-5 w-32" />
        <Skeleton className="h-40 w-full" />
      </Card>
    );
  }
  // While a change is saving, show the new value instead of the one the server still has.
  const pending = action.isPending ? action.variables.body : {};
  const value = (key) => (key in pending ? pending[key] : control[key]);
  const save = (patch, success) => action.mutate({ path: '/control', method: 'PATCH', body: patch, success });
  const running = value('running');

  return (
    <Card>
      <CardHeader
        icon={SlidersHorizontal}
        title="Controls"
        subtitle={
          online
            ? 'Changes reach the simulator within about 3 seconds.'
            : "Saved right away; the simulator picks them up when it's online."
        }
      />
      <div className="divide-y divide-border">
        <ToggleRow
          label="Simulation running"
          checked={running}
          onChange={(on) => save({ running: on }, on ? 'Simulation resumed' : 'Simulation paused')}
          help={
            running
              ? 'Machines stream readings and people work their shifts.'
              : 'Paused: nothing new is written until you switch it back on.'
          }
        />
        <div className="space-y-1.5 px-4 py-3.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <label htmlFor={tickId} className="text-sm font-medium text-fg">
              Machine readings every
            </label>
            <Select
              id={tickId}
              className="w-auto"
              value={value('telemetryTickMs') ?? 5000}
              onChange={(e) => save({ telemetryTickMs: Number(e.target.value) })}
            >
              {withCurrent(TICKS, control.telemetryTickMs).map((ms) => (
                <option key={ms} value={ms}>
                  {ms / 1000} s
                </option>
              ))}
            </Select>
          </div>
          <p className="text-xs text-subtle">
            How often each machine sends a reading. Faster looks more live and stores more data.
          </p>
        </div>
        <ToggleRow
          label="Simulated people"
          checked={value('humanActivity')}
          onChange={(on) =>
            save({ humanActivity: on }, on ? 'Simulated people are back at work' : 'Simulated people stopped')
          }
          help="Staff check in for their shifts, take breaks, work through work orders and job cards, raise requests and log rejections."
        />
        <Segmented
          className="px-4 py-3.5"
          legend="Activity speed"
          options={withCurrent(SPEEDS, control.humanSpeed).map((x) => ({ value: x, label: `${x}×` }))}
          value={value('humanSpeed')}
          onChange={(humanSpeed) => save({ humanSpeed })}
          help="How fast people work. 60× turns a 1-hour repair into 1 minute; shift times stay real."
        />
        <ToggleRow
          label="Managers respond to AI anomalies"
          checked={value('respondToAnomalies')}
          onChange={(on) =>
            save(
              { respondToAnomalies: on },
              on ? 'Managers now respond to AI anomalies' : 'AI anomalies are left to you',
            )
          }
          help="On: simulated managers acknowledge new AI anomalies and open inspection work orders for critical ones. Off leaves that to the demo user."
        />
        <BackfillRow backfill={control.backfill} online={online} now={now} />
      </div>
    </Card>
  );
};
