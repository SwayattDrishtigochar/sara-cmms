import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { attachDetections } from '../src/ai/anomaly/scoring.js';
import {
  CLEAN_SCANS_TO_RESOLVE,
  markDue,
  resetWatchState,
  scanCompany,
  startAnomalyWatch,
} from '../src/ai/anomaly/watch.js';
import { AiUsage } from '../src/db/models/AiUsage.js';
import { subscribe } from '../src/lib/events.js';
import { getModule } from '../src/modules/registry.js';
import { setupDatabase, teardownDatabase } from './helpers/db.js';

const { generate, settings, computeFeatures, investigateAnomaly } = vi.hoisted(() => ({
  generate: vi.fn(),
  settings: {
    tiers: { background: { model: 'test-background' } },
    limits: { 'test-background': { rpm: 10, rpd: 20 } },
    chatReservePct: 50,
    anomaly: { enabled: true, tickSec: 60, quietIntervalMin: 10, alwaysAskAi: false, investigate: false },
  },
  computeFeatures: vi.fn(),
  investigateAnomaly: vi.fn(),
}));
vi.mock('../src/ai/gemini.js', () => ({ generate }));
vi.mock('../src/ai/settings.js', () => ({ getAiSettings: async () => settings }));
vi.mock('../src/ai/anomaly/features.js', async (importOriginal) => ({
  ...(await importOriginal()),
  computeFeatures,
}));
vi.mock('../src/ai/anomaly/investigate.js', () => ({ investigateAnomaly }));
vi.mock('../src/ai/anomaly/baselines.js', async (importOriginal) => ({
  ...(await importOriginal()),
  ensureBaselines: async () => new Map(),
}));

const MIN = 60_000;
const HOUR = 60 * MIN;
const Model = (name) => getModule(name).Model;

let acme;
let imm; // IMM 1 (Pune)
let press; // Press 1 (Pune)
const ids = {};
const events = [];

const feature = (asset, over = {}) => ({
  assetId: String(asset._id),
  name: asset.name,
  tag: asset.assetTag,
  type: asset.typeOfAsset,
  plantId: String(asset.plantId),
  status: 'Running',
  statusSince: new Date(Date.now() - 30 * MIN).toISOString(),
  healthUpdatedAt: null,
  inShift: true,
  job: null,
  transition: false,
  fields: [
    {
      measurement: 'machineParams',
      field: 'vibration',
      unit: 'mm/s',
      last: 4.1,
      mean: 3.9,
      min: 3.5,
      max: 4.1,
      std: 0.2,
      slopePerHour: 2,
      n: 10,
      baseline: { mean: 2.2, std: 0.15, p5: 1.9, p95: 2.5, source: 'history' },
      z: 11.3,
      band: 'above',
      spikes: 10,
      flatline: false,
      flags: ['z', 'band', 'spikes'],
    },
    {
      measurement: 'machineParams',
      field: 'oilTempPv',
      unit: '°C',
      last: 49,
      mean: 48.5,
      min: 48,
      max: 49,
      std: 0.3,
      slopePerHour: 0.5,
      n: 10,
      baseline: { mean: 48, std: 0.4, p5: 47.2, p95: 48.8, source: 'history' },
      z: 1.2,
      band: null,
      spikes: 0,
      flatline: false,
      flags: [],
    },
  ],
  rejectionRate: null,
  idlePowerRatio: null,
  flags: ['z', 'band', 'spikes'],
  ...over,
});
const finding = (over = {}) => ({
  type: 'vibration_high',
  severity: 'warning',
  confidence: 0.85,
  parameters: [{ field: 'vibration', observed: 4.1, expected: 2.2, deviation: '+11σ, rising' }],
  explanation: 'Vibration has climbed to 4.1 mm/s, almost double its usual level. Current is steady.',
  likelyCauses: ['Bearing wear'],
  recommendedActions: ['Check the main drive bearing'],
  urgencyHours: 24,
  ...over,
});
const decision = (asset, over = {}) => ({
  assetId: String(asset._id),
  healthScore: 58,
  state: 'anomalous',
  summary: 'Vibration is high and rising.',
  anomalies: [finding()],
  ...over,
});
const answer = (assets) => generate.mockResolvedValue({ json: { assets }, model: 'mock-model', mock: true });
const anomalies = (filter = {}) =>
  Model('anomalies')
    .find({ companyId: acme.companyId, deleted: { $ne: true }, ...filter })
    .sort({ _id: 1 })
    .lean();

beforeAll(async () => {
  ({ acme } = await setupDatabase());
  const Asset = Model('assets');
  imm = await Asset.findOne({ companyId: acme.companyId, name: 'IMM 1' }).lean();
  press = await Asset.findOne({ companyId: acme.companyId, name: 'Press 1' }).lean();
  const User = Model('users');
  for (const [who, email] of Object.entries({
    owner: 'owner_1@acme.test',
    puneTech: 'maintenance_technician_1@acme.test',
    chennaiTech: 'maintenance_technician_4@acme.test',
    viewer: 'viewer_1@acme.test',
  })) {
    ids[who] = String((await User.findOne({ email }).lean())._id);
  }
  subscribe((event) => {
    if (event.type === 'anomaly') events.push(event);
  });
});
afterAll(teardownDatabase);
beforeEach(() => {
  generate.mockReset();
  investigateAnomaly.mockReset();
  events.length = 0;
});

describe('effects of a scan', () => {
  it('writes health, creates the anomaly with its code and parameters, notifies and publishes', async () => {
    computeFeatures.mockResolvedValue([feature(imm)]);
    answer([decision(imm)]);
    const result = await scanCompany(acme.companyId, { force: true, reason: 'manual' });
    expect(result).toMatchObject({
      reviewed: 1,
      anomalies: 1,
      created: 1,
      notified: 1,
      skipped: 0,
      model: 'mock-model',
      mock: true,
    });
    expect(generate).toHaveBeenCalledTimes(1);
    const call = generate.mock.calls[0][0];
    expect(call).toMatchObject({ tier: 'background', purpose: 'anomaly', companyId: String(acme.companyId) });
    expect(call.mockInput).toHaveLength(1);
    expect(call.contents).toContain(`assetId ${imm._id}`);
    expect(call.schema.properties.assets).toBeDefined();

    const asset = await Model('assets').findById(imm._id).lean();
    expect(asset).toMatchObject({
      healthScore: 58,
      healthSummary: 'Vibration is high and rising.',
      healthModel: 'mock-model (mock)',
    });
    expect(asset.healthUpdatedAt).toBeInstanceOf(Date);

    const [anomaly] = await anomalies();
    expect(anomaly).toMatchObject({
      anomalyCode: 'ANM-1',
      type: 'vibration_high',
      severity: 'warning',
      state: 'open',
      confidence: 0.85,
      summary: 'Vibration has climbed to 4.1 mm/s, almost double its usual level.',
      model: 'mock-model (mock)', // a mock answer says so wherever the model is shown
      cleanScans: 0,
      likelyCauses: ['Bearing wear'],
    });
    expect(String(anomaly.plantId)).toBe(String(imm.plantId));
    expect(anomaly.parameters[0]).toMatchObject({
      field: 'vibration',
      unit: 'mm/s',
      observed: 4.1,
      expected: 2.2,
    });
    expect(anomaly.detectedAt).toBeInstanceOf(Date);
    expect(anomaly.lastSeenAt).toBeInstanceOf(Date);

    const notes = await Model('notifications')
      .find({ companyId: acme.companyId, 'details.module': 'anomalies' })
      .lean();
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      type: 'alert',
      priority: 'medium',
      message: { title: 'Warning: Vibration high on IMM 1' },
    });
    expect(String(notes[0].plantId)).toBe(String(imm.plantId));
    expect(notes[0].details).toMatchObject({ recordId: String(anomaly._id), assetId: String(imm._id) });
    const recipients = notes[0].recipientUsers.map(String);
    expect(recipients).toContain(ids.owner);
    expect(recipients).toContain(ids.puneTech);
    expect(recipients).not.toContain(ids.chennaiTech);
    expect(recipients).not.toContain(ids.viewer);

    expect(events.map((e) => [e.payload.change, e.audience])).toEqual([
      ['new', { plantId: String(imm.plantId) }],
    ]);
    expect(String(events[0].payload.anomaly._id)).toBe(String(anomaly._id));
    expect(investigateAnomaly).not.toHaveBeenCalled();
  });

  it('dedupes by asset and type: severity only goes up, text, lastSeenAt and parameters refresh', async () => {
    const [before] = await anomalies();
    answer([decision(imm, { anomalies: [finding({ explanation: 'Vibration holds at 4.1 mm/s. Same.' })] })]);
    expect(await scanCompany(acme.companyId, { force: true })).toMatchObject({ updated: 1, notified: 0 });
    expect((await anomalies())[0].summary).toBe('Vibration holds at 4.1 mm/s.');

    answer([
      decision(imm, {
        anomalies: [
          finding({
            severity: 'critical',
            confidence: 0.9,
            parameters: [{ field: 'vibration', observed: 4.1, expected: 2.2, deviation: '+12σ' }],
            explanation: 'Vibration is at 4.1 mm/s, +12σ. It keeps rising.',
          }),
        ],
      }),
    ]);
    events.length = 0;
    const result = await scanCompany(acme.companyId, { force: true });
    // A warning that turns critical alerts again.
    expect(result).toMatchObject({ created: 0, updated: 1, anomalies: 1, notified: 1 });
    expect(events.map((e) => [e.payload.change, e.payload.alerted])).toEqual([['escalated', true]]);
    const list = await anomalies();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      severity: 'critical',
      confidence: 0.9,
      state: 'open',
      cleanScans: 0,
      summary: 'Vibration is at 4.1 mm/s, +12σ.',
    });
    expect(list[0].parameters[0].deviation).toBe('+12σ');
    expect(list[0].lastSeenAt.getTime()).toBeGreaterThan(before.lastSeenAt.getTime());

    answer([decision(imm, { anomalies: [finding({ severity: 'info' })] })]);
    await scanCompany(acme.companyId, { force: true });
    expect((await anomalies())[0].severity).toBe('critical');
    expect(
      await Model('notifications').countDocuments({
        companyId: acme.companyId,
        'details.module': 'anomalies',
      }),
    ).toBe(2);
  });

  it('never notifies for an asset the model only puts on watch', async () => {
    computeFeatures.mockResolvedValue([feature(imm), feature(press)]);
    answer([
      decision(imm),
      decision(press, {
        state: 'watch',
        healthScore: 80,
        anomalies: [
          finding({
            type: 'temperature_high',
            severity: 'warning',
            parameters: [{ field: 'oilTempPv', observed: 49, expected: 48, deviation: '+2σ' }],
          }),
        ],
      }),
    ]);
    const result = await scanCompany(acme.companyId, { force: true });
    expect(result).toMatchObject({ reviewed: 2, created: 1, updated: 1, notified: 0 });
    const onPress = await anomalies({ assetId: press._id });
    expect(onPress).toHaveLength(1);
    expect(onPress[0]).toMatchObject({ type: 'temperature_high', state: 'open' });
    expect(events.map((e) => [e.payload.change, e.payload.alerted])).toEqual([['new', false]]);
    const alerts = () =>
      Model('notifications').countDocuments({ companyId: acme.companyId, 'details.module': 'anomalies' });
    expect(await alerts()).toBe(2);

    // Judged anomalous later at the same severity: alerted once, then not again.
    const anomalous = () =>
      decision(press, {
        anomalies: [
          finding({
            type: 'temperature_high',
            parameters: [{ field: 'oilTempPv', observed: 49, expected: 48, deviation: '+3σ' }],
          }),
        ],
      });
    computeFeatures.mockResolvedValue([feature(press)]);
    answer([anomalous()]);
    expect(await scanCompany(acme.companyId, { force: true })).toMatchObject({ updated: 1, notified: 1 });
    expect(events.at(-1).payload).toMatchObject({ change: 'alerted', alerted: true });
    answer([anomalous()]);
    expect(await scanCompany(acme.companyId, { force: true })).toMatchObject({ updated: 1, notified: 0 });
    expect(await alerts()).toBe(3);
  });

  it('caps the health score while anomalies stay open, and says so instead of "all normal"', async () => {
    computeFeatures.mockResolvedValue([feature(imm, { flags: [] })]);
    answer([decision(imm, { state: 'normal', healthScore: 95, summary: 'All normal.', anomalies: [] })]);
    await scanCompany(acme.companyId, { force: true });
    expect(await Model('assets').findById(imm._id).lean()).toMatchObject({
      healthScore: 55, // the IMM's vibration anomaly is still open and critical
      healthSummary: '1 open anomaly still being watched.',
    });
    // That clean scan counted; reset it so the auto-resolve test below starts from a known state.
    await Model('anomalies').updateMany({ assetId: imm._id }, { $set: { cleanScans: 0 } });
  });

  it('auto-resolves after three clean scans of a working machine; OFF, stopped or skipped scans never count', async () => {
    const clean = (over) => [
      decision(imm, { state: 'normal', healthScore: 95, summary: 'All normal.', anomalies: [] }),
      decision(press, { state: 'normal', healthScore: 95, summary: 'All normal.', anomalies: [], ...over }),
    ];
    const pressAnomaly = async () => (await anomalies({ assetId: press._id }))[0];

    // OFF outside the shift: not reviewed at all.
    computeFeatures.mockResolvedValue([
      feature(imm, { flags: [] }),
      feature(press, { status: 'OFF', inShift: false, flags: [] }),
    ]);
    answer(clean());
    let result = await scanCompany(acme.companyId, { force: true });
    expect(result).toMatchObject({ reviewed: 1, skipped: 1 });
    expect((await pressAnomaly()).cleanScans).toBe(0);

    // Stopped in the shift: reviewed and judged clean, but a stopped machine proves nothing.
    computeFeatures.mockResolvedValue([feature(press, { status: 'Stopped', flags: [] })]);
    answer(clean());
    await scanCompany(acme.companyId, { force: true });
    expect((await pressAnomaly()).cleanScans).toBe(0);

    computeFeatures.mockResolvedValue([feature(press, { flags: [] })]);
    for (let i = 1; i < CLEAN_SCANS_TO_RESOLVE; i += 1) {
      answer(clean());
      await scanCompany(acme.companyId, { force: true });
      expect(await pressAnomaly()).toMatchObject({ state: 'open', cleanScans: i });
    }
    answer(clean());
    result = await scanCompany(acme.companyId, { force: true });
    expect(result.resolved).toBe(1);
    const resolved = await pressAnomaly();
    expect(resolved).toMatchObject({ state: 'resolved', cleanScans: CLEAN_SCANS_TO_RESOLVE });
    expect(resolved.resolvedAt).toBeInstanceOf(Date);
    expect(events.at(-1).payload.change).toBe('resolved');

    // The IMM anomaly saw one clean scan (the first, forced one) and was then out of the features.
    expect((await anomalies({ assetId: imm._id }))[0]).toMatchObject({ state: 'open', cleanScans: 1 });
  });

  it('reopens a recently resolved anomaly, creates a new one after six hours, and stays quiet after a false positive', async () => {
    const Anomaly = Model('anomalies');
    const reported = () => [
      decision(press, {
        anomalies: [
          finding({
            type: 'temperature_high',
            parameters: [{ field: 'oilTempPv', observed: 49, expected: 48, deviation: '+3σ' }],
          }),
        ],
      }),
    ];
    computeFeatures.mockResolvedValue([feature(press)]);
    answer(reported());
    let result = await scanCompany(acme.companyId, { force: true });
    expect(result).toMatchObject({ reopened: 1, created: 0, notified: 1 });
    let list = await anomalies({ assetId: press._id });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ state: 'open', resolvedAt: null, cleanScans: 0, severity: 'warning' });
    expect(list[0].detectedAt.getTime()).toBeGreaterThan(Date.now() - MIN); // a reopen is a new detection
    expect(events.map((e) => e.payload.change)).toEqual(['reopened']);

    await Anomaly.updateOne(
      { _id: list[0]._id },
      { $set: { state: 'resolved', resolvedAt: new Date(Date.now() - 7 * HOUR) } },
    );
    answer(reported());
    result = await scanCompany(acme.companyId, { force: true });
    expect(result).toMatchObject({ created: 1, reopened: 0 });
    list = await anomalies({ assetId: press._id });
    expect(list).toHaveLength(2);
    expect(list[1].anomalyCode).not.toBe(list[0].anomalyCode);

    await Anomaly.updateOne(
      { _id: list[1]._id },
      { $set: { state: 'false_positive', resolvedAt: new Date() } },
    );
    answer(reported());
    result = await scanCompany(acme.companyId, { force: true });
    expect(result).toMatchObject({ created: 0, reopened: 0, updated: 0 });
    expect(await anomalies({ assetId: press._id })).toHaveLength(2);

    // A worse finding after a false positive is new evidence: a new anomaly; the verdict on the old stands.
    const worse = reported();
    worse[0].anomalies[0].severity = 'critical';
    answer(worse);
    result = await scanCompany(acme.companyId, { force: true });
    expect(result).toMatchObject({ created: 1, reopened: 0, notified: 1 });
    list = await anomalies({ assetId: press._id });
    expect(list.map((a) => [a.state, a.severity])).toEqual([
      ['resolved', 'warning'],
      ['false_positive', 'warning'],
      ['open', 'critical'],
    ]);
    // The same evidence once the false positive is over an hour old: no longer kept quiet.
    await Anomaly.updateOne({ _id: list[2]._id }, { $set: { deleted: true } });
    await Anomaly.updateOne({ _id: list[1]._id }, { $set: { resolvedAt: new Date(Date.now() - 2 * HOUR) } });
    answer(reported());
    expect(await scanCompany(acme.companyId, { force: true })).toMatchObject({ created: 1 });
  });

  it('resolves after one clean scan once the anomaly’s work order is completed', async () => {
    await Model('anomalies').deleteMany({ assetId: press._id });
    computeFeatures.mockResolvedValue([feature(press)]);
    answer([
      decision(press, {
        anomalies: [
          finding({
            type: 'temperature_high',
            parameters: [{ field: 'oilTempPv', observed: 49, expected: 48, deviation: '+3σ' }],
          }),
        ],
      }),
    ]);
    await scanCompany(acme.companyId, { force: true });
    const [open] = await anomalies({ assetId: press._id, state: 'open' });
    const order = await Model('workorders').create({
      companyId: acme.companyId,
      plantId: press.plantId,
      name: 'Inspect oil cooler',
      asset: press._id,
      anomalyId: open._id,
      workStatus: 'In Progress',
    });
    const clean = () =>
      answer([decision(press, { state: 'normal', healthScore: 95, summary: 'Fine.', anomalies: [] })]);
    computeFeatures.mockResolvedValue([feature(press, { flags: [] })]);
    clean();
    await scanCompany(acme.companyId, { force: true });
    expect(await Model('anomalies').findById(open._id).lean()).toMatchObject({
      state: 'open',
      cleanScans: 1,
    });
    await Model('workorders').updateOne({ _id: order._id }, { $set: { workStatus: 'Completed' } });
    clean();
    expect(await scanCompany(acme.companyId, { force: true })).toMatchObject({ resolved: 1 });
    expect((await Model('anomalies').findById(open._id).lean()).state).toBe('resolved');
    await Model('workorders').deleteOne({ _id: order._id });
  });

  it('runs an investigation for a new warning when the setting is on', async () => {
    settings.anomaly.investigate = true;
    computeFeatures.mockResolvedValue([feature(imm)]);
    answer([
      decision(imm, {
        anomalies: [
          finding({
            type: 'current_high',
            severity: 'critical',
            parameters: [{ field: 'vibration', observed: 4.1, expected: 2.2, deviation: '+11σ' }],
          }),
        ],
      }),
    ]);
    try {
      await scanCompany(acme.companyId, { force: true });
    } finally {
      settings.anomaly.investigate = false;
    }
    expect(investigateAnomaly).toHaveBeenCalledTimes(1);
    const [companyId, anomalyId] = investigateAnomaly.mock.calls[0];
    expect(String(companyId)).toBe(String(acme.companyId));
    const target = await Model('anomalies').findById(anomalyId).lean();
    expect(target).toMatchObject({ type: 'current_high', severity: 'critical' });
  });
});

describe('cadence', () => {
  beforeEach(async () => {
    await Model('anomalies').deleteMany({ companyId: acme.companyId });
    resetWatchState();
    computeFeatures.mockResolvedValue([feature(imm, { flags: [], fields: [feature(imm).fields[1]] })]);
    answer([decision(imm, { state: 'normal', healthScore: 96, summary: 'Fine.', anomalies: [] })]);
  });

  it('reviews a quiet asset once per quiet interval, at once on new evidence, or when asked', async () => {
    expect((await scanCompany(acme.companyId)).reviewed).toBe(1); // never reviewed: due
    expect((await scanCompany(acme.companyId)).reviewed).toBe(0);
    expect(generate).toHaveBeenCalledTimes(1);

    resetWatchState(); // a restart: the stored healthUpdatedAt keeps the cadence
    await Model('assets').updateOne(
      { _id: imm._id },
      { $set: { healthUpdatedAt: new Date(Date.now() - 9 * MIN) } },
    );
    computeFeatures.mockResolvedValue([
      feature(imm, { flags: [], healthUpdatedAt: new Date(Date.now() - 9 * MIN).toISOString() }),
    ]);
    expect((await scanCompany(acme.companyId)).reviewed).toBe(0);
    computeFeatures.mockResolvedValue([
      feature(imm, { flags: [], healthUpdatedAt: new Date(Date.now() - 11 * MIN).toISOString() }),
    ]);
    expect((await scanCompany(acme.companyId)).reviewed).toBe(1);
    expect((await scanCompany(acme.companyId)).reviewed).toBe(0);

    // A screen that had not fired at the last review: due at once, but the same evidence only once.
    const [vibration, oil] = feature(imm).fields;
    computeFeatures.mockResolvedValue([feature(imm, { fields: [vibration, { ...oil, flags: ['z'] }] })]);
    expect((await scanCompany(acme.companyId)).reviewed).toBe(1);
    expect((await scanCompany(acme.companyId)).reviewed).toBe(0);
    computeFeatures.mockResolvedValue([feature(imm, { flags: [] })]);
    expect((await scanCompany(acme.companyId, { force: true })).reviewed).toBe(1);
    settings.anomaly.alwaysAskAi = true;
    expect((await scanCompany(acme.companyId)).reviewed).toBe(1);
    settings.anomaly.alwaysAskAi = false;
    expect((await scanCompany(acme.companyId)).reviewed).toBe(0);
  });

  it('markDue makes an asset due at the next tick', async () => {
    expect((await scanCompany(acme.companyId)).reviewed).toBe(1);
    expect((await scanCompany(acme.companyId)).reviewed).toBe(0);
    markDue(String(acme.companyId), String(imm._id));
    expect((await scanCompany(acme.companyId)).reviewed).toBe(1);
  });

  it('a restart forgets judged evidence: a flagged asset reviewed recently waits for its interval', async () => {
    const recent = new Date(Date.now() - 2 * MIN).toISOString();
    computeFeatures.mockResolvedValue([feature(imm, { healthUpdatedAt: recent })]);
    expect((await scanCompany(acme.companyId)).reviewed).toBe(0);
    expect(generate).not.toHaveBeenCalled();
  });

  it('backs off after a failed call: the assets wait for their quiet interval', async () => {
    generate.mockRejectedValue(new Error('Your prepayment credits are depleted'));
    await expect(scanCompany(acme.companyId)).rejects.toThrow('depleted');
    expect((await scanCompany(acme.companyId)).reviewed).toBe(0);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('never runs two scans of a company at once', async () => {
    const [a, b] = await Promise.all([
      scanCompany(acme.companyId, { force: true }),
      scanCompany(acme.companyId, { force: true }),
    ]);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
  });

  it('stretches the quiet interval x3 past 70 % of the background budget; new evidence stays due', async () => {
    // rpd 20 with a 50 % chat reserve leaves 10 background calls: 7 is past 70 %.
    await AiUsage.insertMany(
      Array.from({ length: 7 }, () => ({
        model: 'test-background',
        purpose: 'anomaly',
        status: 'ok',
        createdAt: new Date(),
      })),
    );
    const quiet = (min) =>
      feature(imm, {
        flags: [],
        fields: [feature(imm).fields[1]],
        healthUpdatedAt: new Date(Date.now() - min * MIN).toISOString(),
      });
    try {
      computeFeatures.mockResolvedValue([quiet(11)]);
      expect(await scanCompany(acme.companyId)).toMatchObject({
        reviewed: 0,
        quotaStretched: true,
        quietIntervalMin: 30,
      });
      computeFeatures.mockResolvedValue([quiet(31)]);
      expect((await scanCompany(acme.companyId)).reviewed).toBe(1);
      computeFeatures.mockResolvedValue([feature(imm)]); // new evidence, reviewed a moment ago
      expect((await scanCompany(acme.companyId)).reviewed).toBe(1);
    } finally {
      await AiUsage.deleteMany({ model: 'test-background' });
    }
    computeFeatures.mockResolvedValue([quiet(11)]);
    expect(await scanCompany(acme.companyId)).toMatchObject({ quotaStretched: false, quietIntervalMin: 10 });
  });
});

describe('startAnomalyWatch', () => {
  it('waits one full tick before the first scan, so a restart does not scan at once', async () => {
    const spy = vi.spyOn(globalThis, 'setTimeout');
    const stop = startAnomalyWatch();
    try {
      await vi.waitFor(() => expect(spy).toHaveBeenCalledWith(expect.any(Function), 60_000));
    } finally {
      stop();
      spy.mockRestore();
    }
    expect(generate).not.toHaveBeenCalled();
  });
});

describe('ground truth scoring', () => {
  it('matches the first anomaly after an injection whose parameters touch the affected fields', async () => {
    await Model('anomalies').deleteMany({ companyId: acme.companyId });
    computeFeatures.mockResolvedValue([feature(imm)]);
    answer([decision(imm)]);
    await scanCompany(acme.companyId, { force: true });
    const [anomaly] = await anomalies();
    const startedAt = new Date(anomaly.detectedAt.getTime() - 5 * MIN);
    const endsAt = new Date(startedAt.getTime() + HOUR);
    const base = { companyId: acme.companyId, assetId: imm._id, startedAt, endsAt, clearedAt: null };
    const [hit, otherField, tooLate, otherAsset, anyField] = await attachDetections([
      { ...base, scenario: 'bearing_wear', affects: ['vibration', 'motorCurrent', 'oilTempPv'] },
      { ...base, scenario: 'overheating', affects: ['zoneTemp1'] },
      { ...base, startedAt: new Date(anomaly.detectedAt.getTime() + MIN) },
      { ...base, assetId: press._id, affects: ['vibration'] },
      { ...base, affects: [], field: undefined },
    ]);
    expect(hit.detection).toEqual({
      anomalyId: String(anomaly._id),
      code: anomaly.anomalyCode,
      detectedAt: anomaly.detectedAt,
      latencySec: 300,
      matchedFields: ['vibration'],
    });
    expect(otherField.detection).toBeNull();
    expect(tooLate.detection).toBeNull();
    expect(otherAsset.detection).toBeNull();
    expect(anyField.detection?.matchedFields).toEqual(['vibration']);
    expect(await attachDetections([])).toEqual([]);

    // A quality finding cites the derived rejectionRate; tool wear names rejectedCount.
    await Model('anomalies').updateOne(
      { _id: anomaly._id },
      { $set: { parameters: [{ field: 'rejectionRate', observed: 9, expected: 2.7 }] } },
    );
    const [wear] = await attachDetections([{ ...base, affects: ['rejectedCount', 'cycleTime'] }]);
    expect(wear.detection?.matchedFields).toEqual(['rejectionRate']);
  });
});
