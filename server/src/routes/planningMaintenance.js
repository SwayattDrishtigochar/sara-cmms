import { Router } from 'express';
import { z } from 'zod';
import { AiUnavailableError } from '../ai/gemini.js';
import { badRequest, parseOrThrow } from '../lib/errors.js';
import { OBJECT_ID_PATTERN } from '../modules/fields.js';
import { assertCan } from '../modules/permissions.js';
import { getModule } from '../modules/registry.js';
import { explainProposal } from '../planning/explain.js';
import { planMaintenanceProposal } from '../planning/maintenance.js';
import { checkResultOf, proposeMaintenancePlan, summarise } from '../planning/maintenancePlan.js';
import { checkMaintenancePlan } from '../planning/maintenancePlanCheck.js';
import { availableUsers } from '../planning/people.js';
import { planBlockFor, toPlanBlock } from '../planning/proposals.js';

/**
 * Maintenance planning routes (phase 5 §6 single task; phase 7 §6 whole plan, check of an edited plan, people
 * availability). Mounted at /api.
 */
export const planningMaintenanceRouter = Router();

const DAY = 86_400_000;
const HOUR = 3_600_000;
const id = z.string().trim().min(1).max(64).optional();
const objectId = z.string().regex(OBJECT_ID_PATTERN, 'must be a 24-character id');
const inputSchema = z.object({
  assetId: id,
  anomalyId: id,
  workOrderId: id,
  plantId: id,
  horizonDays: z.number().int().min(1).max(30).optional(),
  allowNonRunningDays: z.boolean().optional(),
});
const planSchema = z.object({
  scope: z.enum(['plant', 'assets']).default('plant'),
  assetIds: z.array(objectId).max(20).optional(),
  plantId: objectId.optional(),
  start: z.coerce.date().optional(),
  horizonDays: z.number().int().min(1).max(30).optional(),
  objective: z.enum(['protect_production', 'balanced', 'fix_fast']).optional(),
  allowNonRunningDays: z.boolean().optional(),
  anomalyId: objectId.optional(),
  name: z.string().trim().max(120).optional(),
});
const checkSchema = z.object({
  proposalId: z.string().trim().min(1).max(60),
  name: z.string().trim().max(120).optional(),
  objective: z.enum(['protect_production', 'balanced', 'fix_fast']).optional(),
  tasks: z
    .array(
      z.object({
        key: z.string().trim().min(1).max(20),
        start: z.coerce.date().optional(),
        end: z.coerce.date().optional(),
        durationMin: z.number().int().min(1).max(1440).optional(),
        technicianId: objectId.nullable().optional(),
      }),
    )
    .max(20),
});
const peopleQuery = z.object({
  department: z.enum(['Maintenance', 'Production']).default('Maintenance'),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  skills: z.string().max(500).optional(),
  plantId: objectId.optional(),
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

/** A whole maintenance plan for the plant or chosen assets: `{ proposal, plan, check }`. */
planningMaintenanceRouter.post('/planning/maintenance/plan', async (req, res) => {
  assertCan(req.ctx, getModule('workorders'), 'create');
  const input = parseOrThrow(planSchema, req.body ?? {}, 'maintenance plan');
  const draft = await proposeMaintenancePlan(req.ctx, input);
  const { proposal, aiError } = await summarise(req.ctx, draft);
  const plan = await planBlockFor(req.ctx, proposal);
  res.json({
    proposal,
    plan,
    check: checkResultOf(proposal, plan, { aiError }),
    ...(aiError ? { aiError } : {}),
  });
});

/** Checks (and saves) a user-edited maintenance plan → CheckResult. */
planningMaintenanceRouter.post('/planning/maintenance/check', async (req, res) => {
  assertCan(req.ctx, getModule('workorders'), 'create');
  const edited = parseOrThrow(checkSchema, req.body ?? {}, 'edited maintenance plan');
  res.json(await checkMaintenancePlan(req.ctx, edited));
});

/** Who of a department is free for a window (default: the next 8 hours). */
planningMaintenanceRouter.get('/planning/people', async (req, res) => {
  const q = parseOrThrow(peopleQuery, req.query, 'people query');
  const from = q.from ?? new Date();
  const to = q.to ?? new Date(from.getTime() + 8 * HOUR);
  if (to <= from) throw badRequest('The end must be after the start');
  if (to - from > 31 * DAY) throw badRequest('Ask for at most 31 days at a time');
  const skills = (q.skills ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  res.json({
    people: await availableUsers(req.ctx, {
      department: q.department,
      skills,
      window: { start: from, end: to },
      plantId: q.plantId,
    }),
  });
});
