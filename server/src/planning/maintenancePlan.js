import { DateTime } from 'luxon';
import { z } from 'zod';
import { toJsonSchema } from '../agent/declarations.js';
import { asObjectId, fmtDate, plantOf, zoneOf } from '../agent/tools/common.js';
import { AiUnavailableError, generate } from '../ai/gemini.js';
import { badRequest } from '../lib/errors.js';
import { scopeFilter } from '../modules/records.js';
import { getModule } from '../modules/registry.js';
import { assertPlanDates, buildCalendar } from './capacity.js';
import {
  advanceWorking,
  intersectIntervals,
  mergeIntervals,
  subtractIntervals,
  totalSeconds,
} from './intervals.js';
import { maintenanceTasks, planMaintenance } from './maintenance.js';
import { bookPerson, loadPeople, pickPerson, skillsForTask } from './people.js';
import { createProposal } from './proposals.js';

/**
 * Maintenance plan engine (phase 7 §3.4): every PM, calibration, anomaly and unscheduled work order of a plant
 * (or chosen assets) over a horizon, each placed by the phase-5 per-task planner with an objective that trades
 * production impact (downtime cost) against urgency, plus a technician on shift. The AI only summarises.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MAX_TASKS = 20;
const ms = (d) => new Date(d).getTime();
const hoursOf = (msValue) => Math.round((msValue / HOUR) * 100) / 100;
const defined = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => v != null));
const byDeadline = (x, y) => ms(x.deadline) - ms(y.deadline);
const Proposal = () => getModule('planproposals').Model;

export const OBJECTIVE_WEIGHT = { protect_production: 0, balanced: 0.5, fix_fast: 1 };
export const URGENCY = { High: 1, Medium: 0.25, Low: 0.1 };
export const VERDICT_WORD = { doable: 'Doable', adjust: 'Needs adjustment', not_doable: 'Not doable' };

/** `costPerHour` is a number or `(assetId) => number`. */
const costFn = (cost) => (typeof cost === 'function' ? cost : () => Number(cost) || 0);

/** Pure: job-card hours the interval overlaps on the machine × the machine's downtime cost. */
export const impactOf = (machine, interval, costPerHour) => {
  const cards = machine.bookings.filter((b) => b.kind === 'jobcard');
  const hours = hoursOf(totalSeconds(intersectIntervals(cards, [interval])) * 1000);
  return { hours, cost: Math.round(hours * costFn(costPerHour)(machine.assetId)) };
};

/**
 * Pure: (1 − weight) × impact cost + weight × urgency cost. Impact = each pushed card's hours at its machine's
 * rate (the task's machine when a delay names none) + 2 × hours past a plan due date; urgency = waiting hours
 * × rate × URGENCY[priority].
 */
export const scoreOption = (option, task, { weight = 0, costPerHour = 0, now }) => {
  const cost = costFn(costPerHour);
  const own = cost(task.assetId);
  const delays = option.delays ?? [];
  const delayCost = delays.length
    ? delays.reduce((sum, d) => sum + Math.max(0, d.hours) * cost(d.rowId ?? task.assetId), 0)
    : (option.delayHours ?? 0) * own;
  const impactCost = delayCost + 2 * (option.lateHours ?? 0) * own;
  const urgencyCost =
    Math.max(0, hoursOf(ms(option.start) - ms(now))) * own * (URGENCY[task.priority] ?? URGENCY.Medium);
  return (1 - weight) * impactCost + weight * urgencyCost;
};

const phase5Order = (a, b) =>
  a.lateHours - b.lateHours || a.delayHours - b.delayHours || a.maintenanceLateHours - b.maintenanceLateHours;

/** Pure: the lowest-scoring option; defer only when no push exists or every push breaks a due date (never critical). */
export const chooseOption = (task, options, scoring) => {
  const pushes = options.filter((o) => o.id !== 'defer');
  const allowDefer = !pushes.length || (task.severity !== 'critical' && pushes.every((o) => o.lateHours > 0));
  return (
    options
      .filter((o) => o.id !== 'defer' || allowDefer)
      .map((o) => ({ o, s: scoreOption(o, task, scoring) }))
      .sort((a, b) => a.s - b.s || phase5Order(a.o, b.o))[0]?.o ?? null
  );
};

/** Pure: every task as soon as possible (sequential per machine, job cards ignored) and what that would cost. */
export const naiveSchedule = (calendar, tasks, { now, staff, costPerHour = 0 } = {}) => {
  const cursor = new Map();
  let hours = 0;
  let cost = 0;
  for (const task of tasks) {
    const machine = calendar.machines.find((m) => String(m.assetId) === String(task.assetId));
    if (!machine) continue;
    const from = cursor.get(machine.assetId) ?? new Date(now);
    const run = advanceWorking(staff ?? machine.working, from, Math.max(1, task.durationMin) * 60);
    if (!run) continue;
    const impact = impactOf(machine, { start: run.segments[0]?.start ?? from, end: run.end }, costPerHour);
    hours += impact.hours;
    cost += impact.cost;
    cursor.set(machine.assetId, run.end);
  }
  return { productionHoursLost: hoursOf(hours * HOUR), productionImpactCost: Math.round(cost) };
};

/** Phase-5 tasks for the scope (an anomaly's task first), ≤ 20 by deadline. */
export const maintenancePlanTasks = async (ctx, input, now = new Date()) => {
  const { scope = 'plant', assetIds = [], horizonDays = 7, anomalyId } = input;
  if (scope === 'assets' && !assetIds.length) throw badRequest('Pick at least one asset to plan');
  const first = anomalyId ? await maintenanceTasks(ctx, { anomalyId }, now) : [];
  // The anomaly's plant wins over the viewer's default plant.
  const plantId = input.plantId ?? first[0]?.plantId;
  const rest = await Promise.all(
    scope === 'assets'
      ? assetIds.map((assetId) => maintenanceTasks(ctx, { assetId, horizonDays }, now))
      : [maintenanceTasks(ctx, { plantId, horizonDays }, now)],
  );
  const seen = new Set();
  const fresh = (t) => !seen.has(`${t.kind}:${t.refId}`) && seen.add(`${t.kind}:${t.refId}`);
  return [...first.filter(fresh), ...rest.flat().sort(byDeadline).filter(fresh)].slice(0, MAX_TASKS);
};

/** Calendar, Maintenance people, their merged shift time and the downtime cost per asset. */
export const loadContext = async (
  ctx,
  { plantId, assetIds, start, end, includeNonRunningDays, now, excludeBookings },
) => {
  const assetMod = getModule('assets');
  const [assets, settings] = await Promise.all([
    assetMod.Model.find({
      _id: { $in: assetIds.map(asObjectId).filter(Boolean) },
      ...scopeFilter(ctx, assetMod),
    })
      .select('name typeOfAsset downtimeCostPerHour plantId')
      .lean(),
    getModule('costsettings')
      .Model.findOne({ companyId: ctx.companyId })
      .select('defaultDowntimeCostPerHour')
      .lean(),
  ]);
  const assetById = new Map(assets.map((a) => [String(a._id), a]));
  const defaultCost = settings?.defaultDowntimeCostPerHour ?? 2500;
  const costOf = (assetId) => assetById.get(String(assetId))?.downtimeCostPerHour ?? defaultCost;
  const [calendar, people] = await Promise.all([
    buildCalendar(ctx, { plantId, assetIds: [...assetById.keys()], start, end, includeNonRunningDays, now }),
    loadPeople(ctx, {
      department: 'Maintenance',
      plantId,
      window: { start, end },
      includeNonRunningDays,
      excludeBookings,
    }),
  ]);
  // Staffed time = when the technicians' shifts run, breaks out (a person stays on shift through a break).
  const staff = people.length ? mergeIntervals(people.flatMap((p) => p.working ?? p.onShift)) : undefined;
  return { calendar, people, staff, costOf, assetById, currency: ctx.company?.currency?.symbol ?? '₹' };
};

/** Pure: doable ⇔ no issues; not_doable ⇔ a critical issue no adjustment resolves; else adjust. */
export const verdictOf = (issues, adjustments) =>
  !issues.length
    ? 'doable'
    : issues.some((it, i) => it.severity === 'critical' && !adjustments.some((a) => a.resolves.includes(i)))
      ? 'not_doable'
      : 'adjust';

const maintenanceBar = (t, { conflict = false } = {}) =>
  defined({
    id: `mnt-${t.refId}`,
    rowId: String(t.assetId),
    start: t.start,
    end: t.end,
    label: t.title,
    kind: 'maintenance',
    ghost: true,
    change: 'new',
    late: t.late ? true : null,
    conflict: conflict ? true : null,
    tooltip: `${t.durationMin} min · ${t.code ?? t.kind}${t.technician ? ` · ${t.technician.name}` : ''}`,
  });

/** Ghost bars of pushed job cards (phase-5 shape). */
export const moveBars = (moves, rowId, delays) =>
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
      change: Math.abs(ms(m.to.start) - ms(m.from.start)) < 60_000 ? 'extended' : 'moved',
      from: m.from,
      href: `/m/jobcards/${m.jobCardId}`,
      late: delays.find((d) => d.jobCardId === m.jobCardId)?.late ? true : null,
    }),
  );

/** One bar per id, the last one winning (a card pushed by two tasks ends where the last push leaves it). */
export const uniqueBars = (bars) => [...new Map(bars.map((b) => [`${b.kind}:${b.id}`, b])).values()];

/** Job-card reschedule ops (phase-5 shape). */
export const moveOps = (moves) =>
  moves.map((m) => ({
    op: 'update',
    module: 'jobcards',
    id: m.jobCardId,
    label: `Reschedule ${m.code ?? 'job card'}`,
    data: { startDate: m.to.start, endDate: m.to.end },
    before: { startDate: m.from.start, endDate: m.from.end },
  }));

/** The work-order op of a task with the plan link, technician and window merged in. */
export const withWindow = (op, t) =>
  op.module === 'workorders'
    ? {
        ...op,
        data: {
          ...op.data,
          maintenancePlanId: '$op:0',
          people: t.technician ? [t.technician.userId] : [],
          plannedStart: t.start,
          plannedEnd: t.end,
          estimatedDurationMin: t.durationMin,
        },
      }
    : op;

/** Risks from the placed tasks and issues (phase-5 late/deferred + technician_missing as other). */
export const risksOf = (tasks, issues) => [
  ...tasks.flatMap((t) => [
    ...(t.optionId === 'defer'
      ? [
          {
            kind: 'deferred',
            severity: 'warning',
            text: `${t.title} runs after its deadline (${fmtHours(ms(t.end) - ms(t.deadline))} late)`,
            assetId: t.assetId,
          },
        ]
      : []),
    ...(t.delays ?? [])
      .filter((d) => d.late)
      .map((d) => ({
        kind: 'late',
        severity: 'critical',
        text: `${d.code ?? 'A job card'} finishes ${d.hours} h later and misses its plan due date`,
        assetId: d.rowId,
      })),
  ]),
  ...issues
    .filter((i) => i.kind === 'technician_missing')
    .map((i) => ({ kind: 'other', severity: 'warning', text: i.text, assetId: i.assetId })),
];

const fmtHours = (msValue) => `${hoursOf(Math.max(0, msValue))} h`;

/** Metrics of the placed tasks against the naive (ASAP) numbers. */
export const metricsOf = (tasks, naive, currency) => {
  const productionHoursLost = hoursOf(tasks.reduce((s, t) => s + t.impactHours, 0) * HOUR);
  const productionImpactCost = Math.round(tasks.reduce((s, t) => s + t.impactCost, 0));
  return {
    tasks: tasks.length,
    zeroImpactTasks: tasks.filter((t) => t.zeroImpact).length,
    productionHoursLost,
    naiveProductionHoursLost: naive.productionHoursLost,
    productionImpactCost,
    naiveProductionImpactCost: naive.productionImpactCost,
    downtimeCostAvoided: Math.max(0, naive.productionImpactCost - productionImpactCost),
    currency,
  };
};

/** Feasibility block of a plan (verdict rule shared with production). */
export const feasibilityOf = (tasks, issues, adjustments, metrics) => {
  const verdict = verdictOf(issues, adjustments);
  const delays = tasks.flatMap((t) => t.delays ?? []);
  const notes = [
    `${metrics.tasks} task${metrics.tasks === 1 ? '' : 's'}, ${metrics.zeroImpactTasks} in free windows`,
    metrics.productionHoursLost
      ? `${metrics.productionHoursLost} h of production moved`
      : 'no production moved',
    issues.length ? `${issues.length} issue${issues.length === 1 ? '' : 's'}` : null,
  ]
    .filter(Boolean)
    .join('; ');
  return {
    feasible: verdict !== 'not_doable',
    verdict,
    dueDate: tasks.length ? new Date(Math.min(...tasks.map((t) => ms(t.deadline)))) : null,
    projectedFinish: tasks.length ? new Date(Math.max(...tasks.map((t) => ms(t.end)))) : null,
    slackHours: tasks.length ? hoursOf(Math.min(...tasks.map((t) => ms(t.deadline) - ms(t.end)))) : 0,
    shortfall: 0,
    maxDelayHours: delays.length ? Math.max(...delays.map((d) => d.hours)) : 0,
    notes: notes.slice(0, 1000),
  };
};

/**
 * The next window ≥ `from` where the machine is free of every booking and plan block, inside staffed time, with a
 * free person who has the skills. Candidate starts: each gap start, each person's booking end and shift start inside the gap.
 */
export const laterWindow = ({ machine, blocks, staff, people, skills, from, to, seconds }) => {
  const staffed = intersectIntervals(machine.working, staff ?? machine.working);
  const held = [...machine.bookings, ...blocks];
  for (const gap of subtractIntervals([{ start: from, end: to }], held)) {
    const avail = intersectIntervals([gap], staffed);
    const starts = [
      ...new Set(
        [
          gap.start,
          ...people.flatMap((p) => [
            ...p.bookings.map((b) => b.end),
            ...(p.working ?? p.onShift ?? []).map((w) => w.start),
          ]),
        ]
          .map(ms)
          .filter((t) => t >= ms(gap.start) && t < ms(gap.end)),
      ),
    ].sort((a, b) => a - b);
    for (const t of starts.slice(0, 50)) {
      const run = advanceWorking(avail, new Date(t), seconds);
      if (!run) break;
      const block = { start: run.segments[0]?.start ?? new Date(t), end: run.end };
      const person = pickPerson(people, block, { skills });
      if (person) return { ...block, person };
    }
  }
  return null;
};

const defaultName = (ctx, plant, assetsById, scope, start, end) => {
  const names = [...assetsById.values()].map((a) => a.name);
  if (scope === 'assets' && names.length)
    return `Maintenance plan – ${names.slice(0, 3).join(', ')}${names.length > 3 ? ` +${names.length - 3}` : ''}`;
  const d = (x) => DateTime.fromJSDate(new Date(x), { zone: zoneOf(ctx) }).toFormat('dd-MM');
  return `Maintenance plan – ${plant?.name ?? 'plant'} ${d(start)}–${d(end)}`;
};

/**
 * Plans the scope: tasks → per-task options (phase 5) chosen by the objective → technicians → ops, diff, metrics.
 * @param {{ scope?: 'plant'|'assets', assetIds?: string[], plantId?, start?: Date, horizonDays?: number,
 *   objective?: string, allowNonRunningDays?: boolean, anomalyId?, name? }} input
 */
export const buildMaintenancePlan = async (ctx, input = {}, { now = new Date() } = {}) => {
  const scope = input.scope ?? 'plant';
  const objective = OBJECTIVE_WEIGHT[input.objective] != null ? input.objective : 'protect_production';
  const horizonDays = input.horizonDays ?? 7;
  // A past start (a chat "today", a replan of a stored input) means now: nothing is booked in the past.
  const start = new Date(Math.max(ms(input.start ?? now), ms(now)));
  assertPlanDates(now, [start]);
  const tasks = await maintenancePlanTasks(ctx, { ...input, scope, horizonDays }, start);
  if (!tasks.length)
    throw badRequest(`Nothing to plan: everything due in the next ${horizonDays} days is already scheduled`);
  const plant = plantOf(ctx, tasks[0].plantId ?? input.plantId);
  const plantTasks = plant ? tasks.filter((t) => String(t.plantId) === String(plant._id)) : tasks;
  const horizonEnd = new Date(ms(start) + horizonDays * DAY);
  const end = new Date(Math.max(...plantTasks.map((t) => ms(t.deadline) + 7 * DAY), ms(horizonEnd)));
  const includeNonRunningDays = Boolean(input.allowNonRunningDays);
  const { calendar, people, staff, costOf, assetById, currency } = await loadContext(ctx, {
    plantId: plant?._id ?? null,
    assetIds: [...new Set(plantTasks.map((t) => String(t.assetId)))],
    start,
    end,
    includeNonRunningDays,
    now,
  });
  const scoring = { weight: OBJECTIVE_WEIGHT[objective], costPerHour: costOf, now: start };
  const planned = planMaintenance(calendar, plantTasks, {
    now: start,
    staff,
    choose: (task, options) => chooseOption(task, options, scoring),
    // Balanced / Fix fast weigh waiting for a free window against pushing production now.
    allOptions: scoring.weight > 0,
  });
  const machines = new Map(calendar.machines.map((m) => [String(m.assetId), m]));
  const blocks = new Map();
  const issues = [];
  const adjustments = [];
  const placed = [];
  const fast = objective === 'fix_fast';
  const bookTask = (x, person) => {
    x.person = person;
    bookPerson(person, { kind: 'workorder', id: x.key, code: x.task.code ?? x.key, ...x.block });
  };
  const othersOn = (x) => (blocks.get(String(x.task.assetId)) ?? []).filter((b) => b !== x.block);

  // Pass 1: blocks, and technicians who have the task's trade. A free window nobody (or only another trade) can
  // take waits, before the deadline and still free of production, for someone with the trade, else (nobody at all)
  // for anyone (fix_fast: the first free person).
  planned.tasks.forEach(({ task, options, recommended }, i) => {
    const asset = assetById.get(String(task.assetId));
    const machine = machines.get(String(task.assetId));
    const pick = options.find((o) => o.id === recommended);
    if (!pick || !machine) {
      issues.push({
        kind: 'no_window',
        severity: 'warning',
        text: `${task.title} on ${asset?.name ?? task.assetName} has no window before ${fmtDate(ctx, end)}; it is left out`,
        assetId: String(task.assetId),
      });
      return;
    }
    let block = { start: new Date(pick.start), end: new Date(pick.end) };
    const skills = skillsForTask({ category: task.category, assetType: asset?.typeOfAsset });
    let person = pickPerson(people, block, { skills });
    if (pick.id === 'zero_impact' && (!person || (skills.length && !person.skillMatch && !fast))) {
      const skilled = people.filter((p) => p.skills.some((s) => skills.includes(s)));
      const rosters = [
        ...(skilled.length && !(fast && !person) ? [skilled] : []),
        ...(person ? [] : [people]),
      ];
      const held = [
        // Earlier tasks' final blocks and the later tasks' windows on this machine stay untouched.
        ...(blocks.get(String(task.assetId)) ?? []),
        ...planned.tasks
          .slice(i + 1)
          .filter((x) => String(x.task.assetId) === String(task.assetId))
          .map((x) => x.options.find((o) => o.id === x.recommended))
          .filter(Boolean)
          .map((o) => ({ start: new Date(o.start), end: new Date(o.end) })),
      ];
      for (const roster of rosters) {
        const alt = laterWindow({
          machine,
          blocks: held,
          staff,
          people: roster,
          skills,
          from: block.start,
          to: new Date(task.deadline),
          seconds: Math.max(1, task.durationMin) * 60,
        });
        if (alt) {
          block = { start: alt.start, end: alt.end };
          person = alt.person;
          break;
        }
      }
    }
    const x = { key: `t-${i + 1}`, task, asset, machine, pick, skills, block, person: null, issues: [] };
    // An off-trade person waits for pass 2, so they never take the slot of someone a later task's trade needs.
    if (person && (!skills.length || person.skillMatch || fast)) bookTask(x, person);
    blocks.set(String(task.assetId), [...(blocks.get(String(task.assetId)) ?? []), block]);
    placed.push(x);
  });

  // Pass 2: everyone left gets whoever is free; a free task nobody can take moves to the soonest staffed free slot
  // before its deadline; only then a technician_missing issue, whose suggested slot is booked so that no two
  // suggestions name the same person at the same time.
  for (const x of placed.filter((p) => !p.person)) {
    const { task, machine, skills } = x;
    const free = pickPerson(people, x.block, { skills });
    if (free) {
      bookTask(x, free);
      continue;
    }
    const seconds = Math.max(1, task.durationMin) * 60;
    const search = { blocks: othersOn(x), staff, people, skills, seconds };
    const deadline = new Date(task.deadline);
    if (x.pick.id === 'zero_impact') {
      const alt = laterWindow({ ...search, machine, from: x.block.start, to: deadline });
      if (alt) {
        const list = blocks.get(String(task.assetId));
        const moved = { start: alt.start, end: alt.end };
        list[list.indexOf(x.block)] = moved;
        x.block = moved;
        bookTask(x, alt.person);
        continue;
      }
    }
    const idx =
      issues.push({
        kind: 'technician_missing',
        severity: 'warning',
        text: `No Maintenance technician is free for ${task.title} on ${x.asset?.name ?? task.assetName} at ${fmtDate(ctx, x.block.start, { time: true })}`,
        task: x.key,
        assetId: String(task.assetId),
      }) - 1;
    x.issues.push(idx);
    // A task that pushes production anyway first takes the soonest staffed slot before its deadline (the check
    // re-times the pushed job cards); otherwise, or failing that, the next free window of the machine.
    const alt =
      (x.pick.id !== 'zero_impact' &&
        laterWindow({
          ...search,
          machine: { ...machine, bookings: machine.bookings.filter((b) => b.kind !== 'jobcard') },
          from: x.block.start,
          to: deadline,
        })) ||
      laterWindow({ ...search, machine, from: x.block.end, to: end });
    if (alt) {
      bookPerson(alt.person, { kind: 'workorder', id: `${x.key}-alt`, code: task.code ?? x.key, ...alt });
      blocks.get(String(task.assetId)).push({ start: alt.start, end: alt.end });
      adjustments.push({
        id: `adj-${adjustments.length + 1}`,
        kind: 'move_start',
        label: `Move ${task.title} to ${fmtDate(ctx, alt.start, { time: true })}, when ${alt.person.name} is free`,
        patch: { tasks: [{ key: x.key, start: alt.start, end: alt.end, technicianId: alt.person.userId }] },
        resolves: [idx],
      });
    }
  }

  const bars = [];
  const taskOps = [];
  const out = placed.map(({ key, task, asset, machine, pick, block, person, issues: own }) => {
    const impact = impactOf(machine, block, costOf);
    const t = {
      key,
      kind: task.kind,
      refId: task.refId,
      code: task.code ?? null,
      workOrderId: task.workOrderId ?? null,
      assetId: String(task.assetId),
      asset: asset?.name ?? task.assetName,
      assetType: asset?.typeOfAsset ?? null,
      title: task.title,
      category: task.category,
      priority: task.priority,
      durationMin: task.durationMin,
      deadline: new Date(task.deadline),
      ...block,
      optionId: pick.id,
      impactHours: impact.hours,
      impactCost: impact.cost,
      zeroImpact: impact.hours === 0,
      late: ms(block.start) > ms(task.deadline),
      technician: person ? { userId: person.userId, name: person.name, shiftName: person.shiftName } : null,
      delays: pick.delays ?? [],
      issues: own,
      // The task's own ops (work order, PM/calibration cycle); job-card moves are recomputed by the check.
      ops: pick.ops.filter((op) => op.module !== 'jobcards').map(({ seq: _seq, ...op }) => op),
    };
    bars.push(maintenanceBar(t), ...pick.diff.bars.filter((b) => b.kind !== 'maintenance'));
    taskOps.push(
      ...t.ops.map((op) => withWindow(op, t)),
      ...pick.ops.filter((op) => op.module === 'jobcards').map(({ seq: _seq, ...op }) => op),
    );
    return t;
  });
  if (!out.length)
    throw badRequest(
      `No maintenance window found in the next ${Math.round((ms(end) - ms(start)) / DAY)} days`,
    );

  const naive = naiveSchedule(calendar, plantTasks, { now: start, staff, costPerHour: costOf });
  const metrics = metricsOf(out, naive, currency);
  const feasibility = feasibilityOf(out, issues, adjustments, metrics);
  const horizon = { start, end: new Date(Math.max(ms(horizonEnd), ...out.map((t) => ms(t.end)))) };
  const assetIds = [...new Set(out.map((t) => t.assetId))];
  const name = input.name?.trim() || defaultName(ctx, plant, assetById, scope, start, horizonEnd);
  const ops = [
    {
      op: 'create',
      module: 'maintenanceplans',
      label: `Maintenance plan "${name}"`,
      data: defined({
        name,
        scope,
        assetIds,
        horizon,
        objective,
        status: 'planned',
        plantId: plant?._id ? String(plant._id) : null,
      }),
    },
    ...taskOps,
  ].map((op, seq) => ({ seq, ...op }));
  return {
    name,
    scope,
    assetIds,
    horizon,
    objective,
    plantId: plant?._id ?? null,
    tasks: out,
    metrics,
    verdict: feasibility.verdict,
    feasibility,
    issues,
    adjustments,
    risks: risksOf(out, issues),
    ops,
    diff: { bars: uniqueBars(bars), delays: out.flatMap((t) => t.delays), tasks: out },
    calendar,
  };
};

/** Contract entry point (also what Apply re-runs on PLAN_CHANGED): the stored draft proposal, kind maintenance_plan. */
export const proposeMaintenancePlan = async (ctx, input = {}, opts = {}) => {
  const plan = await buildMaintenancePlan(ctx, input, opts);
  return createProposal(ctx, {
    kind: 'maintenance_plan',
    title: plan.name,
    input: defined({
      ...input,
      scope: plan.scope,
      objective: plan.objective,
      horizonDays: input.horizonDays ?? 7,
      start: input.start ?? undefined,
    }),
    horizon: plan.horizon,
    plantId: plan.plantId,
    anomalyId: input.anomalyId ?? null,
    assetIds: plan.assetIds,
    ops: plan.ops,
    diff: plan.diff,
    options: [],
    recommendedOption: null,
    feasibility: plan.feasibility,
    risks: plan.risks,
    issues: plan.issues,
    adjustments: plan.adjustments,
    metrics: plan.metrics,
    alternatives: [],
  });
};

const SUMMARY_SCHEMA = z.object({
  summary: z.string().max(400),
  bullets: z.array(z.string().max(200)).min(1).max(4),
  watch: z.array(z.string().max(200)).max(3),
});
const SUMMARY_SYSTEM =
  'You summarise a maintenance plan made by the SARA planner for a maintenance manager. Every number (windows, production impact, cost avoided, technicians) is computed by the planner: never change or invent numbers. Start the summary with "Doable:", "Needs adjustment:" or "Not doable:" as the verdict says, then what the plan protects, who does what, and what to watch. Short, plain sentences.';

/** The §4 maintenance_plan_summary call → `{ explanation }` (stored on the proposal by the caller). */
export const explainMaintenancePlan = async (ctx, p) => {
  const tasks = p.diff?.tasks ?? [];
  const input = {
    plan: {
      name: p.title,
      scope: p.input?.scope ?? 'plant',
      assetNames: [...new Set(tasks.map((t) => t.asset).filter(Boolean))].slice(0, 10),
      horizon: p.horizon,
      objective: p.input?.objective ?? 'protect_production',
      currency: { symbol: p.metrics?.currency ?? ctx.company?.currency?.symbol ?? '₹' },
      metrics: p.metrics ?? null,
      tasks: tasks.slice(0, 20).map((t) => ({
        key: t.key,
        title: t.title,
        asset: t.asset,
        kind: t.kind,
        category: t.category,
        start: t.start,
        end: t.end,
        durationMin: t.durationMin,
        technician: t.technician?.name ?? null,
        impactHours: t.impactHours,
        impactCost: t.impactCost,
        zeroImpact: t.zeroImpact,
        late: t.late,
      })),
      verdict: p.feasibility?.verdict ?? 'doable',
      issues: (p.issues ?? []).slice(0, 10).map(({ kind, severity, text }) => ({ kind, severity, text })),
      adjustments: (p.adjustments ?? []).slice(0, 5).map(({ id, kind, label }) => ({ id, kind, label })),
    },
  };
  const answer = await generate({
    tier: 'background',
    purpose: 'planning',
    companyId: ctx.companyId,
    system: SUMMARY_SYSTEM,
    contents: JSON.stringify(input),
    schema: toJsonSchema(SUMMARY_SCHEMA),
    mockInput: { kind: 'maintenance_plan_summary', ...input },
  });
  const parsed = SUMMARY_SCHEMA.safeParse(answer.json);
  if (!parsed.success)
    throw new AiUnavailableError(
      'AI_ERROR',
      'The AI answer did not have the expected shape. Please try again.',
    );
  const { summary, bullets, watch } = parsed.data;
  const text = [summary, ...bullets.map((b) => `• ${b}`), ...watch.map((w) => `Adjust: ${w}`)].join('\n');
  return { explanation: { text, model: answer.model, at: new Date(), mock: Boolean(answer.mock) } };
};

/** Stores the summary on the proposal; when the AI is out, `explanation: null` + `aiError` (never a failed page). */
export const summarise = async (ctx, proposal) => {
  try {
    const patch = await explainMaintenancePlan(ctx, proposal);
    await Proposal().updateOne({ _id: proposal._id }, { $set: patch });
    return { proposal: { ...proposal, ...patch } };
  } catch (err) {
    if (!(err instanceof AiUnavailableError)) throw err;
    return {
      proposal: { ...proposal, explanation: null },
      aiError: { code: err.code, message: err.message },
    };
  }
};

/** The CheckResult of a stored proposal (§3.3 shape) around its plan block. */
export const checkResultOf = (proposal, plan, { aiError, impactDelta = { hours: 0, cost: 0 } } = {}) => ({
  verdict: proposal.feasibility?.verdict ?? 'doable',
  feasibility: proposal.feasibility,
  issues: proposal.issues ?? [],
  adjustments: proposal.adjustments ?? [],
  tasks: proposal.diff?.tasks ?? [],
  metrics: proposal.metrics ?? null,
  impactDelta,
  risks: proposal.risks ?? [],
  plan,
  explanation: proposal.explanation ?? null,
  ...(aiError ? { aiError } : {}),
  proposal,
});
