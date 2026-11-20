import { Router } from 'express';
import { records } from '../modules/records.js';
import { optimize } from '../optimizer/optimizer.js';
import { aiUnavailable } from './ai.js';

/** AI production optimizer for one machine; mounted at /api. */
export const optimizerRouter = Router();

optimizerRouter.get('/optimizer/:assetId', async (req, res) => {
  // Tenancy and plant lock as in the telemetry routes: 404 unless the caller can see the asset.
  const asset = await records.get(req.ctx, 'assets', req.params.assetId, { populate: false });
  const refresh = ['1', 'true'].includes(String(req.query.refresh));
  try {
    res.json(await optimize(req.ctx, asset, { refresh }));
  } catch (err) {
    throw aiUnavailable(err);
  }
});
