import { z } from 'zod';
import { findByIdOrCode, fmtDate, money } from '../agent/tools/common.js';
import { can } from '../modules/permissions.js';
import { getModule } from '../modules/registry.js';
import { planMaintenanceProposal } from './maintenance.js';
import { proposeMaintenancePlan } from './maintenancePlan.js';
import { planBlockFor, toPlanBlock } from './proposals.js';

/**
 * Chat tool `plan_maintenance`: a whole maintenance plan (scope/objective, phase 7 §5) or the phase-5 single-task
 * options; both write only a draft proposal that apply_plan applies after Confirm.
 */

const ref = (max = 120) => z.string().trim().min(1).max(max).optional();
const OBJECTIVES = ['protect_production', 'balanced', 'fix_fast'];

const wholePlan = async (ctx, args, assetId) => {
  const { scope, assetIds, objective, horizonDays, allowNonRunningDays, start, name, anomalyId } = args;
  const ids = await Promise.all(
    (assetIds ?? []).map(async (a) => String((await findByIdOrCode(ctx, 'assets', a))._id)),
  );
  const chosen = [...new Set([...ids, ...(assetId ? [assetId] : [])])];
  const proposal = await proposeMaintenancePlan(ctx, {
    scope: scope ?? (chosen.length ? 'assets' : 'plant'),
    assetIds: chosen,
    objective: objective ?? 'protect_production',
    horizonDays,
    allowNonRunningDays,
    start: start ? new Date(start) : undefined,
    name,
    anomalyId,
  });
  const when = (d) => fmtDate(ctx, d, { time: true });
  const tasks = proposal.diff?.tasks ?? [];
  const m = proposal.metrics ?? {};
  const verdict = proposal.feasibility?.verdict ?? 'doable';
  return {
    forModel: {
      proposalId: String(proposal._id),
      code: proposal.proposalCode,
      kind: 'maintenance_plan',
      name: proposal.title,
      verdict,
      metrics: m,
      tasks: tasks.slice(0, 20).map((t) => ({
        key: t.key,
        title: t.title,
        asset: t.asset,
        start: when(t.start),
        end: when(t.end),
        technician: t.technician?.name ?? null,
        impactHours: t.impactHours,
        zeroImpact: t.zeroImpact,
        late: t.late,
      })),
      issues: (proposal.issues ?? []).map((i) => i.text),
      next:
        verdict === 'not_doable'
          ? 'Apply an adjustment with check_plan, then apply_plan'
          : 'Call apply_plan { proposalId } so the user can confirm',
    },
    summary: `${proposal.proposalCode} · ${tasks.length} task${tasks.length === 1 ? '' : 's'} · ${m.zeroImpactTasks ?? 0} zero-impact · ${money(ctx, m.downtimeCostAvoided ?? 0)} avoided`,
    rowCount: tasks.length,
    data: { proposal },
    blocks: [{ type: 'plan', payload: await planBlockFor(ctx, proposal) }],
  };
};

export const maintenancePlanningTools = [
  {
    name: 'plan_maintenance',
    group: 'planning',
    description:
      'Plans maintenance. With scope (plant | assets), assetIds or objective it builds a whole maintenance plan: every PM, calibration, anomaly and unscheduled work order due within horizonDays, each in a window with the least production impact (zero-impact first, downtime cost weighed by the objective), with a technician on shift, and the production hours and cost saved against doing everything at once. Example: { scope: "plant", horizonDays: 7, objective: "protect_production" } or { scope: "assets", assetIds: ["IMM-03"] }. Without those it finds the best window for one task (an anomaly, a work order, or an asset’s due work): a free slot, or options to insert and push job cards, move the rest of the job, or defer. Example: { anomaly: "ANM-7" }. Creates a draft plan; then call apply_plan { proposalId } so the user can confirm.',
    schema: z.object({
      asset: ref().describe('Asset id or tag'),
      anomaly: ref().describe('Anomaly id or ANM-code'),
      workOrder: ref().describe('Work order id or WO-code'),
      horizonDays: z.number().int().min(1).max(30).default(7),
      allowNonRunningDays: z.boolean().default(false),
      scope: z.enum(['plant', 'assets']).optional().describe('Whole plant or the given assets'),
      assetIds: z.array(z.string().trim().min(1).max(120)).max(20).optional().describe('Asset ids or tags'),
      objective: z.enum(OBJECTIVES).optional(),
      start: z.string().trim().min(1).max(40).optional().describe('ISO start of the horizon (default now)'),
      name: z.string().trim().min(1).max(120).optional(),
    }),
    permission: (ctx) => can(ctx, getModule('workorders'), 'create'),
    run: async (ctx, args) => {
      const { asset, anomaly, workOrder, horizonDays, allowNonRunningDays } = args;
      const id = async (module, value) =>
        value ? String((await findByIdOrCode(ctx, module, value))._id) : undefined;
      const assetId = await id('assets', asset);
      const anomalyId = await id('anomalies', anomaly);
      if (args.scope || args.assetIds?.length || args.objective)
        return wholePlan(ctx, { ...args, anomalyId }, assetId);
      const input = {
        assetId,
        anomalyId,
        workOrderId: await id('workorders', workOrder),
        horizonDays,
        allowNonRunningDays,
      };
      const { proposal, calendar, planned } = await planMaintenanceProposal(ctx, input);
      const when = (d) => fmtDate(ctx, d, { time: true });
      const first = planned.tasks.find((t) => t.recommended) ?? planned.tasks[0];
      const others = planned.tasks.filter((t) => t !== first);
      const forModel = {
        proposalId: String(proposal._id),
        code: proposal.proposalCode,
        task: {
          title: first.task.title,
          deadline: when(first.task.deadline),
          durationMin: first.task.durationMin,
        },
        // The stored options carry the other tasks' bookings too (what Apply books).
        options: proposal.options.map((o) => ({
          id: o.id,
          label: o.label,
          start: when(o.start),
          end: when(o.end),
          lateHours: o.lateHours,
          delayHours: o.delayHours,
          delays: o.delays.map((d) => ({ code: d.code, hours: d.hours, late: d.late })),
          risk: o.risk,
        })),
        recommended: proposal.recommendedOption,
        ...(others.length
          ? {
              otherTasks: others.map((t) => ({
                title: t.task.title,
                deadline: when(t.task.deadline),
                recommended: t.recommended,
              })),
            }
          : {}),
        next: 'Call apply_plan { proposalId } so the user can confirm',
      };
      const count = proposal.options.length;
      return {
        forModel,
        summary: `${proposal.proposalCode} · ${count} option${count === 1 ? '' : 's'} · recommended ${proposal.recommendedOption?.replace('_', ' ')}`,
        rowCount: count,
        data: { proposal },
        blocks: [{ type: 'plan', payload: toPlanBlock(ctx, proposal, calendar) }],
      };
    },
  },
];
