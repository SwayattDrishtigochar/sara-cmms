import mongoose from 'mongoose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { env } from '../src/config/env.js';
import {
  bucketFor,
  ensureBucket,
  influxEnabled,
  Point,
  pingInflux,
  writePoints,
} from '../src/config/influx.js';
import { connectMongo } from '../src/config/mongo.js';
import { subscribe } from '../src/lib/events.js';
import { getModule } from '../src/modules/registry.js';
import { cachedLatest, LIVE_TICK_MS, liveSnapshot, watchCompany } from '../src/telemetry/livePoller.js';

const influxUp = influxEnabled && (await pingInflux()) === 'up';
/** The poller's cache only warms when InfluxDB answers (or is not configured at all). */
const influxOk = influxUp || !influxEnabled;

const HOUR = 3_600_000;
const newId = () => new mongoose.Types.ObjectId();
const companyId = newId(); // also the throwaway InfluxDB bucket
const [P1, P2, A, B, U] = [newId(), newId(), newId(), newId(), newId()];
const raw = (name) => getModule(name).Model.collection;
const iso = (ms) => new Date(ms).toISOString();
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A point exactly as the simulator writes it: company/asset/status tags, numbers as floats. */
const point = (measurement, assetId, t, status, fields) => {
  const p = new Point(measurement)
    .tag('companyId', String(companyId))
    .tag('assetId', String(assetId))
    .tag('status', status)
    .timestamp(new Date(t));
  for (const [key, value] of Object.entries(fields)) p.floatField(key, value);
  return p;
};

const T0 = Date.now();
const events = [];
const ofType = (type) => events.filter((e) => e.type === type);
let live;
let unsubscribe;

beforeAll(async () => {
  await connectMongo();
  await mongoose.connection.dropDatabase();
  await getModule('companies').Model.create({ _id: companyId, name: 'Poller Test Co' });
  const since = new Date(T0 - HOUR);
  await raw('assets').insertMany([
    { _id: A, companyId, plantId: P1, name: 'IMM 1', assetStatus: 'Idle', assetStatusSince: since },
    { _id: B, companyId, plantId: P2, name: 'Press 1', assetStatus: 'OFF', assetStatusSince: since },
  ]);
  // Already there when the poller starts: remembered, never announced.
  await raw('notifications').insertOne({
    companyId,
    plantId: P1,
    message: { title: 'Old news' },
    recipientUsers: [U],
    createdAt: new Date(T0 - 5000),
  });
  if (influxUp) {
    await ensureBucket(bucketFor(companyId));
    await writePoints(bucketFor(companyId), [
      point('machineParams', A, T0 - 30_000, 'Idle', { oilTempPv: 41.5 }),
      point('energy', A, T0 - 10_000, 'Idle', { 'POWER TOTAL': 3.2 }),
      point('machineParams', B, T0 - 3 * HOUR, 'OFF', { press_speed: 0 }),
    ]);
  }
  unsubscribe = subscribe((event) => {
    if (event.companyId === String(companyId)) events.push(event);
  });
  live = watchCompany(companyId);
  await live.ready;
});

afterAll(async () => {
  live?.release();
  unsubscribe?.();
  if (influxUp) {
    const headers = { Authorization: `Token ${env.INFLUX_TOKEN}` };
    const found = await fetch(`${env.INFLUX_URL}/api/v2/buckets?name=${bucketFor(companyId)}`, { headers });
    for (const bucket of (await found.json()).buckets ?? []) {
      await fetch(`${env.INFLUX_URL}/api/v2/buckets/${bucket.id}`, { method: 'DELETE', headers });
    }
  }
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

describe('live poller', () => {
  it('primes its cache on the first look without announcing anything', () => {
    expect(events).toEqual([]);
    const a = liveSnapshot(companyId).find((s) => s.assetId === String(A));
    expect(a).toMatchObject({ plantId: String(P1), status: 'Idle', since: iso(T0 - HOUR) });
    if (!influxOk) return;
    const cache = cachedLatest(companyId);
    expect(cache.get(String(B))).toMatchObject({ status: 'OFF', plantId: String(P2) });
    if (!influxUp) return;
    // Each field keeps its own time; the 3-hour-old reading comes from the first, longer look back.
    expect(a.values).toEqual({ oilTempPv: 41.5, 'POWER TOTAL': 3.2 });
    expect(a.times).toEqual({ oilTempPv: T0 - 30_000, 'POWER TOTAL': T0 - 10_000 });
    expect(cache.get(String(A)).values.oilTempPv).toEqual({
      value: 41.5,
      time: iso(T0 - 30_000),
      measurement: 'machineParams',
    });
    expect(cache.get(String(B)).values.press_speed.value).toBe(0);
  });

  it('announces new readings, status changes and MongoDB changes to the right plant', async () => {
    const t = Date.now();
    const stamp = { createdAt: new Date(), updatedAt: new Date() };
    await raw('assets').updateOne(
      { _id: A },
      { $set: { assetStatus: 'Running', assetStatusSince: new Date(t) } },
    );
    await raw('notifications').insertOne({
      companyId,
      plantId: P1,
      message: { title: 'WO-7 assigned to you' },
      recipientUsers: [U],
      priority: 'high',
      ...stamp,
    });
    await raw('downtimes').insertOne({
      companyId,
      plantId: P2,
      assetId: B,
      startedAt: new Date(t - 60_000),
      endedAt: null,
      states: [{ status: 'Stopped', start: new Date(t - 60_000) }],
      totalDowntimeInSeconds: 60,
      requiresVerification: false,
      ...stamp,
    });
    await raw('workorders').insertOne({
      companyId,
      plantId: P1,
      name: 'Oil leak',
      workOrderId: 'WO-7',
      ...stamp,
    });
    await raw('productionplans').insertOne({ companyId, plantId: null, partName: 'Housing-A', ...stamp });
    if (influxUp) {
      await writePoints(bucketFor(companyId), [
        point('machineParams', A, t - 1000, 'Running', { oilTempPv: 44.25 }),
      ]);
    }

    await vi.waitFor(
      () => {
        expect(ofType('status')).toHaveLength(1);
        expect(ofType('notification')).toHaveLength(1);
        expect(ofType('downtime')).toHaveLength(1);
        expect(ofType('record')).toHaveLength(2);
        if (influxUp) expect(ofType('telemetry')).toHaveLength(1);
      },
      { timeout: 4 * LIVE_TICK_MS, interval: 100 },
    );

    expect(ofType('status')[0]).toMatchObject({
      payload: { assetId: String(A), status: 'Running', since: iso(t) },
      audience: { plantId: String(P1) },
    });
    expect(ofType('notification')[0]).toMatchObject({
      payload: { message: { title: 'WO-7 assigned to you' }, priority: 'high' },
      audience: { userIds: [String(U)], plantId: String(P1) },
    });
    expect(ofType('downtime')[0]).toMatchObject({
      payload: { assetId: String(B), status: 'Stopped', endedAt: null, totalDowntimeInSeconds: 60 },
      audience: { plantId: String(P2) },
    });
    // A record without a plant is company-wide: only users without a plant lock may hear of it.
    expect(
      ofType('record')
        .map((e) => [e.payload.module, e.audience.plantId])
        .sort(),
    ).toEqual([
      ['productionplans', null],
      ['workorders', String(P1)],
    ]);
    if (influxUp) {
      expect(ofType('telemetry')[0]).toMatchObject({
        payload: {
          assetId: String(A),
          status: 'Running',
          values: { oilTempPv: 44.25 }, // only the new reading: POWER TOTAL did not change
          times: { oilTempPv: t - 1000 },
          t: t - 1000,
        },
        audience: { plantId: String(P1) },
      });
      expect(Object.keys(ofType('telemetry')[0].payload.values)).toEqual(['oilTempPv']);
    }
  });

  it('announces each change once', async () => {
    const count = events.length;
    await pause(LIVE_TICK_MS + 500);
    expect(events).toHaveLength(count);
  });

  it('keeps polling while anyone listens and stops after the last one leaves', async () => {
    const second = watchCompany(companyId);
    live.release();
    live.release(); // releasing twice counts once
    if (influxOk) expect(cachedLatest(companyId)).not.toBeNull();
    second.release();
    expect(cachedLatest(companyId)).toBeNull();
    expect(liveSnapshot(companyId)).toEqual([]);

    const count = events.length;
    await raw('assets').updateOne(
      { _id: A },
      { $set: { assetStatus: 'Stopped', assetStatusSince: new Date() } },
    );
    await pause(LIVE_TICK_MS + 500);
    expect(events).toHaveLength(count);
  });
});
