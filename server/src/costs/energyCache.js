import { seriesFor } from '../telemetry/queries.js';

const TTL_MS = 60_000;

/**
 * Wraps a seriesFor-shaped fetch with a short in-memory cache keyed by every query argument (company,
 * sorted asset ids, fields, range, window, aggregate). The promise is cached at once, so concurrent
 * identical requests share one query; a failed query is dropped so the next call retries.
 * The asset ids come from the viewer's scope, so a plant-locked viewer gets its own entry.
 */
export const cacheSeries = (fetch, { ttlMs = TTL_MS, clock = Date.now } = {}) => {
  // ponytail: per-process Map, so each API process queries on its own; move to a shared cache (Redis) if
  // the API ever runs as several processes.
  const cache = new Map();
  return (companyId, assetIds, fields, opts = {}) => {
    const now = clock();
    const key = JSON.stringify([
      String(companyId),
      assetIds.map(String).sort(),
      fields,
      new Date(opts.start).getTime(),
      new Date(opts.stop).getTime(),
      opts.every,
      opts.fn,
    ]);
    const hit = cache.get(key);
    if (hit && now - hit.at < ttlMs) return hit.promise;
    for (const [k, v] of cache) if (now - v.at >= ttlMs) cache.delete(k);
    const entry = { at: now, promise: fetch(companyId, assetIds, fields, opts) };
    entry.promise.catch(() => cache.get(key) === entry && cache.delete(key));
    cache.set(key, entry);
    return entry.promise;
  };
};

/** seriesFor behind the 60 s cache: the Costs page asks for the same month of energy several times at once. */
export const cachedSeries = cacheSeries(seriesFor);
