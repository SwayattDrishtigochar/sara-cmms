import mongoose from 'mongoose';

const sessionSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company' },
    sessionId: { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true },
    ip: String,
    userAgent: String,
    expired: { type: Boolean, default: false },
  },
  { timestamps: true, collection: 'sessions' },
);

// MongoDB removes sessions once they expire.
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const Session = mongoose.models.Session ?? mongoose.model('Session', sessionSchema);
