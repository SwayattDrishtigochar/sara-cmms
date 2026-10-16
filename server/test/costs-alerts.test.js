import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AiUnavailableError } from '../src/ai/gemini.js';
import { PHASE5_BUILDERS } from '../src/ai/mockPhase5.js';
import { createApp } from '../src/app.js';
import { checkAlerts, evaluateAlert } from '../src/costs/alerts.js';
import { getCostOverview } from '../src/costs/overview.js';
import { subscribe } from '../src/lib/events.js';
import { records } from '../src/modules/records.js';
import { getModule } from '../src/modules/registry.js';
import { costsRouter } from '../src/routes/costs.js';
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
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
let acme;
let beta;
let sys;
let cmp1; // Pune, no seeded downtime, ₹2000/h
let rate;
const events = [];

/** A downtime of `hours` on Compressor 1 that ends one hour before `end`. */
const stop = (end, hours) =>
  Model('downtimes').collection.insertOne({
    companyId: acme.companyId,
    plantId: cmp1.plantId,
    assetId: cmp1._id,
    startedAt: new Date(end.getTime() - (hours + 1) * HOUR),
    endedAt: new Date(end.getTime() - HOUR),
  });
const makeAlert = async (fields) => {
  const created = await records.create(
    sys,
    'costalerts',
    {
      name: 'Compressor 1 downtime',
      metric: 'downtime',
      scope: 'asset',
      assetId: String(cmp1._id),
      threshold: 100,
      ...fields,
    },
    { source: 'rest' },
  );
  return Model('costalerts').findById(created._id).lean();
};
const reload = (alert) => Model('costalerts').findById(alert._id).lean();

beforeAll(async () => {
  ({ acme, beta } = await setupDatabase());
  sys = await systemContext(acme.companyId);
  cmp1 = await Model('assets').findOne({ companyId: acme.companyId, name: 'Compressor 1' }).lean();
  rate = cmp1.downtimeCostPerHour;
  await stop(NOW, 1);
  subscribe((e) => events.push(e));
});
afterAll(teardownDatabase);

describe('evaluateAlert', () => {
  it('fires once per period with an AI explanation, a history row, a notification and a live event', async () => {
    const alert = await makeAlert({ period: 'day', comparator: 'gt' });
    const first = await evaluateAlert(sys, alert, { now: NOW });
    expect(first).toEqual({ value: rate, periodKey: 'day:2026-10-15', breached: true, fired: true });

    const after = await reload(alert);
    expect(after).toMatchObject({ lastValue: rate, lastPeriodKey: 'day:2026-10-15', lastTriggeredAt: NOW });
    expect(after.history).toHaveLength(1);
    expect(after.history[0]).toMatchObject({ periodKey: 'day:2026-10-15', value: rate, threshold: 100 });
    expect(after.history[0].explanation).toBe(
      'Downtime cost on Compressor 1 reached ₹2,000 today, past the ₹100 limit. Review the work orders and stops behind it before the next period starts.',
    );

    const note = await Model('notifications').findById(after.history[0].notificationId).lean();
    expect(note).toMatchObject({
      type: 'alert',
      priority: 'high',
      message: { title: 'Cost alert: Compressor 1 downtime' },
    });
    expect(note.details.recordId).toBe(String(alert._id));
    const recipients = await Model('users')
      .find({ _id: { $in: note.recipientUsers } })
      .lean();
    expect(recipients.map((u) => u.role).sort()[0]).toBe('admin');
    expect(recipients.some((u) => u.role === 'owner')).toBe(true);
    expect(
      recipients.every((u) => u.role === 'owner' || !u.plantId || String(u.plantId) === String(cmp1.plantId)),
    ).toBe(true);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'record',
        payload: { module: 'costalerts', id: String(alert._id), change: 'triggered' },
      }),
    );

    // Same period: breached again, no second fire — even from a stale in-memory copy (claim on lastPeriodKey).
    expect(
      await evaluateAlert(sys, await reload(alert), { now: new Date(NOW.getTime() + HOUR) }),
    ).toMatchObject({
      breached: true,
      fired: false,
    });
    expect((await evaluateAlert(sys, alert, { now: NOW })).fired).toBe(false);
    expect((await reload(alert)).history).toHaveLength(1);

    // Next day, new breach → fires again.
    const tomorrow = new Date(NOW.getTime() + DAY);
    await stop(tomorrow, 1);
    expect(await evaluateAlert(sys, await reload(alert), { now: tomorrow })).toMatchObject({
      periodKey: 'day:2026-10-16',
      fired: true,
    });
    expect((await reload(alert)).history).toHaveLength(2);
  });

  it('does not fire below the threshold but still stores the value', async () => {
    const alert = await makeAlert({ threshold: 1_000_000 });
    expect(await evaluateAlert(sys, alert, { now: NOW })).toMatchObject({ breached: false, fired: false });
    expect(await reload(alert)).toMatchObject({ lastValue: rate, lastEvaluatedAt: NOW });
  });

  it('lt compares the previous complete period', async () => {
    const alert = await makeAlert({ period: 'week', comparator: 'lt', threshold: 1_000_000 });
    const result = await evaluateAlert(sys, alert, { now: NOW });
    expect(result).toMatchObject({ periodKey: 'week:2026-W41', value: 0, breached: true, fired: true });
    expect((await reload(alert)).history[0]).toMatchObject({ periodKey: 'week:2026-W41', value: 0 });
    expect((await reload(alert)).history[0].explanation).toMatch(
      /^Downtime cost on Compressor 1 reached ₹0 last week, under the ₹10,00,000 floor. Check/,
    );
  });

  it('caps the history at 60 rows', async () => {
    const alert = await makeAlert({});
    const old = Array.from({ length: 60 }, (_, i) => ({
      periodKey: `day:old-${i}`,
      value: 1,
      threshold: 100,
    }));
    await Model('costalerts').updateOne({ _id: alert._id }, { $set: { history: old } });
    await evaluateAlert(sys, await reload(alert), { now: NOW });
    const { history } = await reload(alert);
    expect(history).toHaveLength(60);
    expect(history[0].periodKey).toBe('day:old-1');
    expect(history.at(-1).periodKey).toBe('day:2026-10-15');
  });

  it('falls back to a plain sentence when the AI is unavailable', async () => {
    generate.mockRejectedValueOnce(new AiUnavailableError('AI_QUOTA', 'Daily limit reached'));
    const alert = await makeAlert({ threshold: 1500 });
    expect((await evaluateAlert(sys, alert, { now: NOW })).fired).toBe(true);
    const [row] = (await reload(alert)).history;
    expect(row.explanation).toBe(
      'Downtime cost on Compressor 1 reached ₹2,000 today, past the ₹1,500 limit.',
    );
    expect(row.model).toBeNull();
  });
});

describe('checkAlerts', () => {
  it('evaluates only enabled alerts of that company', async () => {
    const paused = await makeAlert({ enabled: false });
    const later = new Date(NOW.getTime() + 3 * DAY);
    const result = await checkAlerts(acme.companyId, { now: later });
    const enabled = await Model('costalerts').countDocuments({ companyId: acme.companyId, enabled: true });
    expect(result.evaluated).toBe(enabled);
    expect((await reload(paused)).lastEvaluatedAt).toBeUndefined();
    expect(await checkAlerts(beta.companyId, { now: later })).toEqual({ evaluated: 0, fired: 0 });
  });
});

describe('overview', () => {
  it('caches the AI text per scope and period and keeps it as a stale fallback', async () => {
    const owner = await contextFor('owner_1@acme.test');
    const calls = generate.mock.calls.length;
    const first = await getCostOverview(owner, { period: 'day', now: NOW });
    expect(first.ai.headline).toMatch(/spent/);
    expect(first).toMatchObject({ stale: false, mock: true, period: { key: 'day:2026-10-15' } });
    expect(first.summary.totals.downtime).toBeGreaterThanOrEqual(rate);
    expect(first.topDrivers[0]).toMatchObject({ component: expect.any(String), amount: expect.any(Number) });
    const second = await getCostOverview(owner, { period: 'day', now: new Date(NOW.getTime() + 60_000) });
    expect(second.at).toEqual(first.at);
    expect(generate.mock.calls.length).toBe(calls + 1);

    generate.mockRejectedValueOnce(new AiUnavailableError('AI_QUOTA', 'Daily limit reached'));
    const failed = await getCostOverview(owner, { period: 'day', refresh: true, now: NOW });
    expect(failed).toMatchObject({ stale: true, ai: first.ai, aiError: { code: 'AI_QUOTA' } });

    const puneAdmin = await contextFor('plant_manager_1@acme.test');
    await getCostOverview(puneAdmin, { period: 'day', now: NOW });
    const keys = await Model('companies')
      .db.collection('ai_texts')
      .distinct('key', { companyId: acme.companyId });
    expect(keys.sort()).toEqual([`all|day:2026-10-15`, `plant:${puneAdmin.plantLock}|day:2026-10-15`].sort());
  });

  it('words the mock overview from the change, not a fixed sentence', () => {
    const write = PHASE5_BUILDERS.cost_overview;
    const driver = { key: 'a', label: 'CNC 4', component: 'spares', amount: 3800 };
    const input = (prev, deltaPct) => ({
      period: { label: 'October 2026' },
      totals: { total: 5000 },
      previous: { total: prev },
      topDrivers: [{ ...driver, deltaPct }],
    });
    const up = write(input(4000, 20));
    expect(up.summary).toBe(
      'CNC 4 drives the most cost at ₹3,800, mostly spare parts. Overall spend is 25% higher than the same stretch of the previous period.',
    );
    expect(up.drivers[0].explanation).toBe('CNC 4: ₹3,800, mostly spare parts, +20% vs the previous period.');
    expect(write(input(4900, null)).summary).toMatch(/in line with the previous period\.$/);
    const thin = write(input(500, 1700));
    expect(thin.headline).toBe('₹5,000 spent in October 2026 (the previous period has little recorded cost)');
    expect(thin.summary).toMatch(/too little recorded cost in the previous period/);
    expect(thin.drivers[0].explanation).toBe(
      'CNC 4: ₹3,800, mostly spare parts, up from little recorded cost before.',
    );
  });
});

describe('routes', () => {
  let app;
  const tokens = {};
  const as = (who) => ({ authorization: `Bearer ${tokens[who]}` });

  beforeAll(async () => {
    app = createApp({ routers: [{ path: '/api', router: costsRouter }] });
    for (const [who, email] of Object.entries({
      owner: 'owner_1@acme.test',
      viewer: 'viewer_1@acme.test',
      betaOwner: 'owner_1@beta.test',
    })) {
      const res = await request(app).post('/api/auth/login').send({ email, password: PASSWORD });
      tokens[who] = res.body.token;
    }
  });

  it('checks an alert for owners/admins of its company only', async () => {
    const alert = await makeAlert({ name: 'Route check' });
    const url = `/api/costs/alerts/${alert._id}/check`;
    expect((await request(app).post(url).set(as('betaOwner'))).status).toBe(404);
    expect((await request(app).post(url).set(as('viewer'))).status).toBe(403);
    const res = await request(app).post(url).set(as('owner'));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      breached: expect.any(Boolean),
      periodKey: expect.stringMatching(/^day:/),
    });
  });

  it('serves the summary from text and the overview', async () => {
    const summary = await request(app)
      .get('/api/costs/summary')
      .query({ text: 'last 30 days', groupBy: 'category', components: 'labour,downtime' })
      .set(as('viewer'));
    expect(summary.status).toBe(200);
    expect(summary.body).toMatchObject({
      groupBy: 'category',
      components: ['labour', 'downtime'],
      currency: { symbol: '₹' },
    });
    expect(summary.body.totals.energy).toBeNull();
    const bad = await request(app).get('/api/costs/summary').query({ groupBy: 'colour' }).set(as('viewer'));
    expect(bad.status).toBe(400);
    const overview = await request(app)
      .get('/api/costs/overview')
      .query({ period: 'week' })
      .set(as('viewer'));
    expect(overview.status).toBe(200);
    expect(overview.body.ai).toMatchObject({ headline: expect.any(String) });
    expect(
      (await request(app).post('/api/costs/overview/refresh').send({ period: 'week' }).set(as('viewer')))
        .status,
    ).toBe(403);
  });
});
