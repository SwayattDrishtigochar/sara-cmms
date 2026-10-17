import { Router } from 'express';
import { DateTime } from 'luxon';
import { z } from 'zod';
import { labelsFor, zoneOf } from '../agent/tools/common.js';
import { badRequest, forbidden, parseOrThrow } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { OBJECT_ID_PATTERN } from '../modules/fields.js';
import { scopeFilter } from '../modules/records.js';
import { getModule } from '../modules/registry.js';
import { buildCalendar, calendarToGantt, hoursOf } from '../planning/capacity.js';
import { explainProposal } from '../planning/explain.js';
import { canPlanProduction, proposeProduction } from '../planning/production.js';
import { checkProductionPlan, editedFromProposal, editedPlanSchema } from '../planning/productionCheck.js';
import {
  applyProposal,
  discardProposal,
  getProposal,
  listProposals,
  planBlockFor,
} from '../planning/proposals.js';
import { dueDateOf } from '../planning/tools.js';
import { aiUnavailable } from './ai.js';

/** Capacity calendar, production planning, plan checks and proposals (phase 5 §6, phase 7 §6); mounted at /api. */
export const planningRouter = Router();

const DAY = 86_400_000;
const objectId = z.string().regex(OBJECT_ID_PATTERN, 'must be a 24-character id');
const calendarQuery = z.object({
  start: z.coerce.date().optional(),
  end: z.coerce.date().optional(),
  plantId: objectId.optional(),
  assetIds: z.string().max(2000).optional(),
});
const productionBody = z.object({
  partName: z.string().trim().min(1).max(120),
  quantity: z.coerce.number().int().min(1).max(10_000_000),
  dueDate: z.string().trim().min(1).max(40),
  productionPlanId: objectId.optional(),
  toolIds: z.array(objectId).max(5).optional(),
  start: z.coerce.date().optional(),
  plantId: objectId.optional(),
  customerId: objectId.optional(),
  rejectionPct: z.number().min(0).max(50).optional(),
});
const applyBody = z.object({
  option: z.enum(['zero_impact', 'insert', 'move', 'defer']).optional(),
  force: z.boolean().optional(),
});

planningRouter.get('/planning/calendar', async (req, res) => {
  const q = parseOrThrow(calendarQuery, req.query, 'calendar range');
  const start = q.start ?? DateTime.now().setZone(zoneOf(req.ctx)).startOf('day').toJSDate();
  const end = q.end ?? new Date(start.getTime() + 7 * DAY);
  if (end <= start) throw badRequest('The end must be after the start');
  if (end - start > 31 * DAY) throw badRequest('Show at most 31 days at a time');
  const assetIds = (q.assetIds ?? '').split(',').filter(Boolean);
  if (assetIds.some((id) => !OBJECT_ID_PATTERN.test(id))) throw badRequest('assetIds must be record ids');
  const calendar = await buildCalendar(req.ctx, { plantId: q.plantId, assetIds, start, end });
  res.json({
    gantt: calendarToGantt(req.ctx, calendar),
    machines: calendar.machines.map((m) => ({
      assetId: m.assetId,
      efficiency: m.efficiency,
      efficiencySource: m.efficiencySource,
      ...hoursOf(m),
    })),
  });
});

planningRouter.post('/planning/production', async (req, res) => {
  if (!canPlanProduction(req.ctx))
    throw forbidden('Your role or company plan does not allow production planning');
  const input = parseOrThrow(productionBody, req.body, 'production plan');
  const proposal = await proposeProduction(req.ctx, { ...input, dueDate: dueDateOf(req.ctx, input.dueDate) });
  // The fresh plan goes through the same check as an edited one: issues, adjustments, ghost bars and the
  // plan_feasibility explanation (stored on the proposal; AI failure → aiError, never a failed page).
  const { proposal: checked, ...check } = await checkProductionPlan(req.ctx, editedFromProposal(proposal));
  res.json({
    proposal: checked ?? proposal,
    plan: check.plan,
    check,
    ...(check.aiError ? { aiError: check.aiError } : {}),
  });
});

planningRouter.post('/planning/production/check', async (req, res) => {
  if (!canPlanProduction(req.ctx))
    throw forbidden('Your role or company plan does not allow production planning');
  const edited = parseOrThrow(editedPlanSchema, req.body, 'edited plan');
  res.json(await checkProductionPlan(req.ctx, edited));
});

planningRouter.get('/planning/proposals', async (req, res) => {
  const { status, kind, limit } = req.query;
  res.json(await listProposals(req.ctx, { status, kind, limit }));
});

planningRouter.get('/planning/proposals/:id', async (req, res) => {
  const proposal = await getProposal(req.ctx, req.params.id);
  res.json({ proposal, plan: await planBlockFor(req.ctx, proposal) });
});

planningRouter.post('/planning/proposals/:id/apply', async (req, res) => {
  const { option, force } = parseOrThrow(applyBody, req.body ?? {}, 'apply request');
  try {
    res.json(await applyProposal(req.ctx, req.params.id, { option, force }));
  } catch (err) {
    // The updated plan the Planner switches to gets its explanation like any new plan (best effort).
    if (err.code === 'PLAN_CHANGED') {
      await getProposal(req.ctx, err.details.proposalId)
        .then((fresh) => explainProposal(req.ctx, fresh))
        .catch((e) => logger.warn({ err: e }, 'updated plan explanation failed'));
    }
    throw err;
  }
});

planningRouter.post('/planning/proposals/:id/discard', async (req, res) => {
  res.json({ proposal: await discardProposal(req.ctx, req.params.id) });
});

planningRouter.post('/planning/proposals/:id/explain', async (req, res) => {
  if (req.ctx.role === 'view') throw forbidden('Viewers can read plans but not ask for explanations');
  const proposal = await getProposal(req.ctx, req.params.id);
  try {
    res.json({ explanation: await explainProposal(req.ctx, proposal) });
  } catch (err) {
    throw aiUnavailable(err);
  }
});

planningRouter.get('/planning/parts', async (req, res) => {
  if (!req.ctx.modules.includes('tools')) return res.json({ parts: [] });
  const mod = getModule('tools');
  const tools = await mod.Model.find(scopeFilter(req.ctx, mod))
    .select('toolNumber name status mouldParts assets')
    .sort({ toolNumber: 1 })
    .lean();
  const labels = await labelsFor(
    req.ctx,
    'assets',
    tools.flatMap((t) => t.assets ?? []),
  );
  const parts = new Map();
  for (const t of tools) {
    for (const part of t.mouldParts ?? []) {
      const key = part.partName.trim().toLowerCase();
      if (!parts.has(key)) parts.set(key, { partName: part.partName.trim(), tools: [] });
      const entry = parts.get(key);
      if (entry.tools.some((x) => x.id === String(t._id))) continue;
      entry.tools.push({
        id: String(t._id),
        toolNumber: t.toolNumber ?? null,
        name: t.name,
        status: t.status,
        assets: (t.assets ?? [])
          .map((a) => ({ id: String(a), label: labels.get(String(a)) }))
          .filter((a) => a.label),
      });
    }
  }
  res.json({ parts: [...parts.values()].sort((a, b) => a.partName.localeCompare(b.partName)) });
});
