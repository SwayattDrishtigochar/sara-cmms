import { z } from 'zod';
import { env } from '../config/env.js';
import { PlatformSettings } from '../db/models/PlatformSettings.js';
import { parseOrThrow } from '../lib/errors.js';

export const TIERS = ['router', 'fast', 'balanced', 'deep', 'background'];
export const LEVELS = ['minimal', 'low', 'medium', 'high'];
/** A work order opens by itself after `afterScans` consecutive scans (critical: at once) from `minSeverity` up. */
export const DEFAULT_AUTO_WO = Object.freeze({ enabled: true, afterScans: 2, minSeverity: 'warning' });

/** Female prebuilt Gemini voices (shared by Live native audio and TTS); `style` is Google's one-word label. */
export const FEMALE_VOICES = Object.freeze([
  { name: 'Kore', style: 'Firm' },
  { name: 'Aoede', style: 'Breezy' },
  { name: 'Zephyr', style: 'Bright' },
  { name: 'Leda', style: 'Youthful' },
  { name: 'Callirrhoe', style: 'Easy-going' },
  { name: 'Autonoe', style: 'Bright' },
  { name: 'Despina', style: 'Smooth' },
  { name: 'Erinome', style: 'Clear' },
  { name: 'Laomedeia', style: 'Upbeat' },
  { name: 'Achernar', style: 'Soft' },
  { name: 'Gacrux', style: 'Mature' },
  { name: 'Pulcherrima', style: 'Forward' },
  { name: 'Vindemiatrix', style: 'Gentle' },
  { name: 'Sulafat', style: 'Warm' },
]);

/** `auto` = answer in the speaker's language; a code pins one language through the system instruction. */
export const VOICE_LANGUAGES = Object.freeze([
  { code: 'auto', label: 'Auto (match the speaker)', name: null },
  { code: 'en-IN', label: 'English (India)', name: 'English' },
  { code: 'hi-IN', label: 'हिन्दी · Hindi', name: 'Hindi' },
  { code: 'mr-IN', label: 'मराठी · Marathi', name: 'Marathi' },
  { code: 'gu-IN', label: 'ગુજરાતી · Gujarati', name: 'Gujarati' },
  { code: 'ta-IN', label: 'தமிழ் · Tamil', name: 'Tamil' },
  { code: 'te-IN', label: 'తెలుగు · Telugu', name: 'Telugu' },
  { code: 'kn-IN', label: 'ಕನ್ನಡ · Kannada', name: 'Kannada' },
  { code: 'ml-IN', label: 'മലയാളം · Malayalam', name: 'Malayalam' },
  { code: 'bn-IN', label: 'বাংলা · Bengali', name: 'Bengali' },
  { code: 'en-US', label: 'English (US)', name: 'English' },
  { code: 'en-GB', label: 'English (UK)', name: 'English' },
  { code: 'de-DE', label: 'Deutsch · German', name: 'German' },
  { code: 'fr-FR', label: 'Français · French', name: 'French' },
  { code: 'es-ES', label: 'Español · Spanish', name: 'Spanish' },
  { code: 'ar-XA', label: 'العربية · Arabic', name: 'Arabic' },
  { code: 'ja-JP', label: '日本語 · Japanese', name: 'Japanese' },
]);

export const DEFAULT_AI = Object.freeze({
  tiers: {
    router: { model: env.GEMINI_MODEL_ROUTER, thinkingLevel: null, fallback: null },
    fast: { model: env.GEMINI_MODEL_FAST, thinkingLevel: 'low', fallback: env.GEMINI_FALLBACK_FAST },
    balanced: {
      model: env.GEMINI_MODEL_BALANCED,
      thinkingLevel: 'medium',
      fallback: env.GEMINI_FALLBACK_BALANCED,
    },
    deep: { model: env.GEMINI_MODEL_DEEP, thinkingLevel: 'high', fallback: env.GEMINI_FALLBACK_DEEP },
    // Background work never falls back into the chat models.
    background: { model: env.GEMINI_MODEL_BACKGROUND, thinkingLevel: 'low', fallback: null },
  },
  limits: {}, // { [model]: { rpm, rpd } } copied from AI Studio by the superadmin; unknown models get budget.js defaults
  chatReservePct: env.AI_CHAT_RESERVE_PCT,
  showThoughts: true,
  anomaly: {
    enabled: true,
    tickSec: env.ANOMALY_SCAN_TICK_SEC,
    quietIntervalMin: env.ANOMALY_QUIET_INTERVAL_MIN,
    alwaysAskAi: false,
    investigate: true,
    autoWorkOrder: { ...DEFAULT_AUTO_WO },
  },
  costWatch: { enabled: true, intervalMin: env.COST_WATCH_INTERVAL_MIN },
  kpiInsightTtlMin: env.KPI_INSIGHT_TTL_MIN,
  briefingTtlHours: env.BRIEFING_TTL_HOURS,
  voice: {
    enabled: true,
    model: env.GEMINI_MODEL_VOICE,
    fallback: env.GEMINI_FALLBACK_VOICE,
    voiceName: 'Kore',
    languageCode: 'auto',
    maxSessionMin: 10,
    maxConcurrent: 3,
  },
});

const modelId = z.string().regex(/^[a-z0-9.-]+$/, 'Model ids use lowercase letters, digits, dots and dashes');
const tier = z.strictObject({
  model: modelId.optional(),
  thinkingLevel: z.enum(LEVELS).nullable().optional(),
  fallback: modelId.nullable().optional(),
});
const minutes = (max) => z.number().int().min(1).max(max);

export const aiPatchSchema = z.strictObject({
  tiers: z.strictObject(Object.fromEntries(TIERS.map((name) => [name, tier.optional()]))).optional(),
  limits: z
    .record(
      modelId,
      z.strictObject({
        rpm: z.number().int().min(1).max(100_000),
        rpd: z.number().int().min(1).max(10_000_000),
      }),
    )
    .optional(),
  chatReservePct: z.number().int().min(0).max(90).optional(),
  showThoughts: z.boolean().optional(),
  anomaly: z
    .strictObject({
      enabled: z.boolean().optional(),
      tickSec: z.number().int().min(15).max(3600).optional(),
      quietIntervalMin: minutes(1440).optional(),
      alwaysAskAi: z.boolean().optional(),
      investigate: z.boolean().optional(),
      autoWorkOrder: z
        .strictObject({
          enabled: z.boolean().optional(),
          afterScans: z.number().int().min(1).max(10).optional(),
          minSeverity: z.enum(['warning', 'critical']).optional(),
        })
        .optional(),
    })
    .optional(),
  costWatch: z
    .strictObject({ enabled: z.boolean().optional(), intervalMin: minutes(1440).optional() })
    .optional(),
  kpiInsightTtlMin: minutes(1440).optional(),
  briefingTtlHours: z.number().int().min(1).max(168).optional(),
  voice: z
    .strictObject({
      enabled: z.boolean().optional(),
      model: modelId.optional(),
      fallback: modelId.nullable().optional(),
      voiceName: z.enum(FEMALE_VOICES.map((v) => v.name)).optional(),
      languageCode: z.enum(VOICE_LANGUAGES.map((l) => l.code)).optional(),
      maxSessionMin: z.number().int().min(1).max(30).optional(),
      maxConcurrent: z.number().int().min(1).max(50).optional(),
    })
    .optional(),
});

const isPlain = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

/** Deep merge of plain objects; `limits` is replaced as a whole so a model's limits can be removed. */
const merge = (base, patch) => {
  const out = { ...base };
  for (const [key, value] of Object.entries(patch ?? {})) {
    out[key] = key !== 'limits' && isPlain(value) && isPlain(base?.[key]) ? merge(base[key], value) : value;
  }
  return out;
};

let cache = null;

/** The AI settings over DEFAULT_AI; the document is created from env on first read and cached until a save. */
export const getAiSettings = async () => {
  if (cache) return cache;
  const doc = await PlatformSettings.findOneAndUpdate(
    { _id: 'platform' },
    { $setOnInsert: { ai: structuredClone(DEFAULT_AI) } },
    { upsert: true, new: true },
  ).lean();
  cache = merge(DEFAULT_AI, doc.ai);
  return cache;
};

/** Validates a partial change (400 with readable issues otherwise), stores it and returns the full settings. */
export const saveAiSettings = async (patch, userId = null) => {
  const clean = parseOrThrow(aiPatchSchema, patch, 'AI settings');
  const next = merge(await getAiSettings(), clean);
  await PlatformSettings.updateOne(
    { _id: 'platform' },
    { $set: { ai: next, updatedBy: userId } },
    { upsert: true },
  );
  cache = null;
  return getAiSettings();
};

/** Forgets the cached settings (tests, or after editing the document directly). */
export const invalidateAiSettings = () => {
  cache = null;
};
