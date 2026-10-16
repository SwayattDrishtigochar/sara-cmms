import { Router } from 'express';
import { scanCompany } from '../ai/anomaly/watch.js';
import { AppError, badRequest, forbidden } from '../lib/errors.js';
import { records } from '../modules/records.js';
import { getModule } from '../modules/registry.js';

/** AI endpoints for signed-in users; mounted at /api (phase 3 §3). */
export const aiRouter = Router();

/**
 * AiUnavailableError codes (ai/gemini.js) → HTTP statuses the UI can explain. Quota and disabled are
 * 4xx so their message reaches the user (the error handler masks 5xx messages).
 */
const AI_STATUS = { AI_QUOTA: 429, AI_DISABLED: 403, AI_ERROR: 503 };
export const aiUnavailable = (err) =>
  AI_STATUS[err?.code] && !err.status ? new AppError(AI_STATUS[err.code], err.code, err.message) : err;

aiRouter.post('/ai/scan', async (req, res) => {
  if (!['owner', 'admin'].includes(req.ctx.role)) throw forbidden('Only owners and admins can start a scan');
  try {
    res.json(await scanCompany(req.ctx.companyId, { force: true, reason: 'manual' }));
  } catch (err) {
    throw aiUnavailable(err);
  }
});

aiRouter.get('/ai/health', async (req, res) => {
  if (!req.query.assetId) throw badRequest('Pick an asset (assetId)');
  const asset = await records.get(req.ctx, 'assets', String(req.query.assetId), { populate: false });
  const Anomaly = getModule('anomalies').Model;
  const base = { companyId: req.ctx.companyId, assetId: asset._id, deleted: { $ne: true } };
  const [open, recent] = await Promise.all([
    Anomaly.find({ ...base, state: { $in: ['open', 'acknowledged'] } })
      .sort({ detectedAt: -1 })
      .lean(),
    Anomaly.find({ ...base, state: { $in: ['resolved', 'false_positive'] } })
      .sort({ resolvedAt: -1, detectedAt: -1 })
      .limit(10)
      .lean(),
  ]);
  res.json({
    asset: {
      id: String(asset._id),
      name: asset.name,
      status: asset.assetStatus ?? null,
      healthScore: asset.healthScore ?? null,
      healthSummary: asset.healthSummary ?? null,
      healthUpdatedAt: asset.healthUpdatedAt ?? null,
      healthModel: asset.healthModel ?? null,
    },
    anomalies: [...open, ...recent],
  });
});
