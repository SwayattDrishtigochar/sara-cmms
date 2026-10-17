import { fmtDate } from '../agent/tools/common.js';
import { badRequest, conflict } from '../lib/errors.js';
import { getModule } from '../modules/registry.js';
import { assertPlanDates } from './capacity.js';
import {
  advanceWorking,
  intersectIntervals,
  mergeIntervals,
  subtractIntervals,
  totalSeconds,
} from './intervals.js';
import { rescheduleForward } from './maintenance.js';
import {
  checkResultOf,
  feasibilityOf,
  impactOf,
  laterWindow,
  loadContext,
  metricsOf,
  moveBars,
  moveOps,
  risksOf,
  summarise,
  uniqueBars,
  withWindow,
} from './maintenancePlan.js';
import { bookPerson, freeFor, pickPerson, skillsForTask } from './people.js';
import { getProposal, toPlanBlock } from './proposals.js';

/**
 * Check of a user-edited maintenance plan (phase 7 §3.5): every block against the machine, the staffed time, the
 * deadline and the technician; each issue with an adjustment when one exists; the proposal is rewritten so that
 * Apply books exactly what the user sees.
 */

const DAY = 86_400_000;
const ms = (d) => new Date(d).getTime();
const round2 = (n) => Math.round(n * 100) / 100;
const money = (symbol, n) => `${symbol}${Math.round(n).toLocaleString('en-IN')}`;
const overlaps = (a, b) => ms(a.start) < ms(b.end) && ms(b.start) < ms(a.end);
const inside = (list, interval) =>
  mergeIntervals(list).some((w) => ms(w.start) <= ms(interval.start) && ms(interval.end) <= ms(w.end));
const defined = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => v != null));

const blockOf = (run, from) =>
  run ? { start: run.segments[0]?.start ?? new Date(from), end: run.end } : null;

/**
 * @param {{ proposalId, name?, objective?, tasks: [{ key, start?, end?, durationMin?, technicianId?: string|null }] }} edited
 * @returns CheckResult & { tasks: PlannedTask[] (with `issues` indexes), metrics, impactDelta: { hours, cost } }
 */
export const checkMaintenancePlan = async (ctx, edited, { now = new Date() } = {}) => {
  const p = await getProposal(ctx, edited.proposalId);
  if (p.kind !== 'maintenance_plan') throw badRequest(`${p.proposalCode} is not a maintenance plan`);
  if (!['draft', 'failed'].includes(p.status))
    throw conflict(`${p.proposalCode} is ${p.status}; make a new plan`);
  // Records of a partly applied plan are stamped by op seq; re-numbered ops would make the resumed apply reuse
  // the wrong ones, so only a clean draft can be edited.
  if (p.status === 'failed' || p.appliedOps)
    throw conflict(`${p.proposalCode} was partly applied; resume it or make a new plan`);
  const byKey = new Map((edited.tasks ?? []).map((t) => [t.key, t]));
  const tasks = (p.diff?.tasks ?? []).map((t) => {
    const e = byKey.get(t.key) ?? {};
    return {
      ...t,
      start: new Date(e.start ?? t.start),
      end: new Date(e.end ?? t.end),
      durationMin: e.durationMin ?? t.durationMin,
      deadline: new Date(t.deadline),
      technicianId: e.technicianId === undefined ? (t.technician?.userId ?? null) : e.technicianId,
    };
  });
  if (!tasks.length) throw badRequest(`${p.proposalCode} has no tasks to check`);
  assertPlanDates(
    now,
    (edited.tasks ?? []).flatMap((e) => [e.start, e.end]),
  );
  const start = new Date(Math.min(ms(now), ms(p.horizon?.start ?? now), ...tasks.map((t) => ms(t.start))));
  const end = new Date(Math.max(ms(p.horizon?.end ?? now), ...tasks.map((t) => ms(t.end) + DAY)));
  const { calendar, people, staff, costOf, assetById, currency } = await loadContext(ctx, {
    plantId: p.plantId ?? null,
    assetIds: (p.assetIds ?? []).map(String),
    start,
    end,
    includeNonRunningDays: Boolean(p.input?.allowNonRunningDays),
    now,
    excludeBookings: tasks
      .filter((t) => t.workOrderId)
      .map((t) => ({ module: 'workorders', id: t.workOrderId })),
  });
  // A work order being re-planned frees its current window.
  const replanned = new Set(tasks.map((t) => t.workOrderId).filter(Boolean));
  for (const m of calendar.machines) m.bookings = m.bookings.filter((b) => !replanned.has(String(b.id)));
  const machines = new Map(calendar.machines.map((m) => [String(m.assetId), m]));

  const issues = [];
  const adjustments = [];
  const placed = new Map();
  // Every task's block per machine: a suggested move steers clear of all the plan's other tasks, later ones too.
  const planBlocks = new Map();
  for (const t of tasks)
    planBlocks.set(t.assetId, [
      ...(planBlocks.get(t.assetId) ?? []),
      { key: t.key, start: t.start, end: t.end },
    ]);
  const when = (d) => fmtDate(ctx, d, { time: true });
  const out = tasks.map((t) => {
    const { technicianId, ...rest } = t;
    const machine = machines.get(t.assetId);
    const block = { start: t.start, end: t.end };
    const seconds = Math.max(1, t.durationMin) * 60;
    const mine = [];
    const issue = (kind, severity, text, extra = {}) =>
      mine[
        mine.push(issues.push({ kind, severity, text, task: t.key, assetId: t.assetId, ...extra }) - 1) - 1
      ];
    const adjust = (kind, label, patch, idx) =>
      adjustments.push({
        id: `adj-${adjustments.length + 1}`,
        kind,
        label,
        patch: { tasks: [{ key: t.key, ...patch }] },
        resolves: [idx],
      });
    const skills = skillsForTask({
      category: t.category,
      assetType: t.assetType ?? assetById.get(t.assetId)?.typeOfAsset,
    });
    const person = technicianId ? people.find((x) => x.userId === String(technicianId)) : null;
    // A moved block keeps its technician when they can take it, else names someone who can.
    const crewFor = (w) => {
      if (person && inside(person.onShift, w) && freeFor(person, w)) return {};
      const alt = pickPerson(people, w, { skills });
      return alt ? { technicianId: alt.userId } : {};
    };
    const moveTo = (kind, idx, w, why) =>
      w &&
      adjust(
        kind,
        `Move ${t.title} to ${when(w.start)}–${when(w.end)}${why ? ` (${why})` : ''}`,
        { ...w, ...crewFor(w) },
        idx,
      );
    if (!machine) {
      issue('asset_overlap', 'critical', `${t.asset} is not on this plant's calendar any more`);
      return {
        ...rest,
        technician: null,
        impactHours: 0,
        impactCost: 0,
        zeroImpact: true,
        late: false,
        delays: [],
        issues: mine,
      };
    }
    // `others` (tasks already checked) decides which task an overlap is reported on; `peers` (all the other
    // tasks) is what a suggested move must avoid.
    const others = placed.get(t.assetId) ?? [];
    const peers = (planBlocks.get(t.assetId) ?? []).filter((b) => b.key !== t.key);
    const staffed = intersectIntervals(machine.working, staff ?? machine.working);
    const workOrders = machine.bookings.filter((b) => b.kind === 'workorder');
    const held = [...workOrders, ...others];
    const avail = subtractIntervals(staffed, [...workOrders, ...peers]);
    const zeroWindow = (from, before) => {
      for (const gap of subtractIntervals(
        [{ start: from, end: calendar.end }],
        [...machine.bookings, ...peers],
      )) {
        const w = blockOf(advanceWorking(intersectIntervals([gap], staffed), gap.start, seconds), gap.start);
        if (w && (!before || ms(w.end) <= ms(before))) return w;
        if (w && before && ms(w.start) > ms(before)) return null;
      }
      return null;
    };
    const impact = impactOf(machine, block, costOf);
    const clash = held.filter((b) => overlaps(b, block));
    if (clash.length) {
      const idx = issue(
        'asset_overlap',
        'critical',
        `${t.title} overlaps ${clash.map((b) => b.code ?? 'another task of this plan').join(', ')} on ${t.asset}`,
      );
      moveTo(
        'move_start',
        idx,
        blockOf(advanceWorking(avail, block.start, seconds), block.start),
        'next free slot',
      );
    }
    const free = impact.hours > 0 ? zeroWindow(now, t.deadline) : null;
    // SARA's own push (no free window before the deadline) is a cost the metrics show, not an issue; a push
    // a free window avoids, or a bigger push than the plan had, is.
    if (impact.hours > 0 && (free || impact.hours > (t.impactHours ?? 0) + 0.01)) {
      const cards = machine.bookings.filter((b) => b.kind === 'jobcard' && overlaps(b, block));
      const idx = issue(
        'jobcard_overlap',
        'warning',
        `${t.title} pushes ${cards.map((c) => c.code).join(', ')} on ${t.asset}: ${impact.hours} h of production (${money(currency, impact.cost)})`,
      );
      moveTo('move_start', idx, free, 'no production impact');
    }
    // The start instant must be staffed time (a block may start seconds before a break and run on after it).
    const outside = !inside(staffed, { start: block.start, end: new Date(ms(block.start) + 1000) });
    if (outside) {
      const idx = issue(
        'outside_working',
        'critical',
        `${t.title} starts outside the staffed working time (${when(block.start)})`,
      );
      moveTo(
        'move_start',
        idx,
        blockOf(advanceWorking(avail, block.start, seconds), block.start),
        'next staffed window',
      );
    } else if (totalSeconds(intersectIntervals(staffed, [block])) < seconds - 60) {
      const idx = issue(
        'too_short',
        'critical',
        `${t.title} needs ${t.durationMin} min of working time; the block holds less`,
      );
      const run = advanceWorking(staffed, block.start, seconds);
      if (run) adjust('move_end', `End ${t.title} at ${when(run.end)}`, { end: run.end }, idx);
    }
    const late = ms(block.start) > ms(t.deadline);
    if (late) {
      const critical = t.kind === 'anomaly' && t.priority === 'High';
      const idx = issue(
        'past_deadline',
        critical ? 'critical' : 'warning',
        `${t.title} starts after its deadline (${when(t.deadline)})`,
      );
      moveTo('move_start', idx, zeroWindow(now, t.deadline), 'before the deadline');
    }

    const swap = (idx) => {
      const alt = pickPerson(people, block, { skills, exclude: new Set(person ? [person.userId] : []) });
      if (!alt) {
        // Nobody can take the block: the soonest staffed slot before the deadline where someone can (a block
        // that pushes production anyway may keep pushing; a free one stays clear of job cards). A move already
        // suggested for this block carries a technician of its own.
        const moved = adjustments.some((x) => x.kind === 'move_start' && x.patch.tasks[0].key === t.key);
        const slot =
          !moved &&
          laterWindow({
            machine: impact.hours > 0 ? { ...machine, bookings: workOrders } : machine,
            blocks: peers,
            staff,
            people,
            skills,
            from: block.start,
            to: t.deadline,
            seconds,
          });
        if (slot)
          adjust(
            'move_start',
            `Move ${t.title} to ${when(slot.start)}, when ${slot.person.name} is free`,
            { start: slot.start, end: slot.end, technicianId: slot.person.userId },
            idx,
          );
        return;
      }
      if (alt)
        adjust(
          person ? 'swap_technician' : 'assign_technician',
          `${person ? 'Swap to' : 'Assign'} ${alt.name} (${alt.shiftName ?? 'on shift'}${alt.skillMatch ? ', has the skills' : ''})`,
          { technicianId: alt.userId },
          idx,
        );
    };
    let technician = null;
    if (!person) {
      swap(
        issue(
          'technician_missing',
          'warning',
          technicianId
            ? `${t.title}: the chosen person is not a Maintenance technician of this plant`
            : `${t.title} has no technician yet`,
        ),
      );
    } else if (!inside(person.onShift, block)) {
      swap(
        issue('technician_off_shift', 'warning', `${person.name} is not on shift at ${when(block.start)}`, {
          userId: person.userId,
        }),
      );
    } else if (!freeFor(person, block)) {
      const busy = person.bookings.find((b) => overlaps(b, block));
      swap(
        issue(
          'technician_busy',
          'warning',
          `${person.name} is busy with ${busy?.code ?? 'another job'} then`,
          { userId: person.userId },
        ),
      );
    } else {
      technician = { userId: person.userId, name: person.name, shiftName: person.shiftName };
      bookPerson(person, { kind: 'workorder', id: t.key, code: t.code ?? t.key, ...block });
      if (skills.length && !person.skills.some((s) => skills.includes(s))) {
        const skilled = pickPerson(people, block, { skills, exclude: new Set([person.userId]) });
        if (skilled?.skillMatch) {
          const idx = issue(
            'skills_mismatch',
            'warning',
            `${person.name} has none of the skills ${skills.join(', ')}; ${skilled.name} does and is free`,
            { userId: person.userId },
          );
          adjust(
            'swap_technician',
            `Swap to ${skilled.name} (${skilled.shiftName ?? 'on shift'}, has the skills)`,
            { technicianId: skilled.userId },
            idx,
          );
        }
      }
    }

    const pushed =
      impact.hours > 0
        ? rescheduleForward(
            {
              ...machine,
              bookings: [
                ...machine.bookings,
                ...others.map((b, i) => ({ kind: 'workorder', id: `${t.key}-prev-${i}`, ...b })),
              ],
            },
            block,
            { now },
          )
        : { moves: [], delays: [] };
    for (const move of pushed.moves) {
      const booking = machine.bookings.find((b) => b.id === move.jobCardId);
      if (booking) Object.assign(booking, move.to);
    }
    placed.set(t.assetId, [...others, block]);
    return {
      ...rest,
      technician,
      impactHours: impact.hours,
      impactCost: impact.cost,
      zeroImpact: impact.hours === 0,
      late,
      delays: pushed.delays,
      moves: pushed.moves,
      issues: mine,
    };
  });

  const naive = {
    productionHoursLost: p.metrics?.naiveProductionHoursLost ?? 0,
    productionImpactCost: p.metrics?.naiveProductionImpactCost ?? 0,
  };
  const metrics = metricsOf(out, naive, currency);
  const feasibility = feasibilityOf(out, issues, adjustments, metrics);
  const impactDelta = {
    hours: round2(metrics.productionHoursLost - (p.metrics?.productionHoursLost ?? 0)),
    cost: Math.round(metrics.productionImpactCost - (p.metrics?.productionImpactCost ?? 0)),
  };
  const critical = new Set(issues.filter((i) => i.severity === 'critical').map((i) => i.task));
  const bars = out.flatMap((t) => [
    defined({
      id: `mnt-${t.refId}`,
      rowId: t.assetId,
      start: t.start,
      end: t.end,
      label: t.title,
      kind: 'maintenance',
      ghost: true,
      change: 'new',
      late: t.late ? true : null,
      conflict: critical.has(t.key) ? true : null,
      tooltip: `${t.durationMin} min · ${t.code ?? t.kind}${t.technician ? ` · ${t.technician.name}` : ''}`,
    }),
    ...moveBars(t.moves, t.assetId, t.delays),
  ]);
  const name = edited.name?.trim() || p.title;
  const objective = edited.objective ?? p.input?.objective ?? 'protect_production';
  const [planOp] = p.ops ?? [];
  const diffTasks = out.map(({ moves: _m, ...t }) => t);
  const ops = [
    { ...planOp, data: { ...planOp.data, name, objective } },
    ...out.flatMap((t) => [...(t.ops ?? []).map((op) => withWindow(op, t)), ...moveOps(t.moves)]),
  ].map(({ seq: _seq, ...op }, seq) => ({ seq, ...op }));
  const patch = {
    title: name,
    ops,
    diff: { bars: uniqueBars(bars), delays: out.flatMap((t) => t.delays), tasks: diffTasks },
    feasibility,
    risks: risksOf(diffTasks, issues),
    issues,
    adjustments,
    metrics,
    horizon: {
      start: p.horizon?.start ?? start,
      end: new Date(Math.max(ms(p.horizon?.end ?? end), ...out.map((t) => ms(t.end)))),
    },
    'input.edited': edited,
    'input.objective': objective,
  };
  await getModule('planproposals').Model.updateOne({ _id: p._id }, { $set: patch });
  const { 'input.edited': _e, 'input.objective': _o, ...fields } = patch;
  const stored = { ...p, ...fields, input: { ...p.input, edited, objective } };
  const { proposal, aiError } = await summarise(ctx, stored);
  return checkResultOf(proposal, toPlanBlock(ctx, proposal, calendar), { aiError, impactDelta });
};
