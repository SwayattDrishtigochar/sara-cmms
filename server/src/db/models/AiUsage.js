import mongoose from 'mongoose';

export const AI_PURPOSES = [
  'chat',
  'router',
  'title',
  'summary',
  'anomaly',
  'investigation',
  'kpi',
  'cost',
  'briefing',
  'planning',
  'voice',
  'test',
];
export const AI_STATUSES = ['ok', 'error', 'rate_limited', 'blocked', 'mock'];

/** One row per Gemini attempt (refused and mock ones too), kept 30 days for the quota tables. */
const aiUsageSchema = new mongoose.Schema(
  {
    model: { type: String, required: true },
    purpose: { type: String, required: true },
    companyId: { type: mongoose.Schema.Types.ObjectId, default: null },
    status: { type: String, enum: AI_STATUSES, required: true },
    tokens: {
      prompt: { type: Number, default: 0 },
      thoughts: { type: Number, default: 0 },
      candidates: { type: Number, default: 0 },
      total: { type: Number, default: 0 },
    },
    latencyMs: { type: Number, default: 0 },
    // Seconds of audio sent to / received from Gemini on one Live connection (voice only).
    audioSec: {
      in: { type: Number, default: 0 },
      out: { type: Number, default: 0 },
    },
    error: { type: String, default: null },
    createdAt: { type: Date, required: true },
  },
  { collection: 'ai_usage', minimize: false, versionKey: false },
);
aiUsageSchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 86_400 });
aiUsageSchema.index({ model: 1, createdAt: -1 });

export const AiUsage = mongoose.models.AiUsage ?? mongoose.model('AiUsage', aiUsageSchema);
