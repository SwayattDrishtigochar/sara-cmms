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

export const PLAN_EXPLANATION_SCHEMA = z.object({
  summary: z.string().max(400),
  bullets: z.array(z.string().max(200)).min(1).max(4),
});
export const MAINTENANCE_RECOMMENDATION_SCHEMA = z.object({
  recommendedOption: z.enum(['zero_impact', 'insert', 'move', 'defer']),
  summary: z.string().max(400),
  reasons: z.array(z.string().max(200)).min(1).max(3),
});

const SYSTEM = {
  plan_explanation:
    'You explain a production plan made by the SARA planner to a plant manager. Every number is computed by the planner: never change or invent numbers. Say why these machines and moulds were picked, whether the due date is met, and what to watch (risks, alternatives). Short, plain sentences.',
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

const explainProduction = async (ctx, p) => {
  const input = {
    proposal: {
      kind: p.kind,
      title: p.title,
      feasibility: p.feasibility,
      risks: (p.risks ?? []).map((r) => ({ text: r.text })),
      alternatives: p.alternatives ?? [],
      jobCards: (p.diff?.jobCards ?? []).map(({ asset, tool, target, setupMin, start, end }) => ({
        asset,
        tool,
        target,
        setupMin,
        start,
        end,
      })),
    },
  };
  const { json, model, mock } = await ask(ctx, 'plan_explanation', PLAN_EXPLANATION_SCHEMA, input);
  return { explanation: { text: bulletText(json.summary, json.bullets), model, at: new Date(), mock } };
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
      : await explainProduction(ctx, proposal);
  await getModule('planproposals').Model.updateOne({ _id: proposal._id }, { $set: patch });
  return patch.explanation;
};
