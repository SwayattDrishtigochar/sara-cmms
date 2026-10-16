import mongoose from 'mongoose';

/** Keys that never reach the model or the UI (prompt §7.4). */
export const REDACTED_KEYS = new Set([
  'password',
  'credentials',
  'authState',
  'headers',
  'keys',
  'token',
  'otp',
  'secret',
  'socketId',
  'telegram',
  'p256dh',
  'auth',
  'keyHash',
]);

const isObjectId = (v) =>
  v instanceof mongoose.Types.ObjectId || v?._bsontype === 'ObjectId' || v?._bsontype === 'ObjectID';

/** Drops secret keys recursively and turns ObjectIds into strings and Dates into ISO strings. */
export const redact = (value) => {
  if (value == null) return value;
  if (isObjectId(value)) return String(value);
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value === 'object') {
    if (Buffer.isBuffer(value) || value._bsontype) return undefined; // binary, decimals: not for the model
    const out = {};
    for (const [key, v] of Object.entries(value)) {
      if (REDACTED_KEYS.has(key)) continue;
      const clean = redact(v);
      if (clean !== undefined) out[key] = clean;
    }
    return out;
  }
  return value;
};
