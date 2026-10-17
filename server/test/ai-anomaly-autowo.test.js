import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CATEGORY_OF,
  DEFAULT_AUTO_WO,
  openWorkOrderFor,
  PRIORITY_OF,
  STALE_CLAIM_MS,
  shouldOpenWorkOrder,
} from '../src/ai/anomaly/autoWorkOrder.js';
import { confirmingAssets, dueAssets, resetWatchState, scanCompany } from '../src/ai/anomaly/watch.js';
import { aiPatchSchema, DEFAULT_AI } from '../src/ai/settings.js';
import { subscribe } from '../src/lib/events.js';
import { records } from '../src/modules/records.js';
import { getModule } from '../src/modules/registry.js';
import { setupDatabase, systemContext, teardownDatabase } from './helpers/db.js';

const { generate, settings, computeFeatures } = vi.hoisted(() => ({
  generate: vi.fn(),
  settings: {
    tiers: { background: { model: 'test-background' } },
    limits: { 'test-background': { rpm: 10, rpd: 200 } },
    chatReservePct: 50,
    anomaly: {
      enabled: true,
      tickSec: 60,
      quietIntervalMin: 10,
      alwaysAskAi: false,
      investigate: false,
      autoWorkOrder: { enabled: true, afterScans: 2, minSeverity: 'warning' },
    },
  },
  computeFeatures: vi.fn(),
}));
vi.mock('../src/ai/gemini.js', () => ({ generate }));
vi.mock('../src/ai/settings.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getAiSettings: async () => settings,
}));
vi.mock('../src/ai/anomaly/features.js', async (importOriginal) => ({
  ...(await importOriginal()),
  computeFeatures,
}));
vi.mock('../src/ai/anomaly/investigate.js', () => ({ investigateAnomaly: vi.fn() }));
vi.mock('../src/ai/anomaly/baselines.js', async (importOriginal) => ({
  ...(await importOriginal()),
  ensureBaselines: async () => new Map(),
}));
// A fixture roster: the plant's maintenance technicians, skill match first (people.js is another package's).
vi.mock('../src/planning/people.js', async () => {
  const { getModule } = await import('../src/modules/registry.js');
  return {
    skillsForTask: ({ category }) =>
      ({ Mechanical: ['mechanical'], Hydraulic: ['hydraulics'] })[category] ?? [],
    loadPeople: async (ctx, { department, plantId }) => {
      const users = await getModule('users')
        .Model.find({ companyId: ctx.companyId, role: 'technician', department, plantId })
        .sort({ email: 1 })
        .lean();
      return users.map((u) => ({ userId: String(u._id), name: u.firstName, skills: u.skills ?? [] }));
    },
    pickPerson: (people, _interval, { skills }) =>
      people.find((p) => skills.some((s) => p.skills.includes(s))) ?? people[0] ?? null,
  };
});

const MIN = 60_000;
const HOUR = 60 * MIN;
const Model = (name) => getModule(name).Model;

let acme;
let imm;
let press;
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
const clean = (asset) =>
  decision(asset, { state: 'normal', healthScore: 95, summary: 'All normal.', anomalies: [] });
const answer = (assets) => generate.mockResolvedValue({ json: { assets }, model: 'mock-model', mock: true });
const scan = () => scanCompany(acme.companyId, { force: true });
const anomalyOf = (asset, type) =>
  Model('anomalies').findOne({ companyId: acme.companyId, assetId: asset._id, type }).lean();
const workOrdersOf = (anomaly) => Model('workorders').find({ anomalyId: anomaly._id }).lean();
const woNotes = () =>
  Model('notifications')
    .find({ companyId: acme.companyId, 'details.module': 'workorders', 'message.title': /opened for/ })
    .lean();

beforeAll(async () => {
  ({ acme } = await setupDatabase());
  const Asset = Model('assets');
  imm = await Asset.findOne({ companyId: acme.companyId, name: 'IMM 1' }).lean();
  press = await Asset.findOne({ companyId: acme.companyId, name: 'Press 1' }).lean();
  for (const [who, email] of Object.entries({
    manager: 'maintenance_manager_1@acme.test',
    tech: 'maintenance_technician_1@acme.test',
    chennaiTech: 'maintenance_technician_4@acme.test',
    viewer: 'viewer_1@acme.test',
  })) {
    ids[who] = String((await Model('users').findOne({ email }).lean())._id);
  }
  // A maintenance manager plant-locked to Chennai: not told about a Pune machine.
  const chennaiTech = await Model('users').findById(ids.chennaiTech).lean();
  const manager = await Model('users').findById(ids.manager).lean();
  const { _id, email, employeeId, ...rest } = manager;
  const created = await Model('users').create({
    ...rest,
    email: 'chennai_maintenance_manager@acme.test',
    employeeId: 'EMP-CHN-MM',
    plantId: chennaiTech.plantId,
  });
  ids.chennaiManager = String(created._id);
  subscribe((event) => {
    if (event.type === 'anomaly') events.push(event);
  });
});
afterAll(teardownDatabase);
beforeEach(async () => {
  // Earlier tests' orders are done, so each test's machine has no open order to join.
  await Model('workorders').updateMany({ anomalyId: { $ne: null } }, { $set: { workStatus: 'Completed' } });
  generate.mockReset();
  events.length = 0;
  settings.anomaly.autoWorkOrder = { enabled: true, afterScans: 2, minSeverity: 'warning' };
});

describe('automatic work order', () => {
  it('opens exactly one work order after two consecutive scans, with the links, the technician and one notification', async () => {
    computeFeatures.mockResolvedValue([feature(imm)]);
    answer([decision(imm)]);
    expect(await scan()).toMatchObject({ created: 1, workOrders: 0 });
    let anomaly = await anomalyOf(imm, 'vibration_high');
    expect(anomaly.scansSeen).toBe(1);
    expect(anomaly.autoWorkOrderAt).toBeFalsy();
    expect(await workOrdersOf(anomaly)).toHaveLength(0);

    answer([decision(imm)]);
    expect(await scan()).toMatchObject({ updated: 1, workOrders: 1 });
    anomaly = await anomalyOf(imm, 'vibration_high');
    const orders = await workOrdersOf(anomaly);
    expect(orders).toHaveLength(1);
    const [wo] = orders;
    expect(wo).toMatchObject({
      workOrderId: expect.stringMatching(/^WO-\d+$/),
      name: 'Vibration high on IMM 1 – auto',
      category: 'Mechanical',
      priority: 'Medium',
      estimatedDurationMin: 70,
      workStatus: 'Open',
    });
    expect(String(wo.asset)).toBe(String(imm._id));
    expect(String(wo.plantId)).toBe(String(imm.plantId));
    expect(wo.people.map(String)).toEqual([ids.tech]);
    expect(wo.description).toContain('Vibration has climbed to 4.1 mm/s');
    expect(wo.description).toContain('4.1 mm/s observed vs 2.2 mm/s expected (+11σ, rising)');
    expect(wo.description).toContain('1. Check the main drive bearing');
    expect(wo.description).toContain(`from ${anomaly.anomalyCode}`);
    expect(wo.dueDate.getTime() - Date.now()).toBeGreaterThan(23 * HOUR);
    expect(anomaly).toMatchObject({ scansSeen: 2, state: 'acknowledged' });
    expect(String(anomaly.workOrderId)).toBe(String(wo._id));
    expect(anomaly.autoWorkOrderAt).toBeInstanceOf(Date);

    const notes = await woNotes();
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      type: 'alert',
      priority: 'high',
      message: { title: `Work order ${wo.workOrderId} opened for IMM 1`, description: anomaly.summary },
      details: { module: 'workorders', recordId: String(wo._id), assetId: String(imm._id) },
    });
    const recipients = notes[0].recipientUsers.map(String);
    expect(recipients).toContain(ids.manager);
    expect(recipients).not.toContain(ids.chennaiManager);
    expect(recipients).not.toContain(ids.chennaiTech);
    expect(recipients).not.toContain(ids.viewer);
    // The technician hears it once, from the order's own "assigned to you".
    expect(recipients).not.toContain(ids.tech);
    const assigned = await Model('notifications')
      .find({ 'details.recordId': String(wo._id), 'message.title': `${wo.workOrderId} assigned to you` })
      .lean();
    expect(assigned.map((n) => n.recipientUsers.map(String))).toEqual([[ids.tech]]);
    const opened = events.find((e) => e.payload.change === 'work_order');
    expect(opened.audience).toEqual({ plantId: String(imm.plantId) });
    expect(String(opened.payload.anomaly.workOrderId)).toBe(String(wo._id));

    // A third scan: the counter grows, nothing else happens.
    answer([decision(imm)]);
    expect(await scan()).toMatchObject({ updated: 1, workOrders: 0 });
    expect((await anomalyOf(imm, 'vibration_high')).scansSeen).toBe(3);
    expect(await workOrdersOf(anomaly)).toHaveLength(1);
    expect(await woNotes()).toHaveLength(1);
  });

  it('claims the anomaly atomically: two concurrent openers make one work order', async () => {
    const ctx = await systemContext(acme.companyId);
    const created = await records.create(
      ctx,
      'anomalies',
      {
        assetId: String(press._id),
        type: 'pressure_low',
        severity: 'warning',
        state: 'open',
        summary: 'Hydraulic pressure is sagging.',
        explanation: 'Hydraulic pressure is sagging. Oil is warming up.',
        recommendedActions: ['Check for a leak'],
        urgencyHours: 0.25,
      },
      { source: 'system' },
    );
    await Model('anomalies').updateOne({ _id: created._id }, { $set: { scansSeen: 2 } });
    const anomaly = await Model('anomalies').findById(created._id).lean();
    const opts = { feature: feature(press), now: new Date() };
    const results = await Promise.all([
      openWorkOrderFor(ctx, anomaly, opts),
      openWorkOrderFor(ctx, anomaly, opts),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const orders = await workOrdersOf(anomaly);
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({ category: 'Hydraulic', estimatedDurationMin: 75, priority: 'Medium' });
    expect(orders[0].dueDate.getTime() - Date.now()).toBeGreaterThan(50 * MIN); // at least an hour
    expect(
      await openWorkOrderFor(ctx, await Model('anomalies').findById(created._id).lean(), opts),
    ).toBeNull();
  });

  it('opens the work order on the first sight of a critical anomaly', async () => {
    computeFeatures.mockResolvedValue([feature(press)]);
    answer([
      decision(press, {
        anomalies: [
          finding({
            type: 'temperature_high',
            severity: 'critical',
            parameters: [{ field: 'vibration', observed: 4.1, expected: 2.2, deviation: '+11σ' }],
            urgencyHours: 2,
          }),
        ],
      }),
    ]);
    expect(await scan()).toMatchObject({ created: 1, workOrders: 1 });
    const anomaly = await anomalyOf(press, 'temperature_high');
    expect(anomaly.scansSeen).toBe(1);
    const orders = await workOrdersOf(anomaly);
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({ priority: 'High', category: 'Mechanical', estimatedDurationMin: 70 });
    expect(orders[0].dueDate.getTime() - Date.now()).toBeLessThan(2 * HOUR + MIN);
  });

  it('several anomalies of one fault on one machine share one work order', async () => {
    const imm2 = await Model('assets').findOne({ companyId: acme.companyId, name: 'IMM 2' }).lean();
    const critical = (type) =>
      finding({
        type,
        severity: 'critical',
        parameters: [{ field: 'vibration', observed: 4.1, expected: 2.2, deviation: '+11σ' }],
        explanation: `${type} is far out. More text.`,
      });
    computeFeatures.mockResolvedValue([feature(imm2)]);
    answer([decision(imm2, { anomalies: [critical('vibration_high'), critical('temperature_high')] })]);
    expect(await scan()).toMatchObject({ created: 2, workOrders: 1 });
    const vib = await anomalyOf(imm2, 'vibration_high');
    const temp = await anomalyOf(imm2, 'temperature_high');
    const orders = await Model('workorders')
      .find({ asset: imm2._id, anomalyId: { $ne: null } })
      .lean();
    expect(orders).toHaveLength(1);
    expect(String(vib.workOrderId)).toBe(String(orders[0]._id));
    expect(String(temp.workOrderId)).toBe(String(orders[0]._id));
    expect(temp).toMatchObject({ state: 'acknowledged', autoWorkOrderAt: expect.any(Date) });
    expect(orders[0].comments.at(-1).comment).toBe(
      `SARA also found temperature high (${temp.anomalyCode}): temperature_high is far out.`,
    );
    expect(events.filter((e) => e.payload.change === 'work_order')).toHaveLength(2);

    // Once that order is done, a new finding on the machine opens its own.
    await Model('workorders').updateOne({ _id: orders[0]._id }, { $set: { workStatus: 'Completed' } });
    answer([decision(imm2, { anomalies: [critical('vibration_high'), critical('current_high')] })]);
    expect(await scan()).toMatchObject({ workOrders: 1 });
    expect(await Model('workorders').countDocuments({ asset: imm2._id, anomalyId: { $ne: null } })).toBe(2);
  });

  it('a fault back after its work order was completed reopens the anomaly with a new work order', async () => {
    const imm4 = await Model('assets').findOne({ companyId: acme.companyId, name: 'IMM 4' }).lean();
    const vibration = () =>
      decision(imm4, { anomalies: [finding({ severity: 'critical', urgencyHours: 2 })] });
    computeFeatures.mockResolvedValue([feature(imm4)]);
    answer([vibration()]);
    expect((await scan()).workOrders).toBe(1);
    const first = await anomalyOf(imm4, 'vibration_high');
    await Model('workorders').updateOne({ _id: first.workOrderId }, { $set: { workStatus: 'Completed' } });
    answer([clean(imm4)]);
    expect(await scan()).toMatchObject({ resolved: 1 });

    answer([vibration()]);
    expect(await scan()).toMatchObject({ reopened: 1, workOrders: 1 });
    const again = await anomalyOf(imm4, 'vibration_high');
    const orders = await workOrdersOf(again);
    expect(orders).toHaveLength(2);
    expect(String(again.workOrderId)).not.toBe(String(first.workOrderId));
    expect(orders.map((o) => String(o._id))).toContain(String(again.workOrderId));

    // The old, completed order is not the repair of this detection: one clean scan does not resolve it.
    answer([clean(imm4)]);
    expect(await scan()).toMatchObject({ resolved: 0 });
    expect(await anomalyOf(imm4, 'vibration_high')).toMatchObject({ state: 'acknowledged', cleanScans: 1 });
    await Model('workorders').updateOne({ _id: again.workOrderId }, { $set: { workStatus: 'Completed' } });
    answer([clean(imm4)]);
    expect(await scan()).toMatchObject({ resolved: 1 });
  });

  it('minSeverity critical ignores warnings; the counter persists so enabling later opens it at once', async () => {
    settings.anomaly.autoWorkOrder.minSeverity = 'critical';
    const current = () =>
      decision(imm, {
        anomalies: [
          finding({
            type: 'current_high',
            parameters: [{ field: 'vibration', observed: 4.1, expected: 2.2, deviation: '+11σ' }],
          }),
        ],
      });
    computeFeatures.mockResolvedValue([feature(imm)]);
    for (let i = 0; i < 2; i += 1) {
      answer([current()]);
      expect((await scan()).workOrders).toBe(0);
    }
    let anomaly = await anomalyOf(imm, 'current_high');
    expect(anomaly.scansSeen).toBe(2);
    expect(anomaly.autoWorkOrderAt).toBeFalsy();
    expect(await workOrdersOf(anomaly)).toHaveLength(0);

    settings.anomaly.autoWorkOrder.enabled = false;
    settings.anomaly.autoWorkOrder.minSeverity = 'warning';
    answer([current()]);
    expect((await scan()).workOrders).toBe(0);

    settings.anomaly.autoWorkOrder.enabled = true;
    answer([current()]);
    expect((await scan()).workOrders).toBe(1);
    anomaly = await anomalyOf(imm, 'current_high');
    expect((await workOrdersOf(anomaly))[0]).toMatchObject({
      category: 'Electrical',
      estimatedDurationMin: 60,
    });
  });

  it('a clean scan resets the counter, so only consecutive sightings count', async () => {
    const imbalance = () =>
      decision(imm, {
        anomalies: [
          finding({
            type: 'current_imbalance',
            parameters: [{ field: 'vibration', observed: 4.1, expected: 2.2, deviation: '+11σ' }],
          }),
        ],
      });
    computeFeatures.mockResolvedValue([feature(imm)]);
    answer([imbalance()]);
    expect((await scan()).workOrders).toBe(0);
    expect((await anomalyOf(imm, 'current_imbalance')).scansSeen).toBe(1);
    computeFeatures.mockResolvedValue([feature(imm, { flags: [] })]);
    answer([clean(imm)]);
    await scan();
    expect((await anomalyOf(imm, 'current_imbalance')).scansSeen).toBe(0);
    computeFeatures.mockResolvedValue([feature(imm)]);
    answer([imbalance()]);
    expect((await scan()).workOrders).toBe(0);
    expect((await anomalyOf(imm, 'current_imbalance')).scansSeen).toBe(1);
    answer([imbalance()]);
    expect((await scan()).workOrders).toBe(1);
  });

  it('takes over a claim cut off by a restart, and links an order already made instead of opening a second', async () => {
    const ctx = await systemContext(acme.companyId);
    const press2 = await Model('assets').findOne({ companyId: acme.companyId, name: 'Press 2' }).lean();
    const make = (type) =>
      records.create(
        ctx,
        'anomalies',
        {
          assetId: String(press2._id),
          type,
          severity: 'warning',
          state: 'open',
          summary: 'Pressure is off.',
        },
        { source: 'system' },
      );
    const opts = { feature: feature(press2), now: new Date() };
    const claimedAt = (anomaly, ago) =>
      Model('anomalies').updateOne(
        { _id: anomaly._id },
        { $set: { scansSeen: 2, autoWorkOrderAt: new Date(Date.now() - ago) } },
      );
    const load = (anomaly) => Model('anomalies').findById(anomaly._id).lean();

    // A fresh claim belongs to a create still running: hands off.
    const cut = await make('pressure_low');
    await claimedAt(cut, MIN);
    expect(shouldOpenWorkOrder(await load(cut), 'anomalous', DEFAULT_AUTO_WO)).toBe(false);
    expect(await openWorkOrderFor(ctx, await load(cut), opts)).toBeNull();
    // A stale one was cut off: the next scan opens the order.
    await claimedAt(cut, STALE_CLAIM_MS + MIN);
    expect(shouldOpenWorkOrder(await load(cut), 'anomalous', DEFAULT_AUTO_WO)).toBe(true);
    const opened = await openWorkOrderFor(ctx, await load(cut), opts);
    expect(opened.workOrder.workOrderId).toMatch(/^WO-\d+$/);
    expect(String((await load(cut)).workOrderId)).toBe(String(opened.workOrder._id));

    // Cut off after the create, before the link: the order is linked, not made twice.
    const orphaned = await make('pressure_high');
    const orphan = await records.create(
      ctx,
      'workorders',
      { name: 'Orphan', asset: String(press2._id), category: 'Hydraulic', anomalyId: String(orphaned._id) },
      { source: 'system' },
    );
    await Model('anomalies').updateOne({ _id: orphaned._id }, { $set: { workOrderId: null } });
    await claimedAt(orphaned, STALE_CLAIM_MS + MIN);
    const notesBefore = (await woNotes()).length;
    expect(await openWorkOrderFor(ctx, await load(orphaned), opts)).toMatchObject({ linked: true });
    expect(await workOrdersOf(orphaned)).toHaveLength(1);
    expect(String((await load(orphaned)).workOrderId)).toBe(String(orphan._id));
    expect(await woNotes()).toHaveLength(notesBefore);
  });

  it('reviews an anomaly counting toward its work order every tick, not after the quiet interval', async () => {
    const imm3 = await Model('assets').findOne({ companyId: acme.companyId, name: 'IMM 3' }).lean();
    const leak = () =>
      decision(imm3, {
        anomalies: [
          finding({
            type: 'pressure_low',
            parameters: [{ field: 'vibration', observed: 4.1, expected: 2.2, deviation: '+11σ' }],
          }),
        ],
      });
    computeFeatures.mockResolvedValue([feature(imm3)]);
    resetWatchState();
    answer([leak()]);
    expect(await scan()).toMatchObject({ created: 1, workOrders: 0 });
    // Same evidence, reviewed a moment ago: a plain tick still reviews it, and the order opens.
    answer([leak()]);
    expect(await scanCompany(acme.companyId)).toMatchObject({ reviewed: 1, workOrders: 1 });
    // Once the order is open, the asset is back on the quiet interval.
    answer([leak()]);
    expect(await scanCompany(acme.companyId)).toMatchObject({ reviewed: 0 });

    const open = (over) => ({ assetId: 'a', severity: 'warning', scansSeen: 1, workOrderId: null, ...over });
    const confirming = (anomalies, settings = DEFAULT_AUTO_WO) => [...confirmingAssets(anomalies, settings)];
    expect(confirming([open()])).toEqual(['a']);
    expect(confirming([open({ scansSeen: 2 })])).toEqual([]); // reached afterScans: no extra quota
    expect(confirming([open({ scansSeen: 0 })])).toEqual([]);
    expect(confirming([open({ workOrderId: 'x' })])).toEqual([]);
    expect(confirming([open({ severity: 'info' })])).toEqual([]);
    expect(confirming([open()], { ...DEFAULT_AUTO_WO, enabled: false })).toEqual([]);
    const quiet = {
      lastReviewedAt: new Map([['a', Date.now()]]),
      lastEvidence: new Map(),
      quietIntervalMin: 10,
    };
    expect(dueAssets([{ assetId: 'a', flags: [], fields: [] }], quiet)).toHaveLength(0);
    expect(
      dueAssets([{ assetId: 'a', flags: [], fields: [] }], { ...quiet, confirming: new Set(['a']) }),
    ).toHaveLength(1);
  });

  it('shouldOpenWorkOrder is pure and strict', () => {
    const base = {
      state: 'open',
      severity: 'warning',
      scansSeen: 2,
      workOrderId: null,
      autoWorkOrderAt: null,
    };
    expect(shouldOpenWorkOrder(base, 'anomalous', DEFAULT_AUTO_WO)).toBe(true);
    expect(shouldOpenWorkOrder({ ...base, scansSeen: 1 }, 'anomalous', DEFAULT_AUTO_WO)).toBe(false);
    expect(
      shouldOpenWorkOrder({ ...base, scansSeen: 1, severity: 'critical' }, 'anomalous', DEFAULT_AUTO_WO),
    ).toBe(true);
    expect(shouldOpenWorkOrder(base, 'watch', DEFAULT_AUTO_WO)).toBe(false);
    expect(
      shouldOpenWorkOrder({ ...base, severity: 'info', scansSeen: 9 }, 'anomalous', DEFAULT_AUTO_WO),
    ).toBe(false);
    expect(shouldOpenWorkOrder({ ...base, state: 'resolved' }, 'anomalous', DEFAULT_AUTO_WO)).toBe(false);
    expect(shouldOpenWorkOrder({ ...base, workOrderId: 'x' }, 'anomalous', DEFAULT_AUTO_WO)).toBe(false);
    expect(shouldOpenWorkOrder({ ...base, autoWorkOrderAt: new Date() }, 'anomalous', DEFAULT_AUTO_WO)).toBe(
      false,
    );
    expect(shouldOpenWorkOrder(base, 'anomalous', { ...DEFAULT_AUTO_WO, enabled: false })).toBe(false);
    expect(shouldOpenWorkOrder(base, 'anomalous', { ...DEFAULT_AUTO_WO, minSeverity: 'critical' })).toBe(
      false,
    );
    expect(shouldOpenWorkOrder(base, 'anomalous', undefined)).toBe(false);
    expect(Object.values(CATEGORY_OF).every((c) => typeof c === 'string')).toBe(true);
    expect(PRIORITY_OF).toEqual({ critical: 'High', warning: 'Medium', info: 'Low' });
  });

  it('validates the settings patch', () => {
    expect(DEFAULT_AI.anomaly.autoWorkOrder).toEqual(DEFAULT_AUTO_WO);
    const ok = aiPatchSchema.safeParse({
      anomaly: { autoWorkOrder: { enabled: false, afterScans: 3, minSeverity: 'critical' } },
    });
    expect(ok.success).toBe(true);
    for (const bad of [
      { afterScans: 0 },
      { afterScans: 11 },
      { afterScans: 1.5 },
      { minSeverity: 'info' },
      { x: 1 },
    ]) {
      expect(aiPatchSchema.safeParse({ anomaly: { autoWorkOrder: bad } }).success).toBe(false);
    }
  });
});
