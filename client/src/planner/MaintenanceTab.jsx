import { CalendarCheck, Sparkles } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useCan, useSession } from '../auth/useAuth.js';
import { cn, getFormatPrefs } from '../lib/format.js';
import { Button, Card, CardHeader, Skeleton } from '../ui/core.jsx';
import { Field, Input, Switch } from '../ui/form.jsx';
import { Gantt } from './Gantt.jsx';
import { fromLocalDateTime, localDate } from './ganttLayout.js';
import { OptionCards } from './PlanBlock.jsx';
import { PlanHeader, VerdictCard } from './PlanHeader.jsx';
import { ACTIVE, ActionBar, isExpired, StatusNotes, usePlanActions } from './PlanResult.jsx';
import {
  applyAdjustment,
  checkOf,
  isDirty,
  OBJECTIVE_LABEL,
  objectiveOf,
  setTask,
  toEditedMaintenance,
} from './planEdits.js';
import { TaskTable } from './TaskTable.jsx';
import { useCheckMaintenance, useProposeMaintenancePlan } from './usePlanning.js';

const planFailed = (err) => toast.error("Couldn't make a plan", { description: err.message });
const useZone = () => useSession()?.company?.timeZone ?? getFormatPrefs().timeZone;

const AssetChips = ({ assets, value, onChange, disabled }) => {
  const [q, setQ] = useState('');
  const shown = assets.filter(
    (a) => !q || `${a.name} ${a.assetTag ?? ''}`.toLowerCase().includes(q.toLowerCase()),
  );
  const toggle = (id) => onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value, id]);
  return (
    <div className="space-y-2">
      <Input
        type="search"
        placeholder="Filter machines…"
        aria-label="Filter machines"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        disabled={disabled}
      />
      <ul className="flex max-h-40 flex-wrap gap-1.5 overflow-y-auto scrollbar-thin" aria-label="Machines">
        {shown.map((a) => {
          const on = value.includes(a._id);
          return (
            <li key={a._id}>
              <button
                type="button"
                aria-pressed={on}
                disabled={disabled}
                onClick={() => toggle(a._id)}
                className={cn(
                  'rounded-md border px-2 py-1 text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:ring-ring',
                  on
                    ? 'border-brand bg-brand-soft text-brand'
                    : 'border-border text-muted hover:bg-surface-2',
                )}
              >
                {a.name}
              </button>
            </li>
          );
        })}
        {!shown.length && <li className="text-xs text-subtle">No machine matches.</li>}
      </ul>
      <p className="text-xs text-subtle tabular">{value.length} selected</p>
    </div>
  );
};

/**
 * Whole plant or selected assets, horizon, objective slider, non-running days, name → "Plan with SARA".
 * `deepLink = { assetId, anomalyId? }` pre-selects that asset and plans once on mount.
 */
export const MaintenancePlanForm = ({ assets, assetsLoading, deepLink, plantId, onPlanned }) => {
  const can = useCan('workorders');
  const propose = useProposeMaintenancePlan();
  const tz = useZone();
  const [form, setForm] = useState({
    scope: deepLink?.assetId ? 'assets' : 'plant',
    assetIds: deepLink?.assetId ? [deepLink.assetId] : [],
    start: localDate(Date.now(), tz),
    horizonDays: 7,
    slider: 0,
    allowNonRunningDays: false,
    name: '',
  });
  const [error, setError] = useState(null);
  const set = (key, value) => setForm((f) => ({ ...f, [key]: value }));

  const body = (f) => ({
    scope: f.scope,
    ...(f.scope === 'assets' ? { assetIds: f.assetIds } : {}),
    ...(plantId ? { plantId } : {}),
    ...(f.start && f.start !== localDate(Date.now(), tz)
      ? { start: new Date(fromLocalDateTime(`${f.start}T00:00`, tz)).toISOString() }
      : {}),
    horizonDays: Number(f.horizonDays) || 7,
    objective: objectiveOf(f.slider),
    ...(f.allowNonRunningDays ? { allowNonRunningDays: true } : {}),
    ...(f.name.trim() ? { name: f.name.trim() } : {}),
    ...(deepLink?.anomalyId ? { anomalyId: deepLink.anomalyId } : {}),
  });

  const ran = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the deep link plans once, on arrival
  useEffect(() => {
    if (!deepLink?.assetId || ran.current) return;
    ran.current = true;
    propose.mutate(body(form), { onSuccess: onPlanned, onError: planFailed });
  }, [deepLink]);

  const submit = (e) => {
    e.preventDefault();
    if (form.scope === 'assets' && !form.assetIds.length) return setError('Pick at least one machine');
    setError(null);
    propose.mutate(body(form), { onSuccess: onPlanned, onError: planFailed });
  };
  const objective = objectiveOf(form.slider);

  return (
    <form onSubmit={submit} className="space-y-3" noValidate>
      <fieldset>
        <legend className="mb-1.5 text-xs font-medium text-muted">Scope</legend>
        <div className="flex gap-4 text-sm text-fg">
          {[
            ['plant', 'Whole plant'],
            ['assets', 'Selected machines'],
          ].map(([v, label]) => (
            <label key={v} className="inline-flex items-center gap-1.5">
              <input
                type="radio"
                name="scope"
                value={v}
                checked={form.scope === v}
                onChange={() => set('scope', v)}
                disabled={!can.create}
                className="accent-[var(--brand)]"
              />
              {label}
            </label>
          ))}
        </div>
      </fieldset>
      {form.scope === 'assets' &&
        (assetsLoading ? (
          <Skeleton className="h-20" />
        ) : (
          <Field error={error}>
            <AssetChips
              assets={assets ?? []}
              value={form.assetIds}
              onChange={(ids) => {
                set('assetIds', ids);
                setError(null);
              }}
              disabled={!can.create}
            />
          </Field>
        ))}
      <div className="grid grid-cols-2 gap-3">
        <Field label="From">
          {(props) => (
            <Input
              {...props}
              type="date"
              min={localDate(Date.now(), tz)}
              value={form.start}
              onChange={(e) => set('start', e.target.value)}
              disabled={!can.create}
            />
          )}
        </Field>
        <Field label="Days">
          {(props) => (
            <Input
              {...props}
              type="number"
              inputMode="numeric"
              min={1}
              max={30}
              step={1}
              value={form.horizonDays}
              onChange={(e) => set('horizonDays', e.target.value)}
              disabled={!can.create}
            />
          )}
        </Field>
      </div>
      <Field label="Objective" help={OBJECTIVE_LABEL[objective]}>
        {(props) => (
          <div>
            <input
              {...props}
              type="range"
              min={0}
              max={100}
              step={1}
              value={form.slider}
              onChange={(e) => set('slider', Number(e.target.value))}
              disabled={!can.create}
              aria-valuetext={OBJECTIVE_LABEL[objective]}
              className="w-full accent-[var(--brand)]"
            />
            <div className="flex justify-between text-[11px] text-subtle">
              <span>Protect production</span>
              <span>Fix fast</span>
            </div>
          </div>
        )}
      </Field>
      <Switch
        id="plan-non-running"
        checked={form.allowNonRunningDays}
        onChange={(v) => set('allowNonRunningDays', v)}
        label="Allow Sundays and holidays"
        disabled={!can.create}
      />
      <Field label="Name" help="Optional">
        {(props) => (
          <Input
            {...props}
            value={form.name}
            onChange={(e) => set('name', e.target.value)}
            maxLength={120}
            disabled={!can.create}
          />
        )}
      </Field>
      <Button
        type="submit"
        variant="ai"
        icon={Sparkles}
        loading={propose.isPending}
        disabled={!can.create}
        className="w-full"
      >
        {propose.isPending ? 'SARA is planning…' : 'Plan with SARA'}
      </Button>
      {!can.create && (
        <p className="text-xs text-subtle">Your role can't create work orders, so you can only view plans.</p>
      )}
    </form>
  );
};

/**
 * A maintenance plan to edit, check and create: header with impact metrics, editable tasks, Gantt with
 * maintenance blocks, the verdict, and Check / Create / Discard. A single-task window proposal (kind
 * `maintenance`) shows its options instead of the task table.
 */
export const MaintenancePlanResult = ({ result, onResult }) => {
  const p = result.proposal;
  const tz = useZone();
  const can = useCan('workorders');
  const canAct = can.create && ACTIVE.includes(p.status) && !isExpired(p);
  const legacy = p.kind === 'maintenance';
  const checkMut = useCheckMaintenance();
  const [check, setCheck] = useState(() => checkOf(result));
  const [edited, setEdited] = useState(() => toEditedMaintenance({ proposal: p, check: result.check }));
  const [checked, setChecked] = useState(edited);
  const [option, setOption] = useState(null);
  const actions = usePlanActions({ result, onResult, module: 'maintenanceplans' });

  const runCheck = (plan) =>
    checkMut.mutate(plan, {
      onSuccess: (r) => {
        setCheck(r);
        setChecked(plan);
      },
      onError: (err) => toast.error("Couldn't check the plan", { description: err.message }),
    });
  const onApply = (adj) => {
    const next = applyAdjustment(edited, adj);
    setEdited(next);
    runCheck(next);
  };

  const options = result.plan?.options ?? [];
  const chosen = option ?? p.recommendedOption ?? options.find((o) => o.recommended)?.id ?? null;
  const dirty = !legacy && isDirty(edited, checked);
  const plan = check.plan?.rows?.length ? check.plan : result.plan;
  return (
    <Card>
      <div className="space-y-5 p-4">
        <PlanHeader
          code={p.proposalCode}
          title={p.title}
          verdict={legacy ? undefined : check.verdict}
          feasibility={check.feasibility ?? p.feasibility}
          explanation={check.explanation}
          aiError={check.aiError}
          status={isExpired(p) && p.status === 'draft' ? 'expired' : p.status}
          metrics={check.metrics ?? p.metrics}
          becomes={legacy ? 'WO-n' : 'MP-n'}
          onExplain={
            canAct
              ? () =>
                  actions.explainNow((e) => setCheck((c) => ({ ...c, explanation: e, aiError: undefined })))
              : undefined
          }
          explaining={actions.explain.isPending}
        />
        {legacy ? (
          <OptionCards
            options={options}
            value={chosen}
            onChange={canAct ? setOption : undefined}
            name={`option-${p._id}`}
          />
        ) : (
          <section aria-labelledby="tasks-heading">
            <h3 id="tasks-heading" className="mb-2 text-xs font-medium text-muted">
              Work orders
            </h3>
            <TaskTable
              edited={edited}
              check={check}
              timeZone={tz}
              plantId={p.plantId}
              onChange={canAct ? (key, patch) => setEdited((e) => setTask(e, key, patch)) : undefined}
            />
          </section>
        )}
        <section aria-labelledby="mschedule-heading">
          <h3 id="mschedule-heading" className="mb-2 text-xs font-medium text-muted">
            Schedule
          </h3>
          <Gantt data={plan} />
        </section>
        {!legacy && (
          <VerdictCard check={check} onApply={canAct ? onApply : undefined} applying={checkMut.isPending} />
        )}
        <StatusNotes proposal={p} applied={actions.apply.data} />
        {canAct && (
          <ActionBar
            proposal={p}
            dirty={dirty}
            verdict={legacy ? undefined : check.verdict}
            onCheck={legacy ? undefined : () => runCheck(edited)}
            checking={checkMut.isPending}
            onCreate={() => actions.create(legacy && chosen ? { option: chosen } : {})}
            creating={actions.apply.isPending}
            onDiscard={actions.drop}
            discarding={actions.discard.isPending}
            createLabel={legacy ? 'Book the window' : 'Create plan'}
          />
        )}
      </div>
    </Card>
  );
};

/** Card wrapper of the maintenance form with its title. */
export const MaintenanceFormCard = (props) => (
  <Card ai>
    <CardHeader
      icon={CalendarCheck}
      title="Plan maintenance"
      subtitle="SARA places the work orders and technicians where production loses the least."
    />
    <div className="p-4">
      <MaintenancePlanForm {...props} />
    </div>
  </Card>
);
