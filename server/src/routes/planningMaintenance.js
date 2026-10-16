import { Router } from 'express';
import { z } from 'zod';
import { AiUnavailableError } from '../ai/gemini.js';
import { parseOrThrow } from '../lib/errors.js';
import { assertCan } from '../modules/permissions.js';
import { getModule } from '../modules/registry.js';
import { explainProposal } from '../planning/explain.js';
import { planMaintenanceProposal } from '../planning/maintenance.js';
import { toPlanBlock } from '../planning/proposals.js';

/** POST /api/planning/maintenance (phase-5 §6): a maintenance proposal with the AI's recommendation. */
export const planningMaintenanceRouter = Router();

const id = z.string().trim().min(1).max(64).optional();
const inputSchema = z.object({
  assetId: id,
  anomalyId: id,
  workOrderId: id,
  plantId: id,
  horizonDays: z.number().int().min(1).max(30).optional(),
  allowNonRunningDays: z.boolean().optional(),
});

planningMaintenanceRouter.post('/planning/maintenance', async (req, res) => {
  assertCan(req.ctx, getModule('workorders'), 'create');
  const input = parseOrThrow(inputSchema, req.body ?? {}, 'maintenance plan');
  const { proposal, calendar } = await planMaintenanceProposal(req.ctx, input);
  let stored;
  let aiError;
  try {
    // Stores the explanation (and the AI's pick, behind the guardrail) on the proposal.
    await explainProposal(req.ctx, proposal);
    stored = await getModule('planproposals').Model.findById(proposal._id).lean();
  } catch (err) {
    if (!(err instanceof AiUnavailableError)) throw err;
    const pick = proposal.options.find((o) => o.id === proposal.recommendedOption);
    stored = {
      ...proposal,
      explanation: { text: `Least delay: ${pick?.label}`, model: null, at: new Date(), mock: false },
    };
    aiError = { code: err.code, message: err.message };
  }
  res.json({
    proposal: stored,
    plan: toPlanBlock(req.ctx, stored, calendar),
    ...(aiError ? { aiError } : {}),
  });
});
