import { z } from 'zod';
import { findByIdOrCode, fmtDate } from '../agent/tools/common.js';
import { can } from '../modules/permissions.js';
import { getModule } from '../modules/registry.js';
import { planMaintenanceProposal } from './maintenance.js';
import { toPlanBlock } from './proposals.js';

/** Chat tool `plan_maintenance` (phase-5 §5): writes only a draft proposal; apply_plan applies it after Confirm. */

const ref = (max = 120) => z.string().trim().min(1).max(max).optional();

export const maintenancePlanningTools = [
  {
    name: 'plan_maintenance',
    group: 'planning',
    description:
      'Finds the best window for maintenance on a machine: a free slot with no production impact, otherwise options to insert the work and push job cards, move the rest of the job to another machine, or defer, each with the delays against plan due dates. Covers an anomaly (deadline from its urgency), a work order, or every PM, calibration and unscheduled work order of an asset (or the plant when nothing is given) due within horizonDays. Creates a draft plan; then call apply_plan { proposalId } so the user can confirm. Example: { anomaly: "ANM-7" } or { asset: "<asset id>", horizonDays: 7 }.',
    schema: z.object({
      asset: ref().describe('Asset id or tag'),
      anomaly: ref().describe('Anomaly id or ANM-code'),
      workOrder: ref().describe('Work order id or WO-code'),
      horizonDays: z.number().int().min(1).max(30).default(7),
      allowNonRunningDays: z.boolean().default(false),
    }),
    permission: (ctx) => can(ctx, getModule('workorders'), 'create'),
    run: async (ctx, { asset, anomaly, workOrder, horizonDays, allowNonRunningDays }) => {
      const id = async (module, value) =>
        value ? String((await findByIdOrCode(ctx, module, value))._id) : undefined;
      const input = {
        assetId: await id('assets', asset),
        anomalyId: await id('anomalies', anomaly),
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
