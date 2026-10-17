import mongoose from 'mongoose';

const { ObjectId, Mixed } = mongoose.Schema.Types;

export const MESSAGE_STATUSES = ['streaming', 'complete', 'stopped', 'error', 'awaiting_confirmation'];
export const ACTION_STATUSES = ['pending', 'confirmed', 'rejected', 'expired'];

/**
 * One user or assistant message (phase 4 §1). `parts` is what the UI renders, `gemini` the raw model/user
 * contents of the turn after the user text (thought signatures kept, replayed as history).
 */
const messageSchema = new mongoose.Schema(
  {
    conversationId: { type: ObjectId, required: true },
    companyId: { type: ObjectId, required: true },
    userId: { type: ObjectId, required: true },
    role: { type: String, enum: ['user', 'assistant'], required: true },
    text: { type: String, default: '' },
    context: { type: Mixed, default: null }, // { page, recordRef: { module, id } }
    parts: { type: [Mixed], default: [] },
    gemini: { type: [Mixed], default: [] },
    model: String,
    tier: String,
    thinkingLevel: String,
    routerDecision: { type: Mixed, default: null },
    usage: {
      prompt: { type: Number, default: 0 },
      thoughts: { type: Number, default: 0 },
      candidates: { type: Number, default: 0 },
      total: { type: Number, default: 0 },
    },
    latencyMs: Number,
    status: { type: String, enum: MESSAGE_STATUSES, default: 'complete' },
    channel: { type: String, enum: ['text', 'voice'], default: 'text' },
    // { id, tool, args, callId, callIndex, siblingResponses: [Part], preview, status, expiresAt, result }
    pendingAction: { type: Mixed, default: null },
  },
  { collection: 'ai_messages', timestamps: true, versionKey: false, minimize: false },
);
messageSchema.index({ conversationId: 1, createdAt: 1 });
messageSchema.index({ 'pendingAction.id': 1 }, { sparse: true });

export const AiMessage = mongoose.models.AiMessage ?? mongoose.model('AiMessage', messageSchema);
