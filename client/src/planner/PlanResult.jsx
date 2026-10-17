import { CircleCheck, ExternalLink, ShieldCheck, Trash2 } from 'lucide-react';
import { Link, useNavigate } from 'react-router';
import { toast } from 'sonner';
import { formatDateTime, formatRelative } from '../lib/format.js';
import { Button } from '../ui/core.jsx';
import { useApplyProposal, useDiscardProposal, useExplainProposal } from './usePlanning.js';

export const ACTIVE = ['draft', 'failed'];

/** True for an expired draft (or a proposal already marked expired). */
export const isExpired = (p) =>
  p.status === 'expired' || (p.status === 'draft' && p.expiresAt && Date.parse(p.expiresAt) < Date.now());

/**
 * Create / Discard / Regenerate of one proposal. `create(body)` applies it and navigates to the record of
 * `module` it created; PLAN_CHANGED selects the updated plan through `onResult`; PLAN_NOT_DOABLE offers
 * "Create anyway" (force). `explainNow(onDone)` asks for a new summary.
 */
export const usePlanActions = ({ result, onResult, module }) => {
  const p = result.proposal;
  const id = String(p._id);
  const navigate = useNavigate();
  const apply = useApplyProposal(id);
  const discard = useDiscardProposal(id);
  const explain = useExplainProposal(id);

  const create = (body = {}) =>
    apply.mutate(body, {
      onSuccess: (r) => {
        const rec = r?.created?.find((c) => c.module === module);
        toast.success(`Created ${rec?.label ?? p.proposalCode}`, {
          description: `${r?.created?.length ?? 0} created, ${r?.updated?.length ?? 0} updated.`,
        });
        if (rec) navigate(rec.link ?? `/m/${module}/${rec.id}`);
      },
      onError: (err) => {
        if (err.code === 'PLAN_CHANGED' && err.details?.proposalId) {
          toast.info('Plan changed — showing the updated plan', { description: err.message });
          onResult({ proposal: { _id: String(err.details.proposalId) } });
        } else if (err.code === 'PLAN_NOT_DOABLE') {
          toast.error('The last check found this plan not doable', {
            description: 'Apply a suggestion or adjust the rows, then check again.',
            action: { label: 'Create anyway', onClick: () => create({ ...body, force: true }) },
          });
        } else toast.error("Couldn't create the plan", { description: err.message });
      },
    });

  const drop = () =>
    discard.mutate(undefined, {
      onSuccess: () => {
        toast.success(`Discarded ${p.proposalCode}`);
        onResult(null);
      },
      onError: (err) => toast.error("Couldn't discard the plan", { description: err.message }),
    });

  const explainNow = (onDone) =>
    explain.mutate(undefined, {
      onSuccess: (r) => onDone?.(r?.explanation ?? null),
      onError: (err) =>
        toast.error("SARA couldn't explain this plan right now", { description: err.message }),
    });

  return { create, drop, explainNow, apply, discard, explain };
};

/** Stale / expired / failed / applied notes under a plan. */
export const StatusNotes = ({ proposal: p, applied }) => {
  const links = applied ? [...(applied.created ?? []), ...(applied.updated ?? [])] : [];
  return (
    <>
      {p.status === 'stale' && (
        <p className="rounded-lg border border-warn/40 bg-warn/5 px-3 py-2 text-sm text-fg">
          The schedule changed after this plan was made. Make a new plan to see the current picture.
        </p>
      )}
      {isExpired(p) && <p className="text-sm text-muted">This plan expired. Make a new one to create it.</p>}
      {p.status === 'failed' && p.error && (
        <p className="rounded-lg border border-critical/40 bg-critical/5 px-3 py-2 text-sm text-fg">
          The last attempt stopped: {p.error}. Create again to finish it.
        </p>
      )}
      {p.status === 'applied' && (
        <div className="space-y-1.5">
          <p className="flex items-center gap-1.5 text-sm text-success">
            <CircleCheck className="size-4" aria-hidden />
            Created {formatRelative(p.appliedAt)}
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
    </>
  );
};

/** Sticky bottom bar: Check plan (enabled once edited), Create plan (after a clean check), Discard. */
export const ActionBar = ({
  proposal: p,
  dirty,
  verdict,
  onCheck,
  checking,
  onCreate,
  creating,
  onDiscard,
  discarding,
  createLabel = 'Create plan',
}) => {
  const blocked = dirty
    ? 'Check the plan before creating it.'
    : verdict === 'not_doable'
      ? 'Not doable as it stands — apply a suggestion or adjust the rows.'
      : null;
  return (
    <div className="sticky bottom-0 z-10 -mx-4 -mb-4 flex flex-wrap items-center gap-2 border-t border-border bg-surface/95 px-4 py-3 backdrop-blur">
      {onCheck && (
        <Button
          variant={dirty ? 'primary' : 'secondary'}
          icon={ShieldCheck}
          loading={checking}
          disabled={!dirty}
          onClick={onCheck}
        >
          Check plan
        </Button>
      )}
      <Button
        variant={dirty ? 'secondary' : 'primary'}
        icon={CircleCheck}
        loading={creating || p.status === 'applying'}
        disabled={Boolean(blocked) || checking}
        onClick={onCreate}
      >
        {createLabel}
      </Button>
      <Button variant="ghost" icon={Trash2} loading={discarding} onClick={onDiscard}>
        Discard
      </Button>
      <p className="w-full text-xs text-subtle sm:w-auto sm:flex-1 sm:text-right">
        {blocked ?? (p.expiresAt ? `Valid until ${formatDateTime(p.expiresAt)}.` : '')}
      </p>
    </div>
  );
};
