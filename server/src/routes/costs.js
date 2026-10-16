import { Router } from 'express';
import { z } from 'zod';
import { resolveTimeRange } from '../agent/tools/resolve.js';
import { systemContext } from '../context/buildUserContext.js';
import { evaluateAlert } from '../costs/alerts.js';
import { COMPONENTS, costSummary, GROUP_BYS } from '../costs/engine.js';
import { getCostOverview } from '../costs/overview.js';
import { PERIODS } from '../costs/periods.js';
import { forbidden, parseOrThrow } from '../lib/errors.js';
import { records } from '../modules/records.js';
import { aiUnavailable } from './ai.js';

/** Costs page endpoints (phase 5 §6); mounted at /api. Cost alert CRUD uses the generic /api/m/costalerts. */
export const costsRouter = Router();

const list = z
  .string()
  .optional()
  .transform((v) =>
    v
      ? v
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined,
  );
const summaryQuery = z.object({
  start: z.string().optional(),
  stop: z.string().optional(),
  text: z.string().max(120).optional(),
  groupBy: z.enum(GROUP_BYS).default('asset'),
  components: list.pipe(z.array(z.enum(COMPONENTS)).optional()),
  plantId: z.string().optional(),
  assetId: list,
});
const periodSchema = z.object({ period: z.enum(PERIODS).default('month') });

const assertManager = (ctx) => {
  if (!['owner', 'admin'].includes(ctx.role)) throw forbidden('Only owners and admins can do that');
};

costsRouter.get('/costs/summary', async (req, res) => {
  const q = parseOrThrow(summaryQuery, req.query, 'cost query');
  const range =
    q.start || q.stop
      ? resolveTimeRange({ start: q.start, stop: q.stop }, req.ctx)
      : resolveTimeRange({ text: q.text || 'this month' }, req.ctx);
  res.json(
    await costSummary(req.ctx, {
      start: range.start,
      stop: range.stop,
      groupBy: q.groupBy,
      components: q.components,
      plantId: q.plantId,
      assetIds: q.assetId,
    }),
  );
});

const overview = async (req, res, refresh) => {
  const { period } = parseOrThrow(periodSchema, refresh ? (req.body ?? {}) : req.query, 'period');
  try {
    res.json(await getCostOverview(req.ctx, { period, refresh }));
  } catch (err) {
    throw aiUnavailable(err);
  }
};

costsRouter.get('/costs/overview', (req, res) => overview(req, res, false));

costsRouter.post('/costs/overview/refresh', (req, res) => {
  assertManager(req.ctx);
  return overview(req, res, true);
});

/** Evaluates one alert now (as the system, like the watch, so a plant-locked admin stores the full value). */
costsRouter.post('/costs/alerts/:id/check', async (req, res) => {
  assertManager(req.ctx);
  const alert = await records.get(req.ctx, 'costalerts', req.params.id, { populate: false });
  const ctx = await systemContext(req.ctx.companyId);
  res.json(await evaluateAlert(ctx, alert, { fire: alert.enabled !== false }));
});
