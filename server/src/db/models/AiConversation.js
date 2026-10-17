import mongoose from 'mongoose';

const { ObjectId } = mongoose.Schema.Types;

export const TIER_PREFERENCES = ['auto', 'fast', 'balanced', 'deep'];

/** One chat thread of one user (phase 4 §1). */
const conversationSchema = new mongoose.Schema(
  {
    companyId: { type: ObjectId, required: true },
    userId: { type: ObjectId, required: true },
    plantId: { type: ObjectId, default: null },
    title: { type: String, default: '' },
    tierPreference: { type: String, enum: TIER_PREFERENCES, default: 'auto' },
    loadedGroups: { type: [String], default: [] },
    summary: { type: String, default: '' },
    summarizedUpTo: { type: Number, default: 0 },
    lastMessageAt: { type: Date, default: Date.now },
    deleted: { type: Boolean, default: false },
    voice: { type: Boolean, default: false }, // set by the first persisted voice turn (phase 8)
  },
  { collection: 'ai_conversations', timestamps: true, versionKey: false, minimize: false },
);
conversationSchema.index({ companyId: 1, userId: 1, lastMessageAt: -1 });

export const AiConversation =
  mongoose.models.AiConversation ?? mongoose.model('AiConversation', conversationSchema);
