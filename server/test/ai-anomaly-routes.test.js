import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { systemContext } from '../src/context/buildUserContext.js';
import { records } from '../src/modules/records.js';
import { getModule } from '../src/modules/registry.js';
import { aiRouter } from '../src/routes/ai.js';
import { anomaliesRouter } from '../src/routes/anomalies.js';
import { notificationsRouter } from '../src/routes/notifications.js';
import { PASSWORD, setupDatabase, teardownDatabase } from './helpers/db.js';

const { generate, AiUnavailableError, settings, computeFeatures } = vi.hoisted(() => {
  class AiUnavailableError extends Error {
    constructor(code, message) {
      super(message ?? code);
      this.code = code;
    }
  }
  return {
    generate: vi.fn(),
    AiUnavailableError,
    settings: {
      tiers: { background: { model: 'test-background' } },
      limits: { 'test-background': { rpm: 10, rpd: 20 } },
      chatReservePct: 50,
      anomaly: { enabled: true, tickSec: 60, quietIntervalMin: 10, alwaysAskAi: false, investigate: false },
    },
    computeFeatures: vi.fn(),
  };
});
vi.mock('../src/ai/gemini.js', () => ({ generate, AiUnavailableError }));
vi.mock('../src/ai/settings.js', () => ({ getAiSettings: async () => settings }));
vi.mock('../src/ai/anomaly/features.js', async (importOriginal) => ({
  ...(await importOriginal()),
  computeFeatures,
}));
vi.mock('../src/ai/anomaly/baselines.js', async (importOriginal) => ({
  ...(await importOriginal()),
  ensureBaselines: async () => new Map(),
}));
vi.mock('../src/telemetry/queries.js', async (importOriginal) => ({
  ...(await importOriginal()),
  seriesFor: async (_companyId, [assetId], fields) => ({
    series: fields.map((field) => ({
      assetId,
      field,
      measurement: 'machineParams',
      points: [
        [Date.now() - 120_000, 3.9],
        [Date.now() - 60_000, 4.1],
      ],
    })),
  }),
}));

const Model = (name) => getModule(name).Model;
let app;
let acme;
let imm;
let press4; // Chennai
const tokens = {};
const ids = {};
const as = (who) => ({ authorization: `Bearer ${tokens[who]}` });

const feature = (asset) => ({
  assetId: String(asset._id),
  name: asset.name,
  tag: asset.assetTag,
  type: asset.typeOfAsset,
  plantId: String(asset.plantId),
  status: 'Running',
  statusSince: new Date(Date.now() - 30 * 60_000).toISOString(),
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
      flags: ['z'],
    },
  ],
  rejectionRate: null,
  idlePowerRatio: null,
  flags: ['z'],
});

/** An open anomaly on an asset, written the way the watch writes it. */
const openAnomaly = async (asset, type = 'vibration_high') => {
  const ctx = await systemContext(acme.companyId);
  const created = await records.create(
    ctx,
    'anomalies',
    {
      assetId: String(asset._id),
      type,
      severity: 'warning',
      state: 'open',
      summary: 'Vibration is high.',
      explanation: 'Vibration doubled.',
      confidence: 0.8,
    },
    { source: 'system' },
  );
  await Model('anomalies').updateOne(
    { _id: created._id },
    {
      $set: {
        parameters: [{ field: 'vibration', unit: 'mm/s', observed: 4.1, expected: 2.2, deviation: '+11σ' }],
        detectedAt: new Date(),
        lastSeenAt: new Date(),
        model: 'mock-model',
      },
    },
  );
  return String(created._id);
};

beforeAll(async () => {
  ({ acme } = await setupDatabase());
  app = createApp({
    routers: [
      { path: '/api', router: aiRouter },
      { path: '/api', router: anomaliesRouter },
      { path: '/api', router: notificationsRouter },
    ],
  });
  const Asset = Model('assets');
  imm = await Asset.findOne({ companyId: acme.companyId, name: 'IMM 1' }).lean();
  press4 = await Asset.findOne({ companyId: acme.companyId, name: 'Press 3' }).lean();
  for (const [who, email] of Object.entries({
    owner: 'owner_1@acme.test',
    puneTech: 'maintenance_technician_1@acme.test',
    chennaiTech: 'maintenance_technician_4@acme.test',
    viewer: 'viewer_1@acme.test',
    betaOwner: 'owner_1@beta.test',
  })) {
    const res = await request(app).post('/api/auth/login').send({ email, password: PASSWORD });
    expect(res.status).toBe(200);
    tokens[who] = res.body.token;
    ids[who] = String(res.body.user._id);
  }
  ids.pune = String(imm.plantId);
  ids.chennai = String(press4.plantId);
});
afterAll(teardownDatabase);
beforeEach(() => {
  generate.mockReset(); // braces: a function returned from beforeEach runs as its teardown
});

describe('POST /api/ai/scan', () => {
  it('is for owners and admins of the company', async () => {
    expect((await request(app).post('/api/ai/scan')).status).toBe(401);
    expect((await request(app).post('/api/ai/scan').set(as('viewer'))).status).toBe(403);
    expect((await request(app).post('/api/ai/scan').set(as('puneTech'))).status).toBe(403);
  });

  it('runs a forced scan and answers with the counts', async () => {
    computeFeatures.mockResolvedValue([feature(imm)]);
    generate.mockResolvedValue({
      json: {
        assets: [
          {
            assetId: String(imm._id),
            healthScore: 91,
            state: 'normal',
            summary: 'Running normally.',
            anomalies: [],
          },
        ],
      },
      model: 'mock-model',
      mock: true,
    });
    const res = await request(app).post('/api/ai/scan').set(as('owner'));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ reviewed: 1, anomalies: 0, reason: 'manual', model: 'mock-model' });
    expect((await Model('assets').findById(imm._id).lean()).healthScore).toBe(91);
  });

  it('explains an exhausted quota as 429', async () => {
    computeFeatures.mockResolvedValue([feature(imm)]);
    // Lazy: an eagerly rejected promise counts as unhandled before the route gets to it.
    generate.mockImplementation(async () => {
      throw new AiUnavailableError('AI_QUOTA', 'The AI quota for today is used up');
    });
    const res = await request(app).post('/api/ai/scan').set(as('owner'));
    expect(res.status).toBe(429);
    expect(res.body.error).toMatchObject({ code: 'AI_QUOTA', message: 'The AI quota for today is used up' });
  });
});

describe('GET /api/ai/health', () => {
  it('needs an asset the caller can see', async () => {
    expect((await request(app).get('/api/ai/health').set(as('owner'))).status).toBe(400);
    const query = { assetId: String(imm._id) };
    const hidden = await request(app).get('/api/ai/health').query(query).set(as('chennaiTech'));
    expect(hidden.status).toBe(404);
    const other = await request(app).get('/api/ai/health').query(query).set(as('betaOwner'));
    expect(other.status).toBe(404);
  });

  it('returns the health fields with open and recent anomalies', async () => {
    const id = await openAnomaly(imm);
    const res = await request(app)
      .get('/api/ai/health')
      .query({ assetId: String(imm._id) })
      .set(as('puneTech'));
    expect(res.status).toBe(200);
    expect(res.body.asset).toMatchObject({
      id: String(imm._id),
      name: 'IMM 1',
      healthScore: 91,
      healthSummary: 'Running normally.',
    });
    expect(res.body.anomalies.map((a) => a._id)).toEqual([id]);
    expect(res.body.anomalies[0]).toMatchObject({
      anomalyCode: 'ANM-1',
      state: 'open',
      parameters: [{ field: 'vibration' }],
    });
  });
});

describe('POST /api/anomalies/:id/state', () => {
  it('follows the plant rule and the assets.update permission', async () => {
    const [anomaly] = await Model('anomalies').find({ companyId: acme.companyId }).lean();
    const id = String(anomaly._id);
    const bad = await request(app)
      .post(`/api/anomalies/${id}/state`)
      .send({ state: 'closed' })
      .set(as('owner'));
    expect(bad.status).toBe(400);
    expect(
      (
        await request(app)
          .post(`/api/anomalies/${id}/state`)
          .send({ state: 'acknowledged' })
          .set(as('viewer'))
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .post(`/api/anomalies/${id}/state`)
          .send({ state: 'acknowledged' })
          .set(as('chennaiTech'))
      ).status,
    ).toBe(404);
    expect(
      (
        await request(app)
          .post(`/api/anomalies/${id}/state`)
          .send({ state: 'acknowledged' })
          .set(as('betaOwner'))
      ).status,
    ).toBe(404);

    const ack = await request(app)
      .post(`/api/anomalies/${id}/state`)
      .send({ state: 'acknowledged' })
      .set(as('puneTech'));
    expect(ack.status).toBe(200);
    expect(ack.body.anomaly).toMatchObject({ state: 'acknowledged', acknowledgedBy: ids.puneTech });

    const done = await request(app)
      .post(`/api/anomalies/${id}/state`)
      .send({ state: 'false_positive', note: 'Sensor was being replaced.' })
      .set(as('owner'));
    expect(done.status).toBe(200);
    expect(done.body.anomaly).toMatchObject({ state: 'false_positive', notes: 'Sensor was being replaced.' });
    expect(done.body.anomaly.resolvedAt).toBeTruthy();
  });
});

describe('POST /api/anomalies/:id/investigate', () => {
  it('stores and returns the investigation built from the evidence pack', async () => {
    const id = await openAnomaly(imm, 'temperature_high');
    generate.mockResolvedValue({
      json: {
        summary: 'The main drive bearing is wearing.',
        rootCause: 'Bearing wear on the main drive',
        confidence: 0.7,
        recommendedActions: ['Inspect the bearing', 'Plan a replacement'],
        suggestedWorkOrder: {
          name: 'Inspect IMM 1 drive bearing',
          description: 'Check play and lubrication.',
          priority: 'High',
          category: 'Mechanical',
          estimatedDurationMin: 90,
        },
        urgencyHours: 24,
        markdown: '# Findings\nVibration doubled.',
      },
      model: 'mock-model',
      mock: true,
    });
    expect((await request(app).post(`/api/anomalies/${id}/investigate`).set(as('chennaiTech'))).status).toBe(
      404,
    );
    expect((await request(app).post(`/api/anomalies/${id}/investigate`).set(as('viewer'))).status).toBe(403);
    const res = await request(app).post(`/api/anomalies/${id}/investigate`).set(as('puneTech'));
    expect(res.status).toBe(200);
    expect(res.body.investigation).toMatchObject({
      rootCause: 'Bearing wear on the main drive',
      suggestedWorkOrder: { priority: 'High', estimatedDurationMin: 90 },
      model: 'mock-model',
      evidence: { fields: ['vibration'] },
    });
    expect(res.body.investigation.evidence.series[0].points).toHaveLength(2);
    const call = generate.mock.calls[0][0];
    expect(call).toMatchObject({ tier: 'background', purpose: 'investigation' });
    expect(call.mockInput.asset.name).toBe('IMM 1');
    expect(call.mockInput.workOrders.length).toBeGreaterThan(0);
    expect(call.contents).toContain('"similarAnomalies"');
    const stored = await Model('anomalies').findById(id).lean();
    expect(stored.investigation.rootCause).toBe('Bearing wear on the main drive');
  });
});

describe('notifications', () => {
  const Notification = () => Model('notifications');
  const note = (over) =>
    Notification().create({
      companyId: acme.companyId,
      message: { title: 'x' },
      recipientUsers: [],
      readBy: [],
      ...over,
    });
  let mineOnly;
  let everyonePune;
  let chennaiOnly;

  beforeAll(async () => {
    await Notification().deleteMany({ companyId: acme.companyId });
    mineOnly = await note({
      message: { title: 'For the owner' },
      recipientUsers: [ids.owner],
      plantId: null,
    });
    everyonePune = await note({ message: { title: 'Pune, everyone' }, plantId: ids.pune });
    chennaiOnly = await note({
      message: { title: 'Chennai tech' },
      recipientUsers: [ids.chennaiTech],
      plantId: ids.chennai,
    });
    await note({ message: { title: 'Pune tech only' }, recipientUsers: [ids.puneTech], plantId: ids.pune });
  });

  it('lists what is addressed to me or everyone, inside my plant, newest first, with unread count', async () => {
    const owner = await request(app).get('/api/notifications').set(as('owner'));
    expect(owner.status).toBe(200);
    expect(owner.body.items.map((n) => n.message.title)).toEqual(['Pune, everyone', 'For the owner']);
    expect(owner.body.items.every((n) => n.read === false && !('readBy' in n))).toBe(true);
    expect(owner.body.unread).toBe(2);

    const chennai = await request(app).get('/api/notifications').set(as('chennaiTech'));
    expect(chennai.body.items.map((n) => n.message.title)).toEqual(['Chennai tech']);
    expect(chennai.body.unread).toBe(1);
  });

  it('marks one or all as read for me only', async () => {
    expect(
      (await request(app).post(`/api/notifications/${chennaiOnly._id}/read`).set(as('owner'))).status,
    ).toBe(404);
    expect((await request(app).post('/api/notifications/nope/read').set(as('owner'))).status).toBe(404);
    const one = await request(app).post(`/api/notifications/${everyonePune._id}/read`).set(as('owner'));
    expect(one.body).toEqual({ ok: true });
    const after = await request(app).get('/api/notifications').set(as('owner'));
    expect(after.body.items.find((n) => n._id === String(everyonePune._id)).read).toBe(true);
    expect(after.body.unread).toBe(1);

    expect((await request(app).post('/api/notifications/read-all').set(as('owner'))).body).toEqual({
      ok: true,
    });
    expect((await request(app).get('/api/notifications').set(as('owner'))).body.unread).toBe(0);
    expect((await request(app).get('/api/notifications').set(as('chennaiTech'))).body.unread).toBe(1);
    const stored = await Notification().findById(mineOnly._id).lean();
    expect(stored.readBy.map(String)).toEqual([ids.owner]);
  });
});
