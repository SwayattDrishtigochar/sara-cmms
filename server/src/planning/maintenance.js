import { DateTime } from 'luxon';
import { asObjectId, plantOf, zoneOf } from '../agent/tools/common.js';
import { badRequest, notFound } from '../lib/errors.js';
import { humanize } from '../lib/format.js';
import { workingIntervals } from '../lib/shifts.js';
import { scopeFilter } from '../modules/records.js';
import { getModule } from '../modules/registry.js';
import { buildCalendar } from './capacity.js';
import { advanceWorking, intersectIntervals, subtractIntervals, totalSeconds } from './intervals.js';
import { createProposal } from './proposals.js';

/**
 * F2 maintenance planner (phase-5 contract §3.3): tasks (anomalies, PMs, calibrations, unscheduled work
 * orders) → a zero-impact window, or push options (insert / move / defer) with their production delays.
 * The engine computes every number; the AI explanation (planning/explain.js) only explains and may pick.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MAX_TASKS = 20;
const DONE = ['Completed', 'Closed'];
const ACTIVE_ANOMALY = ['open', 'acknowledged'];
const PRIORITY_RANK = { High: 0, Medium: 1, Low: 2 };
const SEVERITY_PRIORITY = { critical: 'High', warning: 'Medium', info: 'Low' };
/** Default work order duration per category when it has no estimate (the telemetry source's table). */
export const CATEGORY_MIN = {
  Breakdown: 90,
  Preventive: 60,
  Electrical: 60,
  Hydraulic: 75,
  Mechanical: 70,
  Inspection: 30,
  Cleaning: 40,
  Calibration: 45,
};

const hoursOf = (ms) => Math.round((ms / HOUR) * 100) / 100;
const ms = (date) => new Date(date).getTime();
const defined = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => v != null));

/**
 * Maintenance tasks to plan, ordered by deadline then priority.
 * @param {{ assetId?, anomalyId?, workOrderId?, horizonDays?: number, plantId? }} input
 */
export const maintenanceTasks = async (ctx, input = {}, now = new Date()) => {
  const { assetId, anomalyId, workOrderId, horizonDays = 7 } = input;
  const horizonEnd = new Date(ms(now) + horizonDays * DAY);
  const notBefore = (date, minMs) => new Date(Math.max(ms(date), ms(now) + minMs));
  const find = (name, filter) => {
    if (ctx.modules && !ctx.modules.includes(name)) return [];
    const mod = getModule(name);
    return mod.Model.find({ ...filter, ...scopeFilter(ctx, mod) }).lean();
  };
  const plantId = assetId ? null : plantOf(ctx, input.plantId)?._id;
  const where = (field) => (assetId ? { [field]: asObjectId(assetId) } : plantId ? { plantId } : {});
  const target = anomalyId ? 'anomaly' : workOrderId ? 'workorder' : null;
  const byId = (id, what) => {
    const oid = asObjectId(id);
    if (!oid) throw notFound(`${what} not found`);
    return { _id: oid };
  };
  const schedule = { isActive: true, nextGenerationDate: { $lte: horizonEnd } };

  const [anomalies, pms, cals, wos] = await Promise.all([
    target === 'workorder'
      ? []
      : find(
          'anomalies',
          target ? byId(anomalyId, 'Anomaly') : { ...where('assetId'), state: { $in: ACTIVE_ANOMALY } },
        ),
    target ? [] : find('preventivemaintenances', { ...where('assetAllocation'), ...schedule }),
    target ? [] : find('calibrations', { ...where('assetAllocation'), ...schedule }),
    target === 'anomaly'
      ? []
      : find(
          'workorders',
          target
            ? byId(workOrderId, 'Work order')
            : {
                ...where('asset'),
                workStatus: { $nin: DONE },
                // Unscheduled, or its window passed and nobody started it (a missed window is re-planned).
                $or: [{ plannedStart: null }, { workStatus: 'Open', plannedEnd: { $lt: now } }],
              },
        ),
  ]);
  if (target === 'anomaly') {
    if (!anomalies.length) throw notFound('Anomaly not found');
    if (!ACTIVE_ANOMALY.includes(anomalies[0].state))
      throw badRequest(
        `${anomalies[0].anomalyCode} is already ${humanize(anomalies[0].state).toLowerCase()}`,
      );
  }
  if (target === 'workorder') {
    if (!wos.length) throw notFound('Work order not found');
    if (DONE.includes(wos[0].workStatus))
      throw badRequest(`${wos[0].workOrderId} is already ${wos[0].workStatus}`);
  }

  // A PM or calibration that already has an open work order is planned through that work order.
  const scheduleIds = [...pms, ...cals].map((p) => p._id);
  const generated = scheduleIds.length
    ? await find('workorders', {
        workStatus: { $nin: DONE },
        $or: [{ pmId: { $in: scheduleIds } }, { calibrationId: { $in: scheduleIds } }],
      })
    : [];
  const hasWo = new Set(generated.flatMap((w) => [String(w.pmId), String(w.calibrationId)]));
  // Same for an anomaly whose work order exists already (made by an earlier plan or by hand).
  const linked = anomalies.length
    ? await find('workorders', {
        workStatus: { $nin: DONE },
        anomalyId: { $in: anomalies.map((a) => a._id) },
      })
    : [];
  const woOf = new Map(linked.map((w) => [String(w.anomalyId), w]));

  const assetIds = [
    ...new Set(
      [
        ...anomalies.map((a) => a.assetId),
        ...[...pms, ...cals].map((p) => p.assetAllocation),
        ...wos.map((w) => w.asset),
      ]
        .filter(Boolean)
        .map(String),
    ),
  ];
  const assetMod = getModule('assets');
  const assets = new Map(
    (
      await assetMod.Model.find({ _id: { $in: assetIds.map(asObjectId) }, ...scopeFilter(ctx, assetMod) })
        .select('name plantId')
        .lean()
    ).map((a) => [String(a._id), a]),
  );
  const base = (assetRef) => {
    const asset = assets.get(String(assetRef));
    return asset && { assetId: String(asset._id), assetName: asset.name, plantId: asset.plantId };
  };

  const tasks = [];
  for (const a of anomalies) {
    const at = base(a.assetId);
    const own = woOf.get(String(a._id));
    // Already booked through its work order: only an explicit request re-plans it.
    if (!at || (!target && own?.plannedStart)) continue;
    const wo = a.investigation?.suggestedWorkOrder ?? {};
    const urgencyHours = a.urgencyHours ?? a.investigation?.urgencyHours ?? 24;
    tasks.push({
      kind: 'anomaly',
      refId: String(a._id),
      code: a.anomalyCode,
      ...at,
      title: wo.name ?? `${humanize(a.type)} – ${at.assetName}`,
      description: wo.description ?? a.summary ?? null,
      durationMin: wo.estimatedDurationMin ?? 90,
      deadline: notBefore(ms(a.detectedAt ?? now) + urgencyHours * HOUR, HOUR),
      priority: SEVERITY_PRIORITY[a.severity] ?? 'Medium',
      category: wo.category ?? 'Inspection',
      severity: a.severity,
      urgencyHours,
      workOrderId: own ? String(own._id) : a.workOrderId ? String(a.workOrderId) : undefined,
    });
  }
  for (const [kind, list] of [
    ['pm', pms],
    ['calibration', cals],
  ]) {
    for (const p of list) {
      const at = base(p.assetAllocation);
      if (!at || hasWo.has(String(p._id))) continue;
      const cycle = p.trigger?.cycle ?? {};
      const unit = String(cycle.duration ?? 'Months').toLowerCase();
      tasks.push({
        kind,
        refId: String(p._id),
        code: p.preventiveMaintenanceId ?? p.calibrationId,
        ...at,
        title: p.selectWorkOrder?.name ?? p.name,
        description: p.description ?? p.selectWorkOrder?.description ?? null,
        durationMin: p.estimatedDurationMin ?? 60,
        deadline:
          ms(p.nextGenerationDate) < ms(now) ? new Date(ms(now) + DAY) : new Date(p.nextGenerationDate),
        priority: p.selectWorkOrder?.priority ?? 'Medium',
        category: kind === 'pm' ? 'Preventive' : 'Calibration',
        dueDate: new Date(p.nextGenerationDate),
        nextGenerationDate: DateTime.fromJSDate(new Date(p.nextGenerationDate))
          .plus({ [unit]: cycle.everyNumber ?? 1 })
          .toJSDate(),
      });
    }
  }
  const covered = new Set(tasks.map((t) => t.workOrderId).filter(Boolean));
  const anomalyTasks = new Set(tasks.filter((t) => t.kind === 'anomaly').map((t) => t.refId));
  for (const w of wos) {
    const at = base(w.asset);
    if (!at || covered.has(String(w._id)) || anomalyTasks.has(String(w.anomalyId))) continue;
    tasks.push({
      kind: 'workorder',
      refId: String(w._id),
      code: w.workOrderId,
      ...at,
      title: w.name,
      description: w.description ?? null,
      durationMin: w.estimatedDurationMin ?? CATEGORY_MIN[w.category] ?? 60,
      deadline: notBefore(w.dueDate ?? ms(now) + 72 * HOUR, HOUR),
      priority: w.priority ?? 'Medium',
      category: w.category ?? 'Breakdown',
      workOrderId: String(w._id),
    });
  }
  return tasks
    .sort(
      (x, y) =>
        ms(x.deadline) - ms(y.deadline) ||
        (PRIORITY_RANK[x.priority] ?? 1) - (PRIORITY_RANK[y.priority] ?? 1),
    )
    .slice(0, MAX_TASKS);
};

/** Earliest run of `seconds` of `avail` inside one gap between bookings (so no booking is touched). */
const firstWindow = (bookings, avail, from, to, seconds) => {
  for (const gap of subtractIntervals([{ start: from, end: to }], bookings)) {
    const run = advanceWorking(intersectIntervals([gap], avail), gap.start, seconds);
    if (run) return { start: run.segments[0]?.start ?? gap.start, end: run.end };
  }
  return null;
};

/** The machine's planned work orders (including ones this plan just booked). */
const heldBy = (machine) => machine.bookings.filter((b) => b.kind === 'workorder');

/** Hours a new end adds past the plan due date (lateness that was already there is not counted again). */
const addedLate = (oldEnd, newEnd, dueDate) =>
  dueDate ? hoursOf(Math.max(0, ms(newEnd) - ms(dueDate)) - Math.max(0, ms(oldEnd) - ms(dueDate))) : 0;

/**
 * Pushes the machine's job cards around a maintenance block: the card overlapping the block keeps its working
 * duration and ends later; each later card starts at max(its start, previous end) with its working duration.
 */
export const rescheduleForward = (machine, block, _options = {}) => {
  // Planned work orders stay put: cards run around them as they run around the new block.
  const avail = subtractIntervals(machine.working, heldBy(machine));
  const free = subtractIntervals(avail, [block]);
  const cards = machine.bookings
    .filter((b) => b.kind === 'jobcard' && ms(b.end) > ms(block.start))
    .sort((a, b) => ms(a.start) - ms(b.start));
  const moves = [];
  const delays = [];
  let lateHours = 0;
  let prevEnd = null;
  for (const card of cards) {
    const from = { start: new Date(card.start), end: new Date(card.end) };
    const work = totalSeconds(intersectIntervals(avail, [from]));
    const begin = prevEnd && prevEnd > ms(card.start) ? new Date(prevEnd) : from.start;
    const run = advanceWorking(free, begin, work);
    // ponytail: past the calendar's end the card is pushed by the block length; a longer calendar fixes it
    const end = run?.end ?? new Date(ms(card.end) + ms(block.end) - ms(block.start));
    const start = ms(card.start) < ms(block.start) || !run?.segments[0] ? from.start : run.segments[0].start;
    prevEnd = ms(end);
    if (Math.abs(ms(end) - ms(from.end)) < MINUTE && Math.abs(ms(start) - ms(from.start)) < MINUTE) continue;
    moves.push({ jobCardId: card.id, code: card.code, label: card.label, from, to: { start, end } });
    lateHours += addedLate(from.end, end, card.dueDate);
    delays.push({
      jobCardId: card.id,
      code: card.code,
      rowId: String(machine.assetId),
      hours: hoursOf(ms(end) - ms(from.end)),
      late: Boolean(card.dueDate && ms(end) > ms(card.dueDate)),
      dueDate: card.dueDate ?? null,
    });
  }
  return { moves, delays, lateHours: hoursOf(lateHours * HOUR) };
};

const workOrderOps = (task, block) => {
  const window = {
    plannedStart: block.start,
    plannedEnd: block.end,
    estimatedDurationMin: task.durationMin,
  };
  const ops = [
    task.workOrderId
      ? {
          op: 'update',
          module: 'workorders',
          id: task.workOrderId,
          label: `Schedule ${task.code ?? task.title}`,
          data: window,
          before: { plannedStart: null, plannedEnd: null },
        }
      : {
          op: 'create',
          module: 'workorders',
          label: `Work order "${task.title}"`,
          data: defined({
            name: task.title,
            description: task.description,
            asset: task.assetId,
            priority: task.priority,
            category: task.category,
            dueDate: task.deadline,
            ...window,
            anomalyId: task.kind === 'anomaly' ? task.refId : null,
            pmId: task.kind === 'pm' ? task.refId : null,
            calibrationId: task.kind === 'calibration' ? task.refId : null,
          }),
        },
  ];
  if (task.nextGenerationDate) {
    ops.push({
      op: 'update',
      module: task.kind === 'pm' ? 'preventivemaintenances' : 'calibrations',
      id: task.refId,
      label: `Move ${task.code} to its next cycle`,
      data: { nextGenerationDate: task.nextGenerationDate },
      before: { nextGenerationDate: task.dueDate },
    });
  }
  return ops;
};

const moveOps = (moves) =>
  moves.map((m) => ({
    op: 'update',
    module: 'jobcards',
    id: m.jobCardId,
    label: `Reschedule ${m.code ?? 'job card'}`,
    data: { startDate: m.to.start, endDate: m.to.end },
    before: { startDate: m.from.start, endDate: m.from.end },
  }));

const maintenanceBar = (task, block, lateHours) =>
  defined({
    id: `mnt-${task.refId}`,
    rowId: String(task.assetId),
    start: block.start,
    end: block.end,
    label: task.title,
    kind: 'maintenance',
    ghost: true,
    change: 'new',
    late: lateHours > 0 ? true : null,
    tooltip: `${task.durationMin} min · ${task.code ?? humanize(task.kind)}`,
  });

const moveBars = (moves, rowId, delays) =>
  moves.map((m) =>
    defined({
      id: m.jobCardId,
      rowId,
      start: m.to.start,
      end: m.to.end,
      label: m.label ?? m.code,
      code: m.code,
      kind: 'jobcard',
      ghost: true,
      change: Math.abs(ms(m.to.start) - ms(m.from.start)) < MINUTE ? 'extended' : 'moved',
      from: m.from,
      href: `/m/jobcards/${m.jobCardId}`,
      late: delays.find((d) => d.jobCardId === m.jobCardId)?.late ? true : null,
    }),
  );

const option = (id, label, task, block, extra = {}) => {
  const delays = extra.delays ?? [];
  const lateHours = extra.lateHours ?? 0;
  const maintenanceLateHours = hoursOf(Math.max(0, ms(block.end) - ms(task.deadline)));
  return {
    id,
    label,
    start: block.start,
    end: block.end,
    lateHours,
    delayHours: hoursOf(delays.reduce((sum, d) => sum + Math.max(0, d.hours), 0) * HOUR),
    maintenanceLateHours,
    delays,
    risk: extra.risk ?? null,
    ops: [...workOrderOps(task, block), ...(extra.ops ?? [])].map((op, seq) => ({ seq, ...op })),
    diff: { bars: [maintenanceBar(task, block, maintenanceLateHours), ...(extra.bars ?? [])], delays },
    moves: extra.moves ?? [],
    added: extra.added ?? [],
  };
};

const lateRisk = (delays) => {
  const late = delays.filter((d) => d.late);
  return late.length ? `${late.map((d) => d.code).join(', ')} would finish after the plan due date` : null;
};

/** Option 3: stop the card at the block, run its remaining parts on the tool's other machine. */
const moveOption = (calendar, machines, machine, task, block, now) => {
  const card = machine.bookings.find(
    (b) => b.kind === 'jobcard' && ms(b.start) < ms(block.end) && ms(b.end) > ms(block.start),
  );
  const tool = card && (calendar.tools ?? []).find((t) => String(t.toolId) === String(card.toolId));
  if (!tool || !card.target || !card.template?.jobName) return null;
  const from = new Date(Math.max(ms(card.start), ms(now)));
  // Time under a planned work order (e.g. one this plan just inserted) makes no parts.
  const producing = subtractIntervals(machine.working, heldBy(machine));
  const totalWork = totalSeconds(intersectIntervals(producing, [{ start: from, end: card.end }]));
  const beforeWork = totalSeconds(intersectIntervals(producing, [{ start: from, end: block.start }]));
  const done = card.partsOut ?? 0;
  const keep = Math.max(
    1,
    done + (totalWork ? Math.floor(((card.target - done) * beforeWork) / totalWork) : 0),
  );
  const rest = card.target - keep;
  if (rest <= 0) return null;
  const perShot =
    tool.parts?.find((p) => p.partName?.toLowerCase() === card.template?.partName?.toLowerCase())?.perShot ??
    tool.parts?.[0]?.perShot ??
    1;
  const reject = (card.template?.rejectionPercentage ?? 0) / 100;
  const toolBusy = (tool.busy ?? []).filter((b) => String(b.jobCardId) !== String(card.id));

  let best = null;
  for (const assetId of tool.assets ?? []) {
    const other = machines.get(String(assetId));
    if (!other || String(assetId) === String(machine.assetId)) continue;
    const seconds =
      (tool.setupMin ?? 45) * 60 +
      (Math.ceil(rest / Math.max(0.01, 1 - reject) / perShot) * tool.cycleSec) / (other.efficiency || 0.85);
    const avail = subtractIntervals(other.working, toolBusy);
    const window = firstWindow(other.bookings, avail, new Date(block.start), calendar.end, seconds);
    if (window && (!best || ms(window.end) < ms(best.window.end))) best = { other, window };
  }
  if (!best) return null;

  const truncated = { ...card, end: new Date(block.start) };
  const pushed = rescheduleForward(
    { ...machine, bookings: machine.bookings.map((b) => (b === card ? truncated : b)) },
    block,
    { now },
  );
  const rowId = String(machine.assetId);
  const newRow = String(best.other.assetId);
  const remainderLate = Boolean(card.dueDate && ms(best.window.end) > ms(card.dueDate));
  const remainderDelay = hoursOf(ms(best.window.end) - ms(card.end));
  const delays = [
    ...(remainderDelay > 0
      ? [
          {
            jobCardId: card.id,
            code: card.code,
            rowId: newRow,
            hours: remainderDelay,
            late: remainderLate,
            dueDate: card.dueDate ?? null,
          },
        ]
      : []),
    ...pushed.delays,
  ];
  const template = card.template ?? {};
  const created = defined({
    ...template,
    operationName: undefined,
    asset: newRow,
    tool: String(card.toolId),
    target: rest,
    idealCycleTime: template.idealCycleTime ?? tool.cycleSec,
    startDate: best.window.start,
    endDate: best.window.end,
    operations: [
      { operationName: template.operationName ?? 'Processing', assetId: newRow, cycleTime: tool.cycleSec },
    ],
  });
  return option('move', `Move the rest of ${card.code ?? 'the job'} to ${best.other.name}`, task, block, {
    delays,
    lateHours: hoursOf((addedLate(card.end, best.window.end, card.dueDate) + pushed.lateHours) * HOUR),
    risk: lateRisk(delays),
    moves: [
      {
        jobCardId: card.id,
        code: card.code,
        label: card.label,
        from: { start: card.start, end: card.end },
        to: { start: card.start, end: truncated.end },
      },
      ...pushed.moves,
    ],
    added: [
      {
        assetId: newRow,
        booking: {
          kind: 'jobcard',
          id: `new-${card.id}`,
          code: 'new',
          start: best.window.start,
          end: best.window.end,
          toolId: card.toolId,
          dueDate: card.dueDate,
        },
      },
    ],
    ops: [
      {
        op: 'update',
        module: 'jobcards',
        id: card.id,
        label: `Stop ${card.code ?? 'the job card'} at ${keep} pcs before the maintenance`,
        data: { endDate: truncated.end, target: keep },
        before: { endDate: card.end, target: card.target },
      },
      {
        op: 'create',
        module: 'jobcards',
        label: `Job card for the remaining ${rest} pcs on ${best.other.name}`,
        data: created,
      },
      ...moveOps(pushed.moves),
    ],
    bars: [
      defined({
        id: card.id,
        rowId,
        start: card.start,
        end: truncated.end,
        label: card.label ?? card.code,
        code: card.code,
        kind: 'jobcard',
        ghost: true,
        change: 'moved',
        from: { start: card.start, end: card.end },
        href: `/m/jobcards/${card.id}`,
      }),
      defined({
        id: `new-${card.id}`,
        rowId: newRow,
        start: best.window.start,
        end: best.window.end,
        label: `${card.label ?? card.code} (rest, ${rest} pcs)`,
        kind: 'jobcard',
        ghost: true,
        change: 'new',
        late: remainderLate ? true : null,
      }),
      ...moveBars(pushed.moves, rowId, pushed.delays),
    ],
  });
};

/** The option to recommend: least plan lateness, then delay, then maintenance lateness; defer only as a last resort. */
const recommend = (task, options) => {
  const pushes = options.filter((o) => o.id !== 'defer');
  const allowDefer = !pushes.length || (task.severity !== 'critical' && pushes.every((o) => o.lateHours > 0));
  return (
    options
      .filter((o) => o.id !== 'defer' || allowDefer)
      .sort(
        (a, b) =>
          a.lateHours - b.lateHours ||
          a.delayHours - b.delayHours ||
          a.maintenanceLateHours - b.maintenanceLateHours,
      )[0] ?? null
  );
};

/**
 * Options for one task on its machine. A free window before the deadline is the only option unless
 * `allOptions` (an objective that weighs urgency): then insert/move compete with it.
 */
const optionsFor = (calendar, machines, task, { now, staff, allOptions = false }) => {
  const machine = machines.get(String(task.assetId));
  if (!machine) return [];
  const avail = staff ?? machine.working;
  const seconds = Math.max(1, task.durationMin) * 60;
  const free = firstWindow(machine.bookings, avail, now, calendar.end, seconds);
  const inTime = free && ms(free.end) <= ms(task.deadline);
  const zero = inTime ? [option('zero_impact', 'Free window, no production impact', task, free)] : [];
  if (inTime && !allOptions) return zero;
  const options = [...zero];
  const open = subtractIntervals(
    intersectIntervals([{ start: now, end: calendar.end }], avail),
    heldBy(machine),
  );
  const run = advanceWorking(open, now, seconds);
  if (run) {
    const block = { start: run.segments[0]?.start ?? now, end: run.end };
    const pushed = rescheduleForward(machine, block, { now });
    options.push(
      option('insert', 'Insert now and push the job cards', task, block, {
        ...pushed,
        risk: lateRisk(pushed.delays),
        ops: moveOps(pushed.moves),
        bars: moveBars(pushed.moves, String(machine.assetId), pushed.delays),
      }),
    );
    const moved = moveOption(calendar, machines, machine, task, block, now);
    if (moved) options.push(moved);
  }
  if (free && !inTime) {
    const late = hoursOf(Math.max(0, ms(free.end) - ms(task.deadline)));
    options.push(
      option('defer', 'Defer to the next free window', task, free, {
        risk:
          task.kind === 'anomaly'
            ? `Runs ${late} h after the AI deadline (urgency ${task.urgencyHours} h)`
            : `Runs ${late} h after its due date`,
      }),
    );
  }
  return options;
};

/** Books the chosen option into the working copy so the next task sees it. */
const commit = (machines, task, chosen) => {
  const machine = machines.get(String(task.assetId));
  for (const move of chosen.moves) {
    const booking = machine.bookings.find((b) => b.id === move.jobCardId);
    if (booking) Object.assign(booking, move.to);
  }
  machine.bookings.push({ kind: 'workorder', id: `mnt-${task.refId}`, start: chosen.start, end: chosen.end });
  for (const { assetId, booking } of chosen.added) machines.get(assetId)?.bookings.push(booking);
};

/**
 * Pure planner. `staff` = intervals with maintenance people on shift (shifts − breaks); absent → machine working time.
 * `choose(task, options)` picks the option booked before the next task (default: the recommendation);
 * `allOptions` also offers insert/move when a free window exists (for a `choose` that weighs urgency).
 * @returns {{ tasks: [{ task, options: MaintenanceOption[], recommended: string|null }] }}
 */
export const planMaintenance = (
  calendar,
  tasks,
  { now = calendar.now ?? new Date(), staff, choose = recommend, allOptions = false } = {},
) => {
  const machines = new Map(calendar.machines.map((m) => [String(m.assetId), structuredClone(m)]));
  // A work order being re-planned frees its current window.
  const replanned = new Set(tasks.map((t) => t.workOrderId).filter(Boolean));
  for (const m of machines.values()) m.bookings = m.bookings.filter((b) => !replanned.has(String(b.id)));
  return {
    tasks: tasks.map((task) => {
      const options = optionsFor(calendar, machines, task, { now: new Date(now), staff, allOptions });
      const chosen = choose(task, options);
      if (chosen) commit(machines, task, chosen);
      return { task, options, recommended: chosen?.id ?? null };
    }),
  };
};

/** Maintenance people's shifts (minus breaks) in [start, end); null when nobody has a shift (then any working time counts). */
const staffWindows = async (ctx, plant, start, end, { includeNonRunningDays }) => {
  const users = getModule('users');
  const people = await users.Model.find({
    ...scopeFilter(ctx, users),
    plantId: plant._id,
    department: 'Maintenance',
    role: { $in: ['technician', 'admin'] },
  })
    .select('shiftId')
    .lean();
  const shiftIds = new Set(
    people
      .map((u) => u.shiftId)
      .filter(Boolean)
      .map(String),
  );
  if (!shiftIds.size) return null;
  const staffed = {
    ...plant,
    shifts: (plant.shifts ?? []).filter((s) => shiftIds.has(String(s._id))),
    ...(includeNonRunningDays ? { runningSchedule: [], holidays: [] } : {}),
  };
  return workingIntervals(staffed, start, end, zoneOf(ctx));
};

/** Job card fields the move option copies into the remainder card, plus target/progress. */
const enrichBookings = async (ctx, calendar) => {
  const ids = calendar.machines.flatMap((m) =>
    m.bookings.filter((b) => b.kind === 'jobcard').map((b) => b.id),
  );
  if (!ids.length) return;
  const mod = getModule('jobcards');
  const cards = new Map(
    (
      await mod.Model.find({
        _id: { $in: ids.map(asObjectId).filter(Boolean) },
        ...scopeFilter(ctx, mod),
      }).lean()
    ).map((c) => [String(c._id), c]),
  );
  for (const booking of calendar.machines.flatMap((m) => m.bookings)) {
    const card = cards.get(String(booking.id));
    if (booking.kind !== 'jobcard' || !card) continue;
    booking.target ??= card.target;
    booking.partsOut ??= card.operations?.[0]?.progress?.partsOut ?? 0;
    booking.toolId ??= card.tool ? String(card.tool) : undefined;
    booking.template ??= defined({
      jobName: card.jobName,
      partName: card.partName,
      productionPlanId: card.productionPlanId ? String(card.productionPlanId) : null,
      idealCycleTime: card.idealCycleTime,
      rejectionPercentage: card.rejectionPercentage,
      mouldParts: card.mouldParts?.map(({ _id, ...part }) => part),
      operationName: card.operations?.[0]?.operationName,
    });
  }
};

/**
 * Loads tasks, staff and the calendar, plans, and stores one draft proposal.
 * @returns {Promise<{ proposal, calendar, planned }>}
 */
export const planMaintenanceProposal = async (ctx, input = {}, { now = new Date() } = {}) => {
  const horizonDays = input.horizonDays ?? 7;
  const tasks = await maintenanceTasks(ctx, input, now);
  if (!tasks.length) {
    throw badRequest(`Nothing to plan: everything due in the next ${horizonDays} days is already scheduled`);
  }
  const plant = plantOf(ctx, tasks[0].plantId ?? input.plantId);
  const plantTasks = tasks.filter((t) => String(t.plantId) === String(plant?._id));
  const taskAssets = [...new Set(plantTasks.map((t) => t.assetId))];
  const toolMod = getModule('tools');
  const tools = await toolMod.Model.find({
    ...scopeFilter(ctx, toolMod),
    assets: { $in: taskAssets.map(asObjectId) },
  })
    .select('assets')
    .lean();
  const assetIds = [...new Set([...taskAssets, ...tools.flatMap((t) => t.assets.map(String))])];
  const lastDeadline = Math.max(...plantTasks.map((t) => ms(t.deadline)));
  const end = new Date(Math.max(lastDeadline + 7 * DAY, ms(now) + horizonDays * DAY));
  const includeNonRunningDays = Boolean(input.allowNonRunningDays);
  const calendar = await buildCalendar(ctx, {
    plantId: plant?._id,
    assetIds,
    start: now,
    end,
    includeNonRunningDays,
    now,
  });
  await enrichBookings(ctx, calendar);
  const staff = plant ? await staffWindows(ctx, plant, now, end, { includeNonRunningDays }) : null;
  const opts = { now, staff: staff ?? undefined };
  const planned = planMaintenance(calendar, plantTasks, opts);
  const picksOf = (plan) =>
    plan.tasks
      .map((t) => ({ ...t, pick: t.options.find((o) => o.id === t.recommended) }))
      .filter((t) => t.pick);

  const picked = picksOf(planned);
  if (!picked.length) {
    throw badRequest(`No maintenance window found in the next ${Math.round((ms(end) - ms(now)) / DAY)} days`);
  }
  const first = picked[0];
  // Apply replays the chosen option's ops, so each option of the first task re-plans the other tasks around it
  // (otherwise picking a non-recommended option books them over pushed job cards).
  // ponytail: per-task choice for the other tasks when users ask for it
  const combos = first.options.map((option) => {
    const run =
      option.id === first.recommended
        ? picked
        : picksOf(
            planMaintenance(calendar, plantTasks, {
              ...opts,
              choose: (task, options) =>
                task === first.task ? options.find((o) => o.id === option.id) : recommend(task, options),
            }),
          );
    const all = run.map((t) => t.pick);
    const { moves: _m, added: _a, ...own } = option;
    const sum = (key) => hoursOf(all.reduce((total, o) => total + o[key], 0) * HOUR);
    return {
      run,
      option: {
        ...own,
        lateHours: sum('lateHours'),
        delayHours: sum('delayHours'),
        delays: all.flatMap((o) => o.delays),
        ops: all.flatMap((o) => o.ops).map(({ seq: _, ...op }, seq) => ({ seq, ...op })),
        diff: { bars: all.flatMap((o) => o.diff.bars), delays: all.flatMap((o) => o.delays) },
      },
    };
  });
  const best = recommend(
    first.task,
    combos.map((c) => c.option),
  );
  const { run: chosen, option: recommended } = combos.find((c) => c.option === best) ?? combos[0];
  const delays = recommended.delays;
  const { lateHours } = recommended;
  const risks = chosen.flatMap(({ task, pick }) => [
    ...(pick.id === 'defer'
      ? [{ kind: 'deferred', severity: 'warning', text: pick.risk, assetId: task.assetId }]
      : []),
    ...pick.delays
      .filter((d) => d.late)
      .map((d) => ({
        kind: 'late',
        severity: 'critical',
        text: `${d.code ?? 'A job card'} finishes ${d.hours} h later and misses its plan due date`,
        assetId: d.rowId,
      })),
  ]);
  const title =
    chosen.length === 1
      ? first.task.title.includes(first.task.assetName)
        ? first.task.title
        : `${first.task.title} – ${first.task.assetName}`
      : `${chosen.length} maintenance tasks`;

  const proposal = await createProposal(ctx, {
    kind: 'maintenance',
    title,
    input: defined({ ...input, horizonDays }),
    horizon: { start: now, end: new Date(ms(now) + horizonDays * DAY) },
    plantId: plant?._id ?? null,
    anomalyId: first.task.kind === 'anomaly' ? first.task.refId : (input.anomalyId ?? null),
    assetIds: taskAssets,
    ops: recommended.ops,
    diff: recommended.diff,
    options: combos.map((c) => c.option),
    recommendedOption: recommended.id,
    feasibility: {
      feasible: lateHours === 0,
      dueDate: first.task.deadline,
      projectedFinish: new Date(Math.max(...chosen.map((t) => ms(t.pick.end)))),
      slackHours: hoursOf(ms(first.task.deadline) - ms(recommended.end)),
      shortfall: 0,
      maxDelayHours: delays.length ? Math.max(...delays.map((d) => d.hours)) : 0,
      notes: chosen
        .map(({ task, pick }) => `${task.code ?? task.title}: ${pick.label}`)
        .join('; ')
        .slice(0, 1000),
    },
    risks,
    alternatives: [],
  });
  return { proposal, calendar, planned };
};

/** Contract entry point (also what Apply re-runs on PLAN_CHANGED): the stored draft proposal. */
export const proposeMaintenance = async (ctx, input, opts) =>
  (await planMaintenanceProposal(ctx, input, opts)).proposal;
