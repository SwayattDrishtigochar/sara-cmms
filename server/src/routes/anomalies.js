import { Router } from 'express';
import { z } from 'zod';
import { investigateAnomaly } from '../ai/anomaly/investigate.js';
import { parseOrThrow } from '../lib/errors.js';
import { plantAudience, publish } from '../lib/events.js';
import { assertCan } from '../modules/permissions.js';
import { records } from '../modules/records.js';
import { getModule } from '../modules/registry.js';
import { aiUnavailable } from './ai.js';

/** Anomaly actions beyond generic CRUD (/api/m/anomalies); mounted at /api. */
export const anomaliesRouter = Router();

const stateSchema = z.object({
  state: z.enum(['acknowledged', 'resolved', 'false_positive']),
  note: z.string().trim().max(2000).optional(),
});

/** The anomaly, if the caller may see it (tenant + plant rule) and change assets. */
const editable = async (req) => {
  const anomaly = await records.get(req.ctx, 'anomalies', req.params.id, { populate: false });
  assertCan(req.ctx, getModule('anomalies'), 'update');
  return anomaly;
};

anomaliesRouter.post('/anomalies/:id/investigate', async (req, res) => {
  const anomaly = await editable(req);
  try {
    res.json({ investigation: await investigateAnomaly(req.ctx.companyId, anomaly._id) });
  } catch (err) {
    throw aiUnavailable(err);
  }
});

anomaliesRouter.post('/anomalies/:id/state', async (req, res) => {
  const { state, note } = parseOrThrow(stateSchema, req.body, 'state change');
  const anomaly = await editable(req);
  await records.update(
    req.ctx,
    'anomalies',
    anomaly._id,
    { state, ...(note ? { notes: note } : {}) },
    { source: 'rest' },
  );
  const Anomaly = getModule('anomalies').Model;
  await Anomaly.updateOne(
    { _id: anomaly._id },
    { $set: state === 'acknowledged' ? { acknowledgedBy: req.ctx.userId } : { resolvedAt: new Date() } },
  );
  const after = await Anomaly.findById(anomaly._id).lean();
  publish(req.ctx.companyId, 'anomaly', { anomaly: after, change: 'state' }, plantAudience(after.plantId));
  res.json({ anomaly: after });
});
