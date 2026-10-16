import { DateTime } from 'luxon';
import { DATE_TOKENS } from '../agent/tools/common.js';
import { badRequest, forbidden } from '../lib/errors.js';
import { escapeRegex } from '../lib/format.js';
import { can } from '../modules/permissions.js';
import { records, scopeFilter } from '../modules/records.js';
import { getModule } from '../modules/registry.js';
import { buildCalendar } from './capacity.js';
import { advanceWorking, intersectIntervals, totalSeconds } from './intervals.js';
import { createProposal } from './proposals.js';

/**
 * Production planner (phase 5 §3.2, F1): part + quantity + due date → one job card per capable mould on
 * its best machine, the quantity split by capacity, feasibility, risks and alternatives, as proposal ops.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const QUARTER = 15 * 60_000;
const OPERATION = {
  'Injection Moulding Machine': 'Moulding',
  'Power Press': 'Pressing',
  'CNC Machine': 'Machining',
};
const ms = (d) => new Date(d).getTime();
const r1 = (n) => Math.round(n * 10) / 10;
const pcs = (n) => Math.round(n).toLocaleString('en-IN');
const sum = (list, f) => list.reduce((a, x) => a + f(x), 0);
const cut = (text) => (text.length > 300 ? `${text.slice(0, 299)}…` : text);
const same = (a, b) =>
  String(a ?? '')
    .trim()
    .toLowerCase() ===
  String(b ?? '')
    .trim()
    .toLowerCase();

const fmt = (cal, d, time = false) =>
  DateTime.fromJSDate(new Date(d), { zone: cal.timeZone }).toFormat(
    `${DATE_TOKENS[cal.dateFormat] ?? 'dd-MM-yyyy'}${time ? ' HH:mm' : ''}`,
  );

/** Can this user ask the production planner (jobcards create + production switched on)? */
export const canPlanProduction = (ctx) =>
  ctx.company?.features?.productionEnabled === true && can(ctx, getModule('jobcards'), 'create');

/** Working seconds a job of `q` good parts needs on a slot, setup included. */
const jobSeconds = (slot, q) => slot.setupSec + Math.ceil(q / (1 - slot.r) / slot.perShot) * slot.secPerShot;
const finishOf = (slot, q) => advanceWorking(slot.free, slot.start, jobSeconds(slot, q))?.end ?? null;

/**
 * Slot of mould t on machine m. ponytail: jobs append after the machine's and the mould's last job card
 * (no gap filling between existing bookings), so a new card never straddles another one.
 */
const slotOf = (cal, tool, machine, { from, dueDate, r, perShot }) => {
  const lastJob = machine.bookings
    .filter((b) => b.kind === 'jobcard')
    .reduce((a, b) => (!a || ms(b.end) > ms(a.end) ? b : a), null);
  const after = Math.max(ms(from), lastJob ? ms(lastJob.end) : 0, ...tool.busy.map((b) => ms(b.end)));
  const free = intersectIntervals(intersectIntervals(machine.free, tool.free), [
    { start: new Date(after), end: cal.end },
  ]);
  if (!free.length) return null;
  const start = free[0].start;
  const mounted = lastJob ? lastJob.toolId : machine.mountedToolId;
  const setupSec = mounted === tool.toolId ? 0 : tool.setupMin * 60;
  const secPerShot = tool.cycleSec / machine.efficiency;
  const rate = (perShot / tool.cycleSec) * machine.efficiency * (1 - r); // good parts per working second
  const toDue = totalSeconds(intersectIntervals(free, [{ start, end: dueDate }]));
  return {
    tool,
    machine,
    free,
    start,
    setupSec,
    secPerShot,
    perShot,
    r,
    rate,
    capacity: Math.max(0, toDue - setupSec) * rate,
  };
};
const byCapacity = (a, b) => b.capacity - a.capacity || ms(a.start) - ms(b.start);

/** Water-filling split: shares in proportion to capacity; short plans give the rest to the earliest finisher. */
const split = (slots, quantity) => {
  if (sum(slots, (s) => s.capacity) >= quantity) {
    let active = slots;
    for (;;) {
      const total = sum(active, (s) => s.capacity);
      const shares = active.map((s) => ({
        slot: s,
        q: Math.ceil((quantity * s.capacity) / total / s.perShot) * s.perShot,
      }));
      const tooSmall = (x) => x.q < Math.max(x.slot.rate * 3600, 0.05 * quantity);
      const drop =
        active.length > 1
          ? shares
              .filter(tooSmall)
              .sort((a, b) => a.q - b.q)
              .find((x) => total - x.slot.capacity >= quantity)
          : null;
      if (drop) {
        active = active.filter((s) => s !== drop.slot);
        continue;
      }
      const largest = shares.reduce((a, b) => (b.q > a.q ? b : a));
      largest.q -= sum(shares, (x) => x.q) - quantity;
      return shares.filter((x) => x.q > 0);
    }
  }
  const shares = slots.map((s) => ({ slot: s, q: Math.floor(s.capacity) }));
  const rest = quantity - sum(shares, (x) => x.q);
  const finish = (x) => ms(finishOf(x.slot, x.q + rest) ?? Number.POSITIVE_INFINITY);
  const earliest = shares.reduce((a, b) => (finish(b) < finish(a) ? b : a));
  earliest.q += rest;
  return shares.filter((x) => x.q > 0);
};

/**
 * @param {{ partName, quantity, dueDate: Date, productionPlanId?, plantId?, toolIds?: string[], start?: Date,
 *   rejectionPct?: number, customerName?, planCode? }} input
 * @param {{ now: Date, rejectionRate?: number, extraCalendar?: object }} opts extraCalendar = the same
 *   calendar with non-running days, for the extra-shift alternative
 */
export const planProduction = (calendar, input, { now = new Date(), rejectionRate, extraCalendar } = {}) => {
  const quantity = Math.round(input.quantity);
  const dueDate = new Date(input.dueDate);
  const r = Math.min(
    0.5,
    Math.max(0, input.rejectionPct != null ? input.rejectionPct / 100 : (rejectionRate ?? 0.02)),
  );
  const from = new Date(Math.max(Math.ceil(ms(now) / QUARTER) * QUARTER, input.start ? ms(input.start) : 0));

  const makers = calendar.tools.filter(
    (t) =>
      t.parts.some((p) => same(p.partName, input.partName)) &&
      (!input.toolIds?.length || input.toolIds.map(String).includes(t.toolId)),
  );
  if (!makers.length) {
    const parts = [...new Set(calendar.tools.flatMap((t) => t.parts.map((p) => p.partName)))].sort();
    throw badRequest(`No mould makes "${input.partName}"`, { parts });
  }
  const machineById = new Map(calendar.machines.map((m) => [m.assetId, m]));
  const skipped = [];
  const candidates = [];
  for (const tool of makers) {
    if (tool.status !== 'In Service') {
      skipped.push({ tool, reason: `is ${tool.status}` });
      continue;
    }
    const part = tool.parts.find((p) => same(p.partName, input.partName));
    const slots = tool.assets
      .map((id) => machineById.get(id))
      .filter(Boolean)
      .map((m) => slotOf(calendar, tool, m, { from, dueDate, r, perShot: part.perShot }))
      .filter(Boolean)
      .sort(byCapacity);
    if (slots.length) candidates.push({ tool, part, slots });
    else skipped.push({ tool, reason: 'has no free machine in this horizon' });
  }

  // One mould per machine: the strongest mould picks first. ponytail: greedy heuristic; upgrade path CP-SAT.
  // One plan, one plant: without a plant given, the strongest mould's plant wins.
  let plantId = input.plantId ? String(input.plantId) : null;
  const taken = new Set();
  const chosen = [];
  for (const c of candidates.sort((a, b) => byCapacity(a.slots[0], b.slots[0]))) {
    const here = c.slots.filter((s) => !plantId || s.machine.plantId === plantId);
    const open = here.filter((s) => !taken.has(s.machine.assetId));
    const calm = open.filter((s) => !s.machine.openAnomalies.some((a) => a.severity === 'critical'));
    const pick = (calm.length ? calm : open)[0];
    if (!pick) {
      skipped.push({
        tool: c.tool,
        reason: here.length
          ? 'has no free machine (its machines are taken by this plan)'
          : 'runs in another plant',
      });
      continue;
    }
    plantId ??= pick.machine.plantId;
    taken.add(pick.machine.assetId);
    chosen.push({ ...pick, part: c.part });
  }
  if (!chosen.length) {
    throw badRequest(`No machine can run a mould for "${input.partName}" in this horizon`, {
      skipped: skipped.map((s) => `${s.tool.toolNumber ?? s.tool.name} ${s.reason}`),
    });
  }

  const partName = chosen[0].part.partName;
  const jobs = split(chosen, quantity).map(({ slot, q }) => {
    const end = finishOf(slot, q) ?? calendar.end;
    const shots = Math.ceil(q / (1 - r) / slot.perShot);
    const setupEnd = slot.setupSec ? advanceWorking(slot.free, slot.start, slot.setupSec)?.end : null;
    return { slot, q, end, shots, setupEnd };
  });

  const projectedFinish = new Date(Math.max(...jobs.map((j) => ms(j.end))));
  const feasible = projectedFinish <= dueDate;
  const slackHours = r1((ms(dueDate) - ms(projectedFinish)) / HOUR);
  const doneByDue = Math.floor(sum(jobs, (j) => Math.min(j.q, j.slot.capacity)));
  const shortfall = feasible ? 0 : Math.max(0, quantity - doneByDue);
  const notes = feasible
    ? `On time: finishes ${fmt(calendar, projectedFinish, true)}, ${slackHours} h before the due date`
    : `Late: ${pcs(shortfall)} pcs short on ${fmt(calendar, dueDate)}; all parts done by ${fmt(calendar, projectedFinish, true)}`;

  const risks = [];
  for (const { slot, end, shots } of jobs) {
    const { machine: m, tool } = slot;
    for (const t of m.dueTasks ?? []) {
      if (ms(t.due) >= ms(slot.start) && ms(t.due) <= ms(end)) {
        risks.push({
          kind: 'pm_due',
          severity: 'warning',
          text: cut(`${t.code} (${t.name}) is due on ${m.name} on ${fmt(calendar, t.due)}`),
          assetId: m.assetId,
        });
      }
    }
    for (const a of m.openAnomalies) {
      risks.push({
        kind: 'anomaly',
        severity: a.severity,
        text: cut(`${a.code} (${a.summary ?? a.type}) is open on ${m.name}`),
        assetId: m.assetId,
      });
    }
    if (tool.maxShotLife > 0 && tool.shotCount + shots > tool.maxShotLife) {
      risks.push({
        kind: 'tool_life',
        severity: 'warning',
        text: `${tool.toolNumber ?? tool.name} passes its shot life during this job (${pcs(tool.shotCount + shots)} of ${pcs(tool.maxShotLife)} shots)`,
        assetId: m.assetId,
      });
    }
  }
  if (!feasible) risks.push({ kind: 'late', severity: 'critical', text: cut(notes) });

  const alternatives = [];
  if (!feasible) {
    if (extraCalendar) {
      try {
        const alt = planProduction(extraCalendar, input, { now, rejectionRate });
        const f = alt.feasibility;
        alternatives.push({
          kind: 'extra_shift',
          text: `Also run on Sundays and holidays: all ${pcs(quantity)} pcs by ${fmt(calendar, f.projectedFinish, true)}${
            f.feasible ? ' (on time)' : ` (${r1(-f.slackHours)} h late)`
          }`,
          projectedFinish: f.projectedFinish,
        });
      } catch {
        // no extra capacity on non-running days either
      }
    }
    for (const s of skipped.slice(0, 3)) {
      alternatives.push({
        kind: 'other_mould',
        text: cut(
          `${s.tool.toolNumber ?? s.tool.name} (${s.tool.name}) also makes ${partName} but ${s.reason}`,
        ),
      });
    }
    alternatives.push({
      kind: 'partial_delivery',
      text: `Deliver ${pcs(doneByDue)} pcs by ${fmt(calendar, dueDate)} and the remaining ${pcs(quantity - doneByDue)} by ${fmt(calendar, projectedFinish, true)}`,
      projectedFinish,
      extraParts: doneByDue,
    });
  }

  const planRef = input.productionPlanId ? String(input.productionPlanId) : '$op:0';
  const title = `${pcs(quantity)} × ${partName} by ${fmt(calendar, dueDate)}`;
  const ops = [
    input.productionPlanId
      ? {
          seq: 0,
          op: 'update',
          module: 'productionplans',
          id: planRef,
          label: `Mark ${input.planCode ?? 'the production plan'} as planned`,
          data: { status: 'Planned' },
        }
      : {
          seq: 0,
          op: 'create',
          module: 'productionplans',
          label: `Production plan: ${title}`,
          data: {
            partName,
            quantity,
            dueDate,
            priority: 'Medium',
            status: 'Planned',
            ...(plantId ? { plantId } : {}),
          },
        },
    ...jobs.map(({ slot, q, end }, i) => {
      const { machine: m, tool, part } = slot;
      return {
        seq: i + 1,
        op: 'create',
        module: 'jobcards',
        label: `${m.name}: ${pcs(q)} × ${partName} with ${tool.toolNumber ?? tool.name}`,
        data: {
          jobName: `${partName} – ${input.customerName ?? 'stock'}`,
          asset: m.assetId,
          tool: tool.toolId,
          productionPlanId: planRef,
          partName,
          target: q,
          idealCycleTime: tool.cycleSec,
          rejectionPercentage: r1(r * 100),
          startDate: slot.start,
          endDate: end,
          mouldParts: [
            {
              partNameId: part.id,
              partName: part.partName,
              assignedPartPerShot: part.perShot,
              ...(part.weight != null ? { partWeightKg: part.weight / 1000 } : {}),
            },
          ],
          operations: [
            {
              operationName: OPERATION[m.typeOfAsset] ?? 'Processing',
              assetId: m.assetId,
              cycleTime: tool.cycleSec,
            },
          ],
        },
      };
    }),
  ];

  const jobCards = jobs.map(({ slot, q, end, shots }) => ({
    assetId: slot.machine.assetId,
    asset: slot.machine.name,
    toolId: slot.tool.toolId,
    tool: slot.tool.toolNumber ?? slot.tool.name,
    target: q,
    setupMin: slot.setupSec / 60,
    start: slot.start,
    end,
    shots,
  }));
  const bars = jobs.flatMap(({ slot, q, end, shots, setupEnd }, i) => [
    ...(setupEnd
      ? [
          {
            id: `op-${i + 1}-setup`,
            rowId: slot.machine.assetId,
            start: slot.start,
            end: setupEnd,
            label: `Changeover to ${slot.tool.toolNumber ?? slot.tool.name}`,
            kind: 'setup',
            ghost: true,
            change: 'new',
          },
        ]
      : []),
    {
      id: `op-${i + 1}`,
      rowId: slot.machine.assetId,
      start: slot.start,
      end,
      label: `${partName} · ${pcs(q)} pcs`,
      kind: 'jobcard',
      ghost: true,
      change: 'new',
      ...(end > dueDate ? { late: true } : {}),
      tooltip: `${slot.tool.toolNumber ?? slot.tool.name} · ${pcs(q)} pcs · ${pcs(shots)} shots`,
    },
  ]);

  return {
    title,
    jobCards,
    feasibility: { feasible, dueDate, projectedFinish, slackHours, shortfall, notes },
    risks,
    alternatives,
    ops,
    // jobCards ride along in the (mixed) diff so the explanation and chat tool can read them back.
    diff: { bars, delays: [], jobCards },
    rejectionRate: r,
    plantId,
    assetIds: [
      ...new Set(makers.flatMap((t) => t.assets).filter((id) => machineById.get(id)?.plantId === plantId)),
    ],
  };
};

/** Σ rejected ÷ (Σ good + Σ rejected) of the part over the last 30 days; null without data. */
const historicalRejection = async (ctx, partName, now) => {
  const since = new Date(ms(now) - 30 * DAY);
  const partRx = { $regex: `^${escapeRegex(partName.trim())}$`, $options: 'i' };
  const [rejections, jobs] = await Promise.all([
    getModule('rejections')
      .Model.find({
        partName: partRx,
        createdAt: { $gte: since, $lte: now },
        ...scopeFilter(ctx, getModule('rejections')),
      })
      .select('rejectedCount')
      .lean(),
    getModule('jobcards')
      .Model.find({
        partName: partRx,
        startDate: { $lte: now },
        endDate: { $gte: since },
        ...scopeFilter(ctx, getModule('jobcards')),
      })
      .select('operations.progress')
      .lean(),
  ]);
  const rejected = sum(rejections, (x) => x.rejectedCount ?? 0);
  const good = sum(jobs, (j) => j.operations?.[0]?.progress?.partsOut ?? 0);
  return good + rejected > 0 ? rejected / (good + rejected) : null;
};

/** Loads the data, plans and stores a draft proposal. `input` is stored and re-run on "plan changed". */
export const proposeProduction = async (ctx, input, { now = new Date() } = {}) => {
  if (!canPlanProduction(ctx))
    throw forbidden('Your role or company plan does not allow production planning');
  const base = { ...input };
  if (input.productionPlanId) {
    const plan = await records.get(ctx, 'productionplans', String(input.productionPlanId));
    base.partName ??= plan.partName;
    base.quantity ??= plan.quantity;
    base.dueDate ??= plan.dueDate;
    base.plantId ??= plan.plantId ? String(plan.plantId) : undefined;
    base.customerName = plan.customer?.name ?? null;
    base.planCode = plan.reqId;
  }
  if (!base.partName || !base.quantity || !base.dueDate)
    throw badRequest('Give the part, quantity and due date');
  const dueDate = new Date(base.dueDate);
  if (Number.isNaN(dueDate.getTime()) || dueDate <= now)
    throw badRequest('The due date must be in the future');
  base.dueDate = dueDate;

  const range = { plantId: base.plantId, start: now, end: new Date(ms(dueDate) + 14 * DAY), now };
  const calendar = await buildCalendar(ctx, range);
  const rejectionRate =
    base.rejectionPct != null ? undefined : await historicalRejection(ctx, base.partName, now);
  let plan = planProduction(calendar, base, { now, rejectionRate });
  if (!plan.feasibility.feasible) {
    const extraCalendar = await buildCalendar(ctx, { ...range, includeNonRunningDays: true });
    plan = planProduction(calendar, base, { now, rejectionRate, extraCalendar });
  }
  const horizonEnd = Math.max(ms(plan.feasibility.projectedFinish), ms(dueDate)) + 12 * HOUR;
  return createProposal(ctx, {
    kind: 'production',
    title: plan.title,
    plantId: plan.plantId,
    input: {
      partName: base.partName,
      quantity: base.quantity,
      dueDate: dueDate.toISOString(),
      ...(input.productionPlanId ? { productionPlanId: String(input.productionPlanId) } : {}),
      ...(input.plantId ? { plantId: String(input.plantId) } : {}),
      ...(input.toolIds?.length ? { toolIds: input.toolIds.map(String) } : {}),
      ...(input.start ? { start: new Date(input.start).toISOString() } : {}),
      ...(input.rejectionPct != null ? { rejectionPct: input.rejectionPct } : {}),
    },
    horizon: { start: new Date(Math.floor(ms(now) / HOUR) * HOUR), end: new Date(horizonEnd) },
    ...(input.productionPlanId ? { productionPlanId: String(input.productionPlanId) } : {}),
    assetIds: plan.assetIds,
    ops: plan.ops,
    diff: plan.diff,
    feasibility: plan.feasibility,
    risks: plan.risks,
    alternatives: plan.alternatives,
  });
};
