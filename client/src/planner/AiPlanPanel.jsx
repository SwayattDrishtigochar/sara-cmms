import {
  CircleCheck,
  ExternalLink,
  Factory,
  Lightbulb,
  MessageSquare,
  RefreshCw,
  Sparkles,
  Trash2,
  TriangleAlert,
  Wrench,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { useAssistant } from '../assistant/useAssistant.js';
import { useCan, useSession } from '../auth/useAuth.js';
import { cn, formatDateTime, formatNumber, formatRelative, getFormatPrefs } from '../lib/format.js';
import { AiProvenance, Badge, Button, Card, CardHeader, Skeleton } from '../ui/core.jsx';
import { Field, Input, Select, Switch } from '../ui/form.jsx';
import { TabPanel, Tabs } from '../ui/overlay.jsx';
import { endOfDay, localDate } from './ganttLayout.js';
import {
  DelayChips,
  FeasibilityBadge,
  hoursText,
  KindIcon,
  OptionCards,
  ProposalStatusBadge,
} from './PlanBlock.jsx';
import {
  useApplyProposal,
  useDiscardProposal,
  useExplainProposal,
  useParts,
  useProposal,
  useProposeMaintenance,
  useProposeProduction,
} from './usePlanning.js';

const planFailed = (err) => toast.error("Couldn't make a plan", { description: err.message });

const ProductionForm = ({ plantId, onProposed }) => {
  const can = useCan('jobcards');
  const parts = useParts();
  const propose = useProposeProduction();
  const tz = useSession()?.company?.timeZone ?? getFormatPrefs().timeZone;
  const [form, setForm] = useState({ partName: '', quantity: '', dueDate: '' });
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
        ...(plantId ? { plantId } : {}),
      },
      { onSuccess: onProposed, onError: planFailed },
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
            ? `Moulds: ${part.tools.map((t) => `${t.toolNumber}${t.assets?.length ? ` (${t.assets.join(', ')})` : ''}`).join(' · ')}`
            : null
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
      <Button
        type="submit"
        variant="ai"
        icon={Sparkles}
        loading={propose.isPending}
        disabled={!can.create}
        className="w-full"
      >
        Auto-plan production
      </Button>
      {!can.create && (
        <p className="text-xs text-subtle">Your role can't create job cards, so you can only view plans.</p>
      )}
    </form>
  );
};

const MaintenanceForm = ({ rows, deepLink, onProposed }) => {
  const can = useCan('workorders');
  const propose = useProposeMaintenance();
  const [assetId, setAssetId] = useState(deepLink?.assetId ?? '');
  const [allowNonRunningDays, setAllow] = useState(false);
  const ran = useRef(false);

  // The deep link (/planner?maintenance=<assetId>&anomaly=<id>) plans once, on arrival.
  useEffect(() => {
    if (!deepLink?.assetId || ran.current) return;
    ran.current = true;
    propose.mutate(
      { assetId: deepLink.assetId, ...(deepLink.anomalyId ? { anomalyId: deepLink.anomalyId } : {}) },
      { onSuccess: onProposed, onError: planFailed },
    );
  }, [deepLink, propose, onProposed]);

  const submit = (e) => {
    e.preventDefault();
    propose.mutate(
      { ...(assetId ? { assetId } : {}), ...(allowNonRunningDays ? { allowNonRunningDays } : {}) },
      { onSuccess: onProposed, onError: planFailed },
    );
  };

  return (
    <form onSubmit={submit} className="space-y-3">
      <Field label="Machine" help="All machines: every due task of the plant in the next 7 days.">
        {(props) => (
          <Select
            {...props}
            value={assetId}
            onChange={(e) => setAssetId(e.target.value)}
            disabled={!can.create}
          >
            <option value="">All machines</option>
            {rows.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Switch
        id="plan-non-running"
        checked={allowNonRunningDays}
        onChange={setAllow}
        label="Also use non-running days"
        disabled={!can.create}
      />
      <Button
        type="submit"
        variant="ai"
        icon={Sparkles}
        loading={propose.isPending}
        disabled={!can.create}
        className="w-full"
      >
        Find maintenance windows
      </Button>
      {propose.isPending && deepLink?.anomalyId && (
        <p className="text-xs text-muted" aria-live="polite">
          Finding a window for the anomaly's work…
        </p>
      )}
      {!can.create && (
        <p className="text-xs text-subtle">Your role can't create work orders, so you can only view plans.</p>
      )}
    </form>
  );
};

/**
 * The AI planning panel: "Auto-plan production" (part, quantity, due date) and "Find maintenance windows"
 * (all machines or one; `deepLink` = { assetId, anomalyId } plans once on mount). `onProposed({ proposal, plan })`.
 */
export const AiPlanPanel = ({ rows = [], plantId, deepLink, onProposed }) => {
  const [tab, setTab] = useState(deepLink ? 'maintenance' : 'production');
  return (
    <Card ai>
      <CardHeader
        icon={Sparkles}
        title="Plan with SARA"
        subtitle="SARA builds the schedule. Nothing changes until you confirm."
        actions={
          <Button
            size="sm"
            variant="ghost"
            icon={MessageSquare}
            onClick={() => useAssistant.getState().open({ text: 'Plan ' })}
          >
            Ask SARA
          </Button>
        }
      />
      <div className="px-4 pt-2 pb-4">
        <Tabs
          value={tab}
          onValueChange={setTab}
          tabs={[
            { value: 'production', label: 'Production', icon: Factory },
            { value: 'maintenance', label: 'Maintenance', icon: Wrench },
          ]}
        >
          <TabPanel value="production" forceMount className="data-[state=inactive]:hidden">
            <ProductionForm plantId={plantId} onProposed={onProposed} />
          </TabPanel>
          <TabPanel value="maintenance" forceMount className="data-[state=inactive]:hidden">
            <MaintenanceForm rows={rows} deepLink={deepLink} onProposed={onProposed} />
          </TabPanel>
        </Tabs>
      </div>
    </Card>
  );
};

// ── Proposal view ────────────────────────────────────────────────────────────

/** Deterministic line shown when the AI explanation is unavailable. */
export const fallbackLine = (proposal, options) => {
  const f = proposal?.feasibility ?? {};
  if (proposal?.kind === 'maintenance') {
    const best = options?.find((o) => o.recommended) ?? options?.[0];
    return best ? `Least delay: ${best.label}` : 'No maintenance window found.';
  }
  if (f.shortfall > 0) return `${formatNumber(f.shortfall)} pcs can't be made by the due date.`;
  if (f.feasible === false) return `Finishes ${hoursText(f.slackHours)} after the due date.`;
  return f.projectedFinish
    ? `Finishes ${formatDateTime(f.projectedFinish)}, ${hoursText(f.slackHours)} before the due date.`
    : 'The plan fits before the due date.';
};

const Explanation = ({ proposal, options, canAct }) => {
  const id = String(proposal._id);
  const explain = useExplainProposal(id);
  const e = proposal.explanation;
  const regenerate = () =>
    explain.mutate(undefined, {
      onError: (err) =>
        toast.error("SARA couldn't explain this plan right now", { description: err.message }),
    });
  const bullets = e?.bullets ?? e?.reasons ?? [];
  return (
    <Card ai className="p-3">
      {explain.isPending ? (
        <div className="space-y-2" role="status" aria-label="Explaining">
          <Skeleton className="h-3.5 w-11/12" />
          <Skeleton className="h-3.5 w-3/4" />
        </div>
      ) : e?.text || e?.summary ? (
        <>
          <p className="text-sm leading-relaxed whitespace-pre-line text-fg">{e.text ?? e.summary}</p>
          {bullets.length > 0 && (
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted">
              {bullets.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
          )}
          <AiProvenance
            className="mt-2"
            model={e.mock ? `${e.model ?? 'AI'} (mock)` : e.model}
            at={e.at ? formatRelative(e.at) : null}
            onRegenerate={canAct ? regenerate : undefined}
          />
        </>
      ) : (
        <>
          <p className="text-sm text-fg">{fallbackLine(proposal, options)}</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Badge tone="neutral">
              <Lightbulb className="size-3.5" aria-hidden />
              AI explanation unavailable
            </Badge>
            {canAct && (
              <button
                type="button"
                onClick={regenerate}
                className="text-[11px] font-medium text-ai hover:underline"
              >
                Try again
              </button>
            )}
          </div>
        </>
      )}
    </Card>
  );
};

const Fact = ({ label, children, className }) => (
  <div>
    <dt className="text-[11px] text-subtle">{label}</dt>
    <dd className={cn('text-sm font-medium text-fg tabular', className)}>{children}</dd>
  </div>
);

const ALT_LABEL = {
  extra_shift: 'Run on non-running days',
  other_mould: 'Another mould',
  partial_delivery: 'Partial delivery',
  non_running_day: 'Non-running day',
  defer: 'Defer',
};

const ACTIVE = ['draft', 'failed'];

/**
 * One proposal: feasibility, AI explanation with provenance, options, delays, risks, alternatives and
 * Confirm / Discard. A `PLAN_CHANGED` answer selects the updated plan (`onSelect(newId)`).
 */
export const ProposalView = ({ id, onSelect, onClose }) => {
  const query = useProposal(id);
  const role = useSession()?.role;
  const apply = useApplyProposal(id);
  const discard = useDiscardProposal(id);
  const [option, setOption] = useState(null);
  const [applied, setApplied] = useState(null);

  if (query.isLoading) {
    return (
      <Card className="space-y-3 p-4" aria-busy="true">
        <Skeleton className="h-5 w-2/3" />
        <Skeleton className="h-16" />
        <Skeleton className="h-9" />
      </Card>
    );
  }
  // A failed refetch keeps the plan on screen; only a plan that never loaded shows the error.
  if (!query.data?.proposal) {
    const gone = query.error?.status === 404;
    return (
      <Card className="flex items-center justify-between gap-3 p-4 text-sm text-muted">
        {gone ? 'This plan no longer exists.' : "Couldn't load this plan."}
        <div className="flex gap-1">
          {!gone && (
            <Button size="sm" variant="ghost" icon={RefreshCw} onClick={() => query.refetch()}>
              Try again
            </Button>
          )}
          <Button size="sm" variant="ghost" icon={X} onClick={onClose}>
            Close
          </Button>
        </div>
      </Card>
    );
  }

  const { proposal: p, plan = {} } = query.data;
  const canAct = role && role !== 'view';
  const options = plan.options ?? [];
  const chosen = option ?? p.recommendedOption ?? options.find((o) => o.recommended)?.id ?? null;
  const expired =
    p.status === 'expired' || (p.status === 'draft' && p.expiresAt && Date.parse(p.expiresAt) < Date.now());
  const f = p.feasibility ?? {};

  const confirm = () =>
    apply.mutate(p.kind === 'maintenance' && chosen ? { option: chosen } : {}, {
      onSuccess: (r) => {
        setApplied(r);
        const n = (r?.created?.length ?? 0) + (r?.updated?.length ?? 0);
        toast.success(`Applied ${p.proposalCode}`, {
          description: `${r?.created?.length ?? 0} created, ${r?.updated?.length ?? 0} updated${n ? '' : ' (nothing to change)'}.`,
        });
      },
      onError: (err) => {
        if (err.code === 'PLAN_CHANGED' && err.details?.proposalId) {
          toast.info('Plan changed — showing the updated plan', { description: err.message });
          onSelect(String(err.details.proposalId));
        } else toast.error("Couldn't apply the plan", { description: err.message });
      },
    });
  const drop = () =>
    discard.mutate(undefined, {
      onSuccess: () => toast.success(`Discarded ${p.proposalCode}`),
      onError: (err) => toast.error("Couldn't discard the plan", { description: err.message }),
    });

  const links = applied ? [...(applied.created ?? []), ...(applied.updated ?? [])] : [];

  return (
    <Card>
      <div className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
        <div className="flex min-w-0 items-start gap-2.5">
          <KindIcon kind={p.kind} className="mt-0.5" />
          <div className="min-w-0">
            <p className="text-xs font-semibold text-subtle tabular">{p.proposalCode}</p>
            <h2 className="text-sm font-semibold text-fg">{p.title}</h2>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              <ProposalStatusBadge status={expired && p.status === 'draft' ? 'expired' : p.status} />
              <FeasibilityBadge feasibility={f} kind={p.kind} />
            </div>
          </div>
        </div>
        <Button size="iconSm" variant="ghost" aria-label="Close plan" onClick={onClose}>
          <X className="size-4" aria-hidden />
        </Button>
      </div>

      <div className="space-y-4 p-4">
        {p.kind !== 'maintenance' && (f.dueDate || f.projectedFinish) && (
          <dl className="grid grid-cols-3 gap-2">
            <Fact label="Due">{formatDateTime(f.dueDate)}</Fact>
            <Fact label="Finishes">{formatDateTime(f.projectedFinish)}</Fact>
            <Fact
              label={f.slackHours < 0 ? 'Late by' : 'Slack'}
              className={f.slackHours < 0 ? 'text-critical' : ''}
            >
              {f.slackHours == null ? '—' : hoursText(f.slackHours)}
            </Fact>
          </dl>
        )}

        <Explanation proposal={p} options={options} canAct={canAct} />

        {options.length > 0 && (
          <OptionCards
            options={options}
            value={chosen}
            onChange={canAct && ACTIVE.includes(p.status) ? setOption : undefined}
            name={`option-${id}`}
          />
        )}
        {options.length > 1 && chosen && options.find((o) => o.recommended)?.id !== chosen && (
          <p className="text-xs text-subtle">
            The Gantt shows the recommended option; your choice is applied on Confirm.
          </p>
        )}

        {plan.delays?.length > 0 && (
          <div>
            <h3 className="mb-1.5 text-xs font-medium text-muted">Job cards pushed</h3>
            <DelayChips delays={plan.delays} />
          </div>
        )}

        {p.risks?.length > 0 && (
          <div>
            <h3 className="mb-1.5 text-xs font-medium text-muted">Risks</h3>
            <ul className="space-y-1.5 text-sm">
              {p.risks.map((r) => (
                <li key={r.text} className="flex items-start gap-2">
                  <TriangleAlert
                    className={cn(
                      'mt-0.5 size-4 shrink-0',
                      r.severity === 'critical' ? 'text-critical' : 'text-warn',
                    )}
                    aria-hidden
                  />
                  <span className="text-fg">
                    <span className="sr-only">{r.severity}: </span>
                    {r.text}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {p.alternatives?.length > 0 && (
          <div>
            <h3 className="mb-1.5 text-xs font-medium text-muted">Alternatives</h3>
            <ul className="space-y-1.5">
              {p.alternatives.map((a) => (
                <li key={`${a.kind}-${a.text}`} className="rounded-lg border border-border px-3 py-2 text-sm">
                  <span className="font-medium text-fg">{ALT_LABEL[a.kind] ?? a.kind}</span>
                  <span className="block text-muted">{a.text}</span>
                  {(a.projectedFinish || a.extraParts != null) && (
                    <span className="mt-0.5 block text-xs text-subtle tabular">
                      {a.projectedFinish && `Finishes ${formatDateTime(a.projectedFinish)}`}
                      {a.projectedFinish && a.extraParts != null && ' · '}
                      {a.extraParts != null && `${formatNumber(a.extraParts)} pcs by the due date`}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        {p.status === 'stale' && (
          <p className="rounded-lg border border-warn/40 bg-warn/5 px-3 py-2 text-sm text-fg">
            The schedule changed after this plan was made. Make a new plan to see the current picture.
          </p>
        )}
        {expired && <p className="text-sm text-muted">This plan expired. Make a new one to book it.</p>}
        {p.status === 'failed' && p.error && (
          <p className="rounded-lg border border-critical/40 bg-critical/5 px-3 py-2 text-sm text-fg">
            The last attempt stopped: {p.error}. Confirm again to finish it.
          </p>
        )}
        {p.status === 'applied' && (
          <div className="space-y-1.5">
            <p className="flex items-center gap-1.5 text-sm text-success">
              <CircleCheck className="size-4" aria-hidden />
              Applied {formatRelative(p.appliedAt)}
            </p>
            {links.length > 0 && (
              <ul className="flex flex-wrap gap-1.5">
                {links.map((r) => (
                  <li key={`${r.module}-${r.id}`}>
                    <Link
                      to={r.link ?? `/m/${r.module}/${r.id}`}
                      className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-0.5 text-xs font-medium text-brand hover:bg-surface-2"
                    >
                      {r.label} <ExternalLink className="size-3" aria-hidden />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {canAct && (ACTIVE.includes(p.status) || p.status === 'applying') && !expired && (
          <div className="flex flex-wrap gap-2 border-t border-border pt-4">
            <Button
              variant="primary"
              icon={CircleCheck}
              loading={apply.isPending || p.status === 'applying'}
              onClick={confirm}
            >
              Confirm plan
            </Button>
            <Button variant="ghost" icon={Trash2} loading={discard.isPending} onClick={drop}>
              Discard
            </Button>
            {p.status === 'draft' && p.expiresAt && (
              <p className="w-full text-xs text-subtle">Valid until {formatDateTime(p.expiresAt)}.</p>
            )}
          </div>
        )}
      </div>
    </Card>
  );
};
