import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import { streamSse } from '../api/sse.js';

/** How much live history each numeric field keeps. */
export const HISTORY_MS = 15 * 60_000;
/** A reading older than this is no longer a current value (it stays in the history). */
export const STALE_MS = 2 * 60_000;
const MAX_BACKOFF_MS = 30_000;
const SWEEP_MS = 15_000;
const EMPTY = { status: null, since: null, values: {}, times: {}, valuesAt: null, history: {} };

const toMs = (value) => {
  if (value == null || value === '') return null;
  const ms = typeof value === 'number' ? value : Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
};

/**
 * Live machine state from `/api/live`. `connection` is idle | connecting | live | reconnecting | offline.
 * `assets[id]` = { status, since (ms), values: { field: value }, times: { field: ms }, valuesAt (ms of the
 * newest reading, fresh or not), history: { field: [[ms, value]] } }. `values` holds only readings younger
 * than STALE_MS. `clockOffset` = server clock − this browser's clock, from `hello`.
 */
export const useLiveStore = create(() => ({ connection: 'idle', assets: {}, clockOffset: 0 }));

/** Adds numeric values at time `t` to the per-field history and drops points older than 15 minutes. */
const appendHistory = (history, values, t) => {
  if (t == null) return history;
  let next = history;
  for (const [field, value] of Object.entries(values ?? {})) {
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    const prev = next[field] ?? [];
    if (prev.length && prev[prev.length - 1][0] >= t) continue; // duplicate or out of order
    const cut = t - HISTORY_MS;
    let keep = 0;
    while (keep < prev.length && prev[keep][0] < cut) keep += 1;
    if (next === history) next = { ...history };
    next[field] = [...prev.slice(keep), [t, value]];
  }
  return next;
};

/**
 * Merges readings, each at its own time (`times[field]`, else `fallbackT`), into an asset. A reading that is
 * not newer than the one held is ignored; one older than STALE_MS at `now` only moves `valuesAt`.
 */
const mergeReadings = (asset, values, times, fallbackT, now) => {
  const next = { ...asset, values: { ...asset.values }, times: { ...asset.times } };
  for (const [field, value] of Object.entries(values ?? {})) {
    const t = toMs(times?.[field]) ?? fallbackT;
    if (t == null) continue;
    next.valuesAt = Math.max(next.valuesAt ?? t, t);
    if (next.times[field] != null && t <= next.times[field]) continue;
    if (now - t > STALE_MS) continue;
    next.values[field] = value;
    next.times[field] = t;
    next.history = appendHistory(next.history, { [field]: value }, t);
  }
  return next;
};

/**
 * Pure reducer for one live event at local time `at`: returns the state patch, or null when the event
 * changes no state. Event shapes: hello { serverTime, snapshot: [{ assetId, status, since, values, times,
 * valuesAt }] }, telemetry { assetId, status, values, times, t }, status { assetId, status, since }.
 */
export const reduceLive = (state, type, data, at = Date.now()) => {
  if (type === 'hello') {
    const clockOffset = Number.isFinite(data?.serverTime) ? data.serverTime - at : (state.clockOffset ?? 0);
    const now = at + clockOffset;
    const assets = { ...state.assets };
    for (const snap of data?.snapshot ?? []) {
      const prev = assets[snap.assetId] ?? EMPTY;
      assets[snap.assetId] = {
        ...mergeReadings(prev, snap.values, snap.times, toMs(snap.valuesAt), now),
        status: snap.status ?? prev.status,
        since: toMs(snap.since) ?? prev.since,
      };
    }
    return { assets, connection: 'live', clockOffset };
  }
  if (!data?.assetId) return null;
  const now = at + (state.clockOffset ?? 0);
  const prev = state.assets[data.assetId] ?? EMPTY;
  if (type === 'status') {
    if (!data.status) return null;
    const since = toMs(data.since ?? data.at ?? data.t) ?? now;
    return { assets: { ...state.assets, [data.assetId]: { ...prev, status: data.status, since } } };
  }
  if (type === 'telemetry') {
    const t = toMs(data.t) ?? now;
    const changed = data.status && prev.status && data.status !== prev.status;
    const next = {
      ...mergeReadings(prev, data.values, data.times, t, now),
      status: data.status ?? prev.status,
      since: changed ? t : prev.since,
    };
    return { assets: { ...state.assets, [data.assetId]: next } };
  }
  return null;
};

/** Drops current values whose reading turned older than STALE_MS (history and `valuesAt` stay); null if none did. */
export const dropStale = (state, at = Date.now()) => {
  const now = at + (state.clockOffset ?? 0);
  let assets = null;
  for (const [id, asset] of Object.entries(state.assets)) {
    const stale = Object.keys(asset.times ?? {}).filter((field) => now - asset.times[field] > STALE_MS);
    if (!stale.length) continue;
    const values = { ...asset.values };
    const times = { ...asset.times };
    for (const field of stale) {
      delete values[field];
      delete times[field];
    }
    assets ??= { ...state.assets };
    assets[id] = { ...asset, values, times };
  }
  return assets && { assets };
};

/** Fills in readings from `GET /telemetry/latest` rows ({ values: { field: { value, time } } }) without overwriting fresher live data. */
export const seedLatest = (rows = [], at = Date.now()) =>
  useLiveStore.setState((state) => {
    const now = at + (state.clockOffset ?? 0);
    const assets = { ...state.assets };
    for (const row of rows) {
      const prev = assets[row.assetId] ?? EMPTY;
      const readings = Object.entries(row.values ?? {});
      const values = Object.fromEntries(readings.map(([field, r]) => [field, r?.value]));
      const times = Object.fromEntries(readings.map(([field, r]) => [field, r?.time]));
      assets[row.assetId] = {
        ...mergeReadings(prev, values, times, null, now),
        status: prev.status ?? row.status ?? null,
        since: prev.since ?? toMs(row.since),
      };
    }
    return { assets };
  });

/** Puts older points from `GET /telemetry/series` in front of the live history of one asset. */
export const seedHistory = (assetId, series = []) =>
  useLiveStore.setState((state) => {
    const prev = state.assets[assetId] ?? EMPTY;
    const history = { ...prev.history };
    for (const { field, points = [] } of series) {
      const live = history[field] ?? [];
      const first = live.length ? live[0][0] : Number.POSITIVE_INFINITY;
      const merged = [...points.filter(([t, v]) => t < first && typeof v === 'number'), ...live];
      const cut = (merged.at(-1)?.[0] ?? 0) - HISTORY_MS;
      history[field] = merged.filter(([t]) => t >= cut);
    }
    return { assets: { ...state.assets, [assetId]: { ...prev, history } } };
  });

// ── Raw event subscribers ────────────────────────────────────────────────────

const listeners = new Map();
const emit = (type, data) => {
  for (const fn of listeners.get(type) ?? []) {
    try {
      fn(data);
    } catch (err) {
      console.error(`live "${type}" handler failed`, err);
    }
  }
};

/** Calls `handler(data)` for every live event of `type` (status, telemetry, record, notification, downtime, …). */
export const useLiveEvent = (type, handler) => {
  const latest = useRef(handler);
  useEffect(() => {
    latest.current = handler;
  });
  useEffect(() => {
    const fn = (data) => latest.current(data);
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(fn);
    return () => listeners.get(type).delete(fn);
  }, [type]);
};

/** `record { module }` events refetch that module's TanStack queries (keys starting ['m', module]). Mount once. */
export const useRecordSync = () => {
  const qc = useQueryClient();
  useLiveEvent('record', (data) => {
    if (data?.module) qc.invalidateQueries({ queryKey: ['m', String(data.module)] });
  });
};

// ── Connection ───────────────────────────────────────────────────────────────

const pause = (ms, signal) =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

const run = async (signal) => {
  const set = useLiveStore.setState;
  for (let attempt = 0; !signal.aborted; attempt += 1) {
    set({ connection: attempt ? 'reconnecting' : 'connecting' });
    try {
      await streamSse('/live', {
        signal,
        onEvent: (type, data) => {
          if (type === 'hello') attempt = 0;
          const patch = reduceLive(useLiveStore.getState(), type, data);
          if (patch) set(patch);
          emit(type, data);
        },
      });
    } catch (err) {
      if (signal.aborted) return;
      if (err?.status === 401 || err?.status === 403) {
        set({ connection: 'offline' }); // signed out: the shell remounts (and reconnects) after sign-in
        return;
      }
    }
    if (signal.aborted) return;
    set({ connection: 'reconnecting' });
    await pause(Math.min(MAX_BACKOFF_MS, 1000 * 2 ** attempt) * (0.5 + Math.random() / 2), signal);
  }
};

let mounted = 0;
let stop = null;

/** Opens the single `/api/live` stream while any caller is mounted (the app shell); returns `connection`. */
export const useLiveConnection = () => {
  useEffect(() => {
    mounted += 1;
    if (mounted === 1) {
      const controller = new AbortController();
      run(controller.signal);
      // A machine that goes quiet must not keep showing its last reading as current.
      const sweep = setInterval(() => {
        const patch = dropStale(useLiveStore.getState());
        if (patch) useLiveStore.setState(patch);
      }, SWEEP_MS);
      stop = () => {
        controller.abort();
        clearInterval(sweep);
      };
    }
    return () => {
      mounted -= 1;
      if (mounted > 0) return;
      stop();
      stop = null;
      useLiveStore.setState({ connection: 'idle', assets: {} });
    };
  }, []);
  return useLiveStore((s) => s.connection);
};

/** Live state of one asset (undefined until the stream or a seed mentions it). */
export const useLiveAsset = (assetId) => useLiveStore((s) => s.assets[assetId]);

const COUNTED = {
  Running: 'Running',
  ON: 'Running',
  Idle: 'Idle',
  Stopped: 'Stopped',
  OFF: 'OFF',
  Maintenance: 'Maintenance',
};

/**
 * Selector factory: machines per status. With `assets` (REST rows `{ _id, assetStatus }`) it counts only
 * those machines and falls back to their stored status; without it, every asset the stream knows.
 */
export const selectStatusCounts = (assets) => (state) => {
  const counts = { Running: 0, Idle: 0, Stopped: 0, OFF: 0, Maintenance: 0 };
  const rows = assets ?? Object.keys(state.assets).map((_id) => ({ _id }));
  for (const row of rows) {
    const key = COUNTED[state.assets[row._id]?.status ?? row.assetStatus];
    if (key) counts[key] += 1;
  }
  return counts;
};

/** Status counts that re-render only when a count changes. */
export const useStatusCounts = (assets) => useLiveStore(useShallow(selectStatusCounts(assets)));
