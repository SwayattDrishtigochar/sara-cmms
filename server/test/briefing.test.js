import mongoose from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AiUnavailableError } from '../src/ai/gemini.js';
import { getAiSettings } from '../src/ai/settings.js';
import { createApp } from '../src/app.js';
import { briefingKey, getBriefing } from '../src/briefing/briefing.js';
import { buildEvidence } from '../src/briefing/evidence.js';
import { AiText } from '../src/db/models/AiText.js';
import { getModule } from '../src/modules/registry.js';
import { briefingRouter } from '../src/routes/briefing.js';
import { contextFor, NOW, PASSWORD, setupDatabase, systemContext, teardownDatabase } from './helpers/db.js';

const { generate } = vi.hoisted(() => ({ generate: vi.fn() }));
vi.mock('../src/ai/gemini.js', async (importOriginal) => {
  const real = await importOriginal();
  generate.mockImplementation(real.generate); // the AI_MOCK answers unless a test overrides one call
  return { ...real, generate };
});
// No Influx in tests: energy has no points.
vi.mock('../src/telemetry/queries.js', async (importOriginal) => ({
  ...(await importOriginal()),
  seriesFor: async () => ({ series: [] }),
}));

const Model = (name) => getModule(name).Model;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY_START = new Date('2026-10-14T18:30:00Z'); // 15 Oct 00:00 IST
const { ObjectId } = mongoose.Types;

let acme;
let beta;
let owner;
let pune; // plant-locked admin of Pune
let chennai; // plant-locked admin of Chennai
let imm1;
let imm2;
let chennaiAsset;
let before;

const insert = (name, doc) =>
  Model(name).collection.insertOne({
    _id: new ObjectId(),
    companyId: acme.companyId,
    deleted: false,
    ...doc,
  });

beforeAll(async () => {
  ({ acme, beta } = await setupDatabase());
  owner = await contextFor('owner_1@acme.test');
  pune = await contextFor('plant_manager_1@acme.test');
  chennai = await contextFor('plant_manager_2@acme.test');
  const sys = await systemContext(acme.companyId);
  const puneId = sys.plants.find((p) => p.name === 'Pune Plant')._id;
  const assets = await Model('assets')
    .find({ companyId: acme.companyId, isProductionAsset: true })
    .sort({ name: 1 })
    .lean();
  [imm1, imm2] = assets.filter((a) => String(a.plantId) === String(puneId));
  chennaiAsset = assets.find((a) => String(a.plantId) !== String(puneId));
  before = await buildEvidence(owner, { now: NOW });

  const partcount = (
    asset,
    produced,
    totalTarget,
    date = new Date('2026-10-15T00:30:00Z'),
    shiftName = 'A',
  ) =>
    insert('partcounts', {
      assetId: asset._id,
      plantId: asset.plantId,
      date,
      shiftName,
      produced,
      totalTarget,
    });
  await partcount(imm1, 400, 500);
  await partcount(imm2, 100, 300);
  await partcount(chennaiAsset, 50, 100);
  await partcount(imm1, 999, 999, new Date('2026-10-14T08:30:00Z'), 'B'); // yesterday's shift B: not today
  await partcount(imm2, 70, 80, new Date('2026-10-14T16:30:00Z'), 'C'); // last night's shift C: ran until 06:00 today

  // Started yesterday 23:50 IST, ended 00:20 IST → 20 min today; plus one still running since 11:45 IST.
  await insert('downtimes', {
    assetId: imm1._id,
    plantId: imm1.plantId,
    startedAt: new Date(DAY_START - 10 * MIN),
    endedAt: new Date(+DAY_START + 20 * MIN),
    reason: ['Mould change'],
  });
  await insert('downtimes', {
    assetId: imm2._id,
    plantId: imm2.plantId,
    startedAt: new Date(NOW - 15 * MIN),
    endedAt: null,
    reason: [],
  });

  const anomaly = (asset, severity, state, code) =>
    insert('anomalies', {
      assetId: asset._id,
      plantId: asset.plantId,
      anomalyCode: code,
      type: 'vibration_high',
      severity,
      state,
      summary: `${severity} on ${asset.name}`,
      detectedAt: new Date(NOW - HOUR),
    });
  await anomaly(imm2, 'warning', 'open', 'ANM-1');
  await anomaly(imm1, 'critical', 'acknowledged', 'ANM-2');
  await anomaly(imm1, 'info', 'resolved', 'ANM-3');
  await anomaly(chennaiAsset, 'info', 'open', 'ANM-4');

  await insert('workorders', {
    plantId: imm1.plantId,
    workOrderId: 'WO-900',
    name: 'Overdue check',
    asset: imm1._id,
    workStatus: 'Open',
    dueDate: new Date(NOW - 2 * HOUR),
  });
  await insert('preventivemaintenances', {
    plantId: imm2.plantId,
    preventiveMaintenanceId: 'PM-900',
    name: 'Grease screws',
    assetAllocation: imm2._id,
    isActive: true,
    nextGenerationDate: new Date(+NOW + 3 * HOUR), // 15:00 IST today
  });
  await insert('jobcards', {
    plantId: imm1.plantId,
    jobCardId: 'JC-900',
    jobName: 'Test job',
    asset: imm1._id,
    target: 100,
    jobStatus: 'Completed',
    actualEnd: new Date(NOW - 30 * MIN),
    completionMetrics: { oee: { oee: 0.9, availability: 0.95, performance: 0.95, quality: 1 } },
  });
});
afterAll(teardownDatabase);

describe('evidence pack', () => {
  it('counts today so far in the company zone', async () => {
    const ev = await buildEvidence(owner, { now: NOW });
    expect(ev.production).toMatchObject({ produced: 620, planned: 980, pct: 63.3 });
    expect(ev.production.byAsset[0]).toMatchObject({ asset: imm1.name, produced: 400, target: 500 });
    expect(ev.production.block.type).toBe('chart');

    expect(ev.downtime).toMatchObject({ totalMinutes: 35, count: 2 });
    expect(ev.downtime.top[0]).toMatchObject({ asset: imm1.name, minutes: 20, reason: 'Mould change' });
    expect(ev.downtime.top[1]).toMatchObject({ asset: imm2.name, minutes: 15, reason: null });

    expect(ev.anomalies).toMatchObject({ open: 3, critical: 1 });
    expect(ev.anomalies.items.map((a) => a.code)).toEqual(['ANM-2', 'ANM-1', 'ANM-4']);

    expect(ev.maintenance.overdue).toBe(before.maintenance.overdue + 1);
    expect(ev.maintenance.dueToday).toBe(before.maintenance.dueToday + 1);
    expect(ev.maintenance.openWorkOrders).toBe(before.maintenance.openWorkOrders + 1);
    expect(ev.maintenance.dueSoon.length).toBeLessThanOrEqual(5);

    expect(ev.oee.jobs).toBe(before.oee.jobs + 1);
    expect(ev.oee.today).not.toBeNull();
    for (const k of ['oee', 'availability', 'performance', 'quality']) {
      expect(ev.oee[k]).toBeGreaterThan(0);
      expect(ev.oee[k]).toBeLessThanOrEqual(1);
    }
    expect(ev.costs).toMatchObject({ currency: { symbol: '₹' }, period: expect.any(String) });
    expect(ev.costs.total).toBeGreaterThanOrEqual(ev.costs.downtime);
    expect(ev.plan.activeJobCards).toBeGreaterThanOrEqual(0);
    for (const section of Object.values(ev)) expect(section.block.type).toMatch(/^(kpis|table|chart)$/);
  });

  it('stays inside the plant lock and the tenant', async () => {
    const ev = await buildEvidence(pune, { now: NOW });
    expect(ev.production).toMatchObject({ produced: 570, planned: 880 });
    expect(ev.anomalies.items.map((a) => a.code)).toEqual(['ANM-2', 'ANM-1']);
    const other = await buildEvidence(chennai, { now: NOW });
    expect(other.production).toMatchObject({ produced: 50, planned: 100 });
    expect(other.downtime.count).toBe(0);
    const betaOwner = await contextFor('owner_1@beta.test');
    const b = await buildEvidence(betaOwner, { now: NOW });
    expect(b.production).toBeNull(); // production switched off for Beta Foods
    expect(b.anomalies?.open ?? 0).toBe(0);
  });
});

describe('briefing', () => {
  it('caches one text per scope and day, refreshes after the TTL or on demand', async () => {
    const ttl = ((await getAiSettings()).briefingTtlHours ?? 4) * HOUR;
    const calls = () => generate.mock.calls.filter(([a]) => a.purpose === 'briefing').length;
    const start = calls();
    const first = await getBriefing(owner, { now: NOW });
    expect(first).toMatchObject({ stale: false, mock: true, model: expect.any(String) });
    expect(first.briefing.actions).toHaveLength(3);
    expect(first.briefing.headline).toMatch(/to watch/);
    expect(first.briefing.narrative).toMatch(/63% of plan \(620 of 980 pcs\)/);
    expect(first.evidence.anomalies.open).toBe(3);
    const [call] = generate.mock.calls.at(-1);
    expect(call).toMatchObject({ tier: 'background', purpose: 'briefing', mockInput: { kind: 'briefing' } });
    expect(JSON.parse(call.contents).evidence.production.block).toBeUndefined();

    const again = await getBriefing(owner, { now: new Date(+NOW + MIN) });
    expect(again.at).toEqual(first.at);
    expect(calls()).toBe(start + 1);
    await getBriefing(owner, { now: new Date(+NOW + ttl + MIN) });
    expect(calls()).toBe(start + 2);
    await getBriefing(owner, { now: new Date(+NOW + 2 * MIN), refresh: true });
    expect(calls()).toBe(start + 3);
  });

  it('keys plant-locked viewers by their plant', async () => {
    await getBriefing(pune, { now: NOW });
    expect(briefingKey(pune, NOW)).toBe(`plant:${pune.plantLock}|2026-10-15`);
    const keys = await AiText.distinct('key', { companyId: acme.companyId, kind: 'briefing' });
    expect(keys).toContain(`plant:${pune.plantLock}|2026-10-15`);
    expect(keys).toContain('all|2026-10-15');
  });

  it('falls back to the last text (stale) or a plain "Today so far" when the AI is unavailable', async () => {
    const cached = await getBriefing(owner, { now: NOW });
    generate.mockRejectedValueOnce(new AiUnavailableError('AI_QUOTA', 'Daily limit reached'));
    const failed = await getBriefing(owner, { now: NOW, refresh: true });
    expect(failed).toMatchObject({ stale: true, aiError: { code: 'AI_QUOTA' } });
    expect(failed.briefing.narrative).toBe(cached.briefing.narrative);

    generate.mockRejectedValueOnce(new AiUnavailableError('AI_QUOTA', 'Daily limit reached'));
    const none = await getBriefing(chennai, { now: NOW });
    expect(none).toMatchObject({ stale: false, model: null, aiError: { code: 'AI_QUOTA' } });
    expect(none.briefing).toMatchObject({ headline: 'Today so far', narrative: null, actions: [] });
    expect(none.briefing.evidence.length).toBeGreaterThan(0);
    expect(none.evidence.production.produced).toBe(50);
  });

  it('drops links that leave the app and evidence the viewer does not have', async () => {
    const betaOwner = await contextFor('owner_1@beta.test');
    const action = (link) => ({ title: 'Do it', why: 'Because', link, ask: null });
    generate.mockResolvedValueOnce({
      json: {
        headline: 'Quiet day',
        narrative: 'Nothing to report.',
        actions: [action('https://evil.example'), action('//evil.example'), action('/costs')],
        evidence: ['production', 'costs'],
      },
      model: 'gemini-test',
      mock: false,
    });
    const { briefing } = await getBriefing(betaOwner, { now: NOW });
    expect(briefing.actions.map((a) => a.link)).toEqual([null, null, '/costs']);
    expect(briefing.evidence).toEqual(['costs']);
  });
});

describe('routes', () => {
  let app;
  const tokens = {};
  const as = (who) => ({ authorization: `Bearer ${tokens[who]}` });

  beforeAll(async () => {
    app = createApp({ routers: [{ path: '/api', router: briefingRouter }] });
    for (const [who, email] of Object.entries({ owner: 'owner_1@acme.test', viewer: 'viewer_1@acme.test' })) {
      const res = await request(app).post('/api/auth/login').send({ email, password: PASSWORD });
      tokens[who] = res.body.token;
    }
  });

  it('serves the briefing to every role and refresh to owners/admins only', async () => {
    const res = await request(app).get('/api/briefing').set(as('viewer'));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      briefing: { headline: expect.any(String) },
      evidence: expect.any(Object),
    });
    expect((await request(app).post('/api/briefing/refresh').set(as('viewer')).send({})).status).toBe(403);
    const fresh = await request(app).post('/api/briefing/refresh').set(as('owner')).send({});
    expect(fresh.status).toBe(200);
    expect(fresh.body.briefing.actions).toHaveLength(3);
  });

  it('narrows a company-wide viewer to a picked plant of their company', async () => {
    const res = await request(app)
      .get('/api/briefing')
      .query({ plantId: String(imm1.plantId) })
      .set(as('owner'));
    expect(res.status).toBe(200);
    expect(res.body.evidence.anomalies.items.map((a) => a.code)).toEqual(['ANM-2', 'ANM-1']);
    const betaPlant = (await systemContext(beta.companyId)).plants[0]._id;
    const bad = await request(app)
      .get('/api/briefing')
      .query({ plantId: String(betaPlant) })
      .set(as('owner'));
    expect(bad.status).toBe(400);
  });
});
