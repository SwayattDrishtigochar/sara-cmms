import { z } from 'zod';
import { toJsonSchema } from '../agent/declarations.js';
import { labelsFor } from '../agent/tools/common.js';
import { AiUnavailableError, generate } from '../ai/gemini.js';
import { getModule } from '../modules/registry.js';

/**
 * The AI explanation of a REST-made proposal (phase 5 §4): one background call, purpose 'planning'. The
 * planners compute every number; the model only explains (production) or picks among the options it is
 * given (maintenance, behind a guardrail). AiUnavailableError propagates; callers show the fallback.
 */

export const PLAN_FEASIBILITY_SCHEMA = z.object({
  summary: z.string().max(400),
  bullets: z.array(z.string().max(200)).min(1).max(4),
  adjust: z.array(z.string().max(200)).max(3),
});
export const MAINTENANCE_RECOMMENDATION_SCHEMA = z.object({
  recommendedOption: z.enum(['zero_impact', 'insert', 'move', 'defer']),
  summary: z.string().max(400),
  reasons: z.array(z.string().max(200)).min(1).max(3),
});

const SYSTEM = {
  plan_feasibility:
    'You explain a production plan (as the SARA planner made it, or as the user edited it) to a plant manager. Every number and the verdict are computed by the planner: never change or invent them. Start the summary with "Doable:", "Needs adjustment:" or "Not doable:" matching plan.verdict, say which machines, moulds and operators run each job card, whether the due date is met, and in "adjust" list what to change (from the given adjustments). Short, plain sentences.',
  maintenance_recommendation:
    'You recommend one of the given maintenance scheduling options to a maintenance manager. The lateness numbers are computed: never change them. Prefer options that keep every production plan on time and do the maintenance before its deadline; pick "defer" only when every other option makes a plan late, and never for a critical task. Short, plain sentences.',
};

const ask = async (ctx, kind, schema, input) => {
  const answer = await generate({
    tier: 'background',
    purpose: 'planning',
    companyId: ctx.companyId,
    system: SYSTEM[kind],
    contents: JSON.stringify(input),
    schema: toJsonSchema(schema),
    mockInput: { kind, ...input },
  });
  const parsed = schema.safeParse(answer.json);
  if (!parsed.success)
    throw new AiUnavailableError(
      'AI_ERROR',
      'The AI answer did not have the expected shape. Please try again.',
    );
  return { json: parsed.data, model: answer.model, mock: Boolean(answer.mock) };
};

const bulletText = (summary, lines) => [summary, ...lines.map((l) => `• ${l}`)].join('\n');
const iso = (d) => (d ? new Date(d).toISOString() : null);

/**
 * `plan_feasibility` (phase 7 §4) for a production plan, proposed or edited: the verdict, issues and
 * adjustments are the engine's; the model only puts them in words. Returns `{ text, model, at, mock }`.
 * @param {{ title, partName, quantity, dueDate, feasibility, jobCards, issues, adjustments, risks }} plan
 */
export const feasibilityText = async (ctx, plan) => {
  const f = plan.feasibility ?? {};
  const input = {
    plan: {
      title: plan.title,
      partName: plan.partName,
      quantity: plan.quantity,
      dueDate: iso(plan.dueDate ?? f.dueDate),
      verdict: f.verdict ?? 'doable',
      finishAt: iso(f.projectedFinish),
      slackHours: f.slackHours ?? null,
      shortfall: f.shortfall ?? 0,
      jobCards: (plan.jobCards ?? []).slice(0, 10).map((j) => ({
        key: j.key,
        asset: j.asset,
        tool: j.tool,
        target: j.target,
        start: iso(j.start),
        end: iso(j.end),
        setupMin: j.setupMin ?? 0,
        operators: [...new Set((j.operators ?? []).map((o) => o.name).filter(Boolean))],
        shifts: j.shifts ?? (j.operators ?? []).length,
      })),
      issues: (plan.issues ?? []).slice(0, 10).map(({ kind, severity, text }) => ({ kind, severity, text })),
      adjustments: (plan.adjustments ?? []).slice(0, 5).map(({ id, kind, label }) => ({ id, kind, label })),
      risks: (plan.risks ?? []).slice(0, 5).map((r) => r.text),
    },
  };
  const { json, model, mock } = await ask(ctx, 'plan_feasibility', PLAN_FEASIBILITY_SCHEMA, input);
  const text = [
    bulletText(json.summary, json.bullets),
    ...(json.adjust.length ? [`Adjust: ${json.adjust.join(' · ')}`] : []),
  ].join('\n');
  return { text, model, at: new Date(), mock };
};

const explainProduction = async (ctx, p) => {
  const edited = p.input?.edited ?? p.input ?? {};
  const explanation = await feasibilityText(ctx, {
    title: p.title,
    partName: edited.partName,
    quantity: edited.quantity,
    dueDate: edited.dueDate,
    feasibility: p.feasibility,
    jobCards: p.diff?.jobCards ?? [],
    issues: p.issues ?? p.feasibility?.issues ?? [],
    adjustments: p.adjustments ?? p.feasibility?.adjustments ?? [],
    risks: p.risks ?? [],
  });
  return { explanation };
};

/** The maintenance recommendation patch: explanation, plus the AI's pick when it passes the guardrail. */
export const explainMaintenance = async (ctx, p) => {
  const options = p.options ?? [];
  const recommended = options.find((o) => o.id === p.recommendedOption) ?? options[0];
  const wo = recommended?.ops?.find((o) => o.module === 'workorders')?.data ?? {};
  const [assets, anomaly] = await Promise.all([
    labelsFor(ctx, 'assets', (p.assetIds ?? []).map(String)),
    p.anomalyId
      ? getModule('anomalies')
          .Model.findOne({ _id: p.anomalyId, companyId: ctx.companyId })
          .select('severity')
          .lean()
      : null,
  ]);
  const severity = anomaly?.severity ?? null;
  const input = {
    task: {
      title: p.title,
      kind: p.anomalyId ? 'anomaly' : wo.pmId ? 'pm' : wo.calibrationId ? 'calibration' : 'workorder',
      assetName: [...assets.values()][0] ?? null,
      deadline: wo.dueDate ?? p.feasibility?.dueDate ?? null,
      durationMin: wo.estimatedDurationMin ?? null,
      severity,
    },
    options: options.map(({ id, label, lateHours, delayHours, maintenanceLateHours, risk }) => ({
      id,
      label,
      lateHours,
      delayHours,
      maintenanceLateHours,
      risk: risk ?? null,
    })),
    recommended: recommended?.id ?? null,
  };
  const { json, model, mock } = await ask(
    ctx,
    'maintenance_recommendation',
    MAINTENANCE_RECOMMENDATION_SCHEMA,
    input,
  );
  // Guardrail: the pick must be offered, and never "defer" a critical task or while another option keeps
  // every plan on time.
  const pick = options.find((o) => o.id === json.recommendedOption);
  const deferWrongly =
    pick?.id === 'defer' &&
    options.some((o) => o.id !== 'defer' && (severity === 'critical' || (o.lateHours ?? 0) === 0));
  const chosen = pick && !deferWrongly ? pick : recommended;
  return {
    explanation: { text: bulletText(json.summary, json.reasons), model, at: new Date(), mock },
    ...(chosen && chosen.id !== p.recommendedOption
      ? { recommendedOption: chosen.id, ops: chosen.ops ?? [], diff: chosen.diff ?? p.diff }
      : {}),
  };
};

/** Asks the AI to explain a proposal, stores it on the proposal and returns `{ text, model, at, mock }`. */
export const explainProposal = async (ctx, proposal) => {
  const patch =
    proposal.kind === 'maintenance'
      ? await explainMaintenance(ctx, proposal)
      : proposal.kind === 'maintenance_plan'
        ? await (await import('./maintenancePlan.js')).explainMaintenancePlan(ctx, proposal)
        : await explainProduction(ctx, proposal);
  await getModule('planproposals').Model.updateOne({ _id: proposal._id }, { $set: patch });
  return patch.explanation;
};
