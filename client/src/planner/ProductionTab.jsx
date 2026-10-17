import { Factory, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { useCan, useSession } from '../auth/useAuth.js';
import { getFormatPrefs } from '../lib/format.js';
import { RefSelect } from '../modules/RefSelect.jsx';
import { Button, Card, CardHeader, Skeleton } from '../ui/core.jsx';
import { Field, Input, Select } from '../ui/form.jsx';
import { Gantt } from './Gantt.jsx';
import { DAY, endOfDay, localDate } from './ganttLayout.js';
import { JobCardTable } from './JobCardTable.jsx';
import { PlanHeader, VerdictCard } from './PlanHeader.jsx';
import { ACTIVE, ActionBar, isExpired, StatusNotes, usePlanActions } from './PlanResult.jsx';
import { applyAdjustment, checkOf, isDirty, setCard, toEditedProduction } from './planEdits.js';
import { useCheckProduction, useParts, useProposeProduction } from './usePlanning.js';

const HOUR = 36e5;
const planFailed = (err) => toast.error("Couldn't make a plan", { description: err.message });
const useZone = () => useSession()?.company?.timeZone ?? getFormatPrefs().timeZone;

/** Part, quantity, due date, plant and customer → "Plan with SARA" → `onPlanned({ proposal, plan, check })`. */
export const ProductionPlanForm = ({ plantId, onPlanned }) => {
  const ctx = useSession();
  const can = useCan('jobcards');
  const parts = useParts();
  const propose = useProposeProduction();
  const tz = useZone();
  const [form, setForm] = useState({
    partName: '',
    quantity: '',
    dueDate: localDate(Date.now() + 7 * DAY, tz),
    plantId: plantId ?? '',
    customerId: null,
  });
  const [errors, setErrors] = useState({});
  const list = parts.data?.parts ?? [];
  const part = list.find((p) => p.partName === form.partName);
  const set = (key) => (e) => {
    setForm((f) => ({ ...f, [key]: e.target.value }));
    setErrors((errs) => ({ ...errs, [key]: null }));
  };

  const submit = (e) => {
    e.preventDefault();
    const quantity = Number(form.quantity);
    const next = {
      partName: form.partName ? null : 'Pick a part',
      quantity:
        Number.isInteger(quantity) && quantity >= 1 && quantity <= 10_000_000
          ? null
          : 'Enter 1 to 10,000,000 parts',
      dueDate: form.dueDate ? null : 'Pick a due date',
    };
    setErrors(next);
    if (Object.values(next).some(Boolean)) return;
    propose.mutate(
      {
        partName: form.partName,
        quantity,
        dueDate: new Date(endOfDay(form.dueDate, tz)).toISOString(),
        ...(form.plantId ? { plantId: form.plantId } : {}),
        ...(form.customerId ? { customerId: form.customerId } : {}),
      },
      { onSuccess: onPlanned, onError: planFailed },
    );
  };

  return (
    <form onSubmit={submit} className="space-y-3" noValidate>
      <Field
        label="Part"
        required
        error={errors.partName}
        help={
          part?.tools?.length
            ? part.tools
                .map(
                  (t) =>
                    `${t.toolNumber ?? t.name} · ${t.assets?.length ? t.assets.map((a) => a.label ?? a).join(', ') : 'no machine yet'}`,
                )
                .join(' — ')
            : 'The moulds that make the part decide which machines can run it.'
        }
      >
        {(props) =>
          parts.isLoading ? (
            <Skeleton className="h-9" />
          ) : (
            <Select {...props} value={form.partName} onChange={set('partName')} disabled={!can.create}>
              <option value="">{list.length ? 'Choose a part…' : 'No moulds have parts yet'}</option>
              {list.map((p) => (
                <option key={p.partName} value={p.partName}>
                  {p.partName} · {p.tools?.length ?? 0} mould{p.tools?.length === 1 ? '' : 's'}
                </option>
              ))}
            </Select>
          )
        }
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Quantity" required error={errors.quantity}>
          {(props) => (
            <Input
              {...props}
              type="number"
              inputMode="numeric"
              min={1}
              max={10_000_000}
              step={1}
              suffix="pcs"
              value={form.quantity}
              onChange={set('quantity')}
              disabled={!can.create}
            />
          )}
        </Field>
        <Field label="Due date" required error={errors.dueDate}>
          {(props) => (
            <Input
              {...props}
              type="date"
              min={localDate(Date.now(), tz)}
              value={form.dueDate}
              onChange={set('dueDate')}
              disabled={!can.create}
            />
          )}
        </Field>
      </div>
      {!ctx?.plantLocked && ctx?.plants?.length > 1 && (
        <Field label="Plant">
          {(props) => (
            <Select {...props} value={form.plantId} onChange={set('plantId')} disabled={!can.create}>
              <option value="">Any plant</option>
              {ctx.plants.map((p) => (
                <option key={p._id} value={p._id}>
                  {p.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
      )}
      <Field label="Customer" help="Optional">
        {(props) => (
          <RefSelect
            {...props}
            refModule="customers"
            value={form.customerId}
            onChange={(customerId) => setForm((f) => ({ ...f, customerId }))}
            placeholder="Search customers…"
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
        <p className="text-xs text-subtle">Your role can't create job cards, so you can only view plans.</p>
      )}
    </form>
  );
};

/**
 * A production plan to edit, check and create: header, editable job cards, Gantt with ghost bars, the
 * verdict with Apply suggestion, and Check / Create / Discard. `onResult(next | null)` selects another plan.
 */
export const ProductionPlanResult = ({ result, onResult }) => {
  const p = result.proposal;
  const tz = useZone();
  const plantLocked = useSession()?.plantLocked;
  const can = useCan('jobcards');
  const canAct = can.create && ACTIVE.includes(p.status) && !isExpired(p);
  const parts = useParts();
  const checkMut = useCheckProduction();
  const [check, setCheck] = useState(() => checkOf(result));
  const [edited, setEdited] = useState(() => toEditedProduction({ proposal: p, check: result.check }));
  const [checked, setChecked] = useState(edited);
  const actions = usePlanActions({ result, onResult, module: 'productionplans' });

  const runCheck = (plan) =>
    checkMut.mutate(plan, {
      onSuccess: (r) => {
        setCheck(r);
        setChecked(plan);
      },
      onError: (err) => toast.error("Couldn't check the plan", { description: err.message }),
    });
  const onChange = (key, patch) => setEdited((e) => setCard(e, key, patch));
  const onAdd = () => {
    const n = edited.jobCards.filter((c) => c.key.startsWith('new-')).length + 1;
    const start = new Date(Math.ceil(Date.now() / HOUR) * HOUR).toISOString();
    const first = edited.jobCards[0];
    setEdited((e) => ({
      ...e,
      jobCards: [
        ...e.jobCards,
        {
          key: `new-${n}`,
          assetId: first?.assetId ?? '',
          toolId: first?.toolId ?? '',
          target: Math.max(0, e.quantity - e.jobCards.reduce((s, c) => s + (Number(c.target) || 0), 0)),
          start,
          end: new Date(Date.parse(start) + 8 * HOUR).toISOString(),
          operators: [],
        },
      ],
    }));
  };
  const onRemove = (key) => setEdited((e) => ({ ...e, jobCards: e.jobCards.filter((c) => c.key !== key) }));
  const onApply = (adj) => {
    const next = applyAdjustment(edited, adj);
    setEdited(next);
    runCheck(next);
  };

  const dirty = isDirty(edited, checked);
  const plan = check.plan?.rows?.length ? check.plan : result.plan;
  return (
    <Card>
      <div className="space-y-5 p-4">
        <PlanHeader
          code={p.proposalCode}
          title={p.title}
          verdict={check.verdict}
          feasibility={check.feasibility ?? p.feasibility}
          explanation={check.explanation}
          aiError={check.aiError}
          status={isExpired(p) && p.status === 'draft' ? 'expired' : p.status}
          onExplain={
            canAct
              ? () =>
                  actions.explainNow((e) => setCheck((c) => ({ ...c, explanation: e, aiError: undefined })))
              : undefined
          }
          explaining={actions.explain.isPending}
        />
        <section aria-labelledby="jobcards-heading">
          <h3 id="jobcards-heading" className="mb-2 text-xs font-medium text-muted">
            Job cards
          </h3>
          <JobCardTable
            edited={edited}
            check={check}
            parts={parts.data?.parts ?? []}
            machines={plan?.rows ?? []}
            shifts={plan?.shifts ?? []}
            timeZone={tz}
            plantId={edited.plantId}
            plantLocked={plantLocked}
            onChange={canAct ? onChange : undefined}
            onAdd={canAct ? onAdd : undefined}
            onRemove={canAct ? onRemove : undefined}
          />
        </section>
        <section aria-labelledby="schedule-heading">
          <h3 id="schedule-heading" className="mb-2 text-xs font-medium text-muted">
            Schedule
          </h3>
          <Gantt data={plan} />
        </section>
        <VerdictCard check={check} onApply={canAct ? onApply : undefined} applying={checkMut.isPending} />
        <StatusNotes proposal={p} applied={actions.apply.data} />
        {canAct && (
          <ActionBar
            proposal={p}
            dirty={dirty}
            verdict={check.verdict}
            onCheck={() => runCheck(edited)}
            checking={checkMut.isPending}
            onCreate={() => actions.create()}
            creating={actions.apply.isPending}
            onDiscard={actions.drop}
            discarding={actions.discard.isPending}
          />
        )}
      </div>
    </Card>
  );
};

/** Card wrapper of the production form with its title. */
export const ProductionFormCard = ({ plantId, onPlanned }) => (
  <Card ai>
    <CardHeader
      icon={Factory}
      title="Plan production"
      subtitle="SARA picks the machines, windows and operators. Nothing is booked until you create the plan."
    />
    <div className="p-4">
      <ProductionPlanForm plantId={plantId} onPlanned={onPlanned} />
    </div>
  </Card>
);
