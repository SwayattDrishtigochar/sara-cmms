import { useQueryClient } from '@tanstack/react-query';
import { Building2, CalendarCheck, CalendarRange, Factory, MessageSquare, RefreshCw } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useAssistant } from '../assistant/useAssistant.js';
import { useSession } from '../auth/useAuth.js';
import { cn, formatDate, formatNumber, getFormatPrefs } from '../lib/format.js';
import { useLiveEvent } from '../live/liveStore.js';
import { useRecords } from '../modules/useModules.js';
import { useUi } from '../store/ui.js';
import { Button, Card, CardHeader, PageHeader, Skeleton } from '../ui/core.jsx';
import { TabPanel, Tabs } from '../ui/overlay.jsx';
import { Gantt } from './Gantt.jsx';
import { DAY, startOfDay } from './ganttLayout.js';
import { MaintenanceFormCard, MaintenancePlanResult } from './MaintenanceTab.jsx';
import { PlanRecordsList, PlansList } from './PlansList.jsx';
import { ProductionFormCard, ProductionPlanResult } from './ProductionTab.jsx';
import { useCalendar, useProposal } from './usePlanning.js';

const ZOOMS = [1, 3, 7, 14];
const PLANNING_MODULES = ['jobcards', 'workorders', 'productionplans', 'maintenanceplans', 'planproposals'];
const TAB_OF = { production: 'production', maintenance: 'maintenance', maintenance_plan: 'maintenance' };

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

const ScheduleCard = ({ calendar, params, start, days, gantt }) => {
  const machines = calendar.data?.machines ?? [];
  const freeHours = machines.reduce((sum, m) => sum + (m.freeHours ?? 0), 0);
  return (
    <Card>
      <CardHeader
        icon={CalendarRange}
        title="Machine schedule"
        subtitle={
          calendar.data
            ? `${formatDate(params.start)} – ${formatDate(start + days * DAY - 1)} · ${machines.length || gantt?.rows?.length || 0} machines · ${formatNumber(freeHours, { digits: 0 })} h free`
            : `${formatDate(params.start)} – ${formatDate(start + days * DAY - 1)}`
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
  );
};

const ResultSlot = ({ query, id, Result, onResult, fallback }) => {
  if (!id) return fallback;
  if (query.isLoading) {
    return (
      <Card className="space-y-3 p-4" aria-busy="true" role="status" aria-label="Loading the plan">
        <Skeleton className="h-5 w-2/3" />
        <Skeleton className="h-16" />
        <Skeleton className="h-40" />
      </Card>
    );
  }
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
          <Button size="sm" variant="ghost" onClick={() => onResult(null)}>
            Close
          </Button>
        </div>
      </Card>
    );
  }
  return <Result key={id} result={query.data} onResult={onResult} />;
};

/**
 * /planner: Production and Maintenance tabs, each a "Plan with SARA" form, the selected plan to edit,
 * check and create, and the lists of suggested and created plans. `?tab=`, `?proposal=<id>` select;
 * `?maintenance=<assetId>&anomaly=<id>` opens the Maintenance tab and plans that machine once.
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
  const assets = useRecords('assets', { limit: 200, sort: 'name' });

  const selectedId = params.get('proposal');
  const selected = useProposal(selectedId);
  const deepAsset = params.get('maintenance');
  const deepAnomaly = params.get('anomaly');
  const deepLink = useMemo(
    () => (deepAsset ? { assetId: deepAsset, anomalyId: deepAnomaly ?? undefined } : null),
    [deepAsset, deepAnomaly],
  );
  const resultTab = TAB_OF[selected.data?.proposal?.kind];
  const tab = params.get('tab') ?? (deepLink ? 'maintenance' : (resultTab ?? 'production'));

  useLiveEvent('record', (d) => {
    if (PLANNING_MODULES.includes(d?.module)) qc.invalidateQueries({ queryKey: ['planning'] });
  });

  const setTab = (next) =>
    setParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        p.set('tab', next);
        return p;
      },
      { replace: true },
    );
  const select = useCallback(
    (id, forTab) =>
      setParams(
        (prev) => {
          const p = new URLSearchParams();
          const t = forTab ?? prev.get('tab');
          if (t) p.set('tab', t);
          if (id) p.set('proposal', id);
          return p;
        },
        { replace: true },
      ),
    [setParams],
  );
  /** A form planned, a check replaced the plan, or a plan changed on apply: select it (null closes). */
  const onResult = useCallback(
    (r, forTab) => {
      const id = r?.proposal?._id ?? r?.proposal?.id;
      if (!id) return select(null, forTab);
      if (r.plan) qc.setQueryData(['m', 'planproposals', String(id)], r);
      return select(String(id), forTab ?? TAB_OF[r.proposal.kind]);
    },
    [qc, select],
  );

  const schedule = (
    <ScheduleCard
      calendar={calendar}
      params={calendarParams}
      start={start}
      days={days}
      gantt={calendar.data?.gantt}
    />
  );
  /** Grid cells of a tab: an open plan spans both columns (its tables need the width) and the form drops below it. */
  const cells = (name) => {
    const open = resultTab === name && Boolean(selectedId);
    return {
      form: cn('min-w-0 lg:col-start-2', open ? 'lg:row-start-2' : 'lg:row-start-1'),
      result: cn('min-w-0 space-y-4 lg:col-start-1 lg:row-start-1', open && 'lg:col-span-2'),
    };
  };
  const slotFor = (name, Result) => (
    <ResultSlot
      query={selected}
      id={resultTab === name ? selectedId : null}
      Result={Result}
      onResult={(r) => onResult(r, name)}
      fallback={schedule}
    />
  );

  return (
    <div className="mx-auto max-w-[1600px] px-4 py-6 sm:px-6">
      <PageHeader
        icon={CalendarRange}
        title="Planner"
        description="SARA drafts production and maintenance plans from your data. Edit, check, then create."
        actions={
          <>
            {plantName && (
              <span className="flex items-center gap-1.5 text-xs text-muted">
                <Building2 className="size-3.5" aria-hidden /> {plantName}
              </span>
            )}
            <Zoom days={days} onChange={setDays} />
            <Button
              size="sm"
              variant="ghost"
              icon={MessageSquare}
              onClick={() => useAssistant.getState().open({ text: 'Plan ' })}
            >
              Ask SARA
            </Button>
          </>
        }
      />
      <Tabs
        value={tab}
        onValueChange={setTab}
        tabs={[
          { value: 'production', label: 'Production', icon: Factory },
          { value: 'maintenance', label: 'Maintenance', icon: CalendarCheck },
        ]}
      >
        <TabPanel value="production">
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(320px,380px)]">
            <div className={cells('production').form}>
              <ProductionFormCard plantId={plantId} onPlanned={(r) => onResult(r, 'production')} />
            </div>
            <div className={cells('production').result}>{slotFor('production', ProductionPlanResult)}</div>
            <div className="min-w-0 space-y-4 lg:col-start-1">
              <PlansList
                kind="production"
                selectedId={selectedId}
                onSelect={(id) => select(id, 'production')}
              />
              <PlanRecordsList module="productionplans" />
            </div>
          </div>
        </TabPanel>
        <TabPanel value="maintenance">
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(320px,380px)]">
            <div className={cells('maintenance').form}>
              <MaintenanceFormCard
                assets={assets.data?.items ?? []}
                assetsLoading={assets.isLoading}
                deepLink={deepLink}
                plantId={plantId}
                onPlanned={(r) => onResult(r, 'maintenance')}
              />
            </div>
            <div className={cells('maintenance').result}>{slotFor('maintenance', MaintenancePlanResult)}</div>
            <div className="min-w-0 space-y-4 lg:col-start-1">
              <PlansList
                kind="maintenance_plan,maintenance"
                selectedId={selectedId}
                onSelect={(id) => select(id, 'maintenance')}
              />
              <PlanRecordsList module="maintenanceplans" />
            </div>
          </div>
        </TabPanel>
      </Tabs>
    </div>
  );
};
