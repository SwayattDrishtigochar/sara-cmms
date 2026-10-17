import { GoogleGenAI } from '@google/genai';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { canSpend, normalizeUsage, recordUsage, releaseSpend } from './budget.js';
import { mockGenerate, mockStream } from './mock.js';
import { thinkingConfigFor } from './models.js';
import { getAiSettings } from './settings.js';

/** No model could answer: `code` is 'AI_QUOTA' (rate limits, budget), 'AI_ERROR' (API failure) or 'AI_DISABLED'. */
export class AiUnavailableError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AiUnavailableError';
    this.code = code;
    this.status = { AI_QUOTA: 429, AI_ERROR: 502, AI_DISABLED: 403 }[code] ?? 503;
  }
}

/** A 429 whose retryDelay is longer than this switches models instead of waiting. */
const RETRY_MAX_SEC = 10;

let client = null;
let injected = null;

/** Scripted responses instead of Gemini (mock = scripted stand-in): AI_MOCK=true or no key. An injected test client always runs "for real". */
export const isMock = () => !injected && (env.AI_MOCK || !env.GEMINI_API_KEY);

export const getClient = () => {
  if (injected) return injected;
  client ??= new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
  return client;
};

/** Tests: a stand-in `{ models: { generateContent, generateContentStream, list } }` in place of the SDK; null restores it. */
export const _setClient = (client) => {
  injected = client ?? null;
};

/** Seconds from the `"retryDelay": "12s"` in a 429 body, or null when the error carries none. */
export const parseRetryDelaySec = (err) => {
  const match = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(String(err?.message ?? err ?? ''));
  return match ? Number(match[1]) : null;
};

const sleep = (ms, signal) =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

const tierOf = (settings, tier) => {
  const t = settings.tiers[tier];
  if (!t) throw new Error(`Unknown AI tier "${tier}"`);
  return t;
};

/** The API's own message out of the JSON body the SDK puts in `error.message`. */
const shortMessage = (err) => {
  const raw = String(err?.message ?? err ?? 'unknown error');
  try {
    return String(JSON.parse(raw)?.error?.message ?? raw).slice(0, 300);
  } catch {
    return raw.slice(0, 300);
  }
};

const baseConfig = ({ system, schema, tools, signal }) => ({
  ...(system ? { systemInstruction: system } : {}),
  ...(tools?.length ? { tools } : {}),
  ...(schema ? { responseMimeType: 'application/json', responseJsonSchema: schema } : {}),
  ...(signal ? { abortSignal: signal } : {}),
});

const parseJson = (text) =>
  JSON.parse(
    String(text ?? '')
      .replace(/^\s*```(?:json)?\s*/i, '')
      .replace(/\s*```\s*$/, ''),
  );

/**
 * Opens one call with tier routing: budget check, a short wait and one retry on a 429, then the tier's
 * fallback model (never for `background`). Refused and failed attempts are logged in ai_usage here; the
 * caller logs the successful one once it knows the usage.
 */
const openWithRouting = async ({ tier, purpose, companyId, signal, thinking, onAttempt }, open) => {
  const settings = await getAiSettings();
  const { model: primary, fallback, thinkingLevel } = tierOf(settings, tier);
  const level = thinking ?? thinkingLevel;
  const canFallBack = tier !== 'background' && Boolean(fallback) && fallback !== primary;
  let model = primary;
  let retried = false;
  const log = (status, extra = {}) => recordUsage({ model, purpose, companyId, status, ...extra });
  for (;;) {
    const budget = await canSpend(model, purpose);
    if (!budget.ok) {
      await log('blocked', { error: budget.reason });
      if (canFallBack && model === primary) {
        model = fallback;
        continue;
      }
      throw new AiUnavailableError('AI_QUOTA', budget.reason);
    }
    onAttempt?.({
      model,
      tier,
      thinkingLevel: level,
      fallbackFrom: model === primary ? null : primary,
      mock: false,
    });
    const started = Date.now();
    try {
      if (env.LOG_PROMPTS) logger.debug({ purpose, tier, model }, 'gemini request');
      return { value: await open(model, level, settings), model, started };
    } catch (err) {
      const latencyMs = Date.now() - started;
      if (signal?.aborted) {
        releaseSpend(model);
        throw err;
      }
      if (err?.status !== 429) {
        await log('error', { latencyMs, error: shortMessage(err) });
        throw new AiUnavailableError('AI_ERROR', `The AI service failed: ${shortMessage(err)}`);
      }
      await log('rate_limited', { latencyMs, error: shortMessage(err) });
      const delay = parseRetryDelaySec(err);
      if (!retried && delay != null && delay <= RETRY_MAX_SEC) {
        retried = true;
        await sleep(delay * 1000, signal);
        if (signal?.aborted) throw err;
        continue;
      }
      if (canFallBack && model === primary) {
        model = fallback;
        retried = false;
        continue;
      }
      throw new AiUnavailableError(
        'AI_QUOTA',
        'The AI models are busy right now. Please try again in a minute.',
      );
    }
  }
};

/**
 * One non-streaming call with tier routing, budget, 429 handling and usage logging.
 * `schema` (JSON Schema) switches on JSON mode and parses the answer into `json`.
 */
export const generate = async ({
  tier = 'fast',
  purpose,
  companyId = null,
  system,
  contents,
  schema,
  mockInput,
  signal,
  thinking,
  onAttempt,
}) => {
  if (isMock()) {
    const { model, thinkingLevel } = tierOf(await getAiSettings(), tier);
    onAttempt?.({ model, tier, thinkingLevel: thinking ?? thinkingLevel, fallbackFrom: null, mock: true });
    const started = Date.now();
    const { text, json, usage } = mockGenerate({ purpose, mockInput, schema, contents });
    const latencyMs = Date.now() - started;
    await recordUsage({ model, purpose, companyId, status: 'mock', usage, latencyMs });
    return { text, json, model, tier, usage, latencyMs, mock: true };
  }
  const open = (model, level) =>
    getClient().models.generateContent({
      model,
      contents,
      config: { ...baseConfig({ system, schema, signal }), thinkingConfig: thinkingConfigFor(model, level) },
    });
  const routing = { tier, purpose, companyId, signal, thinking, onAttempt };
  const { value: res, model, started } = await openWithRouting(routing, open);
  const latencyMs = Date.now() - started;
  const text = res.text ?? '';
  let json;
  if (schema) {
    try {
      json = parseJson(text);
    } catch {
      const error = 'The answer was not valid JSON';
      await recordUsage({
        model,
        purpose,
        companyId,
        status: 'error',
        usage: res.usageMetadata,
        latencyMs,
        error,
      });
      throw new AiUnavailableError('AI_ERROR', 'The AI answer was not valid JSON. Please try again.');
    }
  }
  await recordUsage({ model, purpose, companyId, status: 'ok', usage: res.usageMetadata, latencyMs });
  return { text, json, model, tier, usage: normalizeUsage(res.usageMetadata), latencyMs, mock: false };
};

/**
 * Streaming call (chat): yields the SDK chunks with the same routing, budget and 429 handling as `generate`
 * (a 429 while opening the stream falls back; one mid-stream throws). The final chunk's usage is recorded.
 */
export const generateStream = async function* ({
  tier = 'balanced',
  purpose = 'chat',
  companyId = null,
  system,
  contents,
  tools,
  signal,
  thinking,
  mockInput,
  onAttempt,
}) {
  const settings = await getAiSettings();
  if (isMock()) {
    const { model, thinkingLevel } = tierOf(settings, tier);
    onAttempt?.({ model, tier, thinkingLevel: thinking ?? thinkingLevel, fallbackFrom: null, mock: true });
    const started = Date.now();
    let last;
    for await (const chunk of mockStream({ contents, tools, mockInput, system })) {
      last = chunk;
      yield chunk;
    }
    const latencyMs = Date.now() - started;
    await recordUsage({ model, purpose, companyId, status: 'mock', usage: last?.usageMetadata, latencyMs });
    return;
  }
  const open = (model, level) =>
    getClient().models.generateContentStream({
      model,
      contents,
      config: {
        ...baseConfig({ system, tools, signal }),
        thinkingConfig: thinkingConfigFor(model, level, { includeThoughts: settings.showThoughts }),
      },
    });
  const routing = { tier, purpose, companyId, signal, thinking, onAttempt };
  const { value: stream, model, started } = await openWithRouting(routing, open);
  let last;
  let status = 'ok';
  let error = null;
  try {
    for await (const chunk of stream) {
      last = chunk;
      yield chunk;
    }
  } catch (err) {
    if (signal?.aborted) throw err;
    status = err?.status === 429 ? 'rate_limited' : 'error';
    error = shortMessage(err);
    const code = status === 'rate_limited' ? 'AI_QUOTA' : 'AI_ERROR';
    throw new AiUnavailableError(code, `The AI stream failed: ${error}`);
  } finally {
    const latencyMs = Date.now() - started;
    await recordUsage({ model, purpose, companyId, status, usage: last?.usageMetadata, latencyMs, error });
  }
};
