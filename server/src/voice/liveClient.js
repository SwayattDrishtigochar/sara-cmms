import { canSpend, normalizeUsage, recordUsage } from '../ai/budget.js';
import { AiUnavailableError, getClient } from '../ai/gemini.js';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { CONNECT_TIMEOUT_MS } from './protocol.js';

/** One Gemini Live connection per voice session (phase 8 §3.1). The Live URL carries the key: never log it. */

let injected = null;

/** Tests: a LiveClientLike instead of the SDK (fakeLive, mockLive); null restores it. */
export const _setLiveClient = (client) => {
  injected = client ?? null;
};

/** Scripted Live (ai/mockLive.js) instead of Gemini: AI_MOCK=true or no key, unless a client is injected. */
export const isVoiceMock = () => !injected && (env.AI_MOCK || !env.GEMINI_API_KEY);

/** LiveClientLike = { connect({ model, config, callbacks }) → Promise<LiveSessionLike> }. */
export const liveApi = async () =>
  injected ?? (isVoiceMock() ? (await import('../ai/mockLive.js')).mockLive : getClient().live);

/** Start-of-speech sensitivity is the plant-floor noise knob: LOW = fewer false barge-ins from machine noise. */
export const VAD = Object.freeze({ startOfSpeechSensitivity: 'START_SENSITIVITY_LOW' });

/** The Live setup SARA sends: audio out in a female prebuilt voice, captions both ways, compression, resumption. */
export const buildLiveConfig = ({ system, declarations, voiceName, handle = null }) => ({
  responseModalities: ['AUDIO'],
  speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } },
  systemInstruction: system,
  tools: [{ functionDeclarations: declarations }],
  inputAudioTranscription: {},
  outputAudioTranscription: {},
  realtimeInputConfig: { automaticActivityDetection: VAD },
  contextWindowCompression: { slidingWindow: {} },
  sessionResumption: handle ? { handle } : {},
});

/** Adds one Live usageMetadata to { prompt (+ toolUsePromptTokenCount), thoughts, candidates (responseTokenCount), total }. */
export const addLiveUsage = (total, usageMetadata) => {
  const u = normalizeUsage(usageMetadata ?? {});
  u.prompt += usageMetadata?.toolUsePromptTokenCount ?? 0;
  for (const key of ['prompt', 'thoughts', 'candidates', 'total']) total[key] = (total[key] ?? 0) + u[key];
  return total;
};

/** Error text without URLs (the Live URL holds the API key), for logs and ai_usage. */
export const clean = (text) =>
  String(text ?? '')
    .replace(/\b(wss?|https?):\/\/\S+/gi, '[url]')
    .slice(0, 300);

const QUOTA = /RESOURCE_EXHAUSTED|quota|429|rate/i;

/** One connect attempt raced against an early close/error and CONNECT_TIMEOUT_MS. */
const attempt = (api, { model, config, callbacks }) =>
  new Promise((resolve, reject) => {
    let state = 'connecting';
    const fail = (err) => {
      if (state !== 'connecting') return;
      state = 'failed';
      clearTimeout(timer);
      reject(err);
    };
    const timer = setTimeout(() => fail(new Error('The Live connection timed out')), CONNECT_TIMEOUT_MS);
    const wrapped = {
      onmessage: (msg) => {
        if (state !== 'failed') callbacks.onmessage?.(msg);
      },
      onerror: (e) => {
        if (state === 'connecting') fail(new Error(clean(e?.message ?? e?.error?.message ?? 'Live error')));
        else if (state === 'open') callbacks.onerror?.(e);
      },
      onclose: (e) => {
        if (state === 'connecting')
          fail(new Error(clean(`Live closed (${e?.code ?? '?'}): ${e?.reason || 'no reason'}`)));
        else if (state === 'open') callbacks.onclose?.(e);
      },
    };
    Promise.resolve()
      .then(() => api.connect({ model, config, callbacks: wrapped }))
      .then(
        (session) => {
          if (state !== 'connecting') {
            session?.close?.(); // timed out or closed meanwhile: do not leak the late connection
            return;
          }
          state = 'open';
          clearTimeout(timer);
          resolve(session);
        },
        (err) => fail(new Error(clean(err?.message ?? err))),
      );
  });

/**
 * Opens one Live connection. Not mock: canSpend(model, 'voice') per attempt; the primary, then settings.voice.fallback
 * once (when set and different) on a refusal or any connect failure. Failures are recorded in ai_usage
 * (blocked / rate_limited / error). `models` overrides that order (a resumption handle only fits the model that
 * issued it). Throws AiUnavailableError('AI_QUOTA' | 'AI_ERROR').
 * @returns {Promise<{ session, model, connectMs, mock, fallbackFrom }>}
 */
export const openLive = async ({ settings, companyId = null, config, callbacks, models: only = null }) => {
  const mock = isVoiceMock();
  const api = await liveApi();
  const primary = settings.voice.model;
  const fallback = settings.voice.fallback;
  const models = only ?? (fallback && fallback !== primary ? [primary, fallback] : [primary]);
  let last = null;
  for (const model of models) {
    const log = (status, extra) => recordUsage({ model, purpose: 'voice', companyId, status, ...extra });
    if (!mock) {
      const budget = await canSpend(model, 'voice');
      if (!budget.ok) {
        await log('blocked', { error: budget.reason });
        last = new AiUnavailableError('AI_QUOTA', budget.reason);
        continue;
      }
    }
    const started = Date.now();
    try {
      const session = await attempt(api, { model, config, callbacks });
      return {
        session,
        model,
        connectMs: Date.now() - started,
        mock,
        fallbackFrom: model === primary ? null : primary,
      };
    } catch (err) {
      const reason = clean(err.message);
      const quota = QUOTA.test(reason);
      logger.warn({ model, reason }, 'Gemini Live connect failed');
      if (mock) throw new AiUnavailableError('AI_ERROR', `The AI service failed: ${reason}`);
      await log(quota ? 'rate_limited' : 'error', { latencyMs: Date.now() - started, error: reason });
      last = quota
        ? new AiUnavailableError(
            'AI_QUOTA',
            'The AI models are busy right now. Please try again in a minute.',
          )
        : new AiUnavailableError('AI_ERROR', `The AI service failed: ${reason}`);
    }
  }
  throw last;
};
