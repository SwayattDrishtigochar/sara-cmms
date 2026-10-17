import {
  CalendarCheck,
  CalendarRange,
  CircleCheck,
  Clock,
  ExternalLink,
  Factory,
  OctagonAlert,
  Pencil,
  Plus,
  Sparkles,
  TriangleAlert,
  Users,
  Wrench,
} from 'lucide-react';
import { Link } from 'react-router';
import { cn, formatDateTime, formatMoney, formatNumber } from '../lib/format.js';
import { Badge, Card, CardHeader } from '../ui/core.jsx';
import { delayText, Gantt } from './Gantt.jsx';
import { VERDICT_LABEL, verdictTone } from './planEdits.js';

/** 6 → "6 h", 5.46 → "5.5 h". */
export const hoursText = (h) => `${Number(Math.abs(h ?? 0).toFixed(Math.abs(h) < 10 ? 1 : 0))} h`;

/** Feasibility as a badge: production "On time" / "Short 1,200 pcs" / "Late 6 h"; maintenance by impact. */
export const feasibilityOf = (feasibility, kind) => {
  if (!feasibility) return null;
  const f = feasibility;
  if (kind === 'maintenance') {
    if (f.feasible === false) return { tone: 'critical', icon: TriangleAlert, label: 'Makes a plan late' };
    if (f.maxDelayHours > 0)
      return { tone: 'warn', icon: Clock, label: `Delays ${hoursText(f.maxDelayHours)}` };
    return { tone: 'success', icon: CircleCheck, label: 'No production impact' };
  }
  if (f.shortfall > 0) {
    return { tone: 'critical', icon: TriangleAlert, label: `Short ${formatNumber(f.shortfall)} pcs` };
  }
  if (f.feasible === false) {
    return { tone: 'critical', icon: TriangleAlert, label: `Late ${hoursText(f.slackHours)}` };
  }
  return { tone: 'success', icon: CircleCheck, label: 'On time' };
};

export const FeasibilityBadge = ({ feasibility, kind, className }) => {
  const f = feasibilityOf(feasibility, kind);
  if (!f) return null;
  return (
    <Badge tone={f.tone} className={className}>
      <f.icon className="size-3.5" aria-hidden />
      {f.label}
    </Badge>
  );
};

const VERDICT_ICON = { good: CircleCheck, warn: TriangleAlert, critical: OctagonAlert };
const VERDICT_TONE = { good: 'success', warn: 'warn', critical: 'critical' };
/** Doable / Needs adjustment / Not doable (icon + words, never colour alone); null without a verdict. */
export const VerdictBadge = ({ verdict, className }) => {
  if (!verdict) return null;
  const tone = verdictTone(verdict);
  const Icon = VERDICT_ICON[tone];
  return (
    <Badge tone={VERDICT_TONE[tone]} className={className}>
      <Icon className="size-3.5" aria-hidden />
      {VERDICT_LABEL[verdict] ?? verdict}
    </Badge>
  );
};

const STATUS = {
  draft: { label: 'Draft', tone: 'ai' },
  applying: { label: 'Applying', tone: 'brand' },
  applied: { label: 'Applied', tone: 'success' },
  discarded: { label: 'Discarded', tone: 'off' },
  stale: { label: 'Out of date', tone: 'warn' },
  expired: { label: 'Expired', tone: 'off' },
  failed: { label: 'Failed', tone: 'critical' },
};
export const ProposalStatusBadge = ({ status }) => {
  const s = STATUS[status] ?? { label: status ?? 'Unknown', tone: 'neutral' };
  return <Badge tone={s.tone}>{s.label}</Badge>;
};

const KIND = {
  maintenance: { icon: Wrench, label: 'Maintenance window' },
  maintenance_plan: { icon: CalendarCheck, label: 'Maintenance plan' },
  production: { icon: Factory, label: 'Production plan' },
};
export const KindIcon = ({ kind, className }) => {
  const k = KIND[kind] ?? KIND.production;
  return <k.icon className={cn('size-4 shrink-0 text-muted', className)} role="img" aria-label={k.label} />;
};

const Tile = ({ label, value, sub, tone }) => (
  <div className="rounded-lg border border-border bg-surface px-3 py-2">
    <dt className="text-[11px] text-muted">{label}</dt>
    <dd className={cn('text-base font-semibold text-fg tabular', tone === 'critical' && 'text-critical')}>
      {value}
    </dd>
    {sub && <dd className="text-[11px] text-subtle tabular">{sub}</dd>}
  </div>
);

/** Maintenance plan metrics as stat tiles: production impact, downtime cost avoided, zero-impact tasks. */
export const MetricTiles = ({ metrics: m, className }) =>
  m ? (
    <dl className={cn('grid grid-cols-2 gap-2 sm:grid-cols-4', className)}>
      <Tile
        label="Production impact"
        value={hoursText(m.productionHoursLost)}
        sub={m.productionImpactCost != null ? formatMoney(m.productionImpactCost) : null}
        tone={m.productionHoursLost > 0 ? 'critical' : undefined}
      />
      <Tile
        label="Downtime cost avoided"
        value={formatMoney(m.downtimeCostAvoided ?? 0)}
        sub={
          m.naiveProductionHoursLost != null
            ? `vs ${hoursText(m.naiveProductionHoursLost)} if done at once`
            : null
        }
      />
      <Tile label="Zero-impact tasks" value={`${m.zeroImpactTasks ?? 0} of ${m.tasks ?? 0}`} />
      <Tile label="Tasks" value={m.tasks ?? 0} />
    </dl>
  ) : null;

/** One line per job card with its operators (`payload.jobCards[].operators`). */
export const OperatorLines = ({ jobCards, className }) =>
  jobCards?.length ? (
    <ul className={cn('space-y-1 text-xs text-muted', className)} aria-label="Operators per job card">
      {jobCards.slice(0, 10).map((c, i) => (
        <li key={c.key ?? i} className="flex items-start gap-1.5">
          <Users className="mt-0.5 size-3 shrink-0" aria-hidden />
          <span>
            <span className="font-medium text-fg">{c.asset}</span>
            {c.target != null && ` · ${formatNumber(c.target)} pcs`}
            {' · '}
            {c.operators?.length
              ? [...new Set(c.operators.map((o) => o.name ?? o.userId))].join(', ')
              : 'no operator yet'}
          </span>
        </li>
      ))}
    </ul>
  ) : null;

/** Tasks of a maintenance plan with their technician (`payload.tasks`). */
export const TaskLines = ({ tasks, className }) =>
  tasks?.length ? (
    <ul className={cn('space-y-1 text-xs text-muted', className)} aria-label="Maintenance tasks">
      {tasks.slice(0, 10).map((t) => (
        <li key={t.key} className="flex items-start gap-1.5">
          <Wrench className="mt-0.5 size-3 shrink-0" aria-hidden />
          <span>
            <span className="font-medium text-fg">{t.asset}</span> · {t.title} · {formatDateTime(t.start)} ·{' '}
            {t.technician?.name ?? 'nobody free yet'}
            {t.zeroImpact ? ' · no impact' : t.impactHours ? ` · ${hoursText(t.impactHours)} moved` : ''}
            {t.late && <span className="text-critical"> · after its deadline</span>}
          </span>
        </li>
      ))}
    </ul>
  ) : null;

/** `JC-14 +2.0 h` chips; a delay that makes its plan late is critical (icon + word, not colour alone). */
export const DelayChips = ({ delays, className }) =>
  delays?.length ? (
    <ul className={cn('flex flex-wrap gap-1.5', className)} aria-label="Job card delays">
      {delays.map((d) => (
        <li key={d.jobCardId ?? d.code}>
          <Badge tone={d.late ? 'critical' : 'neutral'} className="tabular">
            {d.late ? (
              <TriangleAlert className="size-3.5" aria-hidden />
            ) : (
              <Clock className="size-3.5" aria-hidden />
            )}
            {d.code} {delayText(d.hours)}
            {d.late && <span>· late</span>}
          </Badge>
        </li>
      ))}
    </ul>
  ) : null;

const optionFacts = (o) =>
  [
    o.lateHours > 0 ? `Plans late by ${hoursText(o.lateHours)}` : 'Plans stay on time',
    o.delayHours > 0 ? `Job cards ${delayText(o.delayHours)}` : 'No job card delays',
    o.maintenanceLateHours > 0 && `Starts ${hoursText(o.maintenanceLateHours)} after the deadline`,
  ].filter(Boolean);

const LETTERS = 'ABCDEFGH';

/**
 * Maintenance options as cards A/B/C with their impact and a Recommended badge. With `onChange` they are a
 * radio group (`value` = option id); without, a read-only list.
 */
export const OptionCards = ({ options, value, onChange, name = 'plan-option' }) => {
  if (!options?.length) return null;
  const card = (o, i) => (
    <>
      <span className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold text-subtle">Option {LETTERS[i]}</span>
        <span className="text-sm font-medium text-fg">{o.label}</span>
        {o.recommended && (
          <Badge tone="ai">
            <Sparkles className="size-3.5" aria-hidden />
            Recommended
          </Badge>
        )}
      </span>
      <span className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted tabular">
        {optionFacts(o).map((f) => (
          <span key={f} className={cn(f.startsWith('Plans late') && 'font-medium text-critical')}>
            {f}
          </span>
        ))}
      </span>
      {o.risk && (
        <span className="mt-1 flex items-start gap-1 text-xs text-warn">
          <TriangleAlert className="mt-0.5 size-3 shrink-0" aria-hidden />
          {o.risk}
        </span>
      )}
    </>
  );
  if (!onChange) {
    return (
      <ul className="space-y-1.5">
        {options.map((o, i) => (
          <li key={o.id} className="flex flex-col rounded-lg border border-border px-3 py-2">
            {card(o, i)}
          </li>
        ))}
      </ul>
    );
  }
  return (
    <fieldset className="space-y-1.5">
      <legend className="mb-1.5 text-xs font-medium text-muted">Choose how to fit the work in</legend>
      {options.map((o, i) => (
        <label
          key={o.id}
          className={cn(
            'flex cursor-pointer gap-2.5 rounded-lg border px-3 py-2 transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring',
            value === o.id ? 'border-brand bg-brand-soft' : 'border-border hover:bg-surface-2',
          )}
        >
          <input
            type="radio"
            name={name}
            value={o.id}
            checked={value === o.id}
            onChange={() => onChange(o.id)}
            className="mt-1 accent-[var(--brand)]"
          />
          <span className="flex min-w-0 flex-col">{card(o, i)}</span>
        </label>
      ))}
    </fieldset>
  );
};

/** Chat `plan` block: compact Gantt with SARA's ghost bars, verdict, operators/tasks, delays, options and a Planner link. */
export const PlanBlock = ({ payload }) => {
  const p = payload ?? {};
  const kind = p.proposal?.kind;
  return (
    <Card className="overflow-hidden">
      <CardHeader
        icon={CalendarRange}
        title={p.title ?? p.proposal?.title ?? 'Machine schedule'}
        subtitle={p.proposal ? `${p.proposal.code} · ${(KIND[kind] ?? KIND.production).label}` : null}
        actions={
          <>
            <VerdictBadge verdict={p.verdict ?? p.feasibility?.verdict} />
            <FeasibilityBadge feasibility={p.feasibility} kind={kind} />
          </>
        }
      />
      <div className="space-y-3 p-3">
        <Gantt data={p} compact />
        <MetricTiles metrics={p.metrics} />
        <OperatorLines jobCards={p.jobCards} />
        <TaskLines tasks={p.tasks} />
        <DelayChips delays={p.delays} />
        <OptionCards options={p.options} />
        {p.risks?.length > 0 && (
          <ul className="space-y-1 text-xs text-muted">
            {p.risks.slice(0, 3).map((r) => (
              <li key={r.text} className="flex items-start gap-1.5">
                <TriangleAlert
                  className={cn(
                    'mt-0.5 size-3 shrink-0',
                    r.severity === 'critical' ? 'text-critical' : 'text-warn',
                  )}
                  aria-label={r.severity}
                />
                {r.text}
              </li>
            ))}
          </ul>
        )}
        {p.proposal?.id && (
          <Link
            to={`/planner?proposal=${p.proposal.id}`}
            className="inline-flex items-center gap-1.5 text-sm font-medium text-brand hover:underline"
          >
            Open in Planner <ExternalLink className="size-3.5" aria-hidden />
          </Link>
        )}
      </div>
    </Card>
  );
};

/** Confirm card body for `apply_plan`: the plan's Gantt and what will be written. */
export const PlanPreview = ({ payload }) => {
  const plan = payload?.plan ?? {};
  const chosen = plan.options?.find((o) => o.id === payload?.option);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <VerdictBadge verdict={plan.verdict ?? plan.feasibility?.verdict} />
        <FeasibilityBadge feasibility={plan.feasibility} kind={payload?.proposal?.kind} />
        {chosen && <Badge tone="ai">{chosen.label}</Badge>}
      </div>
      <Gantt data={plan} compact />
      <MetricTiles metrics={plan.metrics} />
      <OperatorLines jobCards={plan.jobCards} />
      <TaskLines tasks={plan.tasks} />
      <DelayChips delays={plan.delays} />
      {payload?.ops?.length > 0 && (
        <ol className="divide-y divide-border rounded-lg border border-border text-sm">
          {payload.ops.map((op) => (
            <li key={op.seq} className="flex items-start gap-2 px-3 py-2">
              {op.op === 'create' ? (
                <Plus className="mt-0.5 size-4 shrink-0 text-success" aria-label="Create" />
              ) : (
                <Pencil className="mt-0.5 size-4 shrink-0 text-info" aria-label="Update" />
              )}
              <span className="min-w-0">
                <span className="font-medium text-fg">{op.label}</span>
                {op.summary && <span className="block text-xs text-muted">{op.summary}</span>}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
};
