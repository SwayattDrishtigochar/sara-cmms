import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pacificDay } from '../src/ai/budget.js';
import { getAiSettings } from '../src/ai/settings.js';
import { createApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import { PlatformSettings } from '../src/db/models/PlatformSettings.js';
import { adminAiRouter } from '../src/routes/adminAi.js';
import { PASSWORD, setupDatabase, teardownDatabase } from './helpers/db.js';

let app;
let admin; // superadmin auth header
let adminId;
let owner; // Acme owner auth header

const api = (method, path = '', auth = admin) =>
  request(app)
    [method](`/api/admin/ai${path}`)
    .set(auth ?? {});

beforeAll(async () => {
  await setupDatabase();
  app = createApp({ routers: [{ path: '/api/admin/ai', router: adminAiRouter }] });
  const login = async (email, password) => {
    const res = await request(app).post('/api/auth/login').send({ email, password });
    expect(res.status).toBe(200);
    return { auth: { authorization: `Bearer ${res.body.token}` }, id: String(res.body.user._id) };
  };
  ({ auth: admin, id: adminId } = await login(env.SUPERADMIN_EMAIL, env.SUPERADMIN_PASSWORD));
  ({ auth: owner } = await login('owner_1@acme.test', PASSWORD));
});
afterAll(teardownDatabase);

describe('access', () => {
  it('is for the superadmin only', async () => {
    expect((await request(app).get('/api/admin/ai')).status).toBe(401);
    const routes = [
      ['get', ''],
      ['put', ''],
      ['get', '/models'],
      ['post', '/test'],
      ['get', '/usage'],
    ];
    for (const [method, path] of routes) {
      expect((await api(method, path, owner).send({})).status).toBe(403);
    }
  });
});

describe('settings', () => {
  it('shows the settings with the key status and the mock flag, never the key', async () => {
    const res = await api('get');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ mock: true, apiKeyConfigured: Boolean(env.GEMINI_API_KEY) });
    expect(res.body.settings.tiers.fast).toEqual({
      model: env.GEMINI_MODEL_FAST,
      thinkingLevel: 'low',
      fallback: env.GEMINI_FALLBACK_FAST,
    });
    expect(res.body.settings).toMatchObject({
      chatReservePct: env.AI_CHAT_RESERVE_PCT,
      anomaly: { enabled: true, tickSec: env.ANOMALY_SCAN_TICK_SEC, investigate: true },
      costWatch: { enabled: true, intervalMin: env.COST_WATCH_INTERVAL_MIN },
    });
    expect(JSON.stringify(res.body)).not.toContain(env.GEMINI_API_KEY || 'no-key-configured');
  });

  it('validates and stores a patch', async () => {
    const bad = [
      { tiers: { fast: { model: 'Bad Model!' } } },
      { tiers: { fast: { thinkingLevel: 'ultra' } } },
      { nope: 1 },
      { chatReservePct: 95 },
      { limits: { 'gemini-3.8-flash': { rpm: 0, rpd: 10 } } },
      { anomaly: { tickSec: 5 } },
    ];
    for (const body of bad) {
      const res = await api('put').send(body);
      expect(res.status).toBe(400);
      expect(res.body.error.details.length).toBeGreaterThan(0);
    }

    const res = await api('put').send({
      tiers: { fast: { thinkingLevel: 'high' }, background: { fallback: null } },
      limits: { 'gemini-3.8-flash': { rpm: 5, rpd: 100 } },
      anomaly: { tickSec: 120, alwaysAskAi: true },
      showThoughts: false,
    });
    expect(res.status).toBe(200);
    expect(res.body.settings.tiers.fast).toEqual({
      model: env.GEMINI_MODEL_FAST,
      thinkingLevel: 'high',
      fallback: env.GEMINI_FALLBACK_FAST,
    });
    expect(res.body.settings).toMatchObject({
      limits: { 'gemini-3.8-flash': { rpm: 5, rpd: 100 } },
      anomaly: { tickSec: 120, alwaysAskAi: true, enabled: true },
      showThoughts: false,
    });
    expect((await api('get')).body.settings.anomaly.tickSec).toBe(120);
    const doc = await PlatformSettings.findById('platform').lean();
    expect(String(doc.updatedBy)).toBe(adminId);
    expect(doc.ai.tiers.fast.thinkingLevel).toBe('high');
  });
});

describe('models, test call and usage', () => {
  it('lists models with free and thinking info next to the tiers', async () => {
    const res = await api('get', '/models');
    expect(res.status).toBe(200);
    const { tiers } = await getAiSettings();
    expect(res.body.models.find((m) => m.id === tiers.balanced.model)).toMatchObject({
      displayName: expect.any(String),
      free: expect.any(Boolean),
      thinking: expect.any(Array),
    });
    expect(res.body.tiers).toEqual(tiers);
  });

  it('runs a test call and reports it in usage', async () => {
    expect((await api('post', '/test').send({ tier: 'nope' })).status).toBe(400);
    const res = await api('post', '/test').send({});
    expect(res.status).toBe(200);
    const { tiers } = await getAiSettings();
    expect(res.body).toMatchObject({
      ok: true,
      model: tiers.fast.model,
      latencyMs: expect.any(Number),
      error: null,
    });
    expect(res.body.text).toContain('mock');

    const usage = await api('get', '/usage');
    expect(usage.status).toBe(200);
    expect(usage.body.day).toBe(pacificDay());
    expect(usage.body.models.find((m) => m.model === tiers.fast.model)).toMatchObject({
      mock: 1,
      calls: 0,
      limits: { rpm: expect.any(Number), rpd: expect.any(Number) },
      free: true,
    });
  });
});
