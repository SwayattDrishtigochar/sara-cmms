import mongoose from 'mongoose';

const RESYNC_MS = 60_000;
let offset = 0; // MongoDB's clock − this host's clock, in ms
let syncedAt = 0;
let pending = null;

const measure = async () => {
  try {
    const sent = Date.now();
    const { localTime } = await mongoose.connection.db.admin().command({ hello: 1 });
    offset = new Date(localTime).getTime() - (sent + Date.now()) / 2;
  } catch {
    // keep the previous offset
  }
};

/**
 * Now by MongoDB's clock (ms). The telemetry source stamps heartbeats and telemetry with that clock
 * (a Pi has no RTC), so "online", "fresh" and injection timing compare against it, not against this host,
 * whose clock may differ. The offset is re-measured at most once a minute; on failure the last one stays.
 */
export const dbNow = async () => {
  if (!pending && Date.now() - syncedAt > RESYNC_MS && mongoose.connection.readyState === 1) {
    syncedAt = Date.now();
    pending = measure().finally(() => {
      pending = null;
    });
  }
  if (pending) await pending;
  return Math.round(Date.now() + offset);
};
