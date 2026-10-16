import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Factory, Search, SearchX, TriangleAlert } from 'lucide-react';
import { useEffect, useMemo } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useShallow } from 'zustand/react/shallow';
import { api } from '../api/client.js';
import { useSession } from '../auth/useAuth.js';
import { cn } from '../lib/format.js';
import { seedLatest, useLiveEvent, useLiveStore, useStatusCounts } from '../live/liveStore.js';
import { useRecords } from '../modules/useModules.js';
import { useUi } from '../store/ui.js';
import { statusStyle } from '../ui/charts.jsx';
import { Button, Card, EmptyState, PageHeader } from '../ui/core.jsx';
import { Input, Select } from '../ui/form.jsx';
import { LINK_BUTTON, LiveBadge } from './bits.jsx';
import { MachineCard, MachineCardSkeleton } from './MachineCard.jsx';

const STATUSES = ['Running', 'Idle', 'Stopped', 'OFF', 'Maintenance'];
const GRID = 'grid gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4';

const isMachine = (a) => a.isProductionAsset || a.isEnergyAsset || a.isSensorIntegration;
const normalStatus = (s) => (s === 'ON' ? 'Running' : s);

const StatusChip = ({ label, icon: Icon, count, active, onClick }) => (
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
    {Icon && <Icon className="size-4" aria-hidden />}
    <span className={cn(active && 'font-medium')}>{label}</span>
    <span className="font-semibold text-fg tabular">{count}</span>
  </button>
);

const MachineGrid = ({ items }) => (
  <ul className={GRID}>
    {items.map((asset) => (
      <li key={asset._id}>
        <MachineCard asset={asset} />
      </li>
    ))}
  </ul>
);

/** /machines — the live floor: status summary, filters and a card per connected machine. */
export const MachinesPage = () => {
  const ctx = useSession();
  const plantId = useUi((s) => s.plantId);
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const type = params.get('type') ?? '';
  const status = params.get('status') ?? '';
  const update = (patch) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    setParams(next, { replace: true });
  };

  const plantFilter = plantId && !ctx?.plantLocked ? { plantId } : undefined;
  const assets = useRecords('assets', { limit: 100, sort: 'name', filter: plantFilter });
  const latest = useQuery({
    queryKey: ['telemetry', 'latest'],
    queryFn: ({ signal }) => api('/telemetry/latest', { signal }),
  });
  useEffect(() => {
    if (latest.data?.assets) seedLatest(latest.data.assets);
  }, [latest.data]);
  // A status change usually means a job started or ended: refresh the list so each card names its current job.
  // cancelRefetch: false folds a burst (shift start moves every machine at once) into one request.
  const qc = useQueryClient();
  useLiveEvent('status', () =>
    qc.invalidateQueries({ queryKey: ['m', 'assets', 'list'] }, { cancelRefetch: false }),
  );

  const machines = useMemo(() => (assets.data?.items ?? []).filter(isMachine), [assets.data]);
  const counts = useStatusCounts(machines);
  const liveStatus = useLiveStore(
    useShallow((s) => Object.fromEntries(machines.map((m) => [m._id, s.assets[m._id]?.status]))),
  );
  const types = useMemo(() => [...new Set(machines.map((m) => m.typeOfAsset))].sort(), [machines]);

  const needle = q.trim().toLowerCase();
  const visible = machines.filter((m) => {
    if (status && normalStatus(liveStatus[m._id] ?? m.assetStatus) !== status) return false;
    if (type && m.typeOfAsset !== type) return false;
    if (!needle) return true;
    return [m.name, m.assetTag, m.typeOfAsset, m.location, m.plantId?.name].some((v) =>
      v?.toLowerCase().includes(needle),
    );
  });
  const plants = new Map();
  for (const m of visible) {
    const key = m.plantId?._id ?? '';
    if (!plants.has(key)) plants.set(key, { name: m.plantId?.name ?? 'No plant', items: [] });
    plants.get(key).items.push(m);
  }
  const grouped = plants.size > 1;
  const filtered = Boolean(q || type || status);

  let body;
  if (assets.isLoading) {
    body = (
      <ul className={GRID} aria-label="Loading machines">
        {Array.from({ length: 8 }, (_, i) => (
          <li key={i}>
            <MachineCardSkeleton />
          </li>
        ))}
      </ul>
    );
  } else if (assets.isError) {
    body = (
      <Card>
        <EmptyState
          icon={TriangleAlert}
          title="Couldn't load your machines"
          action={
            <Button onClick={() => assets.refetch()} loading={assets.isFetching}>
              Try again
            </Button>
          }
        >
          {assets.error.message}
        </EmptyState>
      </Card>
    );
  } else if (!machines.length) {
    body = (
      <Card>
        <EmptyState
          icon={Factory}
          title="No connected machines yet"
          action={
            <Link to="/m/assets" className={LINK_BUTTON}>
              Open assets
            </Link>
          }
        >
          Machines show up here once an asset is marked as a production, energy-metered or sensor-connected
          machine.
        </EmptyState>
      </Card>
    );
  } else if (!visible.length) {
    body = (
      <Card>
        <EmptyState
          icon={SearchX}
          title="No machines match"
          action={<Button onClick={() => update({ q: '', type: '', status: '' })}>Clear filters</Button>}
        >
          Try a different search, or clear the filters to see every machine.
        </EmptyState>
      </Card>
    );
  } else if (grouped) {
    body = (
      <div className="space-y-8">
        {[...plants].map(([key, plant]) => (
          <section key={key} aria-labelledby={`plant-${key}`}>
            <h2 id={`plant-${key}`} className="mb-3 flex items-baseline gap-2 text-sm font-semibold text-fg">
              {plant.name}
              <span className="text-xs font-normal text-subtle tabular">
                {plant.items.length} {plant.items.length === 1 ? 'machine' : 'machines'}
              </span>
            </h2>
            <MachineGrid items={plant.items} />
          </section>
        ))}
      </div>
    );
  } else {
    body = <MachineGrid items={visible} />;
  }

  return (
    <div className="mx-auto max-w-[1600px] px-4 py-6 sm:px-6">
      <PageHeader
        icon={Factory}
        title="Machines"
        description="Live status and key readings from every connected machine."
        actions={<LiveBadge />}
      />

      <fieldset className="mb-4 flex flex-wrap gap-2">
        <legend className="sr-only">Filter by status</legend>
        <StatusChip
          label="All"
          count={machines.length}
          active={!status}
          onClick={() => update({ status: '' })}
        />
        {STATUSES.map((s) => (
          <StatusChip
            key={s}
            label={s}
            icon={statusStyle(s).icon}
            count={counts[s]}
            active={status === s}
            onClick={() => update({ status: status === s ? '' : s })}
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
            aria-label="Search machines"
            placeholder="Search by name, tag or location…"
            className="pl-9"
            value={q}
            onChange={(e) => update({ q: e.target.value })}
          />
        </div>
        <Select
          aria-label="Machine type"
          value={type}
          onChange={(e) => update({ type: e.target.value })}
          className="w-auto min-w-40 flex-1 sm:flex-none"
        >
          <option value="">All types</option>
          {types.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </Select>
        {machines.length > 0 && (
          <span className="ml-auto text-xs text-subtle tabular" aria-live="polite">
            {filtered ? `${visible.length} of ${machines.length} machines` : `${machines.length} machines`}
          </span>
        )}
      </div>

      {body}
    </div>
  );
};
