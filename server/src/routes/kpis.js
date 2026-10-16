import { Router } from 'express';
import { AiUnavailableError } from '../ai/gemini.js';
import { refreshInsights } from '../kpis/insights.js';
import { runKpi } from '../kpis/runner.js';
import { assertCan } from '../modules/permissions.js';
import { records } from '../modules/records.js';
import { getModule } from '../modules/registry.js';
import { aiUnavailable } from './ai.js';

/** KPI runs and insights (docs/phase5-contracts.md §6); mounted at /api. No create route: KPIs come from chat. */
export const kpisRouter = Router();

const kpiOf = (req) => records.get(req.ctx, 'kpis', req.params.id, { populate: false });

kpisRouter.get('/kpis/:id/run', async (req, res) => {
  const kpi = await kpiOf(req);
  res.json({ result: await runKpi(req.ctx, kpi) });
});

kpisRouter.post('/kpis/insights/refresh', async (req, res) => {
  try {
    res.json(await refreshInsights(req.ctx.companyId));
  } catch (err) {
    if (!(err instanceof AiUnavailableError)) throw err;
    res.json({ refreshed: 0, aiError: err.message });
  }
});

kpisRouter.post('/kpis/:id/explain', async (req, res) => {
  const kpi = await kpiOf(req);
  assertCan(req.ctx, getModule('kpis'), 'update');
  try {
    await refreshInsights(req.ctx.companyId, { kpiIds: [String(kpi._id)], force: true });
  } catch (err) {
    throw aiUnavailable(err);
  }
  const after = await kpiOf(req);
  res.json({ insight: after.insight ?? null });
});
