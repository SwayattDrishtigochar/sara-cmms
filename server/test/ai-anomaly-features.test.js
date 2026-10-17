import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  baselineFor,
  baselineKey,
  clearBaselineCache,
  ensureBaselines,
  refreshBaselines,
  resolveBaseline,
} from '../src/ai/anomaly/baselines.js';
import { computeFeatures } from '../src/ai/anomaly/features.js';
import { env } from '../src/config/env.js';
import {
  bucketFor,
  ensureBucket,
  influxEnabled,
  Point,
  pingInflux,
  writePoints,
} from '../src/config/influx.js';
import { Baseline } from '../src/db/models/Baseline.js';
import { ParameterSpec } from '../src/db/models/ParameterSpec.js';
import { getModule } from '../src/modules/registry.js';
import { PASSWORD, setupDatabase, teardownDatabase } from './helpers/db.js';
import { seedCompany } from './helpers/fixtures.js';

const MIN = 60_000;
const influxUp = influxEnabled && (await pingInflux()) === 'up';

describe.skipIf(!influxUp)('baselines and features against InfluxDB', () => {
  // A company of its own: its id names a throwaway bucket that other test packages never touch.
  const slug = `anomaly-${Date.now().toString(36)}`;
  let companyId;
  let imm;
  let compressor;
  // "Now" sits 45 s into the current minute; each 1-minute window gets one point at its half minute,
  // so 1-minute means are the points themselves and the 10-minute window holds minutes 9..0.
  const NOW = Math.floor(Date.now() / MIN) * MIN + 45_000;
  const minute = (minutesAgo) => NOW - 45_000 - minutesAgo * MIN + 30_000;

  const point = (measurement, assetId, t, status, fields) => {
    const p = new Point(measurement)
      .tag('companyId', companyId)
      .tag('assetId', assetId)
      .tag('status', status)
      .timestamp(new Date(t));
    for (const [key, value] of Object.entries(fields)) p.floatField(key, value);
    return p;
  };

  beforeAll(async () => {
    await setupDatabase();
    clearBaselineCache();
    const account = await seedCompany({
      name: 'Anomaly Works',
      slug,
      domain: 'anomaly.test',
      plantNames: ['Pune'],
      password: PASSWORD,
      now: new Date(NOW),
    });
    companyId = String(account.companyId);
    const Asset = getModule('assets').Model;
    const find = (name) => Asset.findOne({ companyId, name }).lean();
    imm = String((await find('IMM 1'))._id);
    compressor = String((await find('Compressor 1'))._id);
    await Asset.updateOne(
      { _id: imm },
      { $set: { assetStatus: 'Running', assetStatusSince: new Date(NOW - 30 * MIN) } },
    );
    await Asset.updateOne(
      { _id: compressor },
      { $set: { assetStatus: 'Idle', assetStatusSince: new Date(NOW - 45 * MIN) } },
    );
    await ParameterSpec.create([
      {
        assetType: 'Injection Moulding Machine',
        measurement: 'machineParams',
        field: 'oilTempPv',
        unit: '°C',
        normalMin: 35,
        normalMax: 55,
      },
      {
        assetType: 'Injection Moulding Machine',
        measurement: 'machineParams',
        field: 'vibration',
        unit: 'mm/s',
        normalMin: 0,
        normalMax: 4.5,
      },
    ]);

    const points = [];
    // History (4 h 7 min → 1 h 3 min ago): oil temperature while Running and while Idle, vibration for 30 min only.
    // It ends well before the baselines' 60-minute holdout, which InfluxDB measures on its own clock: this
    // machine's clock may run a minute or two ahead of a remote server's.
    for (let m = 247; m > 62; m -= 1) {
      points.push(point('machineParams', imm, minute(m), 'Running', { oilTempPv: 48 + 0.4 * Math.sin(m) }));
      if (m > 97)
        points.push(point('machineParams', imm, minute(m), 'Idle', { oilTempPv: 42 + 0.3 * Math.cos(m) }));
      if (m <= 92)
        points.push(
          point('machineParams', imm, minute(m), 'Running', { vibration: 2.2 + 0.1 * Math.sin(m) }),
        );
      points.push(point('energy', compressor, minute(m), 'Idle', { 'POWER TOTAL': 5 + 0.2 * Math.sin(m) }));
    }
    // The last 10 minutes: oil heating 1 °C per minute, vibration frozen, idle power doubled.
    for (let m = 9; m >= 0; m -= 1) {
      points.push(point('machineParams', imm, minute(m), 'Running', { oilTempPv: 64 - m, vibration: 2.2 }));
      points.push(point('energy', compressor, minute(m), 'Idle', { 'POWER TOTAL': 10 }));
    }
    // Shift output of IMM 1: the current shift started 2.5 h ago, the one before 8 h earlier.
    await getModule('partcounts').Model.create([
      { companyId, assetId: imm, date: new Date(NOW - 150 * MIN), shiftName: 'B', produced: 1000 },
      { companyId, assetId: imm, date: new Date(NOW - 630 * MIN), shiftName: 'A', produced: 3000 },
    ]);
    await getModule('rejections').Model.create({
      companyId,
      assetId: imm,
      partName: 'Housing',
      rejectionReason: 'Short shot',
      rejectedCount: 40,
      createdAt: new Date(NOW - 60 * MIN),
    });
    await ensureBucket(bucketFor(companyId));
    await writePoints(bucketFor(companyId), points);
  });

  afterAll(async () => {
    const headers = { Authorization: `Token ${env.INFLUX_TOKEN}` };
    const found = await fetch(`${env.INFLUX_URL}/api/v2/buckets?name=${bucketFor(companyId)}`, { headers });
    for (const bucket of (await found.json()).buckets ?? []) {
      await fetch(`${env.INFLUX_URL}/api/v2/buckets/${bucket.id}`, { method: 'DELETE', headers });
    }
    await teardownDatabase();
  });

  it('computes baselines per asset, field and status from 1-minute means', async () => {
    const { rows } = await refreshBaselines(companyId);
    const by = (assetId, field, status) =>
      rows.find((r) => r.assetId === assetId && r.field === field && r.status === status);
    const running = by(imm, 'oilTempPv', 'Running');
    expect(running).toMatchObject({ measurement: 'machineParams', n: 185 });
    expect(running.mean).toBeCloseTo(48, 0);
    expect(running.std).toBeGreaterThan(0.2);
    expect(running.std).toBeLessThan(0.4);
    expect(running.p5).toBeGreaterThan(47.5);
    expect(running.p95).toBeLessThan(48.5);
    const idle = by(imm, 'oilTempPv', 'Idle');
    expect(idle.n).toBe(150);
    expect(idle.mean).toBeCloseTo(42, 0);
    expect(by(imm, 'vibration', 'Running').n).toBe(30);
    expect(by(compressor, 'POWER TOTAL', 'Idle')).toMatchObject({ measurement: 'energy', n: 185 });
    expect(await Baseline.countDocuments({ companyId })).toBe(rows.length);
  });

  it('serves the rows from memory and falls back to the spec band for thin history', async () => {
    const map = await baselineFor(companyId);
    expect(map.get(baselineKey(imm, 'oilTempPv', 'Running'))).toMatchObject({ n: 185 });
    const specs = new Map([['Injection Moulding Machine|vibration', { normalMin: 0, normalMax: 4.5 }]]);
    const ask = (field, status) =>
      resolveBaseline(map, specs, { assetId: imm, type: 'Injection Moulding Machine', field, status });
    expect(ask('oilTempPv', 'Running').source).toBe('history');
    expect(ask('oilTempPv', 'Idle').source).toBe('history');
    expect(ask('vibration', 'Running')).toMatchObject({ mean: 2.25, p5: 0, p95: 4.5, source: 'spec' });
    expect(ask('vibration', 'Idle')).toBeNull();
    clearBaselineCache(companyId);
    expect((await baselineFor(companyId)).size).toBe(map.size); // reloaded from MongoDB
    expect((await ensureBaselines(companyId)).size).toBe(map.size); // fresh enough: no recompute
  });

  it('screens the last 10 minutes: z, slope, flatline and idle power', async () => {
    const features = await computeFeatures(companyId, { now: new Date(NOW) });
    const byId = Object.fromEntries(features.map((f) => [f.assetId, f]));
    const machine = byId[imm];
    expect(machine).toMatchObject({
      name: 'IMM 1',
      type: 'Injection Moulding Machine',
      status: 'Running',
      transition: false,
      idlePowerRatio: null,
    });
    // The generated account leaves a job card running on IMM 1.
    expect(machine.job).toMatchObject({ jobCardId: expect.stringMatching(/^JC-\d+$/) });
    const oil = machine.fields.find((f) => f.field === 'oilTempPv');
    // The minute still running at NOW (stamped after it) is left out: 9 complete minutes, 55 → 63 °C.
    expect(oil).toMatchObject({ measurement: 'machineParams', unit: '°C', n: 9, last: 63, band: 'above' });
    expect(oil.mean).toBeCloseTo(59, 3);
    expect(oil.slopePerHour).toBeCloseTo(60, 3);
    // 11 °C over a steady week, against the noise floor of the 35–55 °C spec band (20 / 12): z ≈ 6.6.
    expect(oil.z).toBeCloseTo(6.6, 1);
    expect(oil.baseline.std).toBeCloseTo(20 / 12, 3);
    expect(oil.baseline).toMatchObject({ source: 'history' });
    expect(oil.flags).toEqual(['z', 'band', 'spikes']);
    const vibration = machine.fields.find((f) => f.field === 'vibration');
    expect(vibration).toMatchObject({ last: 2.2, std: 0, flatline: true, baseline: { source: 'spec' } });
    expect(vibration.flags).toEqual(['flatline']);
    expect(machine.flags).toEqual(['z', 'band', 'spikes', 'flatline', 'rejects']);

    // 40 rejects in the last hour, ~400 of this shift's 1000 parts, against a clean history (0.5 % floor).
    expect(machine.rejectionRate).toMatchObject({
      windowHours: 1,
      parts: 400,
      rejected: 40,
      recentPct: 10,
      baselinePct: 0,
      baselineSource: 'history',
      z: 26.9,
      enoughParts: true,
    });

    const util = byId[compressor];
    expect(util.status).toBe('Idle');
    expect(util.fields.map((f) => f.field)).toEqual(['POWER TOTAL']);
    expect(util.idlePowerRatio).toBeCloseTo(2, 1);
    expect(util.flags).toContain('idle_power');

    // Assets without readings are listed with no fields, so the watch can skip them.
    const silent = features.filter((f) => !f.fields.length);
    expect(silent.length).toBeGreaterThan(0);
    expect(silent.every((f) => f.flags.length === 0)).toBe(true);
  });
});
