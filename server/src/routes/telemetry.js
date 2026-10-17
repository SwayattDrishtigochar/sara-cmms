import { setTimeout as delay } from 'node:timers/promises';
import { Router } from 'express';
import { stillSignedIn } from '../auth/middleware.js';
import { ParameterSpec } from '../db/models/ParameterSpec.js';
import { badRequest } from '../lib/errors.js';
import { subscribe } from '../lib/events.js';
import { openSse } from '../lib/sse.js';
import { records } from '../modules/records.js';
import { ENERGY_FIELDS, KEY_FIELDS, SHOT_FIELDS } from '../telemetry/catalog.js';
import { cachedLatest, liveSnapshot, watchCompany } from '../telemetry/livePoller.js';
import {
  discoverFields,
  latestValues,
  parseRange,
  pickWindow,
  seriesFor,
  statusTimeline,
} from '../telemetry/queries.js';

/** Machine telemetry for the web app; mounted at /api behind authenticate. */
export const telemetryRouter = Router();

const MAX_ASSETS = 100;
/** Window aggregates a chart may ask for (fn=…); without one each field uses its natural aggregate. */
const SERIES_FNS = ['mean', 'sum', 'max', 'min', 'last'];
/** How long a new /live stream waits for a cold company cache before saying hello anyway. */
const HELLO_WAIT_MS = 2000;
/** A /live stream re-checks the sign-in this often and ends once it is gone. */
const SESSION_CHECK_MS = 60_000;
/** Fields that are not averaged per chart window (interval energy and shot counters sum, totals take the last). */
const AGGREGATE_OF = new Map(
  [...ENERGY_FIELDS, ...SHOT_FIELDS].filter((f) => f.aggregate).map((f) => [f.field, f.aggregate]),
);

const fieldKey = (f) => `${f.measurement}\u0000${f.field}`;
const listParam = (value) => [
  ...new Set(
    String(value ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  ),
];
const iso = (value) => {
  const date = value == null ? null : new Date(value);
  return date && !Number.isNaN(date.getTime()) ? date.toISOString() : null;
};

/** Tenancy and plant-lock check: 404 unless the caller can see the asset. */
const assetFor = (req, id) => {
  if (!id) throw badRequest('Pick an asset (assetId)');
  return records.get(req.ctx, 'assets', String(id), { populate: false });
};

/** ParameterSpec rows for the asset type, then the fixed energy and shot fields its flags switch on. */
const knownFields = async (asset) => {
  const type = asset.typeOfAsset;
  const specs = await ParameterSpec.find({ assetType: type }).sort({ _id: 1 }).lean();
  const fields = specs.map((s) => ({
    measurement: s.measurement,
    field: s.field,
    unit: s.unit ?? null,
    valueType: s.valueType ?? 'number',
    normalMin: s.normalMin ?? null,
    normalMax: s.normalMax ?? null,
  }));
  const fixed = [
    ...(asset.isEnergyAsset
      ? ENERGY_FIELDS.filter((f) => !f.furnaceOnly || type === 'Furnace').map((f) => ({
          ...f,
          measurement: 'energy',
        }))
      : []),
    ...(asset.isProductionAsset ? SHOT_FIELDS.map((f) => ({ ...f, measurement: 'shotCountDetails' })) : []),
  ];
  const seen = new Set(fields.map(fieldKey));
  for (const f of fixed) {
    if (seen.has(fieldKey(f))) continue;
    fields.push({
      measurement: f.measurement,
      field: f.field,
      unit: f.unit,
      valueType: 'number',
      normalMin: null,
      normalMax: null,
    });
  }
  const keys = KEY_FIELDS[type] ?? [];
  return fields.map((f) => ({ ...f, key: keys.includes(f.field) }));
};

telemetryRouter.get('/telemetry/fields', async (req, res) => {
  const asset = await assetFor(req, req.query.assetId);
  const [fields, discovered] = await Promise.all([
    knownFields(asset),
    discoverFields(req.ctx.companyId, String(asset._id)).catch((err) => {
      req.log?.warn({ err }, 'field discovery failed');
      return [];
    }),
  ]);
  const seen = new Set(fields.map(fieldKey));
  for (const f of discovered) {
    // Status lives in the timeline, not in the parameter list.
    if (f.measurement === 'timelineData' || seen.has(fieldKey(f))) continue;
    fields.push({ ...f, unit: null, valueType: null, normalMin: null, normalMax: null, key: false });
  }
  res.json({ fields });
});

telemetryRouter.get('/telemetry/latest', async (req, res) => {
  const ids = listParam(req.query.assetIds);
  if (ids.length > MAX_ASSETS) throw badRequest(`Ask for ${MAX_ASSETS} assets or fewer`);
  const assets = ids.length
    ? await Promise.all(ids.map((id) => assetFor(req, id)))
    : (await records.list(req.ctx, 'assets', { limit: MAX_ASSETS, populate: false })).items;
  const assetIds = assets.map((a) => String(a._id));
  // While someone watches /live the poller holds every asset's latest readings; otherwise ask InfluxDB.
  const cache = cachedLatest(req.ctx.companyId);
  const influx = cache
    ? null
    : await latestValues(req.ctx.companyId, assetIds).catch((err) => {
        req.log?.warn({ err }, 'latest telemetry query failed');
        return new Map();
      });
  res.json({
    assets: assets.map((asset) => {
      const id = String(asset._id);
      const live = cache?.get(id);
      return {
        assetId: id,
        status: live ? live.status : (asset.assetStatus ?? null),
        since: iso(live ? live.since : asset.assetStatusSince),
        values: (live ? live.values : influx?.get(id)) ?? {}, // an asset newer than the cache has none yet
      };
    }),
  });
});

telemetryRouter.get('/telemetry/series', async (req, res) => {
  const asset = await assetFor(req, req.query.assetId);
  const { start, stop } = parseRange(req.query);
  const known = await knownFields(asset);
  const requested = listParam(req.query.fields);
  const fields = requested.length ? requested : [...new Set(known.filter((f) => f.key).map((f) => f.field))];
  if (!fields.length) throw badRequest('Pick at least one field (fields=…)');
  if (fields.length > 60) throw badRequest('Ask for 60 fields or fewer');
  const { fn } = req.query;
  if (fn !== undefined && !SERIES_FNS.includes(fn))
    throw badRequest(`fn must be one of ${SERIES_FNS.join(', ')}`);
  const every = pickWindow(start, stop);
  const byAggregate = Map.groupBy(fields, (field) => fn ?? AGGREGATE_OF.get(field) ?? 'mean');
  // One query takes ≤ 20 fields; Machine 360 seeds every numeric field (~35 on an IMM) at once.
  const batches = [...byAggregate].flatMap(([fn, names]) =>
    Array.from({ length: Math.ceil(names.length / 20) }, (_, i) => [fn, names.slice(i * 20, i * 20 + 20)]),
  );
  const results = await Promise.all(
    batches.map(([fn, names]) =>
      seriesFor(req.ctx.companyId, [String(asset._id)], names, { start, stop, every, fn }),
    ),
  );
  const unitOf = new Map(known.map((f) => [fieldKey(f), f.unit]));
  const series = results
    .flatMap((r) => r.series)
    .sort((a, b) => fields.indexOf(a.field) - fields.indexOf(b.field))
    .map(({ field, measurement, points }) => ({
      field,
      measurement,
      unit: unitOf.get(fieldKey({ measurement, field })) ?? null,
      points,
    }));
  res.json({ start, stop, every, series });
});

telemetryRouter.get('/telemetry/timeline', async (req, res) => {
  const asset = await assetFor(req, req.query.assetId);
  res.json(await statusTimeline(req.ctx.companyId, String(asset._id), parseRange(req.query)));
});

/**
 * SSE: `hello` with the live snapshot, then the company's events this user may see (live poller,
 * record changes). Ends once the sign-in behind it expires or the user is deleted.
 */
telemetryRouter.get('/live', async (req, res) => {
  const { ctx } = req;
  const companyId = String(ctx.companyId);
  const plantLock = ctx.plantLock ? String(ctx.plantLock) : null;
  const userId = ctx.userId ? String(ctx.userId) : null;
  // An event that names a plant (even null) only reaches users of that plant; plant-less ones are company-wide.
  const visible = ({ plantId, userIds, superAdmin } = {}) =>
    !(plantLock && plantId !== undefined && String(plantId) !== plantLock) &&
    !(userIds && !userIds.map(String).includes(userId)) &&
    !(superAdmin && ctx.role !== 'superAdmin');

  const sse = openSse(res);
  const live = watchCompany(companyId);
  let unsubscribe = () => {};
  const check = setInterval(async () => {
    const signedIn = await stillSignedIn(req).catch(() => true); // a database hiccup is not a sign-out
    if (!signedIn) sse.close();
  }, SESSION_CHECK_MS);
  res.on('close', () => {
    clearInterval(check);
    unsubscribe();
    live.release();
  });

  await Promise.race([live.ready, delay(HELLO_WAIT_MS)]);
  if (sse.closed) return;
  // Subscribing and saying hello in one synchronous step: no event falls between the snapshot and the stream.
  unsubscribe = subscribe((event) => {
    if (event.companyId === companyId && visible(event.audience)) sse.send(event.type, event.payload);
  });
  const snapshot = liveSnapshot(companyId);
  sse.send('hello', {
    serverTime: Date.now(),
    snapshot: plantLock ? snapshot.filter((s) => s.plantId === plantLock) : snapshot,
  });
});
