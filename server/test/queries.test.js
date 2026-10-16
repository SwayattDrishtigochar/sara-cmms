import mongoose from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { env } from '../src/config/env.js';
import {
  bucketFor,
  ensureBucket,
  influxEnabled,
  Point,
  pingInflux,
  writePoints,
} from '../src/config/influx.js';
import {
  discoverFields,
  latestValues,
  parseRange,
  pickWindow,
  seriesFor,
  statusTimeline,
} from '../src/telemetry/queries.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const UNIT_MS = { s: 1000, m: MIN, h: HOUR, d: DAY };
const toMs = (duration) => Number(duration.slice(0, -1)) * UNIT_MS[duration.at(-1)];
const newId = () => new mongoose.Types.ObjectId().toString();
const EVIL = 'x") |> drop()';

describe('pickWindow', () => {
  const expected = { '15m': '10s', '1h': '30s', '6h': '5m', '24h': '5m', '7d': '1h', '30d': '3h' };

  it.each(Object.keys(expected))('keeps %s at or under 300 points', (range) => {
    const { start, stop } = parseRange({ range });
    const every = pickWindow(start.getTime(), stop.getTime());
    expect(every).toBe(expected[range]);
    expect(Math.ceil((stop - start) / toMs(every)) + 1).toBeLessThanOrEqual(300);
  });

  it('honours a smaller point budget', () => {
    expect(pickWindow(0, DAY, 50)).toBe('30m');
  });
});

describe('parseRange', () => {
  it('defaults to the last 24 hours', () => {
    const { start, stop } = parseRange({});
    expect(Math.abs(stop.getTime() - Date.now())).toBeLessThan(1000);
    expect(stop - start).toBe(DAY);
  });

  it('takes a quick range, optionally ending at a given stop', () => {
    const stop = '2026-10-15T06:30:00.000Z';
    const r = parseRange({ range: '7d', stop });
    expect(r.stop.toISOString()).toBe(stop);
    expect(r.stop - r.start).toBe(7 * DAY);
  });

  it('takes an explicit start and stop as ISO or epoch ms', () => {
    const r = parseRange({ start: '2026-10-14T00:00:00Z', stop: String(Date.parse('2026-10-15T00:00:00Z')) });
    expect(r.start.toISOString()).toBe('2026-10-14T00:00:00.000Z');
    expect(r.stop.toISOString()).toBe('2026-10-15T00:00:00.000Z');
  });

  it.each([
    [{ range: 'forever' }],
    [{ range: 'constructor' }],
    [{ start: 'not a date' }],
    [{ start: '2026-10-15T00:00:00Z', stop: '2026-10-14T00:00:00Z' }],
    [{ start: '2026-01-01T00:00:00Z', stop: '2026-10-01T00:00:00Z' }],
  ])('rejects %j', (input) => {
    expect(() => parseRange(input)).toThrow(expect.objectContaining({ status: 400 }));
  });
});

describe('input checks', () => {
  const companyId = newId();

  it.each([EVIL, `${'a'.repeat(23)}"`, 'x\\") |> drop()'])(
    'rejects the asset id %s before querying',
    async (id) => {
      await expect(latestValues(companyId, [id])).rejects.toMatchObject({ status: 400 });
      await expect(seriesFor(companyId, [id], ['oilTempPv'])).rejects.toMatchObject({ status: 400 });
      await expect(statusTimeline(companyId, id, parseRange({}))).rejects.toMatchObject({ status: 400 });
      await expect(discoverFields(companyId, id)).rejects.toMatchObject({ status: 400 });
    },
  );

  it('rejects bad field names, windows and aggregates', async () => {
    const id = newId();
    await expect(seriesFor(companyId, [id], [EVIL])).rejects.toMatchObject({ status: 400 });
    await expect(seriesFor(companyId, [id], [])).rejects.toMatchObject({ status: 400 });
    await expect(seriesFor(companyId, [id], ['a'], { every: '7m' })).rejects.toMatchObject({ status: 400 });
    await expect(seriesFor(companyId, [id], ['a'], { fn: 'drop' })).rejects.toMatchObject({ status: 400 });
  });
});

const influxUp = influxEnabled && (await pingInflux()) === 'up';

describe.skipIf(!influxUp)('queries against InfluxDB', () => {
  const companyId = newId(); // throwaway bucket, deleted afterwards
  const A = newId();
  const B = newId();
  const NOW = Date.now();
  const H0 = Math.floor((NOW - 6 * HOUR) / HOUR) * HOUR; // an hour boundary, so 1h windows are predictable
  const ago = (hours) => NOW - hours * HOUR;

  // Mirrors the simulator's writes: company/asset/status tags, numbers always float.
  const point = (measurement, assetId, t, status, fields) => {
    const p = new Point(measurement)
      .tag('companyId', companyId)
      .tag('assetId', assetId)
      .tag('status', status)
      .timestamp(new Date(t));
    for (const [key, value] of Object.entries(fields)) {
      if (typeof value === 'number') p.floatField(key, value);
      else p.stringField(key, value);
    }
    return p;
  };
  const status = (hoursAgo, value) => point('timelineData', A, ago(hoursAgo), value, { assetStatus: value });

  beforeAll(async () => {
    await ensureBucket(bucketFor(companyId));
    await writePoints(bucketFor(companyId), [
      point('machineParams', A, H0 + 10 * MIN, 'Running', { oilTempPv: 10, toolName: 'Mould A' }),
      point('machineParams', A, H0 + 20 * MIN, 'Idle', { oilTempPv: 40 }),
      point('machineParams', A, H0 + 30 * MIN, 'Running', { oilTempPv: 10 }),
      point('machineParams', A, H0 + 70 * MIN, 'Idle', { oilTempPv: 50, toolName: 'Mould B' }),
      point('energy', A, H0 + 15 * MIN, 'Running', { 'POWER TOTAL': 5, 'ENERGY CONSUMPTION': 0.5 }),
      point('energy', A, H0 + 45 * MIN, 'Idle', { 'POWER TOTAL': 7, 'ENERGY CONSUMPTION': 0.25 }),
      point('machineParams', B, H0 + 5 * MIN, 'Running', { oilTempPv: 33 }),
      status(30, 'OFF'),
      status(5, 'Running'),
      status(3, 'Stopped'),
      status(2.5, 'Running'),
      status(2, 'Running'),
      status(1.5, 'OFF'),
      status(0.5, 'Idle'),
    ]);
  });

  afterAll(async () => {
    const headers = { Authorization: `Token ${env.INFLUX_TOKEN}` };
    const found = await fetch(`${env.INFLUX_URL}/api/v2/buckets?name=${bucketFor(companyId)}`, { headers });
    for (const bucket of (await found.json()).buckets ?? []) {
      await fetch(`${env.INFLUX_URL}/api/v2/buckets/${bucket.id}`, { method: 'DELETE', headers });
    }
  });

  it('returns the newest value per field across status series, without timelineData', async () => {
    const latest = await latestValues(companyId, [A, B]);
    const a = latest.get(A);
    expect(a.oilTempPv).toEqual({
      value: 50,
      time: new Date(H0 + 70 * MIN).toISOString(),
      measurement: 'machineParams',
    });
    expect(a.toolName.value).toBe('Mould B');
    expect(a['POWER TOTAL']).toMatchObject({ value: 7, measurement: 'energy' });
    expect(a['ENERGY CONSUMPTION'].value).toBe(0.25);
    expect(a.assetStatus).toBeUndefined();
    expect(latest.get(B).oilTempPv.value).toBe(33);
  });

  it('reads a company without a bucket as empty', async () => {
    const latest = await latestValues(newId(), [A]);
    expect(latest.get(A)).toEqual({});
  });

  it('builds one numeric series per field, merging status series and skipping strings', async () => {
    const range = { start: new Date(H0), stop: new Date(H0 + 2 * HOUR), every: '1h' };
    const result = await seriesFor(companyId, [A], ['oilTempPv', 'toolName', 'POWER TOTAL'], range);
    expect(result.every).toBe('1h');
    const byField = Object.fromEntries(result.series.map((s) => [s.field, s]));
    expect(Object.keys(byField).sort()).toEqual(['POWER TOTAL', 'oilTempPv']);
    expect(byField.oilTempPv).toEqual({
      assetId: A,
      field: 'oilTempPv',
      measurement: 'machineParams',
      points: [
        [H0 + HOUR, 20],
        [H0 + 2 * HOUR, 50],
      ],
    });
    expect(byField['POWER TOTAL'].points).toEqual([[H0 + HOUR, 6]]);
  });

  it('applies sum and time-ordered last across status series', async () => {
    const range = { start: new Date(H0), stop: new Date(H0 + HOUR), every: '1h' };
    const sum = await seriesFor(companyId, [A], ['ENERGY CONSUMPTION'], { ...range, fn: 'sum' });
    expect(sum.series[0].points).toEqual([[H0 + HOUR, 0.75]]);
    const last = await seriesFor(companyId, [A], ['POWER TOTAL'], { ...range, fn: 'last' });
    expect(last.series[0].points).toEqual([[H0 + HOUR, 7]]);
  });

  it('picks a window when none is given', async () => {
    const result = await seriesFor(companyId, [A, B], ['oilTempPv'], {
      start: new Date(H0),
      stop: new Date(H0 + 2 * HOUR),
    });
    expect(result.every).toBe('30s');
    expect(result.series.map((s) => s.assetId).sort()).toEqual([A, B].sort());
  });

  it('builds status runs from the prior state, with totals and availability', async () => {
    const t = await statusTimeline(companyId, A, { start: new Date(ago(4)), stop: new Date(ago(1)) });
    expect(t.runs).toEqual([
      {
        status: 'Running',
        start: new Date(ago(4)).toISOString(),
        end: new Date(ago(3)).toISOString(),
        seconds: 3600,
      },
      {
        status: 'Stopped',
        start: new Date(ago(3)).toISOString(),
        end: new Date(ago(2.5)).toISOString(),
        seconds: 1800,
      },
      {
        status: 'Running',
        start: new Date(ago(2.5)).toISOString(),
        end: new Date(ago(1.5)).toISOString(),
        seconds: 3600,
      },
      {
        status: 'OFF',
        start: new Date(ago(1.5)).toISOString(),
        end: new Date(ago(1)).toISOString(),
        seconds: 1800,
      },
    ]);
    expect(t.totals).toEqual({ Running: 7200, Idle: 0, Stopped: 1800, OFF: 1800 });
    expect(t.coverageSec).toBe(10_800);
    expect(t.availability).toBe(0.8); // 7200 running ÷ (10800 covered − 1800 OFF)
  });

  it('clips the last run to now', async () => {
    const t = await statusTimeline(companyId, A, { start: new Date(ago(4)), stop: new Date(ago(-1)) });
    const last = t.runs.at(-1);
    expect(last.status).toBe('Idle');
    expect(Date.parse(last.end)).toBeGreaterThanOrEqual(NOW);
    expect(Date.parse(last.end)).toBeLessThanOrEqual(Date.now());
    expect(t.totals.OFF).toBe(3600);
    expect(t.totals.Idle).toBeGreaterThanOrEqual(1800);
    expect(t.coverageSec).toBe(t.runs.reduce((sum, r) => sum + r.seconds, 0));
  });

  it('starts at the first event when nothing came before, and reports 0 when nothing is scheduled', async () => {
    const t = await statusTimeline(companyId, A, { start: new Date(ago(31)), stop: new Date(ago(29)) });
    expect(t.runs).toEqual([
      {
        status: 'OFF',
        start: new Date(ago(30)).toISOString(),
        end: new Date(ago(29)).toISOString(),
        seconds: 3600,
      },
    ]);
    expect(t.coverageSec).toBe(3600);
    expect(t.availability).toBe(0);
  });

  it('discovers the measurement/field pairs an asset reports', async () => {
    expect(await discoverFields(companyId, A)).toEqual([
      { measurement: 'energy', field: 'ENERGY CONSUMPTION' },
      { measurement: 'energy', field: 'POWER TOTAL' },
      { measurement: 'machineParams', field: 'oilTempPv' },
      { measurement: 'machineParams', field: 'toolName' },
      { measurement: 'timelineData', field: 'assetStatus' },
    ]);
    expect(await discoverFields(companyId, B)).toEqual([
      { measurement: 'machineParams', field: 'oilTempPv' },
    ]);
  });
});
