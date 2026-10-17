import mongoose from 'mongoose';

/** Normal band per asset type and field, written by the telemetry source (or set from an OEM manual). */
const parameterSpecSchema = new mongoose.Schema(
  {
    assetType: { type: String, required: true },
    measurement: { type: String, required: true },
    field: { type: String, required: true },
    unit: String,
    valueType: { type: String, enum: ['number', 'string', 'boolean'], default: 'number' },
    normalMin: Number,
    normalMax: Number,
  },
  { timestamps: true, collection: 'parameterspecs' },
);
parameterSpecSchema.index({ assetType: 1, measurement: 1, field: 1 }, { unique: true });

export const ParameterSpec =
  mongoose.models.ParameterSpec ?? mongoose.model('ParameterSpec', parameterSpecSchema);
