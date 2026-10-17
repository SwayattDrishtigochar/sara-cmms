import { ArrowRight, Check, CircleCheck, CircleX, Clock, ShieldCheck, X } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { cellText } from '../blocks/DataTable.jsx';
import { KpiPreview } from '../kpis/KpiPreviewBlock.jsx';
import { cn, humanize } from '../lib/format.js';
import { useModuleMeta } from '../modules/useModules.js';
import { PlanPreview } from '../planner/PlanBlock.jsx';
import { useNow } from '../superadmin/parts.jsx';
import { Badge, Button } from '../ui/core.jsx';

const HIDDEN = new Set([
  '_id',
  'id',
  'companyId',
  'company',
  'createdBy',
  'updatedBy',
  'createdAt',
  'updatedAt',
  'deleted',
  '__v',
  'lastModifiedBy',
]);

/** "9:05" left until `expiresAt`, or null once it has passed. */
export const countdownText = (expiresAt, now = Date.now()) => {
  const ms = Date.parse(expiresAt) - now;
  if (!expiresAt || Number.isNaN(ms)) return '';
  if (ms <= 0) return null;
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

const isEmpty = (v) => v == null || v === '' || (Array.isArray(v) && !v.length);
// Bookkeeping sub-documents (trackProcess, durations, comments) that older previews carried.
const isPlainObject = (v) => v && typeof v === 'object' && !Array.isArray(v) && !v._id && !v.name;
const isNoise = (v) => isPlainObject(v) || (Array.isArray(v) && v.some(isPlainObject));

/** Display text of a preview value: ref ids by their label, then the table cell rules. */
const show = (value, labels = {}) => {
  if (Array.isArray(value)) return value.map((v) => show(v, labels)).join(', ') || '—';
  if (typeof value === 'string' && labels[value]) return labels[value];
  if (value && typeof value === 'object' && !Array.isArray(value) && !value._id && !value.name) {
    return JSON.stringify(value);
  }
  return cellText(value);
};

const useLabelOf = (module) => {
  const { data: meta } = useModuleMeta(module);
  return (key) =>
    meta?.fields?.find((f) => f.key === key)?.label ??
    humanize(key.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase());
};

const Rows = ({ children }) => (
  <dl className="grid grid-cols-[minmax(7rem,auto)_1fr] gap-x-3 gap-y-1 text-sm">{children}</dl>
);
const Row = ({ label, children }) => (
  <>
    <dt className="truncate text-muted">{label}</dt>
    <dd className="min-w-0 break-words text-fg">{children}</dd>
  </>
);

const CreatePreview = ({ payload, labelOf }) => (
  <div className="space-y-3">
    {payload.items?.map((item, i) => {
      const entries = Object.entries(item.doc ?? {}).filter(
        ([k, v]) => !HIDDEN.has(k) && !isEmpty(v) && !isNoise(v),
      );
      return (
        <div key={i} className="rounded-lg border border-border bg-surface px-3 py-2">
          {payload.items.length > 1 && <p className="mb-1 text-xs font-medium text-subtle">#{i + 1}</p>}
          <Rows>
            {entries.map(([k, v]) => (
              <Row key={k} label={labelOf(k)}>
                {show(v, item.labels)}
              </Row>
            ))}
          </Rows>
        </div>
      );
    })}
  </div>
);

const UpdatePreview = ({ payload, labelOf }) => (
  <div className="space-y-3">
    {payload.items?.map((item) => (
      <div key={item.id} className="overflow-hidden rounded-lg border border-border bg-surface">
        <p className="border-b border-border bg-surface-2 px-3 py-1.5 text-xs font-semibold text-fg">
          {item.label}
        </p>
        <table className="w-full text-sm">
          <thead className="text-left text-[11px] text-subtle">
            <tr>
              <th className="px-3 py-1 font-medium">Field</th>
              <th className="px-3 py-1 font-medium">Before</th>
              <th className="px-3 py-1 font-medium">After</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {item.changes?.map((c) => (
              <tr key={c.field}>
                <td className="px-3 py-1.5 text-muted">{labelOf(c.field)}</td>
                <td className="px-3 py-1.5 text-muted line-through decoration-critical/60">
                  {show(c.from, item.labels)}
                </td>
                <td className="px-3 py-1.5 font-medium text-fg">{show(c.to, item.labels)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    ))}
  </div>
);

const WorkOrderLine = ({ workOrder }) =>
  workOrder ? (
    <Row label="Work order">
      {workOrder.link ? (
        <Link to={workOrder.link} className="font-medium text-brand hover:underline">
          {workOrder.code} · {workOrder.name}
        </Link>
      ) : (
        `${workOrder.code} · ${workOrder.name}`
      )}
      {workOrder.asset && <span className="text-muted"> on {workOrder.asset}</span>}
    </Row>
  ) : null;

const Preview = ({ payload }) => {
  const labelOf = useLabelOf(payload.module);
  switch (payload.action) {
    case 'create':
      return <CreatePreview payload={payload} labelOf={labelOf} />;
    case 'update':
      return <UpdatePreview payload={payload} labelOf={labelOf} />;
    case 'delete':
      return (
        <Rows>
          <Row label="Records">
            <ul className="list-disc pl-4">
              {payload.items?.map((item) => (
                <li key={item.id}>{item.label}</li>
              ))}
            </ul>
          </Row>
          {payload.reason && <Row label="Reason">{payload.reason}</Row>}
        </Rows>
      );
    case 'status':
      return (
        <Rows>
          <WorkOrderLine workOrder={payload.workOrder} />
          <Row label="Status">
            <span className="inline-flex flex-wrap items-center gap-1.5">
              <Badge value={payload.from} />
              <ArrowRight className="size-3.5 text-subtle" aria-label="to" />
              <Badge value={payload.to} />
            </span>
          </Row>
          {payload.note && <Row label="Note">{payload.note}</Row>}
        </Rows>
      );
    case 'plan':
      return <PlanPreview payload={payload} />;
    case 'kpi':
      return <KpiPreview payload={payload} />;
    case 'comment':
      return (
        <Rows>
          <WorkOrderLine workOrder={payload.workOrder} />
          <Row label="Comment">
            <blockquote className="border-l-2 border-border-strong pl-2 whitespace-pre-wrap">
              {payload.comment}
            </blockquote>
          </Row>
        </Rows>
      );
    default:
      return (
        <pre className="max-h-64 overflow-auto rounded-lg bg-surface-2 p-2 font-mono text-xs scrollbar-thin">
          {JSON.stringify(payload, null, 2)}
        </pre>
      );
  }
};

const DONE = {
  confirmed: { icon: CircleCheck, text: 'Confirmed', tone: 'success' },
  rejected: { icon: CircleX, text: 'Rejected · nothing was saved', tone: 'neutral' },
  expired: { icon: Clock, text: 'Expired · nothing was saved', tone: 'neutral' },
};

/**
 * `confirm` block: what a write tool will do (labels, before/after diff), a countdown to `expiresAt`, and
 * Confirm / Reject. `action` = the message's pendingAction ({ id, status, expiresAt }); else the payload's
 * `actionId` / `expiresAt`. `onConfirm(actionId)` / `onReject(actionId)`.
 */
export const ConfirmCard = ({ payload = {}, action, onConfirm, onReject, className }) => {
  const now = useNow(1000);
  const [busy, setBusy] = useState(null);
  const expiresAt = action?.expiresAt ?? payload.expiresAt;
  const left = countdownText(expiresAt, now);
  const soon = Date.parse(expiresAt) - now < 60_000;
  const raw = action?.status ?? 'pending';
  const status = raw === 'pending' && left === null ? 'expired' : raw;
  const pending = status === 'pending';
  const actionId = action?.id ?? payload.actionId;
  const ready = pending && Boolean(actionId);
  const done = DONE[status];
  const run = async (kind, fn) => {
    setBusy(kind);
    try {
      await fn?.();
    } finally {
      setBusy(null);
    }
  };
  return (
    <section
      aria-label={payload.label ?? 'Confirm change'}
      className={cn(
        'overflow-hidden rounded-xl border bg-surface-2/50',
        pending ? 'border-warn/50' : 'border-border',
        className,
      )}
    >
      <header className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <span className="flex min-w-0 items-center gap-2 text-sm font-semibold text-fg">
          <ShieldCheck className={cn('size-4 shrink-0', pending ? 'text-warn' : 'text-muted')} aria-hidden />
          <span className="truncate">{payload.label ?? 'Confirm this change'}</span>
        </span>
        {payload.moduleLabel && <Badge tone="neutral">{payload.moduleLabel}</Badge>}
      </header>
      <div className="px-3 py-3">
        <Preview payload={payload} />
      </div>
      <footer className="flex min-h-12 flex-wrap items-center justify-between gap-2 border-t border-border px-3 py-2">
        {done ? (
          <span className="flex min-w-0 items-center gap-2" role="status">
            <Badge tone={done.tone}>
              <done.icon className="size-3.5" aria-hidden />
              {done.text}
            </Badge>
            {status === 'confirmed' && action?.result?.summary && (
              <span className="truncate text-xs text-muted">{action.result.summary}</span>
            )}
          </span>
        ) : (
          <>
            <span className="flex items-center gap-1.5 text-xs text-muted" aria-live="off">
              <Clock className="size-3.5" aria-hidden />
              {left ? (
                <>
                  Expires in{' '}
                  <span className={cn('font-medium tabular', soon ? 'text-warn' : 'text-fg')}>{left}</span>
                </>
              ) : (
                'Waiting for you to confirm'
              )}
            </span>
            <span className="flex gap-2">
              <Button
                size="sm"
                variant="ghost"
                icon={X}
                disabled={!ready || busy}
                loading={busy === 'reject'}
                onClick={() => run('reject', () => onReject?.(actionId))}
              >
                Reject
              </Button>
              <Button
                size="sm"
                variant="primary"
                icon={Check}
                disabled={!ready || busy}
                loading={busy === 'confirm'}
                onClick={() => run('confirm', () => onConfirm?.(actionId))}
              >
                Confirm
              </Button>
            </span>
          </>
        )}
      </footer>
    </section>
  );
};
