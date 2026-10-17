import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { _resetBudget } from '../src/ai/budget.js';
import { KNOWN_LIVE_MODELS } from '../src/ai/models.js';
import { getAiSettings, saveAiSettings } from '../src/ai/settings.js';
import { createApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import { logger } from '../src/lib/logger.js';
import { voiceRouter } from '../src/routes/voice.js';
import { _setLiveClient } from '../src/voice/liveClient.js';
import { attachVoiceServer } from '../src/voice/server.js';
import { PASSWORD, setupDatabase, teardownDatabase } from './helpers/db.js';
import { createFakeLive, until } from './helpers/fakeLive.js';

const ORIGIN = new URL(env.CLIENT_URL.split(',')[0].trim()).origin;
const fake = createFakeLive();
const tokens = {};
let app;
let server;
let voice;
let base;

/** A ws client that records JSON messages and resolves `closed` with the close code. */
const connect = ({ path = '/api/voice', origin = ORIGIN } = {}) => {
  const ws = new WebSocket(`${base}${path}`, origin ? { origin } : {});
  const messages = [];
  ws.on('message', (data, isBinary) => {
    if (!isBinary) messages.push(JSON.parse(data.toString()));
  });
  const closed = new Promise((resolve) => ws.on('close', (code) => resolve(code)));
  const failed = new Promise((resolve) => {
    ws.on('error', (err) => resolve(err));
    ws.on('unexpected-response', (_req, res) => resolve({ status: res.statusCode }));
  });
  const opened = new Promise((resolve) => ws.on('open', resolve));
  const next = (type, n = 1) =>
    until(() => messages.filter((m) => m.type === type)[n - 1], { what: type, timeout: 8000 });
  const start = async (who, extra = {}) => {
    await opened;
    ws.send(JSON.stringify({ type: 'start', token: tokens[who], ...extra }));
  };
  return { ws, messages, closed, failed, opened, next, start };
};

beforeAll(async () => {
  await setupDatabase();
  _setLiveClient(fake.client);
  _resetBudget();
  const { voice: v } = await getAiSettings();
  await saveAiSettings({ limits: { [v.model]: { rpm: 10_000, rpd: 100_000 } } });
  app = createApp({ routers: [{ path: '/api', router: voiceRouter }] });
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  voice = attachVoiceServer(server);
  base = `ws://127.0.0.1:${server.address().port}`;
  for (const [who, email, password] of [
    ['owner', 'owner_1@acme.test', PASSWORD],
    ['tech', 'maintenance_technician_1@acme.test', PASSWORD],
    ['admin', env.SUPERADMIN_EMAIL, env.SUPERADMIN_PASSWORD],
  ]) {
    const res = await request(app).post('/api/auth/login').send({ email, password });
    expect(res.status).toBe(200);
    tokens[who] = res.body.token;
  }
});
afterAll(async () => {
  await voice.close();
  await new Promise((resolve) => server.close(resolve));
  _setLiveClient(null);
  await teardownDatabase();
});

describe('voice WebSocket', () => {
  it('destroys other upgrade paths and refuses a foreign Origin', async () => {
    const wrong = connect({ path: '/api/other' });
    expect(await wrong.failed).toBeInstanceOf(Error);
    const foreign = connect({ origin: 'https://evil.example' });
    expect(await foreign.failed).toEqual({ status: 403 });
    const none = connect({ origin: null });
    expect(await none.failed).toEqual({ status: 403 });
  });

  it('closes 4001 without a start in time or with a bad token', async () => {
    const silent = connect();
    expect(await silent.closed).toBe(4001);
    expect(silent.messages[0]).toMatchObject({ type: 'error', code: 'UNAUTHORIZED', fatal: true });

    const bad = connect();
    await bad.opened;
    bad.ws.send(JSON.stringify({ type: 'start', token: 'not-a-jwt' }));
    expect(await bad.closed).toBe(4001);
    expect(bad.messages[0]).toMatchObject({ type: 'error', code: 'UNAUTHORIZED' });

    const garbage = connect();
    await garbage.opened;
    garbage.ws.send(JSON.stringify({ type: 'text', text: 'hi' }));
    expect(await garbage.closed).toBe(4008);
  }, 15_000);

  it('starts a session; the same user again replaces it; the limit refuses others', async () => {
    const first = connect();
    await first.start('owner');
    expect(await first.next('ready')).toMatchObject({ voice: 'Kore', language: 'auto', mock: false });
    expect(voice.size()).toBe(1);

    const second = connect();
    await second.start('owner', { language: 'hi-IN' });
    expect(await second.next('ready')).toMatchObject({ language: 'hi-IN' });
    expect(await first.next('closed')).toMatchObject({ reason: 'replaced' });
    expect(await first.closed).toBe(1000);
    expect(voice.size()).toBe(1);

    await saveAiSettings({ voice: { maxConcurrent: 1 } });
    try {
      const other = connect();
      await other.start('tech');
      expect(await other.next('error')).toMatchObject({ code: 'VOICE_BUSY', fatal: true });
      expect(await other.closed).toBe(4029);
    } finally {
      await saveAiSettings({ voice: { maxConcurrent: 3 } });
    }

    second.ws.send(JSON.stringify({ type: 'end' }));
    expect(await second.next('closed')).toMatchObject({ reason: 'ended' });
    expect(await second.closed).toBe(1000);
    await until(() => voice.size() === 0);
  });

  it('refuses the platform account and floods', async () => {
    const admin = connect();
    await admin.start('admin');
    expect(await admin.next('error')).toMatchObject({ code: 'VOICE_DISABLED' });
    expect(await admin.closed).toBe(4003);

    const flood = connect();
    await flood.start('tech');
    await flood.next('ready');
    for (let i = 0; i < 120; i++) flood.ws.send(JSON.stringify({ type: 'mute', muted: false }));
    expect(await flood.next('error')).toMatchObject({ code: 'RATE_LIMITED', fatal: true });
    expect(await flood.closed).toBe(4008);

    // A frame above maxPayload: ws closes 1009 itself; the session ends as an error and frees its slot.
    const info = vi.spyOn(logger, 'info');
    try {
      const big = connect();
      await big.start('tech');
      await big.next('ready');
      big.ws.send(Buffer.alloc(20_000));
      expect(await big.closed).toBe(1009);
      await until(() => voice.size() === 0);
      await until(() =>
        info.mock.calls.some(([o, msg]) => msg === 'voice session ended' && o.reason === 'error'),
      );
    } finally {
      info.mockRestore();
    }
  });

  it('serves the voice config and, to the superadmin only, the Live models', async () => {
    const auth = (who) => ({ authorization: `Bearer ${tokens[who]}` });
    const config = await request(app).get('/api/voice/config').set(auth('owner'));
    expect(config.status).toBe(200);
    expect(config.body).toMatchObject({
      enabled: true,
      defaults: { voice: 'Kore', language: 'auto' },
      maxSessionMin: 10,
    });
    expect(config.body.voices).toHaveLength(14);
    expect(config.body.languages[0].code).toBe('auto');
    expect((await request(app).get('/api/voice/config').set(auth('admin'))).body.enabled).toBe(false);

    expect((await request(app).get('/api/voice/models').set(auth('owner'))).status).toBe(403);
    const models = await request(app).get('/api/voice/models').set(auth('admin'));
    expect(models.status).toBe(200);
    expect(models.body.models.map((m) => m.id)).toEqual(expect.arrayContaining(KNOWN_LIVE_MODELS));
    expect(models.body.voice).toMatchObject({ voiceName: 'Kore', maxConcurrent: 3 });
  });
});
