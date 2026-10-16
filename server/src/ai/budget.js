import { DateTime } from 'luxon';
import { AiUsage } from '../db/models/AiUsage.js';
import { FREE_TIER } from './models.js';
import { getAiSettings } from './settings.js';

/** Gemini quotas reset at midnight in this zone. */
const PACIFIC = 'America/Los_Angeles';
/** Limits for a model the superadmin has not configured. */
export const DEFAULT_LIMITS = { rpm: 10, rpd: 250 };
/** Purposes that must leave `chatReservePct` of every daily quota to the chat. */
export const BACKGROUND_PURPOSES = new Set([
  'anomaly',
  'investigation',
  'kpi',
  'cost',
  'briefing',
  'planning',
]);
/** Statuses that consumed a request on Google's side. */
const COUNTED = ['ok', 'error'];

export const pacificDay = (date = new Date()) => DateTime.fromJSDate(date, { zone: PACIFIC }).toISODate();
const pacificDayStart = () => DateTime.now().setZone(PACIFIC).startOf('day').toJSDate();

export const limitsFor = (model, limits = {}) => ({ ...DEFAULT_LIMITS, ...(limits[model] ?? {}) });

/** `{ prompt, thoughts, candidates, total }` from SDK usageMetadata or an already normalized object. */
export const normalizeUsage = (u = {}) => {
  const prompt = u.promptTokenCount ?? u.prompt ?? 0;
  const thoughts = u.thoughtsTokenCount ?? u.thoughts ?? 0;
  const candidates = u.candidatesTokenCount ?? u.candidates ?? 0;
  return {
    prompt,
    thoughts,
    candidates,
    total: u.totalTokenCount ?? u.total ?? prompt + thoughts + candidates,
  };
};

// ponytail: in-memory counters for one server process; move to Mongo counters if SARA ever runs several.
let minute = new Map(); // model → call timestamps of the last 60 s
// Pacific day → model → counted requests, and requests let through by canSpend not yet recorded.
let day = { key: null, counts: new Map(), pending: new Map() };

const seedDay = async () => {
  const key = pacificDay();
  if (day.key === key) return;
  const rows = await AiUsage.aggregate([
    { $match: { createdAt: { $gte: pacificDayStart() }, status: { $in: COUNTED } } },
    { $group: { _id: '$model', n: { $sum: 1 } } },
  ]);
  day = { key, counts: new Map(rows.map((r) => [r._id, r.n])), pending: new Map() };
};

/** Reserves one request for `model` now, or says why not (minute limit, daily limit, chat reserve). */
export const canSpend = async (model, purpose) => {
  const { limits, chatReservePct } = await getAiSettings();
  const { rpm, rpd } = limitsFor(model, limits);
  await seedDay();
  const now = Date.now();
  const stamps = (minute.get(model) ?? []).filter((t) => now - t < 60_000);
  minute.set(model, stamps);
  if (stamps.length >= rpm) {
    return {
      ok: false,
      reason: `${model} has reached its ${rpm} requests per minute. Please try again in a moment.`,
    };
  }
  // In-flight requests count too: parallel background calls must not all pass the cap at once.
  const pending = day.pending.get(model) ?? 0;
  const used = (day.counts.get(model) ?? 0) + pending;
  const background = BACKGROUND_PURPOSES.has(purpose);
  const cap = background ? Math.floor(rpd * (1 - chatReservePct / 100)) : rpd;
  if (used >= cap) {
    return {
      ok: false,
      reason: background
        ? `${model} has used ${used} of its ${rpd} daily requests; the rest is kept for chat until midnight Pacific.`
        : `${model} has used all ${rpd} of its daily requests. The quota resets at midnight Pacific.`,
    };
  }
  stamps.push(now);
  day.pending.set(model, pending + 1);
  return { ok: true };
};

/** Gives back a request canSpend let through that ended without a usage row (aborted while opening). */
export const releaseSpend = (model) => {
  const pending = day.pending.get(model) ?? 0;
  if (pending > 0) day.pending.set(model, pending - 1);
};

/** Writes one ai_usage row and keeps today's in-memory count in step. */
export const recordUsage = async ({
  model,
  purpose,
  companyId = null,
  status,
  usage,
  latencyMs = 0,
  error = null,
}) => {
  await AiUsage.create({
    model,
    purpose,
    companyId,
    status,
    tokens: normalizeUsage(usage),
    latencyMs,
    error: error ? String(error).slice(0, 500) : null,
    createdAt: new Date(),
  });
  if (day.key !== pacificDay()) return;
  // ok / error / rate_limited close a request canSpend let through ('blocked' and 'mock' never had one).
  if (COUNTED.includes(status) || status === 'rate_limited') releaseSpend(model);
  if (COUNTED.includes(status)) day.counts.set(model, (day.counts.get(model) ?? 0) + 1);
};

const count = (status) => ({ $sum: { $cond: [{ $eq: ['$status', status] }, 1, 0] } });

/** Today's (Pacific) usage per model, including configured models with no calls yet. */
export const usageToday = async () => {
  const { tiers, limits } = await getAiSettings();
  const rows = await AiUsage.aggregate([
    { $match: { createdAt: { $gte: pacificDayStart() } } },
    {
      $group: {
        _id: '$model',
        calls: { $sum: { $cond: [{ $in: ['$status', COUNTED] }, 1, 0] } },
        tokens: { $sum: '$tokens.total' },
        rateLimited: count('rate_limited'),
        errors: count('error'),
        blocked: count('blocked'),
        mock: count('mock'),
      },
    },
  ]);
  const byModel = new Map(rows.map((r) => [r._id, r]));
  const configured = Object.values(tiers).flatMap((t) => [t.model, t.fallback]);
  const ids = new Set([...configured.filter(Boolean), ...byModel.keys()]);
  return [...ids].sort().map((model) => {
    const r = byModel.get(model) ?? {};
    return {
      model,
      calls: r.calls ?? 0,
      tokens: r.tokens ?? 0,
      rateLimited: r.rateLimited ?? 0,
      errors: r.errors ?? 0,
      blocked: r.blocked ?? 0,
      mock: r.mock ?? 0,
      limits: limitsFor(model, limits),
      free: FREE_TIER.has(model),
    };
  });
};

/** Clears the in-memory counters (tests). */
export const _resetBudget = () => {
  minute = new Map();
  day = { key: null, counts: new Map(), pending: new Map() };
};
