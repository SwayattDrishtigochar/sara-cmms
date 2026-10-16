import { logger } from '../lib/logger.js';
import { getClient, isMock } from './gemini.js';
import { getAiSettings, LEVELS } from './settings.js';

/** Supported thinking levels per model (ai.google.dev thinking table, 2026-10-15). */
export const THINKING_LEVELS = {
  'gemini-4-argon': ['low', 'medium', 'high'],
  'gemini-3.8-flash': ['low', 'medium', 'high'],
  'gemini-3.6-flash': ['minimal', 'low', 'medium', 'high'],
  'gemini-3.5-flash-lite': ['minimal', 'low', 'medium', 'high'],
  'gemini-3.1-pro-preview': ['low', 'medium', 'high'],
  'gemini-3-flash-preview': ['minimal', 'low', 'medium', 'high'],
};

/** Models with a free tier (pricing page, 2026-10-15). */
export const FREE_TIER = new Set([
  'gemini-3.8-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemini-2.5-pro',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
]);

/**
 * `{ thinkingLevel: 'LOW'…, includeThoughts }` with the level clamped to the model's nearest supported one
 * (ties go to the cheaper level); just `{ includeThoughts }` when the model has no table entry or no level is asked.
 */
export const thinkingConfigFor = (model, level, { includeThoughts = false } = {}) => {
  const supported = THINKING_LEVELS[model];
  const want = LEVELS.indexOf(String(level ?? '').toLowerCase());
  if (!supported || want < 0) return { includeThoughts };
  const distance = (name) => Math.abs(LEVELS.indexOf(name) - want);
  const nearest = supported.reduce((best, name) => (distance(name) < distance(best) ? name : best));
  return { thinkingLevel: nearest.toUpperCase(), includeThoughts };
};

const TTL_MS = 10 * 60_000;
let cached = { at: 0, ttl: 0, models: null };

const describe = (id, m = {}) => ({
  id,
  displayName: m.displayName ?? id,
  inputTokenLimit: m.inputTokenLimit ?? null,
  outputTokenLimit: m.outputTokenLimit ?? null,
  thinking: THINKING_LEVELS[id] ?? [],
  free: FREE_TIER.has(id),
});

/** Without the API: the models this file knows plus the configured ones. */
const knownModels = async () => {
  const { tiers } = await getAiSettings();
  const configured = Object.values(tiers).flatMap((t) => [t.model, t.fallback]);
  const ids = new Set([...Object.keys(THINKING_LEVELS), ...FREE_TIER, ...configured].filter(Boolean));
  return [...ids].sort().map((id) => describe(id));
};

const fetchModels = async () => {
  const out = [];
  for await (const m of await getClient().models.list({ config: { pageSize: 100 } })) {
    if (!m.supportedActions?.includes('generateContent')) continue;
    out.push(describe(String(m.name).replace(/^models\//, ''), m));
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
};

/** generateContent-capable models from the API, cached 10 minutes; the built-in list in mock mode or on failure. */
export const listModels = async () => {
  if (cached.models && Date.now() - cached.at < cached.ttl) return cached.models;
  let models;
  let ttl = TTL_MS;
  try {
    models = isMock() ? await knownModels() : await fetchModels();
  } catch (err) {
    logger.warn({ err: err.message }, 'listing Gemini models failed, using the built-in list');
    models = await knownModels();
    ttl = 60_000;
  }
  cached = { at: Date.now(), ttl, models };
  return models;
};
