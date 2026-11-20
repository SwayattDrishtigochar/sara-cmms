import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  Box,
  ChevronLeft,
  ClipboardList,
  ExternalLink,
  HardHat,
  LocateFixed,
  Maximize2,
  MessageSquareWarning,
  Minimize2,
  OctagonX,
  Sparkles,
  Wrench,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { severityOf } from '../anomalies/parts.jsx';
import { assetIdOf, useOpenAnomalies } from '../anomalies/useAnomalies.js';
import { api } from '../api/client.js';
import { useSession } from '../auth/useAuth.js';
import { cn, refLabel } from '../lib/format.js';
import { seedLatest, useLiveEvent, useLiveStore } from '../live/liveStore.js';
import { cardFields, fieldLabel, formatValue } from '../machines/telemetry.js';
import { useRecords } from '../modules/useModules.js';
import { OptimizerCard } from '../optimizer/OptimizerCard.jsx';
import { useUi } from '../store/ui.js';
import { StatusPill } from '../ui/core.jsx';

/** The shop-floor scene (public/shopfloor, from "3D Models/Shopfloor"): machines are matched by asset tag. */
const SCENE_URL = '/shopfloor/viewer/index.html';
const SCENE_STATE = {
  Running: 'RUNNING',
  ON: 'RUNNING',
  Idle: 'IDLE',
  Stopped: 'STOPPED',
  Maintenance: 'MAINTENANCE',
  OFF: 'OFFLINE',
};
const STATUS_COLOR = {
  Running: '#22c55e',
  Idle: '#f59e0b',
  Stopped: '#ef4444',
  Maintenance: '#2f80ed',
  OFF: '#8a9096',
};
const COUNT_ORDER = ['Running', 'Idle', 'Stopped', 'Maintenance', 'OFF'];
const KIND = {
  stopped: { icon: OctagonX, label: 'Stopped' },
  anomaly: { icon: Sparkles, label: 'AI anomaly' },
  workOrder: { icon: Wrench, label: 'Work order' },
  request: { icon: MessageSquareWarning, label: 'Request' },
};
const SEVERITY_COLOR = { critical: '#ef4444', warning: '#f59e0b', info: '#2f80ed' };
const OPEN_WORK = ['Open', 'In Progress', 'On Hold', 'Re Open'];

const isMachine = (a) => a.isProductionAsset || a.isEnergyAsset || a.isSensorIntegration;
const refId = (v) => String(v?._id ?? v ?? '');
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const worstOf = (items) =>
  items.reduce((w, a) => (!w || severityOf(a.severity).rank > severityOf(w.severity).rank ? a : w), null);

/** What the scene needs for one machine: its state plus the live values its HMI screen and heaters show. */
const payloadOf = (m) => {
  const v = m.values;
  const critical = m.attention.some((a) => a.severity === 'critical' && a.kind !== 'stopped');
  const state = m.status === 'Stopped' && critical ? 'ALARM' : (SCENE_STATE[m.status] ?? 'OFFLINE');
  const temps = {};
  for (const [zone, field] of [
    ['Z1', 'barrelTempZone1'],
    ['Z2', 'barrelTempZone2'],
    ['Z3', 'barrelTempZone3'],
  ]) {
    if (num(v[field]) !== undefined) temps[zone] = v[field];
  }
  const out = { state };
  if (num(v.shotCount) !== undefined) out.shotCount = v.shotCount;
  if (num(v.spindleSpeed) !== undefined) out.rpm = Math.round(v.spindleSpeed);
  if (Object.keys(temps).length) out.temps = temps;
  // The moulding cycle (and the operator's open-gate / take-part / bin routine) runs at the real cycle time.
  const cycle = num(v.cycleTime) ?? num(m.job?.idealCycleTime);
  if (cycle) out.cycleTime = cycle;
  return out;
};

/** Every machine of the picked plant with live status, job, operators and what needs attention. */
const usePlantMachines = () => {
  const ctx = useSession();
  const plantId = useUi((s) => s.plantId);
  const filter = plantId && !ctx?.plantLocked ? { plantId } : undefined;
  const assets = useRecords('assets', { limit: 100, sort: 'name', filter });
  const latest = useQuery({
    queryKey: ['telemetry', 'latest'],
    queryFn: ({ signal }) => api('/telemetry/latest', { signal }),
  });
  useEffect(() => {
    if (latest.data?.assets) seedLatest(latest.data.assets);
  }, [latest.data]);
  const qc = useQueryClient();
  useLiveEvent('status', () =>
    qc.invalidateQueries({ queryKey: ['m', 'assets', 'list'] }, { cancelRefetch: false }),
  );
  const live = useLiveStore((s) => s.assets);
  const anomalies = useOpenAnomalies();
  const workOrders = useRecords('workorders', { filter: { workStatus: OPEN_WORK }, limit: 200 });
  const requests = useRecords('requests', { filter: { status: 'Open' }, limit: 200 });
  const jobs = useRecords('jobcards', { filter: { jobStatus: 'In Progress' }, limit: 200 });

  const machines = useMemo(() => {
    const byAsset = (rows, key = 'asset') => {
      const map = new Map();
      for (const r of rows ?? []) {
        const id = key === 'anomaly' ? assetIdOf(r) : refId(r.asset);
        map.set(id, [...(map.get(id) ?? []), r]);
      }
      return map;
    };
    const anomalyMap = byAsset(anomalies.data?.items, 'anomaly');
    const woMap = byAsset(workOrders.data?.items);
    const reqMap = byAsset(requests.data?.items);
    const jobMap = byAsset(jobs.data?.items);
    return (assets.data?.items ?? []).filter(isMachine).map((a) => {
      const id = String(a._id);
      const l = live[id];
      const status = l?.status ?? a.assetStatus ?? null;
      const wos = woMap.get(id) ?? [];
      const jc = jobMap.get(id)?.[0];
      const attention = [
        status === 'Stopped' && {
          kind: 'stopped',
          severity: 'critical',
          label: 'Machine stopped',
          to: `/machines/${id}`,
        },
        ...(anomalyMap.get(id) ?? []).map((x) => ({
          kind: 'anomaly',
          severity: x.severity ?? 'warning',
          label: x.summary ?? x.title ?? 'AI anomaly',
          to: `/m/anomalies/${x._id}`,
        })),
        ...wos.map((w) => ({
          kind: 'workOrder',
          severity: w.priority === 'High' || w.priority === 'Critical' ? 'warning' : 'info',
          label: `${w.workOrderId ?? 'WO'} · ${w.name ?? ''} (${w.workStatus})`,
          to: `/m/workorders/${w._id}`,
        })),
        ...(reqMap.get(id) ?? []).map((r) => ({
          kind: 'request',
          severity: 'info',
          label: `${r.requestId ?? 'Request'} · ${r.name ?? ''}`,
          to: `/m/requests/${r._id}`,
        })),
      ].filter(Boolean);
      return {
        id,
        tag: a.assetTag,
        name: a.name,
        type: a.typeOfAsset,
        area: a.location,
        asset: a,
        status,
        values: l?.values ?? {},
        maintenance: status === 'Maintenance' || wos.some((w) => w.workStatus === 'In Progress'),
        job: jc
          ? {
              id: String(jc._id),
              code: jc.jobCardId,
              name: jc.jobName,
              part: jc.partName ?? null,
              idealCycleTime: jc.idealCycleTime ?? null,
              operators: (jc.assignedTo ?? []).map(refLabel).filter(Boolean),
              partsOut: jc.operations?.[0]?.progress?.partsOut ?? null,
              target: jc.target ?? null,
            }
          : null,
        attention,
      };
    });
  }, [assets.data, live, anomalies.data, workOrders.data, requests.data, jobs.data]);

  return { machines, loading: assets.isLoading, error: assets.error };
};

/** The machine's running production job card: code, part and live progress toward the target. */
const JobPlate = ({ job }) => {
  const pct = job.target ? Math.min(100, Math.round(((job.partsOut ?? 0) / job.target) * 100)) : null;
  return (
    <div className="pointer-events-none w-40 rounded-lg border border-white/60 bg-white/90 px-2 py-1.5 text-[10px] text-slate-600 shadow-md backdrop-blur">
      <p className="flex items-center gap-1 font-semibold text-slate-900">
        <ClipboardList className="size-3 shrink-0 text-[#F58120]" />
        <span className="truncate">
          {job.code} · {job.part ?? job.name}
        </span>
      </p>
      {pct != null && (
        <>
          <div className="mt-1 h-1 overflow-hidden rounded-full bg-slate-200">
            <div className="h-full rounded-full bg-[#F58120]" style={{ width: `${pct}%` }} />
          </div>
          <p className="mt-0.5 flex justify-between">
            <span>
              {(job.partsOut ?? 0).toLocaleString()} / {job.target.toLocaleString()} pcs
            </span>
            <span className="font-semibold text-slate-900">{pct}%</span>
          </p>
        </>
      )}
    </div>
  );
};

/** Status chip + attention pin over one machine; the scene moves it every frame through `ref`. */
const MachineLabel = ({ machine, hovered, selected, onPick, labelRef }) => {
  const [over, setOver] = useState(false);
  const worst = worstOf(machine.attention);
  const color = STATUS_COLOR[machine.status] ?? STATUS_COLOR.OFF;
  const Kind = worst ? (KIND[worst.kind]?.icon ?? AlertTriangle) : null;
  const pinColor = worst ? SEVERITY_COLOR[worst.severity] : null;
  const open = (hovered || over) && !selected;
  return (
    <div
      ref={labelRef}
      className={cn('pointer-events-none absolute left-0 top-0 will-change-transform', open && 'z-10')}
    >
      <div className="relative flex -translate-x-1/2 -translate-y-full flex-col items-center gap-1">
        {worst && (
          <button
            type="button"
            onClick={() => onPick(machine)}
            onMouseEnter={() => setOver(true)}
            onMouseLeave={() => setOver(false)}
            className="sf-pin pointer-events-auto relative grid size-9 place-items-center rounded-full border-2 border-white text-white shadow-lg transition-transform hover:scale-125"
            style={{ background: pinColor, '--pin': pinColor }}
            title={worst.label}
          >
            <Kind className="size-4" aria-hidden />
            {machine.attention.length > 1 && (
              <span className="absolute -right-1.5 -top-1.5 grid size-4 place-items-center rounded-full bg-fg text-[10px] font-bold text-surface">
                {machine.attention.length}
              </span>
            )}
          </button>
        )}
        <button
          type="button"
          onClick={() => onPick(machine)}
          onMouseEnter={() => setOver(true)}
          onMouseLeave={() => setOver(false)}
          className={cn(
            'pointer-events-auto flex items-center gap-1.5 rounded-full border bg-white/90 px-2.5 py-1 text-[11px] font-semibold text-slate-800 shadow-md backdrop-blur transition',
            open || selected ? 'scale-110 border-slate-900/40' : 'border-white/60',
          )}
        >
          <span
            className="size-2 rounded-full"
            style={{ background: color, boxShadow: `0 0 8px ${color}` }}
          />
          {machine.tag ?? machine.name}
          <span className="font-medium text-slate-500">
            {machine.status === 'Maintenance' ? 'In Maintenance' : (machine.status ?? 'No data')}
          </span>
        </button>
        {machine.job && <JobPlate job={machine.job} />}
        {open && (
          <div className="pointer-events-none absolute left-full top-0 ml-3 w-64 rounded-xl border border-white/60 bg-white/95 p-3 text-left text-xs text-slate-700 shadow-xl backdrop-blur">
            <p className="text-sm font-semibold text-slate-900">{machine.name}</p>
            <p className="text-[11px] text-slate-500">{machine.type}</p>
            {machine.job && (
              <p className="mt-2">
                <span className="font-medium text-slate-900">{machine.job.code}</span> {machine.job.name}
                {machine.job.operators.length > 0 && (
                  <span className="block text-slate-500">Operator: {machine.job.operators.join(', ')}</span>
                )}
              </p>
            )}
            {machine.attention.length > 0 ? (
              <ul className="mt-2 space-y-1">
                {machine.attention.slice(0, 4).map((a) => {
                  const Icon = KIND[a.kind]?.icon ?? AlertTriangle;
                  return (
                    <li key={`${a.kind}:${a.label}`} className="flex items-start gap-1.5">
                      <Icon
                        className="mt-0.5 size-3.5 shrink-0"
                        style={{ color: SEVERITY_COLOR[a.severity] }}
                      />
                      <span className="line-clamp-2">{a.label}</span>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="mt-2 text-emerald-600">Nothing needs attention</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

/** Side panel of the clicked machine: live values, job, attention, AI production boost. */
const MachinePanel = ({ machine, onClose }) => (
  <aside className="pointer-events-auto absolute bottom-3 right-3 top-3 flex w-92 max-w-[calc(100%-1.5rem)] flex-col overflow-hidden rounded-2xl border border-border bg-surface/95 shadow-2xl backdrop-blur">
    <div className="flex items-start gap-3 border-b border-border p-4">
      <div className="min-w-0 flex-1">
        <p className="truncate text-base font-semibold text-fg">{machine.name}</p>
        <p className="truncate text-xs text-subtle">
          {[machine.tag, machine.type, machine.area].filter(Boolean).join(' · ')}
        </p>
        <StatusPill status={machine.status ?? 'OFF'} className="mt-2" />
      </div>
      <button
        type="button"
        onClick={onClose}
        className="rounded-lg p-1 text-subtle hover:bg-surface-2"
        aria-label="Close"
      >
        <X className="size-4" />
      </button>
    </div>
    <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 scrollbar-thin">
      <div className="grid grid-cols-2 gap-2">
        {cardFields(machine.asset).map(({ field, unit }) => (
          <div key={field} className="rounded-lg bg-surface-2 px-3 py-2">
            <p className="truncate text-[11px] text-subtle">{fieldLabel(field)}</p>
            <p className="text-sm font-semibold text-fg">
              {machine.values[field] == null ? '—' : `${formatValue(machine.values[field])} ${unit}`}
            </p>
          </div>
        ))}
      </div>
      {machine.job && (
        <div className="rounded-xl border border-border p-3">
          <p className="flex items-center gap-1.5 text-xs font-semibold text-fg">
            <ClipboardList className="size-3.5 text-brand" /> {machine.job.code} · {machine.job.name}
          </p>
          {machine.job.operators.length > 0 && (
            <p className="mt-1 text-xs text-muted">Operator: {machine.job.operators.join(', ')}</p>
          )}
          {machine.job.target ? (
            <>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-2">
                <div
                  className="h-full rounded-full bg-brand"
                  style={{
                    width: `${Math.min(100, ((machine.job.partsOut ?? 0) / machine.job.target) * 100)}%`,
                  }}
                />
              </div>
              <p className="mt-1 text-[11px] text-subtle">
                {machine.job.partsOut ?? 0} / {machine.job.target} parts
              </p>
            </>
          ) : null}
        </div>
      )}
      {machine.attention.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-xs font-semibold text-fg">Needs attention</p>
          {machine.attention.map((a) => {
            const Icon = KIND[a.kind]?.icon ?? AlertTriangle;
            return (
              <Link
                key={`${a.kind}:${a.label}`}
                to={a.to}
                className="flex items-start gap-2 rounded-lg border border-border px-2.5 py-2 text-xs text-fg hover:bg-surface-2"
              >
                <Icon className="mt-0.5 size-3.5 shrink-0" style={{ color: SEVERITY_COLOR[a.severity] }} />
                <span className="line-clamp-2">{a.label}</span>
              </Link>
            );
          })}
        </div>
      )}
      <OptimizerCard assetId={machine.id} assetType={machine.type} compact />
      <Link
        to={`/machines/${machine.id}`}
        className="flex items-center justify-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm font-medium text-fg hover:bg-surface-2"
      >
        Open machine page <ExternalLink className="size-3.5" />
      </Link>
    </div>
  </aside>
);

export default function Plant3DPage() {
  const navigate = useNavigate();
  const connection = useLiveStore((s) => s.connection);
  const { machines, loading, error } = usePlantMachines();
  const frameRef = useRef(null);
  const sceneRef = useRef(null);
  const labelRefs = useRef(new Map());
  const operatorRefs = useRef(new Map());
  const [sceneIds, setSceneIds] = useState(null);
  const [hoveredId, setHoveredId] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Full screen: the whole 3D view (scene, labels, panels) fills the screen; Esc or the button leaves it.
  const rootRef = useRef(null);
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    const onChange = () =>
      setFullscreen(Boolean(rootRef.current) && document.fullscreenElement === rootRef.current);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);
  const toggleFullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    else rootRef.current?.requestFullscreen?.().catch(() => {});
  };

  // Wait for the scene's API, then follow its hover/select events and pin the labels to the machines.
  const onFrameLoad = () => {
    const win = frameRef.current?.contentWindow;
    if (!win) return;
    const attach = (sf) => {
      sceneRef.current = sf;
      setSceneIds(sf.machines);
      win.addEventListener('shopfloor:hover', (e) => setHoveredId(e.detail?.id ?? null));
      win.addEventListener('shopfloor:select', (e) => {
        const id = e.detail?.id ?? null;
        setSelectedId(id);
        if (id) sf.focus(id);
      });
      sf.onFrame(() => {
        for (const [tag, el] of labelRefs.current) {
          const a = sf.getAnchor(tag);
          if (!a || !el) continue;
          el.style.display = a.visible ? '' : 'none';
          el.style.transform = `translate(${a.x}px, ${a.y}px)`;
        }
        for (const [tag, el] of operatorRefs.current) {
          const a = sf.getOperatorAnchor?.(tag);
          if (!el) continue;
          el.style.display = a?.visible ? '' : 'none';
          if (a) el.style.transform = `translate(${a.x}px, ${a.y}px)`;
        }
      });
    };
    if (win.shopfloor) win.shopfloor.ready.then(() => attach(win.shopfloor));
    else win.addEventListener('shopfloor:ready', () => attach(win.shopfloor), { once: true });
  };

  const byTag = useMemo(() => new Map(machines.map((m) => [m.tag, m])), [machines]);
  const inScene = useMemo(
    () => (sceneIds ?? []).map((tag) => byTag.get(tag)).filter(Boolean),
    [sceneIds, byTag],
  );

  // Live data → scene: state, cycle time, shot count, spindle speed and barrel temperatures, plus the
  // operator of the running job card (animated at the machine). Scene slots with no SARA machine stay OFFLINE.
  useEffect(() => {
    const sf = sceneRef.current;
    if (!sf || !sceneIds) return;
    for (const tag of sceneIds) {
      const m = byTag.get(tag);
      sf.apply(tag, m ? payloadOf(m) : { state: 'OFFLINE' });
      const operator = m?.job?.operators?.[0];
      sf.setOperator?.(tag, operator ? { name: operator } : null);
    }
  }, [sceneIds, byTag]);

  const pick = (m) => {
    if (!sceneIds?.includes(m.tag)) return navigate(`/machines/${m.id}`);
    setSelectedId(m.tag);
    sceneRef.current?.focus(m.tag);
    sceneRef.current?.highlight(m.tag);
  };

  const counts = COUNT_ORDER.map((s) => [s, inScene.filter((m) => (m.status ?? 'OFF') === s).length]);
  const attention = machines
    .filter((m) => m.attention.length)
    .sort(
      (a, b) =>
        severityOf(worstOf(b.attention).severity).rank - severityOf(worstOf(a.attention).severity).rank,
    );
  const selected = selectedId ? byTag.get(selectedId) : null;

  return (
    <div ref={rootRef} className="absolute inset-0 overflow-hidden bg-[#e9ecef]">
      <style>{`.sf-pin{animation:sf-bob 2.4s ease-in-out infinite}.sf-pin::after{content:'';position:absolute;inset:-6px;border-radius:9999px;border:2px solid var(--pin);animation:sf-ping 1.6s ease-out infinite}@keyframes sf-bob{50%{transform:translateY(-5px)}}@keyframes sf-ping{from{opacity:.9;transform:scale(.8)}to{opacity:0;transform:scale(1.7)}}`}</style>
      <iframe
        ref={frameRef}
        src={SCENE_URL}
        title="3D shop floor"
        onLoad={onFrameLoad}
        className="absolute inset-0 size-full border-0"
      />

      <div className="pointer-events-none absolute inset-0">
        {inScene.map((m) => (
          <MachineLabel
            key={m.tag}
            machine={m}
            hovered={hoveredId === m.tag}
            selected={selectedId === m.tag}
            onPick={pick}
            labelRef={(el) => (el ? labelRefs.current.set(m.tag, el) : labelRefs.current.delete(m.tag))}
          />
        ))}
        {inScene
          .filter((m) => m.job?.operators?.length)
          .map((m) => (
            <div
              key={`operator:${m.tag}`}
              ref={(el) => (el ? operatorRefs.current.set(m.tag, el) : operatorRefs.current.delete(m.tag))}
              className="pointer-events-none absolute left-0 top-0 will-change-transform"
              style={{ display: 'none' }}
            >
              <span className="flex -translate-x-1/2 -translate-y-full items-center gap-1 whitespace-nowrap rounded-full bg-[#F58120] px-2 py-0.5 text-[10px] font-semibold text-white shadow-md">
                <HardHat className="size-3" /> {m.job.operators[0]}
              </span>
            </div>
          ))}

        <div className="pointer-events-auto absolute left-3 top-3 rounded-2xl border border-white/60 bg-white/85 px-4 py-3 shadow-lg backdrop-blur">
          <p className="flex items-center gap-2 text-sm font-semibold text-slate-900">
            <Box className="size-4 text-brand" /> 3D shop floor
            <span
              className={cn(
                'ml-1 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold',
                connection === 'live' ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-200 text-slate-600',
              )}
            >
              <span
                className={cn(
                  'size-1.5 rounded-full',
                  connection === 'live' ? 'animate-pulse bg-emerald-500' : 'bg-slate-400',
                )}
              />
              {connection === 'live' ? 'Live' : connection}
            </span>
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {counts.map(([s, n]) => (
              <span
                key={s}
                className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-700"
              >
                <span className="size-2 rounded-full" style={{ background: STATUS_COLOR[s] }} />
                {n} {s === 'OFF' ? 'off' : s.toLowerCase()}
              </span>
            ))}
          </div>
          <button
            type="button"
            onClick={() => {
              sceneRef.current?.resetView();
              sceneRef.current?.highlight(null);
              setSelectedId(null);
            }}
            className="mt-2 inline-flex items-center gap-1 text-[11px] font-medium text-brand hover:underline"
          >
            <LocateFixed className="size-3" /> Reset view
          </button>
          <p className="mt-1 text-[10px] text-slate-500">
            Two-finger scroll to move · Pinch or wheel to zoom · Drag to rotate
          </p>
        </div>

        {!selected && attention.length > 0 && (
          <button
            type="button"
            onClick={() => setDrawerOpen(true)}
            aria-expanded={drawerOpen}
            className={cn(
              'absolute right-3 top-3 flex items-center gap-2 rounded-full border border-white/60 bg-white/90 py-1.5 pl-1.5 pr-3 text-xs font-semibold text-slate-900 shadow-lg backdrop-blur transition hover:bg-white',
              drawerOpen ? 'pointer-events-none opacity-0' : 'pointer-events-auto opacity-100',
            )}
          >
            <span className="relative grid size-6 place-items-center rounded-full bg-red-500 text-[11px] font-bold text-white">
              <span className="absolute inset-0 animate-ping rounded-full bg-red-500/40" />
              {attention.length}
            </span>
            Needs attention
            <ChevronLeft className="size-3.5 text-slate-500" />
          </button>
        )}

        {!selected && attention.length > 0 && (
          <aside
            aria-label="Needs attention"
            className={cn(
              'absolute right-3 top-3 flex max-h-[calc(100%-1.5rem)] w-72 flex-col rounded-2xl border border-white/60 bg-white/90 shadow-2xl backdrop-blur transition duration-300 ease-out',
              drawerOpen
                ? 'pointer-events-auto translate-x-0 opacity-100'
                : 'pointer-events-none translate-x-[calc(100%+1rem)] opacity-0',
            )}
          >
            <div className="flex items-center gap-1.5 border-b border-slate-200/70 py-2 pl-3 pr-2">
              <AlertTriangle className="size-3.5 text-red-500" />
              <p className="flex-1 text-xs font-semibold text-slate-900">
                Needs attention ({attention.length})
              </p>
              <button
                type="button"
                onClick={() => setDrawerOpen(false)}
                className="rounded-lg p-1 text-slate-500 hover:bg-slate-100 hover:text-slate-900"
                aria-label="Close needs attention"
              >
                <X className="size-4" />
              </button>
            </div>
            <ul className="min-h-0 flex-1 space-y-1 overflow-y-auto p-2 scrollbar-thin">
              {attention.map((m) => {
                const w = worstOf(m.attention);
                const Icon = KIND[w.kind]?.icon ?? AlertTriangle;
                return (
                  <li key={m.id}>
                    <button
                      type="button"
                      onClick={() => {
                        setDrawerOpen(false);
                        pick(m);
                      }}
                      onMouseEnter={() => sceneIds?.includes(m.tag) && sceneRef.current?.highlight(m.tag)}
                      onMouseLeave={() => sceneRef.current?.highlight(selectedId)}
                      className="flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left text-xs text-slate-700 hover:bg-white"
                    >
                      <Icon
                        className="mt-0.5 size-3.5 shrink-0"
                        style={{ color: SEVERITY_COLOR[w.severity] }}
                      />
                      <span className="min-w-0">
                        <span className="block font-semibold text-slate-900">
                          {m.tag ?? m.name}
                          {!sceneIds?.includes(m.tag) && (
                            <span className="ml-1 font-normal text-slate-400">(not in 3D)</span>
                          )}
                        </span>
                        <span className="line-clamp-1">{w.label}</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </aside>
        )}

        {selected && <MachinePanel machine={selected} onClose={() => setSelectedId(null)} />}

        {(!sceneIds || loading) && !error && (
          <div className="absolute inset-0 grid place-items-center">
            <p className="rounded-full bg-white/90 px-4 py-2 text-sm font-medium text-slate-700 shadow">
              Loading 3D shop floor…
            </p>
          </div>
        )}
        {document.fullscreenEnabled && (
          <button
            type="button"
            onClick={toggleFullscreen}
            className="pointer-events-auto absolute bottom-3 left-3 inline-flex items-center gap-1.5 rounded-full border border-white/60 bg-white/90 px-3 py-1.5 text-xs font-semibold text-slate-900 shadow-lg backdrop-blur transition hover:bg-white"
            title={fullscreen ? 'Exit full screen (Esc)' : 'Full screen'}
          >
            {fullscreen ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
            {fullscreen ? 'Exit full screen' : 'Full screen'}
          </button>
        )}

        {error && (
          <p className="absolute bottom-14 left-3 rounded-lg bg-white/90 px-3 py-2 text-sm text-red-600 shadow">
            Couldn't load your machines: {error.message}
          </p>
        )}
      </div>
    </div>
  );
}
