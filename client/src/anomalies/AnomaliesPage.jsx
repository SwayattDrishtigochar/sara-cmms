import { useQueryClient } from '@tanstack/react-query';
import { Activity, ScanSearch, Search, SearchX, ShieldCheck, Sparkles, TriangleAlert } from 'lucide-react';
import { useMemo } from 'react';
import { useSearchParams } from 'react-router';
import { useSession } from '../auth/useAuth.js';
import { cn, formatRelative } from '../lib/format.js';
import { useLiveEvent } from '../live/liveStore.js';
import { useRecords } from '../modules/useModules.js';
import { useUi } from '../store/ui.js';
import { Button, Card, EmptyState, PageHeader, Skeleton } from '../ui/core.jsx';
import { Input, Select } from '../ui/form.jsx';
import { AnomalyDetail } from './AnomalyDetail.jsx';
import { assetOf, ParamChip, StateBadge, severityOf, typeLabel } from './parts.jsx';
import { invalidateAnomalies, useScan } from './useAnomalies.js';

const STATES = [
  { value: 'active', label: 'Open & acknowledged', filter: ['open', 'acknowledged'] },
  { value: 'open', label: 'Open', filter: 'open' },
  { value: 'acknowledged', label: 'Acknowledged', filter: 'acknowledged' },
  { value: 'resolved', label: 'Resolved', filter: 'resolved' },
  { value: 'false_positive', label: 'False positives', filter: 'false_positive' },
  { value: 'all', label: 'All states', filter: undefined },
];
const SEVERITIES = ['critical', 'warning', 'info'];
const LIMIT = 100;

/** Rows matching the in-page filters (severity chip, machine, search). */
export const filterAnomalies = (items, { severity = '', asset = '', q = '' }) => {
  const needle = q.trim().toLowerCase();
  return items.filter((a) => {
    if (severity && a.severity !== severity) return false;
    const machine = assetOf(a);
    if (asset && machine.id !== asset) return false;
    if (!needle) return true;
    return [
      a.anomalyCode,
      a.summary,
      a.explanation,
      typeLabel(a.type),
      machine.name,
      machine.tag,
      ...(a.parameters ?? []).map((p) => p.field),
    ].some((v) => v?.toLowerCase().includes(needle));
  });
};

const SeverityChip = ({ severity, count, active, onClick }) => {
  const s = severityOf(severity);
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'inline-flex h-9 items-center gap-2 rounded-lg border px-3 text-sm shadow-card transition-colors',
        active
          ? 'border-brand bg-brand-soft text-fg'
          : 'border-border bg-surface text-muted hover:bg-surface-2',
      )}
    >
      <s.icon className={cn('size-4', s.text)} aria-hidden />
      <span className={cn(active && 'font-medium')}>{s.label}</span>{' '}
      <span className="font-semibold text-fg tabular">{count}</span>
    </button>
  );
};

const Row = ({ anomaly, onOpen }) => {
  const s = severityOf(anomaly.severity);
  const machine = assetOf(anomaly);
  return (
    <li>
      <button
        type="button"
        onClick={() => onOpen(anomaly._id)}
        className="flex w-full gap-3 px-4 py-3 text-left transition-colors hover:bg-surface-2/70 focus-visible:bg-surface-2 focus-visible:outline-none"
      >
        <span
          className={cn('mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg border', s.soft)}
          title={s.label}
        >
          <s.icon className={cn('size-4', s.text)} aria-hidden />
          <span className="sr-only">{s.label}</span>
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-sm font-semibold text-fg">{machine.name}</span>
            {machine.tag && <span className="font-mono text-xs text-subtle">{machine.tag}</span>}
            <span className="text-sm text-muted">{typeLabel(anomaly.type)}</span>
            <span className="ml-auto flex items-center gap-2">
              <StateBadge state={anomaly.state} />
              <span className="whitespace-nowrap text-xs text-subtle">
                {formatRelative(anomaly.detectedAt)}
              </span>
            </span>
          </span>
          {anomaly.summary && (
            <span className="mt-1 line-clamp-2 block text-sm text-muted">{anomaly.summary}</span>
          )}
          {(anomaly.parameters?.length > 0 || anomaly.confidence != null) && (
            <span className="mt-2 flex flex-wrap items-center gap-1.5">
              {anomaly.parameters?.map((p) => (
                <ParamChip key={p.field} param={p} severity={anomaly.severity} />
              ))}
              {anomaly.confidence != null && (
                <span
                  className="inline-flex items-center gap-1 text-xs text-subtle"
                  title={anomaly.model ? `Decided by ${anomaly.model}` : undefined}
                >
                  <Sparkles className="size-3 text-ai" aria-hidden />
                  {Math.round(anomaly.confidence * 100)}% confident
                </span>
              )}
            </span>
          )}
        </span>
      </button>
    </li>
  );
};

const RowsSkeleton = () => (
  <ul aria-label="Loading anomalies" className="divide-y divide-border">
    {Array.from({ length: 4 }, (_, i) => (
      <li key={i} className="flex gap-3 px-4 py-3">
        <Skeleton className="size-8 rounded-lg" />
        <div className="flex-1 space-y-2">
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="h-3 w-3/4" />
        </div>
      </li>
    ))}
  </ul>
);

/** /anomalies — what SARA found in live machine data, filtered by state, severity, machine and text. */
export const AnomaliesPage = () => {
  const ctx = useSession();
  const qc = useQueryClient();
  const plantId = useUi((s) => s.plantId);
  const [params, setParams] = useSearchParams();
  const state = STATES.find((s) => s.value === params.get('state')) ?? STATES[0];
  const severity = params.get('severity') ?? '';
  const asset = params.get('asset') ?? '';
  const q = params.get('q') ?? '';
  const openId = params.get('open');
  const update = (patch) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    setParams(next, { replace: true });
  };

  const enabled = Boolean(ctx?.modules?.includes('anomalies'));
  const filter = {
    ...(state.filter ? { state: state.filter } : {}),
    ...(plantId && !ctx?.plantLocked ? { plantId } : {}),
  };
  const list = useRecords('anomalies', { filter, sort: '-detectedAt', limit: LIMIT }, { enabled });
  useLiveEvent('anomaly', () => invalidateAnomalies(qc));
  const scan = useScan();

  const items = list.data?.items ?? [];
  const counts = useMemo(() => {
    const c = { critical: 0, warning: 0, info: 0 };
    for (const a of filterAnomalies(items, { asset, q })) c[a.severity] = (c[a.severity] ?? 0) + 1;
    return c;
  }, [items, asset, q]);
  const visible = useMemo(() => filterAnomalies(items, { severity, asset, q }), [items, severity, asset, q]);
  const machines = useMemo(() => {
    const byId = new Map();
    for (const a of items) {
      const m = assetOf(a);
      if (m.id && !byId.has(m.id)) byId.set(m.id, m);
    }
    return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [items]);
  const canScan = ['owner', 'admin'].includes(ctx?.role);
  const filtered = Boolean(severity || asset || q);

  let body;
  if (!enabled) {
    body = (
      <EmptyState icon={Activity} title="Anomaly detection is off">
        The anomalies module isn't switched on for your company.
      </EmptyState>
    );
  } else if (list.isLoading) {
    body = <RowsSkeleton />;
  } else if (list.isError) {
    body = (
      <EmptyState
        icon={TriangleAlert}
        title="Couldn't load anomalies"
        action={
          <Button onClick={() => list.refetch()} loading={list.isFetching}>
            Try again
          </Button>
        }
      >
        {list.error.message}
      </EmptyState>
    );
  } else if (!items.length) {
    body = (
      <EmptyState
        icon={ShieldCheck}
        title={state.value === 'active' ? 'All quiet' : `No ${state.label.toLowerCase()} anomalies`}
        action={
          canScan &&
          state.value === 'active' && (
            <Button icon={ScanSearch} loading={scan.isPending} onClick={() => scan.mutate()}>
              Scan now
            </Button>
          )
        }
      >
        {state.value === 'active'
          ? 'SARA reviews every machine regularly and nothing needs attention right now.'
          : 'Try another state to see older findings.'}
      </EmptyState>
    );
  } else if (!visible.length) {
    body = (
      <EmptyState
        icon={SearchX}
        title="No anomalies match"
        action={<Button onClick={() => update({ severity: '', asset: '', q: '' })}>Clear filters</Button>}
      >
        Try a different search, or clear the filters.
      </EmptyState>
    );
  } else {
    body = (
      <>
        <ul className="divide-y divide-border" aria-label="Anomalies">
          {visible.map((a) => (
            <Row key={a._id} anomaly={a} onOpen={(id) => update({ open: id })} />
          ))}
        </ul>
        {list.data.total > items.length && (
          <p className="border-t border-border px-4 py-2 text-xs text-subtle">
            Showing the newest {items.length} of {list.data.total}. Narrow the state to see older ones.
          </p>
        )}
      </>
    );
  }

  return (
    <div className="mx-auto max-w-[1400px] px-4 py-6 sm:px-6">
      <PageHeader
        icon={Activity}
        title="Anomalies"
        description="What SARA found in live machine data: which parameter is off, why, and what to do about it."
        actions={
          canScan && (
            <Button icon={ScanSearch} loading={scan.isPending} onClick={() => scan.mutate()}>
              Scan now
            </Button>
          )
        }
      />

      <fieldset className="mb-4 flex flex-wrap gap-2">
        <legend className="sr-only">Filter by severity</legend>
        {SEVERITIES.map((s) => (
          <SeverityChip
            key={s}
            severity={s}
            count={counts[s]}
            active={severity === s}
            onClick={() => update({ severity: severity === s ? '' : s })}
          />
        ))}
      </fieldset>

      <div className="mb-5 flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1 basis-56 sm:max-w-sm">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-subtle"
            aria-hidden
          />
          <Input
            type="search"
            aria-label="Search anomalies"
            placeholder="Search by machine, parameter or summary…"
            className="pl-9"
            value={q}
            onChange={(e) => update({ q: e.target.value })}
          />
        </div>
        <Select
          aria-label="State"
          value={state.value}
          onChange={(e) => update({ state: e.target.value === 'active' ? '' : e.target.value })}
          className="w-auto min-w-40 flex-1 sm:flex-none"
        >
          {STATES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </Select>
        <Select
          aria-label="Machine"
          value={asset}
          onChange={(e) => update({ asset: e.target.value })}
          className="w-auto min-w-40 flex-1 sm:flex-none"
        >
          <option value="">All machines</option>
          {machines.map((m) => (
            <option key={m.id} value={m.id}>
              {m.tag ? `${m.name} (${m.tag})` : m.name}
            </option>
          ))}
        </Select>
        {items.length > 0 && (
          <span className="ml-auto text-xs text-subtle tabular" aria-live="polite">
            {filtered ? `${visible.length} of ${items.length} anomalies` : `${items.length} anomalies`}
          </span>
        )}
      </div>

      <Card>{body}</Card>

      <AnomalyDetail id={openId} onClose={() => update({ open: '' })} />
    </div>
  );
};
