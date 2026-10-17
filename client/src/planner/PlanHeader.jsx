import {
  ArrowRight,
  CircleCheck,
  Lightbulb,
  OctagonAlert,
  Sparkles,
  TriangleAlert,
  Wand2,
} from 'lucide-react';
import { cn, formatDateTime, formatMoney, formatRelative } from '../lib/format.js';
import { AiProvenance, Badge, Button, Card, Skeleton } from '../ui/core.jsx';
import { hoursText, MetricTiles, ProposalStatusBadge, VerdictBadge } from './PlanBlock.jsx';
import { VERDICT_LABEL } from './planEdits.js';

const notesText = (notes) => (Array.isArray(notes) ? notes.join(' ') : (notes ?? ''));

/** The deterministic line shown when the AI summary is unavailable. */
export const fallbackLine = ({ verdict, feasibility, metrics }) => {
  const word = VERDICT_LABEL[verdict] ?? 'Doable';
  if (metrics) {
    return `${word}: ${metrics.tasks ?? 0} tasks, ${hoursText(metrics.productionHoursLost)} of production moved`;
  }
  const notes = notesText(feasibility?.notes);
  return `${word}${notes ? `: ${notes}` : ''}`;
};

const Fact = ({ label, children, className }) => (
  <div>
    <dt className="text-[11px] text-subtle">{label}</dt>
    <dd className={cn('text-sm font-medium text-fg tabular', className)}>{children}</dd>
  </div>
);

/**
 * Top of a plan: code (what it becomes on create), title, verdict and status badges, the feasibility facts
 * or metrics tiles, and SARA's summary with its provenance (Regenerate = `onExplain`).
 */
export const PlanHeader = ({
  code,
  title,
  verdict,
  feasibility: f = {},
  explanation: e,
  aiError,
  status,
  metrics,
  onExplain,
  explaining,
  becomes = metrics ? 'MP-n' : 'PP-n',
}) => {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs font-semibold text-subtle tabular">
            {code}
            {status === 'draft' && <span className="font-normal"> · becomes {becomes} on create</span>}
          </p>
          <h2 className="text-base font-semibold text-fg">{title}</h2>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <VerdictBadge verdict={verdict} />
          {status && <ProposalStatusBadge status={status} />}
        </div>
      </div>

      {metrics ? (
        <MetricTiles metrics={metrics} />
      ) : (
        (f.dueDate || f.projectedFinish) && (
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
        )
      )}

      <Card ai className="p-3">
        {explaining ? (
          <div className="space-y-2" role="status" aria-label="Explaining">
            <Skeleton className="h-3.5 w-11/12" />
            <Skeleton className="h-3.5 w-3/4" />
          </div>
        ) : e?.text ? (
          <>
            <p className="text-sm leading-relaxed whitespace-pre-line text-fg">{e.text}</p>
            <AiProvenance
              className="mt-2"
              model={e.mock ? `${e.model ?? 'SARA'} (mock)` : e.model}
              at={e.at ? formatRelative(e.at) : null}
              onRegenerate={onExplain}
            />
          </>
        ) : (
          <>
            <p className="text-sm text-fg">{fallbackLine({ verdict, feasibility: f, metrics })}</p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Badge tone="neutral">
                <Lightbulb className="size-3.5" aria-hidden />
                AI explanation unavailable
              </Badge>
              {aiError?.message && <span className="text-[11px] text-subtle">{aiError.message}</span>}
              {onExplain && (
                <button
                  type="button"
                  onClick={onExplain}
                  className="text-[11px] font-medium text-ai hover:underline"
                >
                  Try again
                </button>
              )}
            </div>
          </>
        )}
      </Card>
    </div>
  );
};

const SEVERITY = {
  critical: { icon: OctagonAlert, cls: 'text-critical' },
  warning: { icon: TriangleAlert, cls: 'text-warn' },
};

/** How much production this check moves compared with the last checked version (maintenance plans). */
export const ImpactDelta = ({ delta }) => {
  if (!delta || Math.abs(delta.hours ?? 0) < 0.01) return null;
  const more = delta.hours > 0;
  return (
    <p className={cn('mt-2 text-sm font-medium tabular', more ? 'text-warn' : 'text-success')}>
      Production impact {more ? '+' : '−'}
      {hoursText(delta.hours)} ({more ? '+' : '−'}
      {formatMoney(Math.abs(delta.cost ?? 0))}) {more ? 'more' : 'less'} than the last check
    </p>
  );
};

const headline = (check) => {
  const n = check.issues?.length ?? 0;
  if (check.verdict === 'doable') return 'Nothing stands in the way. Create the plan when you are ready.';
  if (check.verdict === 'not_doable')
    return `${n} issue${n === 1 ? '' : 's'}; at least one has no suggestion, so change the rows by hand or apply what SARA offers first.`;
  return `${n} issue${n === 1 ? '' : 's'} to settle: apply a suggestion or edit the rows, then check again.`;
};

/**
 * Doable / Needs adjustment / Not doable with the issues (linked to their rows) and SARA's adjustments,
 * each with an Apply suggestion button (`onApply(adjustment)`; absent = read-only).
 */
export const VerdictCard = ({ check, onApply, applying }) => {
  if (!check) return null;
  const issues = check.issues ?? [];
  const adjustments = check.adjustments ?? [];
  return (
    <Card className="p-4" aria-label="Check result">
      <div className="flex flex-wrap items-center gap-2">
        <VerdictBadge verdict={check.verdict} />
        <p className="text-sm text-muted">{headline(check)}</p>
      </div>
      <ImpactDelta delta={check.impactDelta} />
      {issues.length > 0 && (
        <ul className="mt-3 space-y-1.5 text-sm" aria-label="Issues">
          {issues.map((it, i) => {
            const s = SEVERITY[it.severity] ?? SEVERITY.warning;
            const key = it.jobCard ?? it.task;
            return (
              <li key={`${it.kind}-${i}`} className="flex items-start gap-2">
                <s.icon className={cn('mt-0.5 size-4 shrink-0', s.cls)} aria-hidden />
                <span className="min-w-0 text-fg">
                  <span className="sr-only">{it.severity}: </span>
                  {it.text}
                  {key && (
                    <a
                      href={`#row-${key}`}
                      className="ml-1.5 inline-flex items-center gap-0.5 text-xs font-medium text-brand hover:underline"
                    >
                      Go to row <ArrowRight className="size-3" aria-hidden />
                    </a>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {adjustments.length > 0 && (
        <ul className="mt-3 space-y-1.5" aria-label="Suggestions">
          {adjustments.map((a) => (
            <li
              key={a.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-ai/30 bg-ai/5 px-3 py-2"
            >
              <span className="flex min-w-0 items-start gap-1.5 text-sm text-fg">
                <Sparkles className="mt-0.5 size-3.5 shrink-0 text-ai" aria-hidden />
                {a.label}
              </span>
              {onApply && (
                <Button size="sm" variant="soft" icon={Wand2} loading={applying} onClick={() => onApply(a)}>
                  Apply suggestion
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {check.risks?.length > 0 && (
        <ul className="mt-3 space-y-1 text-xs text-muted" aria-label="Risks">
          {check.risks.slice(0, 4).map((r) => (
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
      {check.verdict === 'doable' && !issues.length && (
        <p className="mt-2 flex items-center gap-1.5 text-xs text-success">
          <CircleCheck className="size-3.5" aria-hidden /> No conflicts found.
        </p>
      )}
    </Card>
  );
};
