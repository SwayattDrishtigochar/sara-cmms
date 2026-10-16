import mongoose from 'mongoose';

const { ObjectId, Mixed } = mongoose.Schema.Types;

/**
 * Cached AI texts that several viewers share (docs/phase5-contracts.md §2): the Command Center briefing
 * and the Costs page overview. `key` carries the scope (plant or "all", period), so a plant-locked viewer
 * never reads a text built from another plant's data. Stale texts stay readable as the AI-unavailable
 * fallback; rows unused for 30 days are dropped.
 */
const aiTextSchema = new mongoose.Schema(
  {
    companyId: { type: ObjectId, required: true },
    kind: { type: String, enum: ['briefing', 'cost_overview'], required: true },
    key: { type: String, required: true }, // e.g. "plant:<id>|2026-10-16" or "all|month:2026-10"
    json: { type: Mixed, required: true }, // the validated AI response
    evidence: { type: Mixed }, // the deterministic pack the text was written from
    model: { type: String },
    mock: { type: Boolean, default: false },
    at: { type: Date, required: true },
  },
  { collection: 'ai_texts', versionKey: false, minimize: false },
);
aiTextSchema.index({ companyId: 1, kind: 1, key: 1 }, { unique: true });
aiTextSchema.index({ at: 1 }, { expireAfterSeconds: 30 * 86_400 });

export const AiText = mongoose.models.AiText ?? mongoose.model('AiText', aiTextSchema);
