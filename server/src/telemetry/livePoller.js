import { plantAudience, publish } from '../lib/events.js';
import { logger } from '../lib/logger.js';
import { getModule } from '../modules/registry.js';
import { latestValues } from './queries.js';

/**
 * Feeds /api/live from the databases. The devices write MongoDB and InfluxDB directly, so every
 * 3 s, for each company somebody watches, this reads the newest InfluxDB readings and the MongoDB
 * changes since its last look and publishes them as live events for the record's plant.
 *
 * ponytail: one in-process poller per company and server instance (several instances would each
 * poll the same data); a shared publisher or change streams when that gets expensive.
 */

export const LIVE_TICK_MS = 3000;
/** The cache counts as warm while its last full look is at most this old. */
const WARM_MS = 3 * LIVE_TICK_MS;
/** The first look reaches back far enough to know every field's last reading; later looks only the recent ones. */
const PRIME_LOOKBACK = '-7d';
const TICK_LOOKBACK = '-2m';
/** Writers' clocks differ (the telemetry source follows MongoDB's), so each look re-reads this far back and skips what it saw. */
const LAG_MS = 60_000;
const ASSETS_PER_QUERY = 100;
const CHANGES_PER_LOOK = 500;

const Model = (name) => getModule(name).Model;
const pollers = new Map(); // companyId → poller state

const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());
const msOf = (date) => (date ? new Date(date).getTime() : null);

const notificationEvents = (companyId, docs) => {
  for (const doc of docs) {
    // Same audience as SARA's own notifyUsers: the recipients, inside the notification's plant.
    publish(companyId, 'notification', doc, {
      userIds: doc.recipientUsers?.length ? doc.recipientUsers.map(String) : undefined,
      plantId: doc.plantId ? String(doc.plantId) : undefined,
    });
  }
};

/** One event per machine and look: a backfill can rewrite hundreds of downtimes at once. */
const downtimeEvents = (companyId, docs) => {
  const latest = new Map(docs.map((d) => [String(d.assetId), d]));
  for (const d of latest.values()) {
    publish(
      companyId,
      'downtime',
      {
        id: String(d._id),
        assetId: String(d.assetId),
        status: d.states?.at(-1)?.status ?? null,
        startedAt: d.startedAt,
        endedAt: d.endedAt ?? null,
        totalDowntimeInSeconds: d.totalDowntimeInSeconds ?? 0,
        requiresVerification: Boolean(d.requiresVerification),
        isVerified: Boolean(d.isVerified),
      },
      plantAudience(d.plantId),
    );
  }
};

/** "Something changed in this module": one event per plant and look. */
const recordEvents = (module) => (companyId, docs) => {
  for (const plantId of new Set(docs.map((d) => (d.plantId ? String(d.plantId) : null)))) {
    publish(companyId, 'record', { module }, plantAudience(plantId));
  }
};

const SOURCES = [
  { module: 'notifications', field: 'createdAt', emit: notificationEvents },
  { module: 'downtimes', field: 'updatedAt', emit: downtimeEvents },
  ...['workorders', 'jobcards', 'requests', 'anomalies', 'productionplans'].map((module) => ({
    module,
    field: 'updatedAt',
    select: 'plantId updatedAt',
    emit: recordEvents(module),
  })),
];

/** Asset status and since from MongoDB; a change of either is a `status` event. */
const refreshAssets = async (state) => {
  const docs = await Model('assets')
    .find({ companyId: state.companyId, deleted: { $ne: true } })
    .select('plantId assetStatus assetStatusSince')
    .lean();
  const assets = new Map();
  for (const doc of docs) {
    const assetId = String(doc._id);
    const prev = state.assets.get(assetId);
    const entry = {
      assetId,
      plantId: doc.plantId ? String(doc.plantId) : null,
      status: doc.assetStatus ?? null,
      since: msOf(doc.assetStatusSince),
      values: prev?.values ?? {},
    };
    assets.set(assetId, entry);
    if (prev && (prev.status !== entry.status || prev.since !== entry.since)) {
      publish(
        state.companyId,
        'status',
        { assetId, status: entry.status, since: iso(entry.since) },
        plantAudience(entry.plantId),
      );
    }
  }
  state.assets = assets;
};

/** Newest InfluxDB reading per field, each with its own time; the newer ones become one `telemetry` event per asset. */
const refreshValues = async (state) => {
  const ids = [...state.assets.keys()];
  const lookback = state.valuesPrimed ? TICK_LOOKBACK : PRIME_LOOKBACK;
  for (let i = 0; i < ids.length; i += ASSETS_PER_QUERY) {
    const latest = await latestValues(state.companyId, ids.slice(i, i + ASSETS_PER_QUERY), { lookback });
    for (const [assetId, readings] of latest) {
      const entry = state.assets.get(assetId);
      const values = {};
      const times = {};
      for (const [field, reading] of Object.entries(readings)) {
        if (entry.values[field]?.time >= reading.time) continue;
        entry.values[field] = reading;
        values[field] = reading.value;
        times[field] = Date.parse(reading.time);
      }
      if (!state.valuesPrimed || !Object.keys(times).length) continue;
      publish(
        state.companyId,
        'telemetry',
        { assetId, status: entry.status, values, times, t: Math.max(...Object.values(times)) },
        plantAudience(entry.plantId),
      );
    }
  }
  state.valuesPrimed = true;
};

/** Documents of one source written since the last look, each once, oldest first. */
const changesOf = async (state, { module, field, select }) => {
  state.seen[module] ??= new Map();
  const seen = state.seen[module];
  const cursor = state.cursors[module] ?? state.startedAt;
  const query = Model(module)
    .find({ companyId: state.companyId, [field]: { $gt: new Date(cursor - LAG_MS) } })
    .sort({ [field]: 1 })
    .limit(CHANGES_PER_LOOK)
    .lean();
  if (select) query.select(select);
  const fresh = [];
  for (const doc of await query) {
    const t = msOf(doc[field]);
    const key = `${doc._id}:${t}`;
    if (seen.has(key)) continue;
    seen.set(key, t);
    // A future-dated document must not push the cursor past documents still to come.
    state.cursors[module] = Math.max(state.cursors[module] ?? cursor, Math.min(t, Date.now()));
    fresh.push(doc);
  }
  const floor = (state.cursors[module] ?? cursor) - 2 * LAG_MS;
  for (const [key, t] of seen) if (t < floor) seen.delete(key);
  return fresh;
};

/** The first look only remembers what exists; later looks publish what is new. */
const refreshChanges = async (state) => {
  const primed = state.changesPrimed;
  await Promise.all(
    SOURCES.map(async (source) => {
      const docs = await changesOf(state, source);
      if (primed && docs.length) source.emit(state.companyId, docs);
    }),
  );
  state.changesPrimed = true;
};

const warn = (state, err) => {
  if (state.lastError === err.message) return; // once per distinct problem, not every 3 s
  state.lastError = err.message;
  logger.warn({ err, companyId: state.companyId }, 'live poller could not read the latest data');
};

/** One look: machines (status, then values) and the MongoDB changes side by side. Never throws. */
const look = async (state) => {
  const settled = (promise) =>
    promise.then(
      () => true,
      (err) => {
        warn(state, err);
        return false;
      },
    );
  const [machines, changes] = await Promise.all([
    settled(refreshAssets(state).then(() => refreshValues(state))),
    settled(refreshChanges(state)),
  ]);
  if (machines) state.warmAt = Date.now();
  if (machines && changes) state.lastError = null;
};

const schedule = (state) => {
  state.timer = setTimeout(async () => {
    await look(state);
    if (!state.stopped) schedule(state);
  }, LIVE_TICK_MS);
};

const start = (companyId) => {
  const state = {
    companyId,
    listeners: 0,
    stopped: false,
    timer: null,
    startedAt: Date.now(),
    warmAt: 0,
    assets: new Map(), // assetId → { assetId, plantId, status, since (ms), values: { field: { value, time, measurement } } }
    valuesPrimed: false,
    changesPrimed: false,
    cursors: {},
    seen: {},
    lastError: null,
  };
  state.ready = look(state).then(() => {
    if (!state.stopped) schedule(state);
  });
  pollers.set(companyId, state);
  return state;
};

const stop = (state) => {
  state.stopped = true;
  clearTimeout(state.timer);
  if (pollers.get(state.companyId) === state) pollers.delete(state.companyId);
};

/**
 * Registers one /api/live listener of the company. The first starts its poller, the last `release()`
 * stops it. `ready` resolves (never rejects) once the first look is done.
 */
export const watchCompany = (companyId) => {
  const key = String(companyId);
  const state = pollers.get(key) ?? start(key);
  state.listeners += 1;
  let released = false;
  return {
    ready: state.ready,
    release: () => {
      if (released) return;
      released = true;
      state.listeners -= 1;
      if (state.listeners <= 0) stop(state);
    },
  };
};

/**
 * Latest state per asset id — { status, since (ms), values: { field: { value, time, measurement } } } —
 * while the company is watched and its cache is warm; null otherwise (then ask InfluxDB yourself).
 */
export const cachedLatest = (companyId) => {
  const state = pollers.get(String(companyId));
  return state && Date.now() - state.warmAt < WARM_MS ? state.assets : null;
};

/** What a new /api/live listener starts from: each known asset with its latest values and their times. */
export const liveSnapshot = (companyId) =>
  [...(pollers.get(String(companyId))?.assets.values() ?? [])].map(
    ({ assetId, plantId, status, since, values }) => {
      const fields = Object.entries(values);
      const times = Object.fromEntries(fields.map(([field, r]) => [field, Date.parse(r.time)]));
      const newest = Math.max(...Object.values(times));
      return {
        assetId,
        plantId,
        status,
        since: iso(since),
        values: Object.fromEntries(fields.map(([field, r]) => [field, r.value])),
        times,
        valuesAt: fields.length ? iso(newest) : null,
      };
    },
  );

/** Stops every poller (server shutdown). */
export const stopLivePollers = () => {
  for (const state of pollers.values()) stop(state);
};
