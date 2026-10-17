import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { AiConversation } from '../src/db/models/AiConversation.js';
import { AiMessage } from '../src/db/models/AiMessage.js';
import { conversationsRouter } from '../src/routes/conversations.js';
import { exportRouter, toCsv } from '../src/routes/export.js';
import { PASSWORD, setupDatabase, teardownDatabase } from './helpers/db.js';
import { clearScripts, parseSse, refOf, resultOf, script } from './helpers/mockGemini.js';

let app;
const tokens = {};
const as = (who) => ({ authorization: `Bearer ${tokens[who]}` });

/** Reads the whole SSE body as text. */
const sseText = (req) =>
  req.buffer(true).parse((res, cb) => {
    let data = '';
    res.setEncoding('utf8');
    res.on('data', (chunk) => {
      data += chunk;
    });
    res.on('end', () => cb(null, data));
  });

const post = (who, path, body = {}) => sseText(request(app).post(`/api${path}`).set(as(who)).send(body));
const newConversation = async (who = 'owner') =>
  (await request(app).post('/api/conversations').set(as(who)).send({})).body.conversation;

beforeAll(async () => {
  await setupDatabase();
  app = createApp({
    routers: [
      { path: '/api', router: conversationsRouter },
      { path: '/api', router: exportRouter },
    ],
  });
  for (const [who, email] of Object.entries({
    owner: 'owner_1@acme.test',
    tech: 'maintenance_technician_1@acme.test',
    betaOwner: 'owner_1@beta.test',
  })) {
    const res = await request(app).post('/api/auth/login').send({ email, password: PASSWORD });
    expect(res.status).toBe(200);
    tokens[who] = res.body.token;
  }
});
afterAll(teardownDatabase);
afterEach(clearScripts);

describe('conversations', () => {
  it('creates, lists with a cursor, renames and soft-deletes own conversations', async () => {
    const created = await request(app).post('/api/conversations').set(as('owner')).send({ title: 'Energy' });
    expect(created.status).toBe(201);
    const { id } = created.body.conversation;
    expect(created.body.conversation).toMatchObject({
      title: 'Energy',
      tierPreference: 'auto',
      voice: false,
    });

    for (let i = 0; i < 31; i++) await newConversation();
    const first = await request(app).get('/api/conversations').set(as('owner'));
    expect(first.body.items).toHaveLength(30);
    expect(first.body.nextCursor).toBeTruthy();
    const second = await request(app)
      .get('/api/conversations')
      .query({ cursor: first.body.nextCursor })
      .set(as('owner'));
    expect(second.body.items).toHaveLength(2);
    expect(second.body.nextCursor).toBeNull();
    const ids = [...first.body.items, ...second.body.items].map((c) => c.id);
    expect(new Set(ids).size).toBe(32);
    expect(
      (await request(app).get('/api/conversations').query({ cursor: 'junk' }).set(as('owner'))).status,
    ).toBe(400);

    const patched = await request(app)
      .patch(`/api/conversations/${id}`)
      .set(as('owner'))
      .send({ title: 'Power', tierPreference: 'deep' });
    expect(patched.body.conversation).toMatchObject({ title: 'Power', tierPreference: 'deep' });
    expect(
      (await request(app).patch(`/api/conversations/${id}`).set(as('owner')).send({ tierPreference: 'max' }))
        .status,
    ).toBe(400);

    expect((await request(app).delete(`/api/conversations/${id}`).set(as('owner'))).status).toBe(204);
    expect((await request(app).get(`/api/conversations/${id}`).set(as('owner'))).status).toBe(404);
    expect(await AiConversation.countDocuments({ _id: id, deleted: true })).toBe(1);
  });

  it('only the owner can see or use a conversation', async () => {
    const { id } = await newConversation('owner');
    for (const who of ['tech', 'betaOwner']) {
      expect((await request(app).get(`/api/conversations/${id}`).set(as(who))).status).toBe(404);
      expect(
        (await request(app).post(`/api/conversations/${id}/messages`).set(as(who)).send({ text: 'hi' }))
          .status,
      ).toBe(404);
      expect(
        (await request(app).get('/api/conversations').set(as(who))).body.items.map((c) => c.id),
      ).not.toContain(id);
    }
    expect((await request(app).get('/api/conversations/not-an-id').set(as('owner'))).status).toBe(404);
    expect(
      (await request(app).post(`/api/conversations/${id}/messages`).set(as('owner')).send({ text: '' }))
        .status,
    ).toBe(400);
  });

  it('an answer a restart left streaming reads as an error once no turn could still be running', async () => {
    const { id } = await newConversation();
    const { _id, companyId, userId } = await AiConversation.findById(id).lean();
    const row = (at) => ({
      conversationId: _id,
      companyId,
      userId,
      role: 'assistant',
      status: 'streaming',
      text: '',
      createdAt: at,
      updatedAt: at,
    });
    await AiMessage.collection.insertMany([row(new Date(Date.now() - 10 * 60_000)), row(new Date())]);
    const thread = await request(app).get(`/api/conversations/${id}`).set(as('owner'));
    expect(thread.body.messages.map((m) => m.status)).toEqual(['error', 'streaming']);
    expect(thread.body.messages.map((m) => m.channel)).toEqual(['text', 'text']); // older docs have no channel
  });
});

describe('messages over SSE', () => {
  it('streams the turn as SSE frames and stores it without raw Gemini contents', async () => {
    script(/count assets please/i, [
      { thought: 'Counting.', calls: [{ name: 'mongo_count', args: { module: 'assets' } }] },
      ({ responses }) => ({ text: `You have ${resultOf(responses, 'mongo_count').count} assets.` }),
    ]);
    const { id } = await newConversation();
    const res = await post('owner', `/conversations/${id}/messages`, {
      text: 'count assets please',
      tier: 'fast',
    });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
    const events = parseSse(res.body);
    const types = events.map((e) => e.event);
    expect(types[0]).toBe('meta');
    expect(events[0].data).toMatchObject({ conversationId: id, tier: 'fast' });
    expect(types).toEqual(
      expect.arrayContaining(['thought', 'tool_call', 'tool_result', 'delta', 'usage', 'title', 'done']),
    );
    expect(types.at(-1)).toBe('done');

    const thread = await request(app).get(`/api/conversations/${id}`).set(as('owner'));
    expect(thread.body.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    const assistant = thread.body.messages[1];
    expect(assistant.id).toBe(events[0].data.messageId);
    expect(assistant.gemini).toBeUndefined();
    expect(assistant.text).toMatch(/^You have \d+ assets\.$/);
    expect(assistant.parts.map((p) => p.type)).toContain('tool_result');
    expect(thread.body.conversation.title).toBeTruthy();
  });

  it('confirm streams the continuation; reject answers ok; both only once', async () => {
    const steps = [
      {
        calls: [
          {
            name: 'add_work_order_comment',
            args: { workOrder: 'WO-42', comment: 'Waiting for the seal kit' },
          },
        ],
      },
      ({ responses }) => ({
        text: responses[0]?.response?.status === 'confirmed' ? 'Comment added.' : 'Nothing changed.',
      }),
    ];
    script(/comment on wo-42/i, steps);
    const { id } = await newConversation();
    const first = parseSse(
      (await post('owner', `/conversations/${id}/messages`, { text: 'Add a comment on WO-42' })).body,
    );
    const confirm = first.find((e) => e.event === 'block' && e.data.type === 'confirm');
    expect(confirm.data.payload.label).toMatch(/Comment on WO-42/);
    expect(first.at(-1).data.status).toBe('awaiting_confirmation');
    const { actionId } = confirm.data.payload;

    expect(
      (await request(app).post(`/api/conversations/${id}/actions/${actionId}/confirm`).set(as('tech')))
        .status,
    ).toBe(404);
    const done = await post('owner', `/conversations/${id}/actions/${actionId}/confirm`);
    const events = parseSse(done.body);
    expect(events[0].event).toBe('meta');
    expect(events.find((e) => e.event === 'tool_result').data).toMatchObject({
      name: 'add_work_order_comment',
      ok: true,
    });
    expect(events.at(-1).data).toMatchObject({ status: 'complete', messageId: first[0].data.messageId });
    expect(
      (await request(app).post(`/api/conversations/${id}/actions/${actionId}/confirm`).set(as('owner')))
        .status,
    ).toBe(410);

    script(/comment on wo-42/i, steps);
    const again = parseSse(
      (await post('owner', `/conversations/${id}/messages`, { text: 'Add a comment on WO-42 again' })).body,
    );
    const second = again.find((e) => e.event === 'block' && e.data.type === 'confirm').data.payload.actionId;
    const rejected = await request(app)
      .post(`/api/conversations/${id}/actions/${second}/reject`)
      .set(as('owner'));
    expect(rejected.body).toEqual({ ok: true });
    expect(
      (await request(app).post(`/api/conversations/${id}/actions/${second}/reject`).set(as('owner'))).status,
    ).toBe(410);
    const thread = await request(app).get(`/api/conversations/${id}`).set(as('owner'));
    expect(thread.body.messages.at(-1).pendingAction).toMatchObject({ id: second, status: 'rejected' });
    expect(thread.body.messages.at(-1).pendingAction.siblingResponses).toBeUndefined();
  });

  it('confirming a change left pending by a voice turn runs on a text tier', async () => {
    script(/comment on wo-42 by voice/i, [
      { calls: [{ name: 'add_work_order_comment', args: { workOrder: 'WO-42', comment: 'Seal kit here' } }] },
      ({ responses }) => ({
        text: responses[0]?.response?.status === 'confirmed' ? 'Comment added.' : 'Nothing changed.',
      }),
    ]);
    const { id } = await newConversation();
    const first = parseSse(
      (await post('owner', `/conversations/${id}/messages`, { text: 'Add a comment on WO-42 by voice' }))
        .body,
    );
    const { actionId } = first.find((e) => e.event === 'block' && e.data.type === 'confirm').data.payload;
    const messageId = first[0].data.messageId;
    await AiMessage.updateOne(
      { _id: messageId },
      { $set: { tier: 'voice', channel: 'voice', model: 'gemini-live-mock' } },
    );

    const events = parseSse((await post('owner', `/conversations/${id}/actions/${actionId}/confirm`)).body);
    expect(events[0].data.tier).toBe('balanced');
    expect(events.find((e) => e.event === 'error')).toBeUndefined();
    expect(events.at(-1).data).toMatchObject({ status: 'complete', messageId });
    const thread = await request(app).get(`/api/conversations/${id}`).set(as('owner'));
    expect(thread.body.messages.at(-1)).toMatchObject({ text: 'Comment added.', channel: 'voice' });
  });

  it('stop answers ok:false for a message that is not streaming', async () => {
    const { id } = await newConversation();
    const res = await request(app)
      .post(`/api/conversations/${id}/messages/64b7f0c2a1b2c3d4e5f60718/stop`)
      .set(as('owner'));
    expect(res.body).toEqual({ ok: false });
  });
});

describe('CSV export', () => {
  it('serves the file block of an export_csv call to the message owner only', async () => {
    script(/export assets csv/i, [
      {
        calls: [
          { name: 'mongo_find', args: { module: 'assets', limit: 3, projection: ['name', 'assetTag'] } },
        ],
      },
      ({ responses }) => ({
        calls: [{ name: 'export_csv', args: { name: 'assets', sourceRef: refOf(responses, 'mongo_find') } }],
      }),
      { text: 'Here is the file.' },
    ]);
    const { id } = await newConversation();
    const events = parseSse(
      (await post('owner', `/conversations/${id}/messages`, { text: 'export assets csv' })).body,
    );
    const file = events.find((e) => e.event === 'block' && e.data.type === 'file').data;
    expect(file.payload).toMatchObject({ name: 'assets.csv', rows: 3 });
    expect(file.payload.url).toMatch(new RegExp(`^/api/export/[0-9a-f]{24}/${file.id}\\.csv$`));

    const res = await request(app).get(file.payload.url).set(as('owner'));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/assets\.csv/);
    const lines = res.text.replace(/^﻿/, '').trim().split('\r\n');
    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatch(/Name/);
    expect((await request(app).get(file.payload.url).set(as('tech'))).status).toBe(404);

    const thread = await request(app).get(`/api/conversations/${id}`).set(as('owner'));
    const block = thread.body.messages[1].parts.find((p) => p.type === 'block');
    expect(block).toMatchObject({ id: file.id, blockType: 'file' });
    expect(block.csv).toBeUndefined();
  });

  it('quotes cells and defuses formulas', () => {
    const csv = toCsv({
      columns: [
        { key: 'a', label: 'A', unit: 'kWh' },
        { key: 'b', label: 'B' },
      ],
      rows: [
        { a: 'x, "y"', b: '=SUM(A1)' },
        { a: -5, b: [{ label: 'Ramesh' }, { label: 'Suresh' }] },
      ],
    });
    expect(csv).toBe('﻿A (kWh),B\r\n"x, ""y""",\'=SUM(A1)\r\n-5,Ramesh; Suresh\r\n');
  });
});
