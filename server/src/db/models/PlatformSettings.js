import mongoose from 'mongoose';

/** Platform-wide settings, one document (`_id: 'platform'`); `ai` holds the AI layer settings (ai/settings.js). */
const platformSettingsSchema = new mongoose.Schema(
  {
    _id: { type: String, default: 'platform' },
    ai: { type: mongoose.Schema.Types.Mixed, default: {} },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { collection: 'platformsettings', timestamps: true, minimize: false, versionKey: false },
);

export const PlatformSettings =
  mongoose.models.PlatformSettings ?? mongoose.model('PlatformSettings', platformSettingsSchema);
