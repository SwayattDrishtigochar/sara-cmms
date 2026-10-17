import { useQuery } from '@tanstack/react-query';
import {
  ArrowUpRight,
  CalendarClock,
  Check,
  CircleSlash,
  ClipboardPlus,
  Eye,
  Microscope,
  SearchX,
  Sparkles,
  Wrench,
} from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { toast } from 'sonner';
import { api } from '../api/client.js';
import { useCan, useSession } from '../auth/useAuth.js';
import { cn, formatDateTime, formatDuration, formatRelative, refLabel } from '../lib/format.js';
import { bandOf, bandText, fieldLabel, formatValue } from '../machines/telemetry.js';
import { useRecord, useRecords, useSaveRecord } from '../modules/useModules.js';
import { SERIES_VARS, seriesColor, TelemetryChart } from '../ui/charts.jsx';
import { AiProvenance, Badge, Button, Card, EmptyState, Skeleton } from '../ui/core.jsx';
import { Field, Input, Select, Textarea } from '../ui/form.jsx';
import { Dialog, Sheet } from '../ui/overlay.jsx';
import {
  AutoWorkOrderBadge,
  assetOf,
  deviationOf,
  Markdown,
  ScanProvenance,
  SeverityBadge,
  StateBadge,
  typeLabel,
  urgencyText,
} from './parts.jsx';
import { assetIdOf, isActive, useAnomalyState, useInvestigate } from './useAnomalies.js';

const WINDOW_MS = 2 * 3600e3;
const PRIORITIES = ['Low', 'Medium', 'High'];

/** ±2 h around the detection, capped at `now` (fixed per mount so the query key stays stable). */
export const evidenceWindow = (detectedAt, now = Date.now()) => {
  const detected = Date.parse(detectedAt);
  if (Number.isNaN(detected)) return null;
  return { start: detected - WINDOW_MS, stop: Math.min(now, detected + WINDOW_MS), detected };
};

/** `wrap`: the value may take a second line (link + badge) instead of being cut to one. */
const Stat = ({ label, children, wrap = false, className }) => (
  <div className={cn('min-w-0', className)}>
    <dt className="text-[11px] text-subtle">{label}</dt>
    <dd
      className={cn(
        'text-sm font-medium text-fg',
        wrap ? 'flex flex-wrap items-center gap-x-1.5 gap-y-1' : 'truncate',
      )}
    >
      {children}
    </dd>
  </div>
);

const H3 = ({ icon: Icon, children, className }) => (
  <h3 className={cn('flex items-center gap-1.5 text-sm font-semibold text-fg', className)}>
    {Icon && <Icon className="size-4 text-ai" aria-hidden />}
    {children}
  </h3>
);

const stats = (points) => {
  const values = points.map(([, v]) => v).filter((v) => typeof v === 'number');
  if (!values.length) return null;
  return { min: Math.min(...values), max: Math.max(...values), last: values[values.length - 1] };
};

/** Flagged fields ±2 h with the spec's normal band and a rule where SARA flagged it; one chart per field. */
const Evidence = ({ anomaly }) => {
  const machine = assetOf(anomaly);
  const fields = [...new Set((anomaly.parameters ?? []).map((p) => p.field))];
  const [now] = useState(Date.now);
  const win = evidenceWindow(anomaly.detectedAt, now);
  const specs = useQuery({
    queryKey: ['telemetry', 'fields', machine.id],
    queryFn: ({ signal }) =>
      api('/telemetry/fields', { query: { assetId: machine.id }, signal }).then((r) => r.fields),
    staleTime: 5 * 60_000,
    enabled: Boolean(machine.id),
  });
  const series = useQuery({
    queryKey: ['telemetry', 'series', machine.id, fields.join(','), win?.start, win?.stop],
    queryFn: ({ signal }) =>
      api('/telemetry/series', {
        query: {
          assetId: machine.id,
          fields: fields.join(','),
          start: new Date(win.start).toISOString(),
          stop: new Date(win.stop).toISOString(),
        },
        signal,
      }),
    enabled: Boolean(machine.id && fields.length && win),
  });
  if (!fields.length || !win) return null;
  return (
    <section aria-labelledby="anomaly-evidence" className="space-y-3">
      <H3>
        <span id="anomaly-evidence">Evidence</span>
        <span className="text-xs font-normal text-muted">
          2 h either side · shaded: normal band · red line: when SARA flagged it
        </span>
      </H3>
      {series.isLoading ? (
        <Skeleton className="h-40" />
      ) : series.isError ? (
        <p className="text-sm text-critical">Couldn't load the readings: {series.error.message}</p>
      ) : (
        fields.map((field) => {
          const param = anomaly.parameters.find((p) => p.field === field);
          const spec = specs.data?.find((f) => f.field === field);
          const row = series.data?.series?.find((s) => s.field === field);
          const points = row?.points ?? [];
          const unit = row?.unit ?? spec?.unit ?? param?.unit ?? '';
          const band = spec ? bandOf(spec) : null;
          const st = stats(points);
          const fmt = (v) => formatValue(v) + (unit ? ` ${unit}` : '');
          return (
            <div key={field} className={cn('rounded-lg border border-border p-3', SERIES_VARS)}>
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <p className="text-sm font-medium text-fg">{fieldLabel(field)}</p>
                <p className="text-xs text-muted">
                  {deviationOf(param) && (
                    <span className="font-semibold text-fg tabular">{deviationOf(param)} · </span>
                  )}
                  {band
                    ? `Normal ${bandText(band, unit)}`
                    : typeof param?.expected === 'number'
                      ? `Expected ${fmt(param.expected)}`
                      : ''}
                </p>
              </div>
              {points.length ? (
                <TelemetryChart
                  series={[{ key: field, label: fieldLabel(field), color: seriesColor(0), points }]}
                  unit={unit || undefined}
                  band={band ?? undefined}
                  domain={[win.start, win.stop]}
                  every={series.data?.every}
                  markers={[{ at: win.detected, label: 'Detected' }]}
                  syncId={`anomaly-${anomaly._id}`}
                  height={160}
                  className="mt-2"
                />
              ) : (
                <p className="mt-2 text-sm text-muted">No readings for this field in the window.</p>
              )}
              <details className="mt-2 text-xs text-muted">
                <summary className="cursor-pointer select-none">Values</summary>
                <dl className="mt-1.5 grid grid-cols-2 gap-2 sm:grid-cols-5">
                  <Stat label="Low">{st ? fmt(st.min) : '—'}</Stat>
                  <Stat label="High">{st ? fmt(st.max) : '—'}</Stat>
                  <Stat label="Latest">{st ? fmt(st.last) : '—'}</Stat>
                  <Stat label="Observed">
                    {typeof param?.observed === 'number' ? fmt(param.observed) : '—'}
                  </Stat>
                  <Stat label="Expected">
                    {typeof param?.expected === 'number' ? fmt(param.expected) : '—'}
                  </Stat>
                </dl>
              </details>
            </div>
          );
        })
      )}
    </section>
  );
};

/** The explanation after the summary: the watch takes the summary from the explanation's first sentence. */
const restOf = (explanation, summary) =>
  summary && explanation?.startsWith(summary) ? explanation.slice(summary.length).trim() : explanation;

const Summary = ({ anomaly }) => (
  <Card ai className="p-4">
    <div className="flex items-start justify-between gap-3">
      <H3 icon={Sparkles}>What SARA found</H3>
      {anomaly.confidence != null && (
        <Badge tone="ai">{Math.round(anomaly.confidence * 100)}% confident</Badge>
      )}
    </div>
    <p className="mt-2 text-sm text-fg">{anomaly.summary}</p>
    {restOf(anomaly.explanation, anomaly.summary) && (
      <p className="mt-2 text-sm text-muted">{restOf(anomaly.explanation, anomaly.summary)}</p>
    )}
    {anomaly.parameters?.length > 0 && (
      <table className="mt-3 w-full text-sm">
        <thead className="text-left text-xs text-muted">
          <tr>
            <th className="py-1 font-medium">Parameter</th>
            <th className="py-1 text-right font-medium">Observed</th>
            <th className="py-1 text-right font-medium">Expected</th>
            <th className="py-1 text-right font-medium">Deviation</th>
          </tr>
        </thead>
        <tbody>
          {anomaly.parameters.map((p) => (
            <tr key={p.field} className="border-t border-border">
              <td className="py-1.5 text-fg">{fieldLabel(p.field)}</td>
              <td className="py-1.5 text-right font-semibold text-fg tabular">
                {formatValue(p.observed)}
                {p.unit && typeof p.observed === 'number' ? ` ${p.unit}` : ''}
              </td>
              <td className="py-1.5 text-right text-muted tabular">{formatValue(p.expected)}</td>
              <td className="py-1.5 text-right text-fg tabular">{deviationOf(p) ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    )}
    {anomaly.likelyCauses?.length > 0 && (
      <div className="mt-3">
        <h4 className="text-xs font-semibold text-muted">Likely causes</h4>
        <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-fg">
          {anomaly.likelyCauses.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
      </div>
    )}
    {anomaly.recommendedActions?.length > 0 && (
      <div className="mt-3">
        <h4 className="text-xs font-semibold text-muted">Recommended</h4>
        <ol className="mt-1 list-decimal space-y-0.5 pl-5 text-sm text-fg">
          {anomaly.recommendedActions.map((a) => (
            <li key={a}>{a}</li>
          ))}
        </ol>
      </div>
    )}
    {anomaly.urgencyHours != null && (
      <p className="mt-3 flex items-center gap-1.5 text-sm text-fg">
        <CalendarClock className="size-4 text-muted" aria-hidden />
        Act within {urgencyText(anomaly.urgencyHours)}
      </p>
    )}
    <ScanProvenance model={anomaly.model} at={formatRelative(anomaly.detectedAt)} className="mt-3" />
  </Card>
);

/** Confirm dialog prefilled from the suggested work order; creates it with the anomaly linked. */
const CreateWorkOrderDialog = ({ anomaly, onClose }) => {
  const suggested = anomaly.investigation?.suggestedWorkOrder ?? {};
  const machine = assetOf(anomaly);
  const navigate = useNavigate();
  const save = useSaveRecord('workorders');
  const [form, setForm] = useState({
    name: suggested.name ?? `${typeLabel(anomaly.type)} on ${machine.name}`,
    description: suggested.description ?? anomaly.explanation ?? anomaly.summary ?? '',
    priority: PRIORITIES.includes(suggested.priority)
      ? suggested.priority
      : anomaly.severity === 'critical'
        ? 'High'
        : 'Medium',
    category: suggested.category ?? 'Breakdown',
    estimatedDurationMin: suggested.estimatedDurationMin ?? '',
  });
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));
  const submit = () => {
    const minutes = Number(form.estimatedDurationMin);
    save.mutate(
      {
        data: {
          name: form.name.trim(),
          description: form.description,
          priority: form.priority,
          category: form.category,
          ...(form.estimatedDurationMin !== '' && !Number.isNaN(minutes)
            ? { estimatedDurationMin: minutes }
            : {}),
          ...(machine.id ? { asset: machine.id } : {}),
          anomalyId: anomaly._id,
        },
      },
      {
        onSuccess: (res) => {
          toast.success(`Work order ${res.item?.workOrderId ?? ''} created`.replace(/\s+/g, ' '), {
            action: { label: 'Open', onClick: () => navigate(`/m/workorders/${res.item._id}`) },
          });
          onClose();
        },
        onError: (err) => toast.error("Couldn't create the work order", { description: err.message }),
      },
    );
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Create work order"
      description={`For ${machine.name}, linked to ${anomaly.anomalyCode}.`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            icon={ClipboardPlus}
            loading={save.isPending}
            disabled={!form.name.trim()}
            onClick={submit}
          >
            Create work order
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Title" required>
          {(p) => <Input {...p} value={form.name} onChange={set('name')} />}
        </Field>
        <Field label="Description">
          {(p) => <Textarea {...p} value={form.description} onChange={set('description')} />}
        </Field>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Priority">
            {(p) => (
              <Select {...p} value={form.priority} onChange={set('priority')}>
                {PRIORITIES.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Category">
            {(p) => <Input {...p} value={form.category} onChange={set('category')} />}
          </Field>
          <Field label="Estimated duration">
            {(p) => (
              <Input
                {...p}
                type="number"
                min={0}
                suffix="min"
                value={form.estimatedDurationMin}
                onChange={set('estimatedDurationMin')}
              />
            )}
          </Field>
        </div>
      </div>
    </Dialog>
  );
};

const Investigation = ({ anomaly, canUpdate, canCreateWo, linked }) => {
  const inv = anomaly.investigation;
  const investigate = useInvestigate(anomaly._id);
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const wo = inv?.suggestedWorkOrder;
  if (!inv) {
    return (
      <Card className="p-4">
        <H3 icon={Microscope}>Investigation</H3>
        <p className="mt-1.5 text-sm text-muted">
          SARA can pull the evidence together — recent readings, work order history, maintenance schedule and
          spare parts — then suggest a root cause and a work order.
        </p>
        {investigate.isPending ? (
          <p className="mt-3 flex items-center gap-2 text-sm text-ai" aria-live="polite">
            <Sparkles className="size-4 animate-pulse" aria-hidden />
            SARA is investigating…
          </p>
        ) : (
          canUpdate && (
            <Button variant="ai" icon={Microscope} className="mt-3" onClick={() => investigate.mutate()}>
              Investigate
            </Button>
          )
        )}
      </Card>
    );
  }
  return (
    <Card ai className="space-y-4 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <H3 icon={Microscope}>Investigation</H3>
        {inv.confidence != null && <Badge tone="ai">{Math.round(inv.confidence * 100)}% confident</Badge>}
      </div>
      {inv.rootCause && (
        <div>
          <h4 className="text-xs font-semibold text-muted">Root cause</h4>
          <p className="mt-0.5 text-sm text-fg">{inv.rootCause}</p>
        </div>
      )}
      {inv.markdown ? (
        <Markdown>{inv.markdown}</Markdown>
      ) : (
        inv.summary && <p className="text-sm text-fg">{inv.summary}</p>
      )}
      {!inv.markdown && inv.recommendedActions?.length > 0 && (
        <div>
          <h4 className="text-xs font-semibold text-muted">Recommended actions</h4>
          <ol className="mt-1 list-decimal space-y-0.5 pl-5 text-sm text-fg">
            {inv.recommendedActions.map((a) => (
              <li key={a}>{a}</li>
            ))}
          </ol>
        </div>
      )}
      {wo && (
        <div className="rounded-lg border border-border bg-surface-2/60 p-3">
          <p className="flex items-center gap-1.5 text-xs font-semibold text-muted">
            <Wrench className="size-3.5" aria-hidden />
            Suggested work order
          </p>
          <p className="mt-1 text-sm font-medium text-fg">{wo.name}</p>
          {wo.description && <p className="mt-0.5 text-sm text-muted">{wo.description}</p>}
          <p className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted">
            {wo.priority && <Badge value={wo.priority} />}
            {wo.category && <span>{wo.category}</span>}
            {wo.estimatedDurationMin != null && <span>~{formatDuration(wo.estimatedDurationMin * 60)}</span>}
            {inv.urgencyHours != null && <span>within {urgencyText(inv.urgencyHours)}</span>}
          </p>
          {linked.length > 0 && (
            <ul className="mt-2 space-y-1 text-sm">
              {linked.map((w) => (
                <li key={w._id}>
                  <Link
                    to={`/m/workorders/${w._id}`}
                    className="inline-flex items-center gap-1.5 text-brand hover:underline"
                  >
                    <ArrowUpRight className="size-3.5" aria-hidden />
                    {w.workOrderId} · {w.name}
                  </Link>
                  <Badge value={w.workStatus} className="ml-2" />
                </li>
              ))}
            </ul>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            {canCreateWo && (
              <Button variant="primary" icon={ClipboardPlus} onClick={() => setCreating(true)}>
                {linked.length ? 'Create another work order' : 'Create work order'}
              </Button>
            )}
            {canCreateWo && (
              <Button
                icon={CalendarClock}
                onClick={() => navigate(`/planner?maintenance=${assetIdOf(anomaly)}&anomaly=${anomaly._id}`)}
              >
                Plan maintenance
              </Button>
            )}
          </div>
        </div>
      )}
      <AiProvenance
        model={inv.mock ? `${inv.model ?? 'SARA'} (mock)` : inv.model}
        at={inv.at ? formatRelative(inv.at) : undefined}
        onRegenerate={canUpdate && !investigate.isPending ? () => investigate.mutate() : undefined}
      />
      {investigate.isPending && (
        <p className="text-xs text-ai" aria-live="polite">
          SARA is investigating again…
        </p>
      )}
      {creating && <CreateWorkOrderDialog anomaly={anomaly} onClose={() => setCreating(false)} />}
    </Card>
  );
};

const FalsePositiveDialog = ({ onConfirm, onClose, pending }) => {
  const [note, setNote] = useState('');
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Mark as a false positive"
      description="A short note helps SARA judge this machine better next time."
      size="sm"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={pending} onClick={() => onConfirm(note.trim())}>
            Mark as false positive
          </Button>
        </>
      }
    >
      <Field label="Note">
        {(p) => (
          <Textarea
            {...p}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="e.g. Planned high-speed trial on this press"
          />
        )}
      </Field>
    </Dialog>
  );
};

const StateActions = ({ anomaly }) => {
  const change = useAnomalyState(anomaly._id);
  const [dismissing, setDismissing] = useState(false);
  return (
    <div className="flex w-full flex-wrap justify-end gap-2">
      {anomaly.state === 'open' && (
        <Button
          icon={Eye}
          loading={change.isPending}
          onClick={() => change.mutate({ state: 'acknowledged' })}
        >
          Acknowledge
        </Button>
      )}
      <Button icon={CircleSlash} disabled={change.isPending} onClick={() => setDismissing(true)}>
        False positive
      </Button>
      <Button
        variant="primary"
        icon={Check}
        loading={change.isPending}
        onClick={() => change.mutate({ state: 'resolved' })}
      >
        Resolve
      </Button>
      {dismissing && (
        <FalsePositiveDialog
          pending={change.isPending}
          onClose={() => setDismissing(false)}
          onConfirm={(note) =>
            change.mutate({ state: 'false_positive', note }, { onSuccess: () => setDismissing(false) })
          }
        />
      )}
    </div>
  );
};

const Body = ({ anomaly }) => {
  const ctx = useSession();
  const canUpdate = useCan('anomalies').update;
  const canCreateWo = useCan('workorders').create;
  const machine = assetOf(anomaly);
  const linked = useRecords(
    'workorders',
    { filter: { anomalyId: anomaly._id }, limit: 5 },
    { enabled: Boolean(ctx?.modules?.includes('workorders')) },
  );
  return (
    <div className="space-y-5">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <SeverityBadge severity={anomaly.severity} />
          <StateBadge state={anomaly.state} />
          <span className="font-mono text-xs text-subtle">{anomaly.anomalyCode}</span>
          {machine.id && (
            <Link
              to={`/machines/${machine.id}`}
              className="ml-auto inline-flex items-center gap-1 text-xs font-medium text-brand hover:underline"
            >
              Machine 360
              <ArrowUpRight className="size-3.5" aria-hidden />
            </Link>
          )}
        </div>
        <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Machine">
            {machine.id ? (
              <Link to={`/machines/${machine.id}`} className="text-brand hover:underline">
                {machine.name}
              </Link>
            ) : (
              machine.name
            )}
            {machine.tag && <span className="ml-1.5 font-mono text-xs text-subtle">{machine.tag}</span>}
          </Stat>
          <Stat label="Detected">{formatDateTime(anomaly.detectedAt)}</Stat>
          {anomaly.resolvedAt ? (
            <Stat label="Resolved">{formatDateTime(anomaly.resolvedAt)}</Stat>
          ) : (
            <Stat label="Last seen">{formatRelative(anomaly.lastSeenAt ?? anomaly.detectedAt)}</Stat>
          )}
          <Stat label="Type">{typeLabel(anomaly.type)}</Stat>
          {anomaly.acknowledgedBy && <Stat label="Acknowledged by">{refLabel(anomaly.acknowledgedBy)}</Stat>}
          {anomaly.workOrderId && (
            <Stat label="Work order" wrap className="col-span-2">
              <Link
                to={`/m/workorders/${anomaly.workOrderId._id ?? anomaly.workOrderId}`}
                className="min-w-0 truncate text-brand hover:underline"
              >
                {refLabel(anomaly.workOrderId)}
              </Link>
              <AutoWorkOrderBadge anomaly={anomaly} />
            </Stat>
          )}
        </dl>
        {anomaly.notes && <p className="mt-3 text-sm text-muted">Note: {anomaly.notes}</p>}
      </div>
      <Summary anomaly={anomaly} />
      <Evidence anomaly={anomaly} />
      <Investigation
        anomaly={anomaly}
        canUpdate={canUpdate}
        canCreateWo={canCreateWo}
        linked={linked.data?.items ?? []}
      />
    </div>
  );
};

/** Side sheet with everything about one anomaly: `id` null closes it. */
export const AnomalyDetail = ({ id, onClose }) => {
  const record = useRecord('anomalies', id);
  const canUpdate = useCan('anomalies').update;
  const anomaly = record.data;
  const title = anomaly ? `${anomaly.anomalyCode} · ${typeLabel(anomaly.type)}` : 'Anomaly';
  return (
    <Sheet
      open={Boolean(id)}
      onOpenChange={(o) => !o && onClose()}
      title={title}
      description={anomaly ? `${assetOf(anomaly).name} · ${assetOf(anomaly).type ?? 'machine'}` : undefined}
      width="max-w-2xl"
      footer={anomaly && canUpdate && isActive(anomaly) ? <StateActions anomaly={anomaly} /> : undefined}
    >
      {record.isLoading ? (
        <div className="space-y-4" aria-busy="true">
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-32" />
          <Skeleton className="h-40" />
        </div>
      ) : record.isError || !anomaly ? (
        <EmptyState icon={SearchX} title="Anomaly not found">
          {record.error?.message ?? 'It may have been removed.'}
        </EmptyState>
      ) : (
        <Body anomaly={anomaly} />
      )}
    </Sheet>
  );
};
