import { DateTime } from 'luxon';
import { z } from 'zod';
import { findByIdOrCode, fmtDate, round, zoneOf } from '../agent/tools/common.js';
import { resolveTimeRange } from '../agent/tools/resolve.js';
import { badRequest } from '../lib/errors.js';
import { OBJECT_ID_PATTERN } from '../modules/fields.js';
import { getModule } from '../modules/registry.js';
import { buildCalendar, calendarToGantt, hoursOf } from './capacity.js';
import { canPlanProduction, proposeProduction } from './production.js';
import { applyProposal, checkApply, planBlockFor } from './proposals.js';

/** Planning tools (phase 5 §5, group planning): capacity, production planning and applying a plan. */

const DAY = 86_400_000;
const id = () => z.string().regex(OBJECT_ID_PATTERN, 'must be a record id');
const at = (ctx, d) => fmtDate(ctx, d, { time: true });

const toDate = (value, what) => {
  const d = new Date(/^\d+$/.test(String(value)) ? Number(value) : value);
  if (Number.isNaN(d.getTime())) throw badRequest(`"${what}" is not a valid date; pass an ISO date`);
  return d;
};

/** ISO date → end of that day in the company zone; full ISO → as is; text → resolveTimeRange's stop. */
export const dueDateOf = (ctx, text) => {
  const s = String(text).trim();
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
      return {
        forModel: {
          proposalId: String(proposal._id),
          code: proposal.proposalCode,
          feasible: f.feasible,
          dueDate: at(ctx, f.dueDate),
          projectedFinish: at(ctx, f.projectedFinish),
          slackHours: f.slackHours,
          shortfall: f.shortfall,
          jobCards: jobCards.map((j) => ({
            asset: j.asset,
            tool: j.tool,
            target: j.target,
            start: at(ctx, j.start),
            end: at(ctx, j.end),
            setupMin: j.setupMin,
          })),
          risks: (proposal.risks ?? []).map((r) => r.text),
          alternatives: (proposal.alternatives ?? []).map((a) => a.text),
          next: 'Call apply_plan { proposalId } so the user can confirm',
        },
        summary: `${proposal.proposalCode} · ${jobCards.length} job card${jobCards.length === 1 ? '' : 's'} · ${slack(f)}`,
        rowCount: jobCards.length,
        blocks: [{ type: 'plan', payload: await planBlockFor(ctx, proposal) }],
      };
    },
  },
  {
    name: 'apply_plan',
    group: 'planning',
    requiresConfirmation: true,
    permission: (ctx) => ctx.role !== 'view',
    description:
      'Applies a draft plan from plan_production or plan_maintenance (creates/updates the job cards, work orders and production plan). The user sees the plan and must confirm. If the schedule changed, the error carries the new plan’s proposalId: offer that one. Example: { proposalId: "PLN-3" } or, for maintenance, { proposalId: "PLN-4", option: "move" }.',
    schema: z.object({
      proposalId: z.string().min(1).max(60),
      option: z.enum(['zero_impact', 'insert', 'move', 'defer']).optional(),
    }),
    preview: async (ctx, { proposalId, option }) => {
      const checked = await checkApply(ctx, proposalId, { option });
      if (checked.applied) throw badRequest(`${checked.proposal.proposalCode} is already applied`);
      const { proposal: p, ops } = checked;
      const cards = ops.filter((o) => o.module === 'jobcards' && o.op === 'create');
      const names = [...new Set((p.diff?.jobCards ?? []).map((j) => j.asset))];
      const label =
        p.kind === 'production' && cards.length
          ? `Apply ${p.proposalCode}: ${cards.length} job card${cards.length === 1 ? '' : 's'} on ${names.join(', ')}`
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
    run: async (ctx, { proposalId, option }) => {
      const { proposal, created = [], updated = [] } = await applyProposal(ctx, proposalId, { option });
      return {
        forModel: { applied: true, code: proposal.proposalCode, created, updated },
        summary: `Applied ${proposal.proposalCode}: ${created.length} created, ${updated.length} updated`,
        rowCount: created.length + updated.length,
        data: { rows: [...created, ...updated] },
      };
    },
  },
];
