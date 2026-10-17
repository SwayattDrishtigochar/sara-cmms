import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildContents } from '../src/agent/history.js';
import { groupsFor, toolsFor } from '../src/agent/tools/registry.js';
import { _resetBudget } from '../src/ai/budget.js';
import { getAiSettings, saveAiSettings } from '../src/ai/settings.js';
import { userFromToken } from '../src/auth/middleware.js';
import { AiConversation } from '../src/db/models/AiConversation.js';
import { AiMessage } from '../src/db/models/AiMessage.js';
import { AiToolAudit } from '../src/db/models/AiToolAudit.js';
import { AiUsage } from '../src/db/models/AiUsage.js';
import { Session } from '../src/db/models/Session.js';
import { getModule } from '../src/modules/registry.js';
import { _setLiveClient } from '../src/voice/liveClient.js';
import { VOICE_STYLE } from '../src/voice/prompt.js';
import { createVoiceSession } from '../src/voice/session.js';
import { MAX_VOICE_TOOLS, VOICE_ERRORS } from '../src/voice/tools.js';
import { setupDatabase, teardownDatabase } from './helpers/db.js';
import {
  audio,
  cancel,
  createFakeLive,
  fakeSocket,
  goAway,
  hear,
  interrupted,
  resumable,
  say,
  signIn,
  toolCall,
  turnComplete,
  until,
  usage,
} from './helpers/fakeLive.js';

const OWNER = 'owner_1@acme.test';
const VIEWER = 'viewer_1@acme.test';
const fake = createFakeLive();
const opened = [];
let chiller;
let settings;

const json = (msg) => Buffer.from(JSON.stringify(msg));

/** A started session on a fake socket; `voice` overrides settings.voice for this session only. */
const open = async (email = OWNER, start = {}, voice = {}, { wait = true } = {}) => {
  const { token, sessionId } = await signIn(email);
  const auth = await userFromToken(token);
  const socket = fakeSocket();
  const session = createVoiceSession({
    socket,
    auth,
    start: { type: 'start', token, ...start },
    settings: { ...settings, voice: { ...settings.voice, ...voice } },
  });
  opened.push(session);
  if (wait) await session.ready;
  return { socket, session, live: fake.last(), auth, sessionId };
};

/** The n-th tool response batch the fake Live received. */
const responses = async (live, n = 1) => {
  await until(() => live.toolResponses.length >= n, { what: `tool response #${n}` });
  return live.toolResponses[n - 1].functionResponses;
};

const workOrders = (name) => getModule('workorders').Model.countDocuments({ name });

/** Every model content with calls is followed by a user content answering each call by id; no orphan answers. */
const expectValidHistory = async (conversationId) => {
  const contents = await buildContents({ _id: conversationId });
  contents.forEach((c, i) => {
    const calls = c.parts.filter((p) => p.functionCall).map((p) => p.functionCall);
    const answers = c.parts.filter((p) => p.functionResponse).map((p) => p.functionResponse);
    if (calls.length) {
      expect(c.role).toBe('model');
      const next = contents[i + 1];
      expect(next.role).toBe('user');
      const ids = next.parts.filter((p) => p.functionResponse).map((p) => p.functionResponse.id);
      expect(ids).toEqual(calls.map((x) => x.id));
    }
    if (answers.length) {
      const prev = contents[i - 1].parts.filter((p) => p.functionCall).map((p) => p.functionCall.id);
      expect(answers.map((a) => a.id)).toEqual(prev);
    }
  });
};

/** A spoken create_record turn that ends awaiting confirmation; returns the action id. */
const askForWorkOrder = async ({ socket, live }, name) => {
  live.emit(
    hear(`Create a work order for Chiller 1: ${name}`, true),
    toolCall([
      'create_record',
      { module: 'workorders', items: [{ name, asset: String(chiller._id), priority: 'High' }] },
    ]),
  );
  const [answer] = await responses(live, live.toolResponses.length + 1);
  expect(answer.response).toMatchObject({ status: 'awaiting_confirmation', label: 'Create 1 work order' });
  live.emit(say('I will create a high-priority work order. Shall I go ahead?'), turnComplete());
  const done = await socket.next('turn_complete', socket.of('turn_complete').length + 1);
  expect(done.status).toBe('awaiting_confirmation');
  return answer.response.actionId;
};

beforeAll(async () => {
  await setupDatabase();
  _setLiveClient(fake.client);
  _resetBudget();
  const { voice } = await getAiSettings();
  // Enough quota for every session of this file (each Live connection is one request).
  settings = await saveAiSettings({
    limits: {
      [voice.model]: { rpm: 10_000, rpd: 100_000 },
      [voice.fallback]: { rpm: 10_000, rpd: 100_000 },
    },
  });
  chiller = await getModule('assets').Model.findOne({ name: 'Chiller 1' }).lean();
});
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(opened.splice(0).map((s) => s.close()));
});
afterAll(async () => {
  _setLiveClient(null);
  await teardownDatabase();
});

describe('voice session', () => {
  it('(1) connects with every permitted tool, a female voice, captions and the voice prompt', async () => {
    const { socket, live, auth } = await open(OWNER, {
      context: { page: 'machine', recordRef: { module: 'assets', id: String(chiller._id) } },
    });
    expect(socket.of('ready')[0]).toMatchObject({
      conversationId: null,
      model: settings.voice.model,
      voice: 'Kore',
      language: 'auto',
      mock: false,
      inputRate: 16000,
      outputRate: 24000,
      limits: { maxSessionMin: 10, idleSec: 90, maxTextChars: 2000 },
      pendingAction: null,
    });
    const names = live.config.tools[0].functionDeclarations.map((d) => d.name);
    const registry = toolsFor(auth.ctx, groupsFor(auth.ctx));
    expect(names).toHaveLength(registry.length - 1 + 2);
    expect(names.length).toBeLessThanOrEqual(MAX_VOICE_TOOLS);
    expect(names).toEqual(expect.arrayContaining(['confirm_action', 'reject_action', 'create_record']));
    expect(names).not.toContain('load_tools');
    expect(live.model).toBe(settings.voice.model);
    expect(live.config.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe('Kore');
    expect(live.config.inputAudioTranscription).toEqual({});
    expect(live.config.outputAudioTranscription).toEqual({});
    expect(live.config.systemInstruction).toContain(VOICE_STYLE);
    expect(live.config.systemInstruction).toContain('Page context: the user is on the machine page');
    expect(live.config.systemInstruction).toContain('Chiller 1');
  });

  it('(2) relays audio both ways, drops it before ready and when muted', async () => {
    const { socket, session } = await open(OWNER, { voice: 'Aoede' }, {}, { wait: false });
    session.handleMessage(Buffer.alloc(1280, 3), true); // before ready: dropped
    await session.ready;
    const live = fake.last();
    expect(live.config.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe('Aoede');
    expect(live.realtime).toEqual([]);
    const frame = Buffer.alloc(1280, 7);
    session.handleMessage(frame, true);
    expect(live.realtime).toEqual([
      { audio: { data: frame.toString('base64'), mimeType: 'audio/pcm;rate=16000' } },
    ]);
    const out = Buffer.alloc(960, 5);
    live.emit(audio(out));
    expect(socket.binary).toHaveLength(1);
    expect(Buffer.compare(socket.binary[0], out)).toBe(0);
    session.handleMessage(json({ type: 'mute', muted: true }), false);
    await until(() => live.realtime.length === 2);
    expect(live.realtime[1]).toEqual({ audioStreamEnd: true });
    session.handleMessage(frame, true);
    expect(live.realtime).toHaveLength(2);
  });

  it('(3) persists a spoken turn with captions, latency, title and the voice flag', async () => {
    const { socket, live } = await open();
    live.emit(
      hear('How many machines ', false),
      hear('are running?', true),
      audio(),
      say('Twelve of '),
      say('twenty machines are running.'),
      usage(100, 20),
      turnComplete(),
    );
    const done = await socket.next('turn_complete');
    const start = socket.of('turn_start')[0];
    expect(start).toMatchObject({ turnId: 't1', user: null });
    expect(socket.of('transcript')).toEqual([
      { type: 'transcript', turnId: 't1', role: 'user', text: 'How many machines ', final: false },
      { type: 'transcript', turnId: 't1', role: 'user', text: 'are running?', final: true },
      { type: 'transcript', turnId: 't1', role: 'assistant', text: 'Twelve of ', final: false },
      {
        type: 'transcript',
        turnId: 't1',
        role: 'assistant',
        text: 'twenty machines are running.',
        final: false,
      },
    ]);
    expect(done).toMatchObject({ turnId: 't1', status: 'complete', messageId: start.messageId });
    expect(done.latencyMs).toBeGreaterThanOrEqual(0);
    expect(socket.of('usage').at(-1)).toMatchObject({ prompt: 100, candidates: 20, total: 120 });

    const [user, assistant] = await AiMessage.find({ conversationId: start.conversationId })
      .sort({ createdAt: 1 })
      .lean();
    expect(user).toMatchObject({ role: 'user', channel: 'voice', text: 'How many machines are running?' });
    expect(assistant).toMatchObject({
      role: 'assistant',
      channel: 'voice',
      tier: 'voice',
      model: settings.voice.model,
      status: 'complete',
      text: 'Twelve of twenty machines are running.',
      parts: [{ type: 'text', text: 'Twelve of twenty machines are running.' }],
      usage: { prompt: 100, candidates: 20, total: 120 },
    });
    expect(assistant.gemini.at(-1)).toEqual({
      role: 'model',
      parts: [{ text: 'Twelve of twenty machines are running.' }],
    });
    expect(assistant.latencyMs).toBeGreaterThanOrEqual(0);
    const conversation = await AiConversation.findById(start.conversationId).lean();
    expect(conversation).toMatchObject({ voice: true, title: 'How many machines are running?' });
  });

  it('(4) runs a read tool: events, toolResponse with the id, audit row and stored round', async () => {
    const { socket, live } = await open();
    const call = toolCall(['mongo_count', { module: 'workorders', filter: { workStatus: 'Open' } }]);
    const { id } = call.toolCall.functionCalls[0];
    live.emit(hear('How many open work orders?', true), say('One moment.'), call);
    const [answer] = await responses(live);
    expect(answer).toMatchObject({
      id,
      name: 'mongo_count',
      response: { ref: id, result: { module: 'workorders' } },
    });
    const count = answer.response.result.count;
    expect(socket.of('tool_call')[0]).toMatchObject({ turnId: 't1', data: { id, name: 'mongo_count' } });
    expect(socket.of('tool_result')[0]).toMatchObject({
      turnId: 't1',
      data: { id, name: 'mongo_count', ok: true },
    });
    live.emit(say(`There are ${count} open work orders.`), turnComplete());
    const done = await socket.next('turn_complete');

    const message = await AiMessage.findById(done.messageId).lean();
    expect(message.parts.map((p) => p.type)).toEqual(['text', 'tool_call', 'tool_result', 'text']);
    expect(message.text).toBe(`One moment.There are ${count} open work orders.`);
    expect(message.gemini[0]).toEqual({
      role: 'model',
      parts: [
        {
          functionCall: {
            id,
            name: 'mongo_count',
            args: { module: 'workorders', filter: { workStatus: 'Open' } },
          },
          thoughtSignature: 'skip_thought_signature_validator',
        },
      ],
    });
    expect(message.gemini[1].parts[0].functionResponse).toMatchObject({ id, name: 'mongo_count' });
    expect(await AiToolAudit.countDocuments({ messageId: message._id, tool: 'mongo_count', ok: true })).toBe(
      1,
    );
    await expectValidHistory(done.conversationId);
  });

  it('(4b) shows the last rows as a table when SARA claims "on your screen" without rendering', async () => {
    const { socket, live } = await open();
    live.emit(hear('Show my machines', true), toolCall(['mongo_find', { module: 'assets', limit: 5 }]));
    await responses(live);
    live.emit(say("You have five machines. I've listed them on your screen."), turnComplete());
    const done = await socket.next('turn_complete');
    const [block] = socket.of('block');
    expect(block).toMatchObject({ turnId: 't1', data: { type: 'table', payload: { title: '5 assets' } } });
    expect(block.data.payload.rows).toHaveLength(5);
    expect(block.data.payload.columns[0]).toMatchObject({
      key: expect.any(String),
      label: expect.any(String),
    });
    expect(socket.messages.indexOf(block)).toBeLessThan(socket.messages.indexOf(done));
    const message = await AiMessage.findById(done.messageId).lean();
    expect(message.parts.map((p) => p.type)).toEqual(['tool_call', 'tool_result', 'text', 'block']);
    expect(message.parts.at(-1)).toMatchObject({ blockType: 'table', id: block.data.id });

    // Already rendered (render_kpis) → no extra block; no claim → no block; nothing looked up → no block.
    live.emit(
      hear('How many are running?', true),
      toolCall(['render_kpis', { items: [{ label: 'Running', value: 3 }] }]),
    );
    await responses(live, 2);
    live.emit(say("Three. I've put the numbers on your screen."), turnComplete());
    await socket.next('turn_complete', 2);
    live.emit(hear('And in total?', true), toolCall(['mongo_count', { module: 'assets' }]));
    await responses(live, 3);
    live.emit(say('Twenty machines.'), turnComplete());
    await socket.next('turn_complete', 3);
    live.emit(hear('Open the machines page', true), say("I've opened the machines page on your screen."));
    live.emit(turnComplete());
    await socket.next('turn_complete', 4);
    expect(socket.of('block').map((b) => b.data.type)).toEqual(['table', 'kpis']);
    await expectValidHistory(done.conversationId);
  });

  it('(5) a voice write waits; confirm only for the latest action from a later turn', async () => {
    const { socket, live } = await open();
    const name = 'Voice coolant leak';
    live.emit(
      hear(`Create a work order for Chiller 1: ${name}`, true),
      toolCall([
        'create_record',
        { module: 'workorders', items: [{ name, asset: String(chiller._id), priority: 'High' }] },
      ]),
    );
    const [asked] = await responses(live, 1);
    const { actionId } = asked.response;
    expect(asked.response).toMatchObject({
      status: 'awaiting_confirmation',
      label: 'Create 1 work order',
      expiresInMin: 10,
    });
    const card = socket.of('block').find((b) => b.data.type === 'confirm');
    expect(card).toMatchObject({
      turnId: 't1',
      data: { payload: { tool: 'create_record', actionId, status: 'pending' } },
    });
    expect(socket.of('confirm')[0]).toMatchObject({
      turnId: 't1',
      action: { id: actionId, status: 'pending' },
    });
    const messageId = socket.of('turn_start')[0].messageId;
    let message = await AiMessage.findById(messageId).lean();
    expect(message.status).toBe('awaiting_confirmation');
    expect(message.gemini).toHaveLength(1); // the write call, unanswered (like chat)
    expect(message.gemini[0].parts[0].functionCall.name).toBe('create_record');

    // The model cannot confirm in the turn it asked, nor run anything else there.
    live.emit(toolCall(['confirm_action', { actionId }], ['mongo_count', { module: 'assets' }]));
    const sameTurn = await responses(live, 2);
    expect(sameTurn.map((r) => r.response)).toEqual([VOICE_ERRORS.noAction, VOICE_ERRORS.waiting]);
    live.emit(say('I will create a high-priority work order. Shall I go ahead?'), turnComplete());
    expect((await socket.next('turn_complete')).status).toBe('awaiting_confirmation');
    expect(await workOrders(name)).toBe(0);

    // Next turn: a wrong id is refused, the right one runs the write.
    live.emit(hear('Yes, go ahead.', true), toolCall(['confirm_action', { actionId: 'nope' }]));
    expect((await responses(live, 3))[0].response).toEqual(VOICE_ERRORS.noAction);
    live.emit(toolCall(['confirm_action', { actionId }]));
    const [confirmed] = await responses(live, 4);
    expect(confirmed.response).toMatchObject({ status: 'confirmed', summary: 'Created 1 work order' });
    expect(await workOrders(name)).toBe(1);
    expect(socket.of('confirm').at(-1)).toMatchObject({
      turnId: 't1',
      action: { id: actionId, status: 'confirmed' },
    });
    expect(socket.of('tool_result').at(-1)).toMatchObject({
      turnId: 't1',
      data: { name: 'create_record', ok: true },
    });
    live.emit(say('Done.'), turnComplete());
    const done = await socket.next('turn_complete', 2);
    expect(done).toMatchObject({ turnId: 't2', status: 'complete' });

    message = await AiMessage.findById(messageId).lean();
    expect(message.status).toBe('complete');
    expect(message.pendingAction).toMatchObject({ status: 'confirmed', via: 'voice', result: { ok: true } });
    expect(message.parts.map((p) => p.type).slice(-2)).toEqual(['tool_result', 'notice']);
    expect(message.parts.at(-1).text).toBe('Confirmed by voice');
    expect(message.gemini.at(-1).parts[0].functionResponse.response.status).toBe('confirmed');
    // confirm_action never enters the stored calls or the tool trace of the confirming turn
    const t2 = await AiMessage.findById(done.messageId).lean();
    expect(JSON.stringify(t2.gemini)).not.toContain('confirm_action');
    expect(t2.parts.some((p) => p.type === 'tool_call')).toBe(false);
    await expectValidHistory(done.conversationId);
  });

  it('(5b) an expired action is refused as gone and its card shows expired', async () => {
    const ctx = await open();
    const { socket, live } = ctx;
    const name = 'Expired leak';
    const actionId = await askForWorkOrder(ctx, name);
    await AiMessage.updateOne(
      { 'pendingAction.id': actionId },
      { $set: { 'pendingAction.expiresAt': new Date(Date.now() - 1000) } },
    );
    live.emit(hear('Yes.', true), toolCall(['confirm_action', { actionId }]));
    const [answer] = await responses(live, live.toolResponses.length + 1);
    expect(answer.response).toMatchObject({ status: 'gone', error: expect.stringMatching(/expired/) });
    expect(await workOrders(name)).toBe(0);
    await until(() => socket.of('confirm').at(-1)?.action.status === 'expired', { what: 'expired card' });
    expect(socket.of('confirm').at(-1)).toMatchObject({ turnId: 't1', action: { id: actionId } });
  });

  it('(6) confirms on screen with an App note, and rejects by voice', async () => {
    const ctx = await open();
    const { socket, live, session } = ctx;
    const actionId = await askForWorkOrder(ctx, 'Clicked leak');
    session.handleMessage(json({ type: 'confirm', actionId: 'other' }), false);
    expect((await socket.next('error')).code).toBe('ACTION_NOT_FOUND');
    session.handleMessage(json({ type: 'confirm', actionId }), false);
    const start = await socket.next('turn_start', 2);
    expect(start.user).toBe('Confirmed: Create 1 work order');
    expect(await workOrders('Clicked leak')).toBe(1);
    expect(socket.of('confirm').at(-1).action).toMatchObject({ id: actionId, status: 'confirmed' });
    await until(() => live.realtime.some((r) => r.text));
    expect(live.realtime.find((r) => r.text).text).toBe(
      'App note: the user confirmed "Create 1 work order" on screen. Result: Created 1 work order. Tell them in one short sentence.',
    );
    live.emit(say('Done, the work order is created.'), turnComplete());
    await socket.next('turn_complete', 2);
    const users = await AiMessage.find({ conversationId: start.conversationId, role: 'user' })
      .sort({ createdAt: 1 })
      .lean();
    expect(users.at(-1)).toMatchObject({ text: 'Confirmed: Create 1 work order', channel: 'voice' });
    const action = await AiMessage.findOne({ 'pendingAction.id': actionId }).lean();
    expect(action.pendingAction.via).toBe('click');
    expect(action.parts.at(-1).text).toBe('Confirmed on screen');

    const rejectId = await askForWorkOrder(ctx, 'Rejected leak');
    const asked = live.toolResponses.length;
    live.emit(hear('No, cancel that.', true), toolCall(['reject_action', { actionId: rejectId }]));
    const [rejected] = await responses(live, asked + 1);
    expect(rejected.response).toEqual({ status: 'rejected' });
    expect(await workOrders('Rejected leak')).toBe(0);
    expect((await AiMessage.findOne({ 'pendingAction.id': rejectId }).lean()).pendingAction.status).toBe(
      'rejected',
    );
    expect(socket.of('confirm').at(-1).action).toMatchObject({ id: rejectId, status: 'rejected' });
    live.emit(say('Okay.'), turnComplete());
    await socket.next('turn_complete', 4);
    await expectValidHistory(start.conversationId);
  });

  it('(7) refuses a viewer’s write without a pending action', async () => {
    const { socket, live } = await open(VIEWER);
    expect(live.config.tools[0].functionDeclarations.map((d) => d.name)).not.toContain('create_record');
    live.emit(
      hear('Create a work order', true),
      toolCall(['create_record', { module: 'workorders', items: [{ name: 'v' }] }]),
    );
    const [answer] = await responses(live);
    expect(answer.response.error).toMatch(/create_record is not available to .+ \(role view\)/);
    live.emit(say('Sorry, you cannot.'), turnComplete());
    const done = await socket.next('turn_complete');
    expect(done.status).toBe('complete');
    expect((await AiMessage.findById(done.messageId).lean()).pendingAction).toBeNull();
    expect(socket.of('confirm')).toHaveLength(0);
  });

  it('(8) sends no response for cancelled calls', async () => {
    const { session, live } = await open();
    const call = toolCall(['mongo_count', { module: 'assets' }]);
    live.emit(hear('count', true), call, cancel(call.toolCall.functionCalls[0].id));
    await session.settled();
    expect(live.toolResponses).toEqual([]);
  });

  it('(9) Gemini barge-in stops the turn; a browser interrupt stops forwarding', async () => {
    const { socket, session, live } = await open();
    live.emit(hear('Tell me everything', true), audio(), say('Well, '), interrupted(), turnComplete());
    expect((await socket.next('interrupted')).turnId).toBe('t1');
    expect((await socket.next('turn_complete')).status).toBe('stopped');

    live.emit(hear('And energy?', true), audio(), say('Energy today '));
    const frames = socket.binary.length;
    const captions = socket.of('transcript').length;
    session.handleMessage(json({ type: 'interrupt' }), false);
    live.emit(audio(), say('was very high.'), turnComplete());
    const done = await socket.next('turn_complete', 2);
    expect(socket.binary).toHaveLength(frames);
    expect(socket.of('transcript')).toHaveLength(captions);
    expect(done.status).toBe('stopped');
    expect((await AiMessage.findById(done.messageId).lean()).text).toBe('Energy today');
  });

  it('(10) a voice model out of quota refuses the next session; usage rows carry audio seconds', async () => {
    const model = 'voice-budget-test';
    settings = await saveAiSettings({ limits: { ...settings.limits, [model]: { rpm: 1, rpd: 1 } } });
    const first = await open(OWNER, {}, { model, fallback: null });
    expect(first.socket.of('ready')[0].model).toBe(model);
    first.session.handleMessage(Buffer.alloc(32000), true); // not a valid frame: BAD_MESSAGE closes the session
    expect((await first.socket.next('closed')).reason).toBe('error');
    expect(first.socket.of('error')[0]).toMatchObject({ code: 'BAD_MESSAGE', fatal: true });
    expect(first.socket.closedWith.code).toBe(4008);

    const second = await open(OWNER, {}, { model, fallback: null });
    expect(second.socket.of('error')[0]).toMatchObject({ code: 'AI_QUOTA', fatal: true });
    expect(second.socket.of('closed')[0].reason).toBe('error');
    expect(second.socket.closedWith.code).toBe(4029);
    const rows = await AiUsage.find({ model, purpose: 'voice' }).lean();
    expect(rows.map((r) => r.status).sort()).toEqual(['blocked', 'ok']);
    expect(rows.find((r) => r.status === 'ok').audioSec).toEqual({ in: 0, out: 0 });
  });

  it('(10b) records audio seconds per connection', async () => {
    const { session, live } = await open();
    for (let i = 0; i < 25; i++) session.handleMessage(Buffer.alloc(1280), true); // 1 s in
    live.emit(audio(48_000)); // 1 s out
    await session.close();
    const row = await AiUsage.findOne({ purpose: 'voice', status: 'ok', 'audioSec.in': 1 }).lean();
    expect(row.audioSec).toEqual({ in: 1, out: 1 });
  });

  it('(11) falls back when the primary model refuses the setup', async () => {
    fake.failNext({ close: { code: 1008, reason: 'model not found' } });
    const { socket } = await open();
    expect(socket.of('ready')[0].model).toBe(settings.voice.fallback);
    expect(socket.of('notice')[0].data.text).toBe(
      `${settings.voice.model} is busy, so ${settings.voice.fallback} answers this session.`,
    );
    const failed = await AiUsage.findOne({ model: settings.voice.model, status: 'error' }).lean();
    expect(failed.error).toMatch(/model not found/);
  });

  it('(12) resumes on goAway with the last handle', async () => {
    const { session, live } = await open();
    live.emit(resumable('handle-1'), goAway());
    const next = await until(() => fake.last() !== live && fake.last());
    expect(next.config.sessionResumption).toEqual({ handle: 'handle-1' });
    await until(() => live.closed);
    await new Promise((r) => setImmediate(r));
    session.handleMessage(Buffer.alloc(640), true);
    await until(() => next.realtime.length === 1);
    expect(live.realtime).toHaveLength(0);
  });

  it('(12b) a handle from the fallback model resumes on the fallback only', async () => {
    fake.failNext({ close: { code: 1008, reason: 'model not found' } });
    const { live } = await open();
    expect(live.model).toBe(settings.voice.fallback);
    live.emit(resumable('fallback-handle'), goAway());
    const next = await until(() => fake.last() !== live && fake.last());
    expect(next.model).toBe(settings.voice.fallback);
    expect(next.config.sessionResumption).toEqual({ handle: 'fallback-handle' });
  });

  it('(12c) reconnects once after an unexpected Gemini close, then ends with AI_ERROR', async () => {
    const { socket, live } = await open();
    const before = fake.sessions.length;
    live.callbacks.onclose({ code: 1008, reason: 'policy' });
    const next = await until(() => fake.last() !== live && fake.last());
    await until(() => live.closed);
    next.callbacks.onclose({ code: 1007, reason: 'bad tool response' });
    expect((await socket.next('closed')).reason).toBe('error');
    expect(socket.of('error')[0]).toMatchObject({ code: 'AI_ERROR', fatal: true });
    expect(socket.closedWith.code).toBe(4502);
    expect(fake.sessions.length).toBe(before + 1);
  });

  it('(14) barge-in words after interrupted + turnComplete open the next turn', async () => {
    const { socket, live } = await open();
    live.emit(hear('Tell me everything', true), say('Well, '), interrupted(), turnComplete());
    expect((await socket.next('turn_complete')).status).toBe('stopped');
    live.emit(hear('Only energy', true));
    expect((await socket.next('turn_start', 2)).turnId).toBe('t2');
    expect(socket.of('transcript').at(-1)).toMatchObject({ turnId: 't2', role: 'user', text: 'Only energy' });
    live.emit(say('Energy is normal.'), turnComplete());
    const done = await socket.next('turn_complete', 2);
    const user = await AiMessage.findOne({ conversationId: done.conversationId, role: 'user' })
      .sort({ createdAt: 1 })
      .lean();
    expect(user.text).toBe('Tell me everything');
  });

  it('(15) an interrupted turn with a tool still running closes; the next answer gets its own turn', async () => {
    const { socket, live } = await open();
    const call = toolCall(['mongo_count', { module: 'assets' }]);
    live.emit(
      hear('Count the assets', true),
      say('One moment.'),
      call,
      cancel(call.toolCall.functionCalls[0].id),
      interrupted(),
      turnComplete(),
      hear('No, energy instead', true),
      say('Energy is normal.'),
      turnComplete(),
    );
    expect(await socket.next('turn_complete')).toMatchObject({ turnId: 't1', status: 'stopped' });
    const done = await socket.next('turn_complete', 2);
    expect(done).toMatchObject({ turnId: 't2', status: 'complete' });
    expect(socket.of('transcript').at(-1)).toMatchObject({ turnId: 't2', text: 'Energy is normal.' });
    expect((await AiMessage.findById(done.messageId).lean()).text).toBe('Energy is normal.');
    expect(live.toolResponses).toEqual([]);
  });

  it('(16) caps browser audio at 1.5x real time and ends a lasting overrun', async () => {
    const { socket, session, live } = await open();
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
    // Real time (25 frames of 40 ms per second) for 5 s: every frame reaches Gemini.
    for (let s = 0; s < 5; s++) {
      vi.setSystemTime(Date.now() + 1000);
      for (let i = 0; i < 25; i++) session.handleMessage(Buffer.alloc(1280), true);
    }
    expect(live.realtime).toHaveLength(125);
    // 100 full frames at once: only the ~2 s burst passes.
    for (let i = 0; i < 100; i++) session.handleMessage(Buffer.alloc(8192), true);
    expect(live.realtime.length - 125).toBeLessThanOrEqual(9);
    expect(socket.of('closed')).toHaveLength(0);
    // Still far above real time for more than 3 s → RATE_LIMITED.
    for (let step = 0; step < 20 && !socket.of('error').length; step++) {
      vi.setSystemTime(Date.now() + 200);
      for (let i = 0; i < 10; i++) session.handleMessage(Buffer.alloc(8192), true);
    }
    vi.useRealTimers();
    expect(socket.of('error')[0]).toMatchObject({ code: 'RATE_LIMITED', fatal: true });
    expect((await socket.next('closed')).reason).toBe('error');
    expect(socket.closedWith.code).toBe(4008);
  });
});

describe('voice session timers', () => {
  const fakeTimers = () =>
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });

  it('(13a) warns a minute before the limit, then ends with max_duration', async () => {
    fakeTimers();
    const { socket, live } = await open(OWNER, {}, { maxSessionMin: 2 });
    await vi.advanceTimersByTimeAsync(50_000);
    live.emit(hear('still here'));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(socket.of('notice').map((n) => n.data.text)).toContain('One minute left in this voice session.');
    live.emit(hear(' and here'));
    await vi.advanceTimersByTimeAsync(51_000);
    expect((await socket.next('closed')).reason).toBe('max_duration');
    expect(socket.closedWith.code).toBe(1000);
  });

  it('(13b) ends after 90 s of silence', async () => {
    fakeTimers();
    const { socket } = await open();
    await vi.advanceTimersByTimeAsync(89_000);
    expect(socket.of('closed')).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2_000);
    expect((await socket.next('closed')).reason).toBe('idle');
  });

  it('(13c) ends when the sign-in session expires', async () => {
    fakeTimers();
    const { socket, sessionId } = await open();
    await Session.updateOne({ sessionId }, { $set: { expired: true } });
    await vi.advanceTimersByTimeAsync(60_000);
    expect((await socket.next('closed')).reason).toBe('signed_out');
    expect(socket.closedWith.code).toBe(4001);
  });

  it('(13d) ends when the user’s role changes mid-session', async () => {
    fakeTimers();
    const Users = getModule('users').Model;
    const email = 'maintenance_technician_1@acme.test';
    const { role } = await Users.findOne({ email }).lean();
    const { socket } = await open(email);
    try {
      // (13a) shows that an unchanged user passes revalidation.
      await Users.updateOne({ email }, { $set: { role: 'viewer' } });
      await vi.advanceTimersByTimeAsync(60_000);
      expect((await socket.next('closed')).reason).toBe('signed_out');
      expect(socket.closedWith.code).toBe(4001);
    } finally {
      await Users.updateOne({ email }, { $set: { role } });
    }
  });

  it('(13e) ends when the superadmin switches voice off', async () => {
    fakeTimers();
    const { socket } = await open();
    try {
      await saveAiSettings({ voice: { enabled: false } });
      await vi.advanceTimersByTimeAsync(60_000);
      expect((await socket.next('closed')).reason).toBe('ended');
      expect(socket.of('error')[0]).toMatchObject({ code: 'VOICE_DISABLED', fatal: true });
      expect(socket.closedWith.code).toBe(4003);
    } finally {
      await saveAiSettings({ voice: { enabled: true } });
    }
  });
});
