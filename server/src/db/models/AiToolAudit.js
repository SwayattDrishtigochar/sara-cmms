import mongoose from 'mongoose';

const { ObjectId, Mixed } = mongoose.Schema.Types;

/** Every tool call the agent made, with redacted arguments; kept 30 days. */
const auditSchema = new mongoose.Schema(
  {
    companyId: { type: ObjectId, required: true },
    userId: { type: ObjectId },
    conversationId: { type: ObjectId },
    messageId: { type: ObjectId },
    tool: { type: String, required: true },
    args: { type: Mixed, default: {} },
    durationMs: Number,
    rowCount: Number,
    ok: { type: Boolean, default: true },
    error: String,
  },
  { collection: 'ai_tool_audit', timestamps: { createdAt: true, updatedAt: false }, versionKey: false },
);
auditSchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 86_400 });
auditSchema.index({ companyId: 1, createdAt: -1 });

export const AiToolAudit = mongoose.models.AiToolAudit ?? mongoose.model('AiToolAudit', auditSchema);
