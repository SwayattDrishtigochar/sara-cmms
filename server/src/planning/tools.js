import { DateTime } from 'luxon';
import { z } from 'zod';
import { findByIdOrCode, fmtDate, round, zoneOf } from '../agent/tools/common.js';
import { resolveTimeRange } from '../agent/tools/resolve.js';
import { AppError, badRequest } from '../lib/errors.js';
import { OBJECT_ID_PATTERN } from '../modules/fields.js';
import { can } from '../modules/permissions.js';
import { getModule } from '../modules/registry.js';
import { buildCalendar, calendarToGantt, hoursOf } from './capacity.js';
import { canPlanProduction, proposeProduction } from './production.js';
import { checkProductionPlan, editedFromProposal } from './productionCheck.js';
import { applyProposal, checkApply, getProposal, planBlockFor } from './proposals.js';

/** Planning tools (phase 5 §5, phase 7 §5, group planning): capacity, plans, checking an edit, applying. */

const DAY = 86_400_000;
const id = () => z.string().regex(OBJECT_ID_PATTERN, 'must be a record id');
const at = (ctx, d) => fmtDate(ctx, d, { time: true });
const VERDICT_TEXT = { doable: 'doable', adjust: 'needs adjustment', not_doable: 'not doable' };
const verdictText = (verdict) => VERDICT_TEXT[verdict] ?? 'doable';

/** Job cards for the model: machine, mould, window, operators by name. */
const cardsForModel = (ctx, jobCards) =>
  jobCards.map((j) => ({
    key: j.key,
    asset: j.asset,
    tool: j.tool,
    target: j.target,
    start: at(ctx, j.start),
    end: at(ctx, j.end),
    setupMin: j.setupMin,
    operators: [...new Set((j.operators ?? []).map((o) => o.name).filter(Boolean))],
  }));
const nextStep = (verdict) =>
  verdict === 'not_doable'
    ? 'Apply an adjustment: check_plan { proposalId, edits: { adjustmentIds: ["adj-1"] } }'
    : 'Call apply_plan { proposalId } so the user can confirm';

/** The stored adjustments' patches (by id) as edits rows: job cards or tasks merged by key, plan fields as is. */
const adjustmentEdits = (proposal, ids = []) =>
  ids.map((adjId) => {
    const adj = (proposal.adjustments ?? []).find((a) => a.id === adjId);
    if (!adj)
      throw badRequest(
        `${proposal.proposalCode} has no adjustment ${adjId}; check the plan again for the current ones`,
      );
    return adj.patch ?? {};
  });

const toDate = (value, what) => {
  const d = new Date(/^\d+$/.test(String(value)) ? Number(value) : value);
  if (Number.isNaN(d.getTime())) throw badRequest(`"${what}" is not a valid date; pass an ISO date`);
  return d;
};

/** ISO date → end of that day in the company zone; full ISO → as is; text → resolveTimeRange's stop. */
const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

export const dueDateOf = (ctx, text, now = DateTime.now()) => {
  const s = String(text).trim();
  // "Friday" / "this Friday" = the coming one (today counts); "next Friday" = the first one after today;
  // "in 9 days" = that day. Everything else goes to the time-range resolver.
  const day = /^(?:(this|next|coming)\s+)?(mon|tue|wed|thu|fri|sat|sun)[a-z]*$/i.exec(s);
  const inDays = /^in\s+(\d{1,3})\s+days?$/i.exec(s);
  if (day || inDays) {
    const today = now.setZone(zoneOf(ctx)).startOf('day');
    const ahead = inDays
      ? Number(inDays[1])
      : (WEEKDAYS.findIndex((w) => w.startsWith(day[2].toLowerCase())) + 1 - today.weekday + 7) % 7 ||
        (day[1]?.toLowerCase() === 'next' ? 7 : 0);
    return today.plus({ days: ahead }).endOf('day').set({ millisecond: 0 }).toJSDate();
  }
  // A day means its last second (23:59:59 local), as the Planner's date input sends it, so titles
  // read "by 25-10-2026" rather than the exclusive 26-10 00:00.
  if (/^\d{4}-\d{2}-\d{2}$/.test(s))
    return DateTime.fromISO(s, { zone: zoneOf(ctx) })
      .endOf('day')
      .set({ millisecond: 0 })
      .toJSDate();
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) return toDate(s, 'dueDate');
  return new Date(Date.parse(resolveTimeRange({ text: s }, ctx).stop) - 1000);
};

const slack = (f) =>
  f.feasible
    ? `on time (${round(f.slackHours)} h slack)`
    : `short ${f.shortfall.toLocaleString('en-IN')} pcs`;

export const planningTools = [
  {
    name: 'capacity_calendar',
    group: 'planning',
    description:
      'Machine capacity: working time (shifts minus breaks, running days, holidays), bookings (job cards, planned maintenance) and free windows per machine, with each machine’s efficiency. Default: now to +7 days, production machines of the plant. Example: { assetIds: ["<id>"], start: "2026-10-16T00:00:00Z", stop: "2026-10-23T00:00:00Z" }.',
    schema: z.object({
      plantId: id().optional(),
      assetIds: z.array(id()).max(20).optional(),
      start: z.string().max(40).optional(),
      stop: z.string().max(40).optional(),
    }),
    run: async (ctx, { plantId, assetIds, start, stop }) => {
      const from = start ? toDate(start, 'start') : new Date();
      const to = stop ? toDate(stop, 'stop') : new Date(from.getTime() + 7 * DAY);
      if (to <= from) throw badRequest('The stop must be after the start');
      if (to - from > 31 * DAY) throw badRequest('Ask for at most 31 days');
      const calendar = await buildCalendar(ctx, { plantId, assetIds, start: from, end: to });
      const machines = calendar.machines.map((m) => ({
        asset: m.name,
        assetId: m.assetId,
        efficiency: round(m.efficiency, 2),
        ...hoursOf(m),
        bookings: m.bookings.slice(0, 10).map((b) => ({
          code: b.code,
          label: b.label,
          start: at(ctx, b.start),
          end: at(ctx, b.end),
        })),
        freeWindows: m.free
          .filter((i) => i.end - i.start >= 30 * 60_000)
          .slice(0, 10)
          .map((i) => ({
            start: at(ctx, i.start),
            end: at(ctx, i.end),
            hours: round((i.end - i.start) / 3_600_000),
          })),
      }));
      const free = round(
        machines.reduce((s, m) => s + m.freeHours, 0),
        0,
      );
      return {
        forModel: { start: at(ctx, from), stop: at(ctx, to), machines },
        summary: `Capacity of ${machines.length} machine${machines.length === 1 ? '' : 's'} · ${free} h free`,
        rowCount: machines.length,
        blocks: [{ type: 'plan', payload: calendarToGantt(ctx, calendar) }],
      };
    },
  },
  {
    name: 'plan_production',
    group: 'planning',
    permission: canPlanProduction,
    description:
      'Plans production of a part: picks every capable mould and its best machine, splits the quantity, checks the due date and lists risks and alternatives. Creates a draft plan only (nothing changes until apply_plan is confirmed). dueDate: ISO date or text like "25 Oct". Example: { part: "Housing-A", quantity: 5000, dueDate: "2026-10-25" }.',
    schema: z.object({
      part: z.string().min(1).max(120),
      quantity: z.int().min(1).max(10_000_000),
      dueDate: z.string().min(1).max(40),
      productionPlan: z.string().max(60).optional(),
      plantId: id().optional(),
      toolIds: z.array(id()).max(5).optional(),
      start: z.string().max(40).optional(),
    }),
    run: async (ctx, args) => {
      const plan = args.productionPlan
        ? await findByIdOrCode(ctx, 'productionplans', args.productionPlan)
        : null;
      const proposal = await proposeProduction(ctx, {
        partName: args.part,
        quantity: args.quantity,
        dueDate: dueDateOf(ctx, args.dueDate),
        ...(plan ? { productionPlanId: String(plan._id) } : {}),
        ...(args.plantId ? { plantId: args.plantId } : {}),
        ...(args.toolIds?.length ? { toolIds: args.toolIds } : {}),
        ...(args.start ? { start: toDate(args.start, 'start') } : {}),
      });
      const f = proposal.feasibility;
      const jobCards = proposal.diff?.jobCards ?? [];
      const verdict = f.verdict ?? 'doable';
      return {
        forModel: {
          proposalId: String(proposal._id),
          code: proposal.proposalCode,
          verdict,
          feasible: f.feasible,
          dueDate: at(ctx, f.dueDate),
          projectedFinish: at(ctx, f.projectedFinish),
          slackHours: f.slackHours,
          shortfall: f.shortfall,
          jobCards: cardsForModel(ctx, jobCards),
          issues: (proposal.issues ?? []).map((i) => i.text),
          adjustments: (proposal.adjustments ?? []).map(({ id, label }) => ({ id, label })),
          risks: (proposal.risks ?? []).map((r) => r.text),
          alternatives: (proposal.alternatives ?? []).map((a) => a.text),
          next: nextStep(verdict),
        },
        summary: `${proposal.proposalCode} · ${jobCards.length} job card${jobCards.length === 1 ? '' : 's'} · ${
          verdict === 'doable' ? `doable (${slack(f)})` : verdictText(verdict)
        }`,
        rowCount: jobCards.length,
        blocks: [{ type: 'plan', payload: await planBlockFor(ctx, proposal) }],
      };
    },
  },
  {
    name: 'check_plan',
    group: 'planning',
    permission: (ctx) =>
      can(ctx, getModule('jobcards'), 'update') || can(ctx, getModule('workorders'), 'update'),
    description:
      'Checks a draft plan after the user edits it (another machine, start/end, quantity, due date, operators or technicians) and says whether it is doable, what conflicts and which adjustment fixes it. Keys are the plan’s job card (op-n) or task (t-n) keys. To take a suggested adjustment, pass its id in adjustmentIds (applied before the other edits). Example: { proposalId: "PLN-3", edits: { jobCards: [{ key: "op-2", assetId: "<IMM 5 id>" }] } } or { proposalId: "PLN-3", edits: { adjustmentIds: ["adj-1"] } }.',
    schema: z.object({
      proposalId: z.string().min(1).max(60),
      edits: z.object({
        adjustmentIds: z.array(z.string().max(20)).max(5).optional(),
        dueDate: z.string().max(40).optional(),
        quantity: z.int().min(1).max(10_000_000).optional(),
        jobCards: z
          .array(
            z.object({
              key: z.string().min(1).max(20),
              assetId: id().optional(),
              start: z.string().max(40).optional(),
              end: z.string().max(40).optional(),
              target: z.int().min(1).max(10_000_000).optional(),
              operatorIds: z.array(id()).max(6).optional(),
            }),
          )
          .max(10)
          .optional(),
        tasks: z
          .array(
            z.object({
              key: z.string().min(1).max(20),
              start: z.string().max(40).optional(),
              end: z.string().max(40).optional(),
              technicianId: id().nullable().optional(),
            }),
          )
          .max(20)
          .optional(),
      }),
    }),
    run: async (ctx, { proposalId, edits }) => {
      const proposal = await getProposal(ctx, proposalId);
      const code = proposal.proposalCode;
      // A check without edits repeats the plan block the plan tool already showed: no second block.
      const changed = Object.values(edits ?? {}).some((v) => (Array.isArray(v) ? v.length > 0 : v != null));
      const planBlocks = (payload) => (changed ? [{ type: 'plan', payload }] : []);
      if (proposal.kind === 'maintenance_plan') {
        if (!can(ctx, getModule('workorders'), 'update'))
          throw badRequest('Your role cannot change maintenance plans');
        const { checkMaintenancePlan } = await import('./maintenancePlanCheck.js');
        const tasks = (proposal.diff?.tasks ?? []).map((t) => ({
          key: t.key,
          start: toDate(t.start, 'start').toISOString(),
          end: toDate(t.end, 'end').toISOString(),
          technicianId: t.technician?.userId ?? null,
        }));
        const taskEdits = [
          ...adjustmentEdits(proposal, edits.adjustmentIds).flatMap((patch) => patch.tasks ?? []),
          ...(edits.tasks ?? []),
        ];
        for (const e of taskEdits) {
          const row = tasks.find((t) => t.key === e.key);
          if (!row) throw badRequest(`${code} has no task ${e.key}`);
          if (e.start) row.start = toDate(e.start, 'start').toISOString();
          if (e.end) row.end = toDate(e.end, 'end').toISOString();
          if (e.technicianId !== undefined) row.technicianId = e.technicianId;
        }
        const check = await checkMaintenancePlan(ctx, { proposalId: String(proposal._id), tasks });
        return {
          forModel: {
            proposalId: String(proposal._id),
            code,
            verdict: check.verdict,
            issues: check.issues.map((i) => i.text),
            adjustments: check.adjustments.map(({ id, kind, label }) => ({ id, kind, label })),
            tasks: (check.tasks ?? []).slice(0, 20).map((t) => ({
              key: t.key,
              title: t.title,
              asset: t.asset,
              start: at(ctx, t.start),
              end: at(ctx, t.end),
              technician: t.technician?.name ?? null,
              impactHours: t.impactHours,
              zeroImpact: t.zeroImpact,
              late: t.late,
            })),
            next: nextStep(check.verdict),
          },
          summary: `${code} · ${verdictText(check.verdict)} · ${check.issues.length} issue${check.issues.length === 1 ? '' : 's'}`,
          rowCount: check.tasks?.length ?? 0,
          blocks: planBlocks(check.plan),
        };
      }
      if (proposal.kind !== 'production')
        throw badRequest(`${code} is a single maintenance task; plan it again`);
      if (!can(ctx, getModule('jobcards'), 'update'))
        throw badRequest('Your role cannot change production plans');
      const edited = editedFromProposal(proposal);
      for (const patch of adjustmentEdits(proposal, edits.adjustmentIds)) {
        if (patch.dueDate) edited.dueDate = toDate(patch.dueDate, 'dueDate').toISOString();
        if (patch.quantity) edited.quantity = patch.quantity;
        for (const { key, ...fields } of patch.jobCards ?? []) {
          const row = edited.jobCards.find((c) => c.key === key);
          if (!row) throw badRequest(`${code} has no job card ${key}`);
          for (const [field, value] of Object.entries(fields)) if (value !== undefined) row[field] = value;
        }
      }
      if (edits.dueDate) edited.dueDate = dueDateOf(ctx, edits.dueDate).toISOString();
      if (edits.quantity) edited.quantity = edits.quantity;
      for (const e of edits.jobCards ?? []) {
        const row = edited.jobCards.find((c) => c.key === e.key);
        if (!row) throw badRequest(`${code} has no job card ${e.key}`);
        if (e.assetId) row.assetId = e.assetId;
        if (e.start) row.start = toDate(e.start, 'start').toISOString();
        if (e.end) row.end = toDate(e.end, 'end').toISOString();
        if (e.target) row.target = e.target;
        if (e.operatorIds) row.operators = e.operatorIds.map((userId) => ({ userId }));
      }
      const check = await checkProductionPlan(ctx, edited);
      return {
        forModel: {
          proposalId: String(proposal._id),
          code,
          verdict: check.verdict,
          issues: check.issues.map((i) => i.text),
          adjustments: check.adjustments.map(({ id, kind, label }) => ({ id, kind, label })),
          jobCards: cardsForModel(ctx, check.jobCards),
          next: nextStep(check.verdict),
        },
        summary: `${code} · ${verdictText(check.verdict)} · ${check.issues.length} issue${check.issues.length === 1 ? '' : 's'}`,
        rowCount: check.jobCards.length,
        blocks: planBlocks(check.plan),
      };
    },
  },
  {
    name: 'apply_plan',
    group: 'planning',
    requiresConfirmation: true,
    permission: (ctx) => ctx.role !== 'view',
    description:
      'Applies a draft plan from plan_production or plan_maintenance (creates/updates the job cards, work orders and production plan). The user sees the plan and must confirm. If the schedule changed, the error carries the new plan’s proposalId: offer that one. If the plan is not doable, fix it with check_plan first, or pass force: true only when the user explicitly wants it anyway. Example: { proposalId: "PLN-3" } or, for maintenance, { proposalId: "PLN-4", option: "move" }.',
    schema: z.object({
      proposalId: z.string().min(1).max(60),
      option: z.enum(['zero_impact', 'insert', 'move', 'defer']).optional(),
      force: z.boolean().optional(),
    }),
    preview: async (ctx, { proposalId, option, force }) => {
      const checked = await checkApply(ctx, proposalId, { option });
      if (checked.applied) throw badRequest(`${checked.proposal.proposalCode} is already applied`);
      const { proposal: p, ops } = checked;
      // No confirm card for an apply that would fail: the same 409 apply gives, before the user confirms.
      if (p.feasibility?.verdict === 'not_doable' && !force)
        throw new AppError(
          409,
          'PLAN_NOT_DOABLE',
          `${p.proposalCode} is not doable: fix it with check_plan (adjustmentIds), or pass force: true only if the user wants it anyway`,
          { verdict: p.feasibility.verdict },
        );
      const cards = ops.filter((o) => o.module === 'jobcards' && o.op === 'create');
      const names = [...new Set((p.diff?.jobCards ?? []).map((j) => j.asset))];
      const wos = ops.filter((o) => o.module === 'workorders');
      const techs = new Set(wos.flatMap((o) => o.data?.people ?? []));
      const label =
        p.kind === 'production' && cards.length
          ? `Apply ${p.proposalCode}: ${cards.length} job card${cards.length === 1 ? '' : 's'} on ${names.join(', ')}`
          : p.kind === 'maintenance_plan'
            ? `Apply ${p.proposalCode}: ${wos.length} work order${wos.length === 1 ? '' : 's'}, ${techs.size} technician${techs.size === 1 ? '' : 's'}`
            : `Apply ${p.proposalCode}: ${p.title}`;
      return {
        type: 'confirm',
        payload: {
          tool: 'apply_plan',
          action: 'plan',
          module: 'planproposals',
          moduleLabel: 'Plan Proposals',
          label,
          proposal: {
            id: String(p._id),
            code: p.proposalCode,
            kind: p.kind,
            title: p.title,
            status: p.status,
          },
          option: checked.option,
          ops: ops.map((o) => ({
            seq: o.seq,
            op: o.op,
            module: o.module,
            label: o.label,
            summary: `${o.op === 'create' ? 'Create' : 'Update'} ${getModule(o.module).singular.toLowerCase()}`,
          })),
          plan: await planBlockFor(ctx, p),
        },
      };
    },
    run: async (ctx, { proposalId, option, force }) => {
      const {
        proposal,
        created = [],
        updated = [],
      } = await applyProposal(ctx, proposalId, { option, force });
      return {
        forModel: { applied: true, code: proposal.proposalCode, created, updated },
        summary: `Applied ${proposal.proposalCode}: ${created.length} created, ${updated.length} updated`,
        rowCount: created.length + updated.length,
        data: { rows: [...created, ...updated] },
      };
    },
  },
];
