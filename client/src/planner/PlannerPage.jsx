import { useQueryClient } from '@tanstack/react-query';
import { Building2, CalendarRange, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useSession } from '../auth/useAuth.js';
import { cn, formatDate, formatNumber, getFormatPrefs } from '../lib/format.js';
import { useLiveEvent } from '../live/liveStore.js';
import { useUi } from '../store/ui.js';
import { Button, Card, CardHeader, PageHeader, Skeleton } from '../ui/core.jsx';
import { AiPlanPanel, ProposalView } from './AiPlanPanel.jsx';
import { Gantt } from './Gantt.jsx';
import { DAY, ghostEnd, mergePlan, startOfDay } from './ganttLayout.js';
import { PlansList } from './PlansList.jsx';
import { useCalendar, useProposal } from './usePlanning.js';

const ZOOMS = [1, 3, 7, 14];
const GHOST_STATES = ['draft', 'applying', 'failed', 'stale'];
const PLANNING_MODULES = ['jobcards', 'workorders', 'planproposals'];

const Zoom = ({ days, onChange }) => (
  <fieldset className="inline-flex rounded-lg border border-border bg-surface p-0.5 shadow-card">
    <legend className="sr-only">Days shown</legend>
    {ZOOMS.map((d) => (
      <button
        key={d}
        type="button"
        aria-pressed={days === d}
        onClick={() => onChange(d)}
        className={cn(
          'h-8 min-w-11 rounded-md px-2.5 text-xs font-medium tabular transition-colors',
          days === d ? 'bg-brand text-brand-fg' : 'text-muted hover:bg-surface-2 hover:text-fg',
        )}
      >
        {d} d
      </button>
    ))}
  </fieldset>
);

/**
 * /planner: the machine Gantt with SARA's proposals as ghost bars, the AI panel, the selected proposal
 * and the plans list. `?proposal=<id>` selects a plan; `?maintenance=<assetId>&anomaly=<id>` plans the
 * machine's maintenance once on arrival.
 */
export const PlannerPage = () => {
  const ctx = useSession();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const pickedPlant = useUi((s) => s.plantId);
  const plantId = ctx?.plantLocked ? undefined : (pickedPlant ?? undefined);
  const plantName = ctx?.plants?.find((p) => p._id === (ctx.plantLocked ? ctx.plantId : pickedPlant))?.name;
  const tz = ctx?.company?.timeZone ?? getFormatPrefs().timeZone;
  const [days, setDays] = useState(3);

  const start = useMemo(() => startOfDay(Date.now(), tz), [tz]);
  const calendarParams = {
    start: new Date(start).toISOString(),
    end: new Date(start + days * DAY).toISOString(),
    ...(plantId ? { plantId } : {}),
  };
  const calendar = useCalendar(calendarParams);

  const selectedId = params.get('proposal');
  const selected = useProposal(selectedId);
  const plan = GHOST_STATES.includes(selected.data?.proposal?.status) ? selected.data.plan : null;
  const gantt = useMemo(() => mergePlan(calendar.data?.gantt, plan), [calendar.data, plan]);

  const deepAsset = params.get('maintenance');
  const deepAnomaly = params.get('anomaly');
  const deepLink = useMemo(
    () => (deepAsset ? { assetId: deepAsset, anomalyId: deepAnomaly ?? undefined } : null),
    [deepAsset, deepAnomaly],
  );

  useLiveEvent('record', (d) => {
    if (PLANNING_MODULES.includes(d?.module)) qc.invalidateQueries({ queryKey: ['planning'] });
  });

  // Widen the view once per proposal so all of its ghost bars are visible.
  const fitted = useRef(null);
  useEffect(() => {
    const end = ghostEnd(plan);
    if (!end || fitted.current === selectedId) return;
    fitted.current = selectedId;
    const need = Math.ceil((end - start) / DAY);
    if (need > days) setDays(ZOOMS.find((z) => z >= need) ?? ZOOMS[ZOOMS.length - 1]);
  }, [plan, selectedId, start, days]);

  const select = useCallback((id) => setParams(id ? { proposal: id } : {}, { replace: true }), [setParams]);
  const onProposed = useCallback(
    (r) => {
      const id = r?.proposal?._id ?? r?.proposal?.id;
      if (!id) return;
      qc.setQueryData(['m', 'planproposals', String(id)], r);
      select(String(id));
    },
    [qc, select],
  );

  const machines = calendar.data?.machines ?? [];
  const freeHours = machines.reduce((sum, m) => sum + (m.freeHours ?? 0), 0);

  return (
    <div className="mx-auto max-w-[1600px] px-4 py-6 sm:px-6">
      <PageHeader
        icon={CalendarRange}
        title="Planner"
        description="Machine schedule with SARA's proposals on top. Nothing is booked until you confirm."
        actions={
          <>
            {plantName && (
              <span className="flex items-center gap-1.5 text-xs text-muted">
                <Building2 className="size-3.5" aria-hidden /> {plantName}
              </span>
            )}
            <Zoom days={days} onChange={setDays} />
          </>
        }
      />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(320px,380px)]">
        <div className="min-w-0 space-y-4">
          <Card>
            <CardHeader
              icon={CalendarRange}
              title="Machine schedule"
              subtitle={
                calendar.data
                  ? `${formatDate(calendarParams.start)} – ${formatDate(start + days * DAY - 1)} · ${machines.length || gantt?.rows?.length || 0} machines · ${formatNumber(freeHours, { digits: 0 })} h free`
                  : `${formatDate(calendarParams.start)} – ${formatDate(start + days * DAY - 1)}`
              }
              actions={
                plan && (
                  <span className="text-xs font-medium text-ai">
                    Showing {selected.data.proposal.proposalCode}
                  </span>
                )
              }
            />
            <div className="p-3">
              {calendar.isLoading ? (
                <div className="space-y-2" role="status" aria-busy="true" aria-label="Loading the schedule">
                  <Skeleton className="h-8" />
                  {[1, 2, 3, 4, 5].map((i) => (
                    <Skeleton key={i} className="h-10" />
                  ))}
                </div>
              ) : calendar.isError ? (
                <div className="flex flex-col items-center gap-3 py-10 text-center text-sm text-muted">
                  <p>Couldn't load the schedule. {calendar.error?.message}</p>
                  <Button size="sm" icon={RefreshCw} onClick={() => calendar.refetch()}>
                    Retry
                  </Button>
                </div>
              ) : (
                <Gantt data={gantt} />
              )}
            </div>
          </Card>
          <PlansList selectedId={selectedId} onSelect={select} />
        </div>
        <div className="min-w-0 space-y-4">
          <AiPlanPanel
            rows={gantt?.rows ?? []}
            plantId={plantId}
            deepLink={deepLink}
            onProposed={onProposed}
          />
          {selectedId && (
            <ProposalView key={selectedId} id={selectedId} onSelect={select} onClose={() => select(null)} />
          )}
        </div>
      </div>
    </div>
  );
};
