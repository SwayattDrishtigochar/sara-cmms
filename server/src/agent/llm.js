import { env } from '../config/env.js';

/**
 * Where the agent gets its model from: `ai/gemini.js` (generate / generateStream, phase 3 §1).
 * Tests and `scripts/eval.js` swap in a scripted model with `setLlm`, so nothing reaches the real API.
 */
let override = null;
let real = null;
let settings = null;

export const setLlm = (impl) => {
  override = impl;
};

export const getLlm = async () => {
  if (override) return override;
  real ??= await import('../ai/gemini.js');
  return real;
};

const TIER_MODEL = {
  router: env.GEMINI_MODEL_ROUTER,
  fast: env.GEMINI_MODEL_FAST,
  balanced: env.GEMINI_MODEL_BALANCED,
  deep: env.GEMINI_MODEL_DEEP,
  background: env.GEMINI_MODEL_BACKGROUND,
};
const TIER_LEVEL = { router: null, fast: 'low', balanced: 'medium', deep: 'high', background: 'low' };

/** Model id, thinking level and thought visibility of a tier: platform settings when available, else env. */
export const tierInfo = async (tier) => {
  const fallback = { model: TIER_MODEL[tier], thinkingLevel: TIER_LEVEL[tier], showThoughts: true };
  if (override?.tierInfo) return { ...fallback, ...(await override.tierInfo(tier)) };
  try {
    settings ??= await import('../ai/settings.js');
    const current = await settings.getAiSettings();
    const t = current?.tiers?.[tier];
    if (!t?.model) return fallback;
    return {
      model: t.model,
      thinkingLevel: t.thinkingLevel ?? TIER_LEVEL[tier],
      showThoughts: current.showThoughts !== false,
    };
  } catch {
    return fallback; // settings module not there yet, or no database
  }
};

/** Errors `ai/gemini.js` throws when a model can't be used: code AI_QUOTA | AI_ERROR | AI_DISABLED. */
export const aiErrorCode = (err) =>
  err?.name === 'AiUnavailableError' || /^AI_/.test(err?.code ?? '') ? (err.code ?? 'AI_ERROR') : null;

/**
 * What the user reads when the model can't answer: never the raw API body. 402/429/RESOURCE_EXHAUSTED read as
 * quota, 503/UNAVAILABLE as busy, 401/403 as a key problem.
 */
export const friendlyAiError = (err) => {
  const raw = String(err?.message ?? '');
  // gemini.js's own sentences (budget reasons, "not valid JSON") are already written for people.
  if (raw && !/^The AI (service|stream) failed/.test(raw) && !raw.includes('{')) return raw;
  if (/\b(402|429)\b|RESOURCE_EXHAUSTED|quota|credits/i.test(raw))
    return 'The AI has used up its quota for now. Try again in a few minutes, or ask your admin to check the AI plan in Superadmin → AI.';
  if (/\b503\b|UNAVAILABLE|high demand|overloaded/i.test(raw))
    return 'The AI models are very busy right now. Please try again in a minute.';
  if (/\b(401|403)\b|PERMISSION_DENIED|API key|blocked/i.test(raw))
    return 'The AI service refused the request. Ask your admin to check the API key in Superadmin → AI.';
  return 'The AI service had a problem answering. Please try again.';
};

export const isAbort = (err) => err?.name === 'AbortError' || err?.code === 'ABORT_ERR';
