import { createHash } from 'node:crypto';
import mongoose from 'mongoose';

/**
 * Deterministic ObjectId from a seed string, so re-seeding keeps the same ids
 * (and InfluxDB buckets/tags keyed by them stay valid).
 */
export const oid = (seed) =>
  new mongoose.Types.ObjectId(createHash('sha1').update(seed).digest('hex').slice(0, 24));

/** Small seeded PRNG (mulberry32). Same seed → same sequence. */
export const prng = (seed) => {
  let a =
    typeof seed === 'number' ? seed : [...String(seed)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7);
  const next = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    float: (min, max) => min + next() * (max - min),
    pick: (list) => list[Math.floor(next() * list.length)],
    chance: (p) => next() < p,
    /** Box–Muller normal sample. */
    normal: (mean = 0, sd = 1) =>
      mean + sd * Math.sqrt(-2 * Math.log(next() || 1e-9)) * Math.cos(2 * Math.PI * next()),
  };
};

export const isObjectIdString = (v) => typeof v === 'string' && /^[a-f0-9]{24}$/i.test(v);
