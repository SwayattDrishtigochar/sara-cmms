import { Router } from 'express';
import { getBriefing } from '../briefing/briefing.js';
import { badRequest, forbidden } from '../lib/errors.js';
import { aiUnavailable } from './ai.js';

/** Command Center briefing (phase 5 §6); mounted at /api. */
export const briefingRouter = Router();

/**
 * A company-wide viewer may narrow the briefing to one of their plants (the header plant picker);
 * a plant-locked viewer always gets their own plant.
 */
const scopedCtx = (ctx, plantId) => {
  if (!plantId || ctx.plantLock) return ctx;
  const plant = ctx.plants.find((p) => String(p._id) === String(plantId));
  if (!plant) throw badRequest('That plant does not belong to your company');
  return { ...ctx, plantLock: plant._id };
};

const send = async (req, res, refresh) => {
  const plantId = refresh ? req.body?.plantId : req.query.plantId;
  try {
    res.json(await getBriefing(scopedCtx(req.ctx, plantId), { refresh }));
  } catch (err) {
    throw aiUnavailable(err);
  }
};

briefingRouter.get('/briefing', (req, res) => send(req, res, false));

briefingRouter.post('/briefing/refresh', (req, res) => {
  if (!['owner', 'admin'].includes(req.ctx.role))
    throw forbidden('Only owners and admins can regenerate the briefing');
  return send(req, res, true);
});
