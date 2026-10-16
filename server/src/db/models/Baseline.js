import mongoose from 'mongoose';

const { ObjectId } = mongoose.Schema.Types;

/**
 * Normal behaviour of one asset field in one machine status: statistics of the last 7 days of
 * 1-minute means (phase 3 §2). Refreshed by the anomaly watch, read by the feature screens.
 */
const baselineSchema = new mongoose.Schema(
  {
    companyId: { type: ObjectId, required: true },
    assetId: { type: ObjectId, required: true },
    measurement: { type: String, required: true },
    field: { type: String, required: true },
    status: { type: String, required: true },
    mean: Number,
    std: Number,
    p5: Number,
    p95: Number,
    n: Number,
    computedAt: { type: Date, required: true },
  },
  { collection: 'baselines', versionKey: false },
);
baselineSchema.index({ companyId: 1, assetId: 1, measurement: 1, field: 1, status: 1 }, { unique: true });

export const Baseline = mongoose.models.Baseline ?? mongoose.model('Baseline', baselineSchema);
