import { Router } from 'express';
import { z } from 'zod';
import { QUOTA_STRETCH, QUOTA_STRETCH_AT } from '../ai/anomaly/watch.js';
import { pacificDay, usageToday } from '../ai/budget.js';
import { AiUnavailableError, generate, isMock } from '../ai/gemini.js';
import { listModels } from '../ai/models.js';
import { getAiSettings, saveAiSettings, TIERS } from '../ai/settings.js';
import { requireSuperAdmin } from '../auth/middleware.js';
import { env } from '../config/env.js';
import { parseOrThrow } from '../lib/errors.js';

/** Superadmin control of the AI layer: models per tier, quotas, background jobs, a test call and today's usage. */
export const adminAiRouter = Router();
adminAiRouter.use(requireSuperAdmin);

const testSchema = z.object({ tier: z.enum(TIERS).default('fast') });

adminAiRouter.get('/', async (_req, res) => {
  res.json({
    settings: await getAiSettings(),
    apiKeyConfigured: Boolean(env.GEMINI_API_KEY),
    mock: isMock(),
    // The anomaly watch's quota stretch: past `at` of the background budget, calm machines wait `factor`× longer.
    quotaStretch: { at: QUOTA_STRETCH_AT, factor: QUOTA_STRETCH },
  });
});

adminAiRouter.put('/', async (req, res) => {
  res.json({ settings: await saveAiSettings(req.body, req.user._id) });
});

adminAiRouter.get('/models', async (_req, res) => {
  const [models, settings] = await Promise.all([listModels(), getAiSettings()]);
  res.json({ models, tiers: settings.tiers });
});

adminAiRouter.post('/test', async (req, res) => {
  const { tier } = parseOrThrow(testSchema, req.body ?? {}, 'test request');
  const started = Date.now();
  try {
    const { model, latencyMs, text } = await generate({
      tier,
      purpose: 'test',
      contents: 'Reply in one short friendly sentence confirming that SARA can reach you.',
    });
    res.json({ ok: true, model, latencyMs, text, error: null });
  } catch (err) {
    if (!(err instanceof AiUnavailableError)) throw err;
    const { tiers } = await getAiSettings();
    res.json({
      ok: false,
      model: tiers[tier].model,
      latencyMs: Date.now() - started,
      text: null,
      error: err.message,
    });
  }
});

adminAiRouter.get('/usage', async (_req, res) => {
  res.json({ day: pacificDay(), models: await usageToday() });
});
