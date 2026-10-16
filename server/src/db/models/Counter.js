import mongoose from 'mongoose';

/** Human-readable id sequences (WO-12, MR-3 …), one per company + plant + type, like CMMS. */
const counterSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, required: true },
    plantId: { type: mongoose.Schema.Types.ObjectId, default: null },
    type: { type: String, required: true },
    seq: { type: Number, default: 0 },
  },
  { collection: 'counters' },
);

counterSchema.index({ companyId: 1, plantId: 1, type: 1 }, { unique: true });

export const Counter = mongoose.models.Counter ?? mongoose.model('Counter', counterSchema);

/** Atomically takes the next number of a sequence. */
export const nextSeq = async ({ companyId, plantId = null, type }) => {
  const filter = { companyId, plantId: plantId ?? null, type };
  try {
    const doc = await Counter.findOneAndUpdate(
      filter,
      { $inc: { seq: 1 } },
      { upsert: true, new: true },
    ).lean();
    return doc.seq;
  } catch (err) {
    // Two first-time upserts can race on the unique index; the retry finds the doc.
    if (err.code !== 11000) throw err;
    const doc = await Counter.findOneAndUpdate(filter, { $inc: { seq: 1 } }, { new: true }).lean();
    return doc.seq;
  }
};
