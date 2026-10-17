import { plantOf, zoneOf } from '../agent/tools/common.js';
import { badRequest } from '../lib/errors.js';
import { shiftWindows, workingIntervals } from '../lib/shifts.js';
import { scopeFilter } from '../modules/records.js';
import { getModule } from '../modules/registry.js';
import { intersectIntervals, mergeIntervals, subtractIntervals, totalSeconds } from './intervals.js';

/**
 * Capacity calendar (phase 5 §3.1): per machine the working time (shifts − breaks on running days, minus
 * holidays), its bookings (open job cards, planned work-order windows) and the free time left; per mould
 * its busy and free time (a mould runs on one machine at a time).
 */

const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const DAY = 86_400_000;
const OPEN_JOBS = ['Open', 'In Progress', 'On Hold'];
const DONE_WORK = ['Completed', 'Closed'];
const ACTIVE_ANOMALY = ['open', 'acknowledged'];
export const DEFAULT_EFFICIENCY = 0.85;

/** Plans look at most this far ahead (calendars and rosters loop day by day per machine and person). */
export const MAX_PLAN_DAYS = 90;
const ms = (d) => new Date(d).getTime();

/** 400 unless every date lies within [now − 1 day, now + MAX_PLAN_DAYS days]: the planners' trust boundary. */
export const assertPlanDates = (now, dates) => {
  const bad = dates.filter(Boolean).find((d) => {
    const t = ms(d);
    return t < ms(now) - DAY || t > ms(now) + MAX_PLAN_DAYS * DAY;
  });
  if (bad) throw badRequest(`Plan at most ${MAX_PLAN_DAYS} days ahead (got ${new Date(bad).toISOString()})`);
};

/** 400 when a calendar or roster window is longer than any plan needs (the backstop for every caller). */
export const assertPlanSpan = (start, end) => {
  if (ms(end) - ms(start) > (MAX_PLAN_DAYS + 31) * DAY)
    throw badRequest(`Plan at most ${MAX_PLAN_DAYS} days ahead`);
};

const Model = (name) => getModule(name).Model;
const scoped = (ctx, name, where) => ({ ...where, ...scopeFilter(ctx, getModule(name)) });
const sid = (v) => (v == null ? null : String(v));

/** Working time of a plant: lib/shifts.workingIntervals (shifts − breaks, overnight-break rule, running days, holidays). */
export const plantWorking = (plant, start, end, zone, { includeNonRunningDays = false } = {}) => {
  if (!plant) return [];
  const p = includeNonRunningDays ? { ...plant, runningSchedule: WEEKDAYS, holidays: [] } : plant;
  return mergeIntervals(workingIntervals(p, start, end, zone));
};

/** Mean of availability × performance of the asset's job cards completed in the last 14 days (actualEnd), else 0.85. */
export const efficiencyOf = async (ctx, assetIds, now = new Date()) => {
  const rows = await Model('jobcards')
    .find(
      scoped(ctx, 'jobcards', {
        asset: { $in: assetIds },
        actualEnd: { $gte: new Date(now.getTime() - 14 * DAY), $lte: now },
        'completionMetrics.oee.availability': { $gt: 0 },
        'completionMetrics.oee.performance': { $gt: 0 },
      }),
    )
    .select('asset completionMetrics.oee')
    .lean();
  const byAsset = new Map();
  for (const r of rows) {
    const { availability, performance } = r.completionMetrics.oee;
    const list = byAsset.get(String(r.asset)) ?? [];
    list.push(Math.min(1, availability) * Math.min(1, performance));
    byAsset.set(String(r.asset), list);
  }
  return new Map(
    assetIds.map((id) => {
      const list = byAsset.get(String(id));
      return [
        String(id),
        list
          ? {
              efficiency: Math.max(0.2, list.reduce((a, b) => a + b, 0) / list.length),
              source: 'history',
            }
          : { efficiency: DEFAULT_EFFICIENCY, source: 'default' },
      ];
    }),
  );
};

const jobBooking = (jc, { now, efficiency, toolCycle, dueDates }) => {
  const perShot = jc.mouldParts?.[0]?.assignedPartPerShot || 1;
  const cycleSec = jc.idealCycleTime || toolCycle || 30;
  const target = jc.target ?? 0;
  const partsOut = jc.operations?.[0]?.progress?.partsOut ?? 0;
  const remainingSec = (Math.ceil(Math.max(0, target - partsOut) / perShot) * cycleSec) / efficiency;
  const finish = new Date(now.getTime() + remainingSec * 1000);
  let start = jc.startDate ?? jc.actualStart;
  let end = jc.endDate;
  // A running card behind schedule books the machine until its remaining parts are made; a waiting
  // card whose planned end has passed still has to run, so it is booked from now.
  if (jc.jobStatus === 'In Progress') {
    if (!end || end < finish) end = finish;
  } else if (end && end < now) {
    start = now;
    end = finish;
  }
  if (!start || !end || end <= start) return null;
  return {
    kind: 'jobcard',
    id: String(jc._id),
    code: jc.jobCardId,
    label: jc.jobName,
    start,
    end,
    assetId: String(jc.asset),
    toolId: sid(jc.tool),
    status: jc.jobStatus,
    productionPlanId: sid(jc.productionPlanId),
    dueDate: dueDates.get(sid(jc.productionPlanId)) ?? null,
    target,
    partsOut,
    perShot,
    cycleSec,
  };
};

/**
 * @param ctx viewer ctx (records.scopeFilter on every read)
 * @param {{ plantId?, assetIds?: string[], start: Date, end: Date, includeNonRunningDays?: boolean, now?: Date }} opts
 */
export const buildCalendar = async (ctx, opts) => {
  const { plantId = null, assetIds, includeNonRunningDays = false } = opts;
  const start = new Date(opts.start);
  const end = new Date(opts.end);
  assertPlanSpan(start, end);
  const now = opts.now ?? new Date();
  const zone = zoneOf(ctx);

  const assets = await Model('assets')
    .find(
      scoped(ctx, 'assets', {
        ...(assetIds?.length ? { _id: { $in: assetIds } } : { isProductionAsset: true }),
        ...(plantId ? { plantId } : {}),
      }),
    )
    .select('name assetTag typeOfAsset assetStatus healthScore plantId')
    .collation({ locale: 'en', numericOrdering: true })
    .sort({ name: 1 })
    .lean();
  const machineIds = assets.map((a) => a._id);

  const tools = await Model('tools')
    .find(scoped(ctx, 'tools', { assets: { $in: machineIds } }))
    .lean();
  const toolIds = tools.map((t) => t._id);
  const [efficiency, jobs, mounted, workOrders, anomalies, pms, calibrations] = await Promise.all([
    efficiencyOf(ctx, machineIds, now),
    Model('jobcards')
      .find(
        scoped(ctx, 'jobcards', {
          $or: [{ asset: { $in: machineIds } }, { tool: { $in: toolIds } }],
          jobStatus: { $in: OPEN_JOBS },
        }),
      )
      .lean(),
    // The mould on each machine now: the tool of its most recently started job card.
    Model('jobcards')
      .find(
        scoped(ctx, 'jobcards', {
          asset: { $in: machineIds },
          actualStart: { $gte: new Date(now.getTime() - 60 * DAY), $lte: now },
        }),
      )
      .select('asset tool actualStart')
      .sort({ actualStart: -1 })
      .lean(),
    Model('workorders')
      .find(
        scoped(ctx, 'workorders', {
          asset: { $in: machineIds },
          workStatus: { $nin: DONE_WORK },
          plannedStart: { $ne: null, $lt: end },
          plannedEnd: { $gt: start },
        }),
      )
      .lean(),
    Model('anomalies')
      .find(scoped(ctx, 'anomalies', { assetId: { $in: machineIds }, state: { $in: ACTIVE_ANOMALY } }))
      .sort({ detectedAt: -1 })
      .lean(),
    ...['preventivemaintenances', 'calibrations'].map((name) =>
      Model(name)
        .find(
          scoped(ctx, name, {
            assetAllocation: { $in: machineIds },
            isActive: { $ne: false },
            nextGenerationDate: { $gte: start, $lt: end },
          }),
        )
        .lean(),
    ),
  ]);

  const planIds = [...new Set(jobs.map((j) => sid(j.productionPlanId)).filter(Boolean))];
  const plans = planIds.length
    ? await Model('productionplans')
        .find(scoped(ctx, 'productionplans', { _id: { $in: planIds } }))
        .select('dueDate')
        .lean()
    : [];
  const dueDates = new Map(plans.map((p) => [String(p._id), p.dueDate]));
  const toolCycle = new Map(tools.map((t) => [String(t._id), t.idealCycleTimeSec]));
  const jobBookings = jobs
    .map((jc) =>
      jobBooking(jc, {
        now,
        efficiency: efficiency.get(String(jc.asset))?.efficiency ?? DEFAULT_EFFICIENCY,
        toolCycle: toolCycle.get(sid(jc.tool)),
        dueDates,
      }),
    )
    .filter((b) => b && b.end > start);
  const mountedTool = new Map();
  for (const jc of mounted)
    if (!mountedTool.has(String(jc.asset))) mountedTool.set(String(jc.asset), sid(jc.tool));

  const workingByPlant = new Map();
  const workingOf = (pid) => {
    const key = String(pid);
    if (!workingByPlant.has(key)) {
      const plant = ctx.plants.find((p) => String(p._id) === key);
      workingByPlant.set(key, plantWorking(plant, start, end, zone, { includeNonRunningDays }));
    }
    return workingByPlant.get(key);
  };

  const machines = assets.map((a) => {
    const assetId = String(a._id);
    const working = workingOf(a.plantId);
    const bookings = [
      ...jobBookings.filter((b) => b.assetId === assetId),
      ...workOrders
        .filter((w) => String(w.asset) === assetId)
        .map((w) => ({
          kind: 'workorder',
          id: String(w._id),
          code: w.workOrderId,
          label: w.name,
          start: w.plannedStart,
          end: w.plannedEnd,
          assetId,
          status: w.workStatus,
        })),
    ].sort((x, y) => x.start - y.start);
    const eff = efficiency.get(assetId);
    return {
      assetId,
      name: a.name,
      assetTag: a.assetTag ?? null,
      typeOfAsset: a.typeOfAsset ?? null,
      status: a.assetStatus ?? null,
      healthScore: a.healthScore ?? null,
      plantId: sid(a.plantId),
      efficiency: eff.efficiency,
      efficiencySource: eff.source,
      mountedToolId: mountedTool.get(assetId) ?? null,
      openAnomalies: anomalies
        .filter((x) => String(x.assetId) === assetId)
        .map((x) => ({
          id: String(x._id),
          code: x.anomalyCode,
          type: x.type,
          severity: x.severity,
          summary: x.summary ?? null,
          detectedAt: x.detectedAt ?? x.createdAt,
          urgencyHours: x.urgencyHours ?? null,
        })),
      dueTasks: [
        ...pms.map((t) => ({ kind: 'pm', id: String(t._id), code: t.preventiveMaintenanceId, ...task(t) })),
        ...calibrations.map((t) => ({
          kind: 'calibration',
          id: String(t._id),
          code: t.calibrationId,
          ...task(t),
        })),
      ].filter((t) => t.assetId === assetId),
      working,
      bookings,
      free: subtractIntervals(working, bookings),
    };
  });

  const range = [{ start, end }];
  const calendarTools = tools.map((t) => {
    const toolId = String(t._id);
    const busy = jobBookings
      .filter((b) => b.toolId === toolId)
      .map((b) => ({ start: b.start, end: b.end, assetId: b.assetId, jobCardId: b.id }));
    return {
      toolId,
      toolNumber: t.toolNumber ?? null,
      name: t.name,
      status: t.status ?? 'In Service',
      assets: (t.assets ?? []).map(String),
      cycleSec: t.idealCycleTimeSec || 30,
      setupMin: t.setupTimeMin ?? 45,
      parts: (t.mouldParts ?? []).map((p) => ({
        id: String(p._id),
        partName: p.partName,
        perShot: p.partPerShot || 1,
        weight: p.partWeight ?? null,
      })),
      shotCount: t.shotCount ?? 0,
      maxShotLife: t.maxShotLife ?? null,
      busy,
      free: subtractIntervals(range, busy),
    };
  });

  const plant = plantOf(ctx, plantId ?? machines[0]?.plantId);
  return {
    start,
    end,
    timeZone: zone,
    dateFormat: ctx.company?.dateFormat ?? 'DD-MM-YYYY',
    plantId: sid(plantId),
    now,
    shifts: plant
      ? shiftWindows(
          includeNonRunningDays ? { ...plant, runningSchedule: WEEKDAYS, holidays: [] } : plant,
          start,
          end,
          zone,
        ).map((w) => ({ name: w.shiftName, start: w.start, end: w.end }))
      : [],
    machines,
    tools: calendarTools,
  };
};

const task = (t) => ({
  assetId: String(t.assetAllocation),
  name: t.name,
  due: t.nextGenerationDate,
  durationMin: t.estimatedDurationMin ?? 60,
});

/** Free and booked working hours of a calendar machine. */
export const hoursOf = (machine) => ({
  freeHours: Math.round((totalSeconds(machine.free) / 3600) * 10) / 10,
  bookedHours:
    Math.round((totalSeconds(intersectIntervals(machine.working, machine.bookings)) / 3600) * 10) / 10,
});

const barOf = (m, b) => ({
  id: b.id,
  rowId: m.assetId,
  start: b.start,
  end: b.end,
  label: b.label,
  kind: b.kind === 'workorder' ? 'maintenance' : 'jobcard',
  status: b.status,
  code: b.code,
  href: `/m/${b.kind === 'workorder' ? 'workorders' : 'jobcards'}/${b.id}`,
  ...(b.dueDate && b.end > b.dueDate ? { late: true } : {}),
  ...(b.kind === 'jobcard' && b.target > 0 && b.partsOut != null
    ? { progress: Math.min(1, b.partsOut / b.target) }
    : {}),
});

/** Calendar → GanttData (§3.4) for the Planner, the Command Center and the plan block. */
export const calendarToGantt = (_ctx, calendar) => {
  const machines = calendar.machines.slice(0, 20);
  return {
    range: { start: calendar.start, end: calendar.end },
    timeZone: calendar.timeZone,
    rows: machines.map((m) => ({
      id: m.assetId,
      label: m.name,
      sub: [m.assetTag, `${Math.round(m.efficiency * 100)} %`].filter(Boolean).join(' · '),
      ...(m.status ? { status: m.status } : {}),
      ...(m.healthScore != null ? { health: m.healthScore } : {}),
      ...(m.typeOfAsset ? { group: m.typeOfAsset } : {}),
    })),
    bars: machines.flatMap((m) => m.bookings.map((b) => barOf(m, b))).slice(0, 300),
    shifts: calendar.shifts,
    markers: machines.flatMap((m) =>
      m.openAnomalies.map((a) => ({
        id: a.id,
        rowId: m.assetId,
        at: a.detectedAt,
        kind: 'anomaly',
        severity: a.severity,
        label: [a.code, a.summary].filter(Boolean).join(' · '),
        href: `/anomalies?open=${a.id}`,
      })),
    ),
  };
};
