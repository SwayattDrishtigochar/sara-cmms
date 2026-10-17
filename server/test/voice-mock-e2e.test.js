import http from 'node:http';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { mockLiveTiming } from '../src/ai/mockLive.js';
import { createApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import { systemContext } from '../src/context/buildUserContext.js';
import { AiMessage } from '../src/db/models/AiMessage.js';
import { AiUsage } from '../src/db/models/AiUsage.js';
import { records } from '../src/modules/records.js';
import { getModule } from '../src/modules/registry.js';
import { voiceRouter } from '../src/routes/voice.js';
import { isVoiceMock } from '../src/voice/liveClient.js';
import { attachVoiceServer } from '../src/voice/server.js';
import { PASSWORD, setupDatabase, teardownDatabase } from './helpers/db.js';
import { clearScripts, resultOf, script } from './helpers/mockGemini.js';

/** The real voice WebSocket on a real HTTP server, no Live client injected: AI_MOCK=true routes it to mockLive. */
let server;
let voice;
let url;
let token;
let acme;
const origin = new URL(env.CLIENT_URL.split(',')[0].trim()).origin;
const tick = (ms = 2) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  ({ acme } = await setupDatabase());
  mockLiveTiming.chunkMs = 0;
  const app = createApp({ routers: [{ path: '/api', router: voiceRouter }] });
  const login = await request(app)
    .post('/api/auth/login')
    .send({ email: 'owner_1@acme.test', password: PASSWORD });
  expect(login.status).toBe(200);
  token = login.body.token;
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  voice = attachVoiceServer(server);
  url = `ws://127.0.0.1:${server.address().port}/api/voice`;
});
afterAll(async () => {
  await voice?.close();
  await new Promise((resolve) => server?.close(resolve) ?? resolve());
  await teardownDatabase();
});
afterEach(clearScripts);

/** A browser-like voice client: JSON messages in order, binary frames counted. */
const connect = async () => {
  const ws = new WebSocket(url, { origin });
  const c = { ws, messages: [], binary: 0 };
  ws.on('message', (data, isBinary) => {
    if (isBinary) c.binary += 1;
    else c.messages.push(JSON.parse(String(data)));
  });
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  c.send = (msg) => ws.send(JSON.stringify(msg));
  /** Waits for the first message after index `from` that matches; returns it. */
  c.next = async (match, from = 0, ms = 15_000) => {
    const t0 = Date.now();
    for (;;) {
      const hit = c.messages.slice(from).find(match);
      if (hit) return hit;
      if (Date.now() - t0 > ms) {
        throw new Error(`no matching message; got ${c.messages.map((m) => m.type).join(', ')}`);
      }
      await tick();
    }
  };
  /** Sends typed text and resolves with this turn's messages once its turn_complete arrives. */
  c.say = async (text) => {
    const from = c.messages.length;
    const binary = c.binary;
    c.send({ type: 'text', text });
    const start = await c.next((m) => m.type === 'turn_start' && m.user === text, from);
    await c.next((m) => m.type === 'turn_complete' && m.turnId === start.turnId, from);
    // Late frames (usage) settle right after turn_complete.
    await tick(20);
    return {
      start,
      messages: c.messages.slice(from).filter((m) => !m.turnId || m.turnId === start.turnId),
      binary: c.binary - binary,
    };
  };
  return c;
};
const of = (messages, type) => messages.filter((m) => m.type === type);
const said = (messages) =>
  of(messages, 'transcript')
    .filter((m) => m.role === 'assistant')
    .map((m) => m.text)
    .join('');

describe('voice mock end to end', () => {
  it('answers, previews a write, confirms it by voice and ends with mock usage', async () => {
    expect(isVoiceMock()).toBe(true);
    script(/how many open work orders/i, [
      { calls: [{ name: 'work_orders_summary', args: { groupBy: 'priority', scope: 'open' } }] },
      ({ responses }) => ({
        text: `You have ${resultOf(responses, 'work_orders_summary').total} open work orders.`,
      }),
    ]);
    script(/create a work order for press 2/i, [
      { calls: [{ name: 'resolve', args: { kind: 'asset', query: 'Press 2' } }] },
      ({ responses }) => ({
        calls: [
          {
            name: 'create_record',
            args: {
              module: 'workorders',
              items: [
                {
                  name: 'Hydraulic leak – Press 2',
                  asset: resultOf(responses, 'resolve').matches[0].id,
                  priority: 'High',
                },
              ],
            },
          },
        ],
      }),
    ]);
    const c = await connect();
    c.send({ type: 'start', token, context: { page: 'dashboard' } });
    const ready = await c.next((m) => m.type === 'ready');
    expect(ready).toMatchObject({ mock: true, inputRate: 16000, outputRate: 24000 });

    // 1. A read question: tool call, result, spoken transcript, tone audio, stored voice messages.
    const ask = await c.say('How many open work orders?');
    expect(of(ask.messages, 'tool_call').map((m) => m.data.name)).toEqual(['work_orders_summary']);
    expect(of(ask.messages, 'tool_result')[0].data).toMatchObject({ name: 'work_orders_summary', ok: true });
    expect(said(ask.messages)).toMatch(/^You have \d+ open work orders\.$/);
    expect(ask.binary).toBeGreaterThanOrEqual(1);
    const done = of(ask.messages, 'turn_complete')[0];
    expect(done.status).toBe('complete');
    const conversationId = done.conversationId;
    const stored = await AiMessage.find({ conversationId }).sort({ createdAt: 1 }).lean();
    expect(stored.map((m) => [m.role, m.channel])).toEqual([
      ['user', 'voice'],
      ['assistant', 'voice'],
    ]);
    expect(stored[1].text).toMatch(/^You have \d+ open work orders\.$/);

    // 2. A write: resolve + create_record preview → confirm card, SARA asks out loud.
    const WorkOrder = getModule('workorders').Model;
    const leaks = () => WorkOrder.countDocuments({ name: 'Hydraulic leak – Press 2' });
    const before = await leaks();
    const write = await c.say('Create a work order for Press 2: hydraulic leak, high priority');
    expect(of(write.messages, 'tool_call').map((m) => m.data.name)).toEqual(['resolve', 'create_record']);
    const card = of(write.messages, 'block').find((b) => b.data.type === 'confirm');
    expect(card.data.payload).toMatchObject({ tool: 'create_record', status: 'pending' });
    expect(of(write.messages, 'confirm')[0].action.status).toBe('pending');
    expect(said(write.messages)).toMatch(/Shall I go ahead\?$/);
    expect(of(write.messages, 'turn_complete')[0].status).toBe('awaiting_confirmation');
    expect(await leaks()).toBe(before);

    // 3. "yes" in a later turn → confirm_action → the work order exists and the card is confirmed.
    const from = c.messages.length;
    const yes = await c.say('yes');
    const confirmed = await c.next((m) => m.type === 'confirm' && m.action.status === 'confirmed', from);
    expect(confirmed.action.id).toBe(card.data.payload.actionId);
    expect(said(yes.messages)).toMatch(/^Done: Created 1 work order/);
    expect(await leaks()).toBe(before + 1);

    // 4. End: closed ended, and the Live connection is recorded as a mock voice row.
    c.send({ type: 'end' });
    const closed = await c.next((m) => m.type === 'closed');
    expect(closed).toMatchObject({ reason: 'ended', conversationId });
    let usage = null;
    for (let i = 0; i < 100 && !usage; i++) {
      usage = await AiUsage.findOne({ purpose: 'voice' }).lean();
      if (!usage) await tick(20);
    }
    expect(usage).toMatchObject({ purpose: 'voice', status: 'mock' });
    c.ws.close();
  });

  it('puts rows on the screen: by render_table, or by the safety net when SARA only claims it', async () => {
    const asset = await getModule('assets')
      .Model.findOne({ companyId: acme.companyId, name: 'IMM 1' })
      .lean();
    await records.create(
      await systemContext(acme.companyId),
      'anomalies',
      {
        assetId: String(asset._id),
        type: 'vibration_high',
        severity: 'warning',
        state: 'open',
        summary: 'Vibration is high.',
        explanation: 'Vibration doubled.',
        confidence: 0.8,
      },
      { source: 'system' },
    );
    const c = await connect();
    c.send({ type: 'start', token });
    await c.next((m) => m.type === 'ready');

    // 1. The flow renders: list_anomalies → render_table (sourceRef) → a table block before the sentence ends.
    const ask = await c.say('Which assets need attention?');
    expect(of(ask.messages, 'tool_call').map((m) => m.data.name)).toEqual(['list_anomalies', 'render_table']);
    const [table] = of(ask.messages, 'block');
    expect(table.data).toMatchObject({ type: 'table', payload: { title: 'Machines needing attention' } });
    expect(table.data.payload.rows.some((r) => /IMM 1/.test(r.asset))).toBe(true);
    expect(said(ask.messages)).toMatch(/IMM 1.*I've put the list on your screen\.$/);

    // 2. The flow only claims it: the session shows the mongo_find rows itself, and stores the block.
    const list = await c.say('Show my machines');
    expect(of(list.messages, 'tool_call').map((m) => m.data.name)).toEqual(['mongo_find']);
    const [net] = of(list.messages, 'block');
    expect(net.data.type).toBe('table');
    expect(net.data.payload.rows.length).toBeGreaterThan(0);
    expect(said(list.messages)).toMatch(/I've listed them on your screen\.$/);
    const stored = await AiMessage.findById(of(list.messages, 'turn_complete')[0].messageId).lean();
    expect(stored.parts.at(-1)).toMatchObject({ type: 'block', blockType: 'table', id: net.data.id });
    c.send({ type: 'end' });
    await c.next((m) => m.type === 'closed');
    c.ws.close();
  });
});
