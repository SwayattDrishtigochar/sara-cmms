import mongoose from 'mongoose';
import { logger } from '../../lib/logger.js';

/**
 * One compact record per scan in the capped collection `ai_scan_log`: the table rows of the flagged
 * assets, what the model answered for them, what the guardrails dropped and why, and the stats. It
 * is how a "nothing found" scan is read back without re-spending a Gemini call. Never the key.
 */

const NAME = 'ai_scan_log';
const SIZE_BYTES = 4 * 1024 * 1024;
let ready = null;

const collection = async () => {
  const db = mongoose.connection.db;
  ready ??= db.createCollection(NAME, { capped: true, size: SIZE_BYTES, max: 400 }).catch((err) => {
    if (err?.codeName === 'NamespaceExists' || err?.code === 48) return;
    ready = null; // a transient failure is retried on the next scan, not cached
    throw err;
  });
  await ready;
  return db.collection(NAME);
};

/** Appends one record; a failure is logged, never fails the scan. */
export const logScan = async (record) => {
  try {
    await (await collection()).insertOne({ at: new Date(), ...record });
  } catch (err) {
    logger.warn({ err }, 'scan log write failed');
  }
};

/** The newest `limit` records, newest first. */
export const recentScans = async (limit = 20) =>
  (await collection()).find().sort({ $natural: -1 }).limit(limit).toArray();
