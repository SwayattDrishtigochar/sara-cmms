import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildContents } from '../src/agent/history.js';
import { setLlm } from '../src/agent/llm.js';
import { runTurn, stopTurn } from '../src/agent/loop.js';
import { claimPendingAction, rejectPendingAction } from '../src/agent/pendingActions.js';
import { buildSystemPrompt, MAX_PROMPT_CHARS } from '../src/agent/systemPrompt.js';
import { getTool } from '../src/agent/tools/registry.js';
import * as gemini from '../src/ai/gemini.js';
import { env } from '../src/config/env.js';
import { AiConversation } from '../src/db/models/AiConversation.js';
import { AiMessage } from '../src/db/models/AiMessage.js';
import { AiToolAudit } from '../src/db/models/AiToolAudit.js';
import { getModule } from '../src/modules/registry.js';
import { contextFor, setupDatabase, teardownDatabase } from './helpers/db.js';
import { clearScripts, recorder, refOf, resultOf, script } from './helpers/mockGemini.js';

let owner;
let viewer;
let chiller;
const calls = []; // every generateStream request of the current test

const newConversation = async (ctx = owner, extra = {}) =>
  (await AiConversation.create({ companyId: ctx.companyId, userId: ctx.userId, ...extra })).toObject();

const turn = async (conversation, userText, { ctx = owner, onEvent, ...rest } = {}) => {
  const sse = recorder({ onEvent });
  const result = await runTurn({ ctx, conversation, userText, sse, ...rest });
  return { sse, result, message: await AiMessage.findById(result.messageId).lean() };
};

beforeAll(async () => {
  await setupDatabase();
  owner = await contextFor('owner_1@acme.test');
  viewer = await contextFor('viewer_1@acme.test');
  chiller = await getModule('assets').Model.findOne({ companyId: owner.companyId, name: 'Chiller 1' }).lean();
  setLlm({
    generate: gemini.generate,
    generateStream: (args) => {
      calls.push(args);
      return gemini.generateStream(args);
    },
  });
});
afterAll(async () => {
  setLlm(null);
  await teardownDatabase();
});
afterEach(() => {
  clearScripts();
  calls.length = 0;
});

describe('system prompt', () => {
  it('stays under the size budget and carries identity, rules and page context', async () => {
    const prompt = await buildSystemPrompt({
      ctx: owner,
      context: { page: 'machine', recordRef: { module: 'assets', id: String(chiller._id) } },
      groups: ['maintenance'],
    });
    expect(prompt.length).toBeLessThanOrEqual(MAX_PROMPT_CHARS);
    expect(prompt).toContain('Acme Components');
    expect(prompt).toContain('I could not determine');
    expect(prompt).toContain('Chiller 1"');
    expect(prompt).toContain('workorders');
  });
});

describe('runTurn', () => {
  it('streams a tool call, its result and the answer, and persists the turn', async () => {
    script(/open work orders/i, [
      {
        thought: 'Count them first.',
        calls: [{ name: 'mongo_count', args: { module: 'workorders', filter: { workStatus: 'Open' } } }],
      },
      ({ responses }) => ({
        text: `There are ${resultOf(responses, 'mongo_count').count} open work orders.`,
      }),
    ]);
    const conversation = await newConversation();
    const { sse, message } = await turn(conversation, 'How many open work orders do we have?');
    const types = sse.types();
    expect(types[0]).toBe('meta');
    expect(types).toEqual(
      expect.arrayContaining(['thought', 'tool_call', 'tool_result', 'delta', 'usage', 'title', 'done']),
    );
    expect(types.indexOf('tool_call')).toBeLessThan(types.indexOf('tool_result'));
    expect(types.at(-1)).toBe('done');
    const result = sse.of('tool_result')[0];
    expect(result).toMatchObject({ name: 'mongo_count', ok: true });
    expect(sse.of('done')[0]).toEqual({ messageId: String(message._id), status: 'complete' });

    expect(message.status).toBe('complete');
    expect(message.text).toMatch(/^There are \d+ open work orders\.$/);
    expect(message.gemini.map((c) => c.role)).toEqual(['model', 'user', 'model']);
    expect(message.gemini[0].parts.find((p) => p.functionCall).thoughtSignature).toBe('mock-signature');
    expect(message.gemini[1].parts[0].functionResponse.response.ref).toBe(result.id);
    expect(message.parts.map((p) => p.type)).toEqual(['thought', 'tool_call', 'tool_result', 'text']);
    expect(message.usage.total).toBeGreaterThan(0);

    // the second step got the history plus the model call and one user content with the response
    expect(calls).toHaveLength(2);
    expect(calls[1].contents.at(-1).parts[0].functionResponse.name).toBe('mongo_count');
    expect(calls[0].tools[0].functionDeclarations.map((d) => d.name)).toContain('mongo_count');

    const saved = await AiConversation.findById(conversation._id).lean();
    expect(saved.title).toBeTruthy();
    expect(sse.of('title')[0].title).toBe(saved.title);
    const audit = await AiToolAudit.findOne({ messageId: message._id }).lean();
    expect(audit).toMatchObject({ tool: 'mongo_count', ok: true });
  });

  it('renders a table from a sourceRef of the same turn', async () => {
    script(/list assets table/i, [
      { calls: [{ name: 'mongo_find', args: { module: 'assets', limit: 5 } }] },
      ({ responses }) => ({
        calls: [
          { name: 'render_table', args: { title: 'Assets', sourceRef: refOf(responses, 'mongo_find') } },
        ],
      }),
      { text: 'Here are five assets.' },
    ]);
    const { sse } = await turn(await newConversation(), 'list assets table please');
    const block = sse.of('block')[0];
    expect(block.type).toBe('table');
    expect(block.payload.rows).toHaveLength(5);
    expect(block.id).toMatch(/^b_/);
  });

  it('auto-loads the group of a permitted tool, answers unknown tools with a hint, loads groups on request', async () => {
    script(/show zz tools/i, [
      { calls: [{ name: 'telemetry_fields', args: { assetId: String(chiller._id) } }] },
      { calls: [{ name: 'nope_tool', args: {} }] },
      ({ responses }) => {
        expect(responses[0].response.error).toMatch(/Unknown tool/);
        return { calls: [{ name: 'load_tools', args: { groups: ['health'] } }] };
      },
      { text: 'Loaded.' },
    ]);
    const conversation = await newConversation();
    const { sse } = await turn(conversation, 'show zz tools');
    expect(sse.of('tool_result').map((r) => [r.name, r.ok])).toEqual([
      ['telemetry_fields', true],
      ['nope_tool', false],
      ['load_tools', true],
    ]);
    expect(calls[1].tools[0].functionDeclarations.map((d) => d.name)).toContain('telemetry_fields');
    expect(calls[3].tools[0].functionDeclarations.map((d) => d.name)).toContain('machine_health');
    const { loadedGroups } = await AiConversation.findById(conversation._id).lean();
    expect(loadedGroups).toEqual(expect.arrayContaining(['telemetry', 'health']));
  });

  it('caps the tool iterations and still answers', async () => {
    script(
      /show endless/i,
      new Array(20).fill({ calls: [{ name: 'mongo_count', args: { module: 'assets' } }] }),
    );
    const { sse, message } = await turn(await newConversation(), 'show endless lookups');
    expect(sse.of('tool_call')).toHaveLength(env.MAX_TOOL_ITERATIONS);
    expect(sse.of('notice').some((n) => /stopped after/.test(n.text))).toBe(true);
    expect(calls.at(-1).tools).toBeUndefined(); // the last step had no tools
    expect(message.status).toBe('complete');
  });

  it('stops when asked', async () => {
    script(/show stop me/i, [
      { calls: [{ name: 'mongo_count', args: { module: 'assets' } }] },
      { text: 'never' },
    ]);
    const { sse, message } = await turn(await newConversation(), 'show stop me', {
      onEvent: (event, data) => {
        if (event === 'meta') expect(stopTurn(data.messageId, owner.userId)).toBe(true);
      },
    });
    expect(sse.of('done')[0].status).toBe('stopped');
    expect(message.status).toBe('stopped');
    expect(stopTurn(message._id, owner.userId)).toBe(false);
  });

  it('a failed turn reads as plain words and still gets a title, without another model call', async () => {
    setLlm({
      generate: gemini.generate,
      generateStream: async function* () {
        yield* [];
        throw new gemini.AiUnavailableError(
          'AI_ERROR',
          'The AI stream failed: {"error":{"code":402,"message":"Your prepayment credits are depleted.","status":"RESOURCE_EXHAUSTED"}}',
        );
      },
    });
    try {
      const conversation = await newConversation();
      const { sse, message } = await turn(conversation, 'show me the failing question please now');
      const [error] = sse.of('error');
      expect(error.code).toBe('AI_ERROR');
      expect(error.message).toMatch(/quota/);
      expect(error.message).not.toMatch(/[{}]|402|RESOURCE_EXHAUSTED/);
      expect(message.status).toBe('error');
      expect(sse.of('title')[0].title).toBe('show me the failing question please');
      expect((await AiConversation.findById(conversation._id).lean()).title).toBe(
        'show me the failing question please',
      );
    } finally {
      setLlm({
        generate: gemini.generate,
        generateStream: (args) => {
          calls.push(args);
          return gemini.generateStream(args);
        },
      });
    }
  });

  it('a mid-turn 429 retry drops the half-streamed text and relaxes the first model signatures', async () => {
    const seen = [];
    const chunk = (part) => ({ candidates: [{ content: { parts: [part] } }] });
    setLlm({
      generate: gemini.generate,
      generateStream: async function* ({ contents }) {
        seen.push(structuredClone(contents));
        if (seen.length === 1) {
          yield chunk({
            functionCall: { name: 'mongo_count', args: { module: 'assets' } },
            thoughtSignature: 'sig-of-model-a',
          });
        } else if (seen.length === 2) {
          yield chunk({ text: 'Half an ans' });
          throw new gemini.AiUnavailableError('AI_QUOTA', '429 RESOURCE_EXHAUSTED');
        } else yield chunk({ text: 'Fresh answer.' });
      },
    });
    try {
      const { message } = await turn(await newConversation(), 'show the retry question');
      expect(message.text).toBe('Fresh answer.');
      expect(message.parts.filter((p) => p.type === 'text').map((p) => p.text)).toEqual(['Fresh answer.']);
      const sigs = seen[2].flatMap((c) => c.parts.map((p) => p.thoughtSignature).filter(Boolean));
      expect(sigs).toEqual(['skip_thought_signature_validator']);
    } finally {
      setLlm({
        generate: gemini.generate,
        generateStream: (args) => {
          calls.push(args);
          return gemini.generateStream(args);
        },
      });
    }
  });

  it('escalates once to the deep tier when the answer is stuck', async () => {
    script(/show unsure/i, [{ text: 'I could not determine that from the data.' }]);
    const { sse, message } = await turn(await newConversation(), 'show unsure thing');
    expect(sse.of('escalated')).toEqual([expect.objectContaining({ to: 'deep' })]);
    expect(message.tier).toBe('deep');
    expect(calls.map((c) => c.tier).at(-1)).toBe('deep');
  });
});

describe('writes need confirmation', () => {
  const createScript = (match) =>
    script(match, [
      { calls: [{ name: 'resolve', args: { kind: 'asset', query: 'Chiller 1' } }] },
      ({ responses }) => ({
        calls: [
          {
            name: 'create_record',
            args: {
              module: 'workorders',
              items: [
                {
                  name: 'Coolant leak',
                  asset: resultOf(responses, 'resolve').matches[0].id,
                  priority: 'High',
                },
              ],
            },
          },
          { name: 'create_record', args: { module: 'workorders', items: [{ name: 'Second change' }] } },
          { name: 'mongo_count', args: { module: 'workorders' } },
        ],
      }),
      ({ responses }) => ({
        text:
          responses[0]?.response?.status === 'confirmed'
            ? `\n\nCreated ${responses[0].response.result.created[0].label}.`
            : 'OK, nothing changed.',
      }),
    ]);
  const countLeaks = () =>
    getModule('workorders').Model.countDocuments({ companyId: owner.companyId, name: 'Coolant leak' });

  it('previews, waits, then confirms and continues the same message', async () => {
    createScript(/create a work order for chiller/i);
    const conversation = await newConversation();
    const before = await countLeaks();
    const { sse, message } = await turn(
      conversation,
      'Create a work order for Chiller 1: coolant leak, high priority',
    );
    const confirm = sse.of('block').find((b) => b.type === 'confirm');
    expect(confirm.payload).toMatchObject({ tool: 'create_record', module: 'workorders', status: 'pending' });
    expect(confirm.payload.actionId).toBeTruthy();
    // The preview shows what was asked for (plus the starting status), not the record's bookkeeping.
    expect(Object.keys(confirm.payload.items[0].doc).sort()).toEqual([
      'asset',
      'name',
      'priority',
      'workStatus',
    ]);
    expect(sse.of('tool_result').find((r) => r.name === 'create_record')).toMatchObject({
      ok: false,
      error: 'one change at a time',
    });
    expect(sse.of('done')[0]).toMatchObject({
      status: 'awaiting_confirmation',
      pendingAction: { id: confirm.payload.actionId },
    });
    expect(message.status).toBe('awaiting_confirmation');
    expect(message.pendingAction.siblingResponses).toHaveLength(2); // the refused write + mongo_count
    expect(await countLeaks()).toBe(before);

    const claimed = await claimPendingAction({
      ctx: owner,
      conversation,
      actionId: confirm.payload.actionId,
    });
    await expect(
      claimPendingAction({ ctx: owner, conversation, actionId: confirm.payload.actionId }),
    ).rejects.toThrow(/already/);
    const next = await turn(conversation, undefined, { continuation: claimed });
    expect(next.result.messageId).toBe(String(message._id));
    expect(next.sse.of('tool_result')[0]).toMatchObject({ name: 'create_record', ok: true });
    expect(next.message.text).toMatch(/^Created WO-\d+/);
    // the answer after the card is a new text part, without the model's leading blank lines
    expect(next.message.parts.at(-1)).toMatchObject({
      type: 'text',
      text: expect.stringMatching(/^Created/),
    });
    expect(next.message.status).toBe('complete');
    expect(next.message.pendingAction.status).toBe('confirmed');
    expect(await countLeaks()).toBe(before + 1);
    // the step answer holds all three responses in call order
    const answer = next.message.gemini.find((c) => c.role === 'user' && c.parts.length === 3);
    expect(answer.parts.map((p) => p.functionResponse.name)).toEqual([
      'create_record',
      'create_record',
      'mongo_count',
    ]);
    expect(answer.parts[0].functionResponse.response.status).toBe('confirmed');
  });

  it('a stop during the confirmed write still records the write it committed', async () => {
    createScript(/log a work order for chiller/i);
    const conversation = await newConversation();
    const before = await countLeaks();
    const { sse } = await turn(conversation, 'Log a work order for Chiller 1: coolant leak');
    const actionId = sse.of('block').find((b) => b.type === 'confirm').payload.actionId;
    const claimed = await claimPendingAction({ ctx: owner, conversation, actionId });
    const stop = new AbortController();
    const { tool } = claimed;
    const stopping = {
      ...tool,
      run: async (...args) => {
        stop.abort(); // the user presses Stop while the write is saving
        return tool.run(...args);
      },
    };
    const next = await turn(conversation, undefined, {
      continuation: { ...claimed, tool: stopping },
      signal: stop.signal,
    });
    expect(next.message.status).toBe('stopped');
    expect(await countLeaks()).toBe(before + 1);
    expect(next.message.pendingAction.result).toMatchObject({ ok: true });
    const answer = next.message.gemini.find((c) => c.role === 'user' && c.parts.length === 3);
    expect(answer.parts[0].functionResponse.response.status).toBe('confirmed');
  });

  it('reject answers the call with rejected and saves nothing', async () => {
    createScript(/raise a work order for chiller/i);
    const conversation = await newConversation();
    const before = await countLeaks();
    const { sse } = await turn(conversation, 'Raise a work order for Chiller 1: coolant leak');
    const actionId = sse.of('block').find((b) => b.type === 'confirm').payload.actionId;
    await rejectPendingAction({ conversation, actionId });
    const message = await AiMessage.findOne({ 'pendingAction.id': actionId }).lean();
    expect(message.pendingAction.status).toBe('rejected');
    expect(message.gemini.at(-1).parts[0].functionResponse.response).toEqual({ status: 'rejected' });
    expect(await countLeaks()).toBe(before);
    await expect(claimPendingAction({ ctx: owner, conversation, actionId })).rejects.toThrow(
      /already rejected/,
    );
  });

  it('a new message expires the pending action as not_confirmed', async () => {
    createScript(/add a work order for chiller/i);
    script(/^hello$/i, [{ text: 'Hi!' }]);
    const conversation = await newConversation();
    const { sse } = await turn(conversation, 'Add a work order for Chiller 1');
    const actionId = sse.of('block').find((b) => b.type === 'confirm').payload.actionId;
    await turn(conversation, 'hello');
    const message = await AiMessage.findOne({ 'pendingAction.id': actionId }).lean();
    expect(message.pendingAction.status).toBe('expired');
    expect(message.gemini.at(-1).parts[0].functionResponse.response).toEqual({ status: 'not_confirmed' });
    const contents = await buildContents(conversation, { keepFull: 0 });
    const roles = contents.map((c) => c.role);
    expect(roles[0]).toBe('user');
    expect(roles.at(-1)).toBe('model');
    const shrunk = contents.flatMap((c) => c.parts).find((p) => p.functionResponse?.name === 'resolve');
    expect(Object.keys(shrunk.functionResponse.response)).toEqual(['ref', 'summary', 'rowCount']);
  });

  it('a viewer gets no write tools', async () => {
    script(/create a work order as viewer/i, [
      { calls: [{ name: 'create_record', args: { module: 'workorders', items: [{ name: 'x' }] } }] },
      { text: 'I cannot create work orders for your role.' },
    ]);
    const { sse } = await turn(await newConversation(viewer), 'Create a work order as viewer', {
      ctx: viewer,
    });
    // ai/mockChat.js REFUSED parses this text to explain the refusal in words: keep both in step
    expect(sse.of('tool_result')[0]).toMatchObject({
      ok: false,
      error: expect.stringMatching(/^create_record is not available to .+ \(role view\)$/),
    });
    expect(sse.of('block')).toHaveLength(0);
    expect(calls[0].tools[0].functionDeclarations.some((d) => d.name === 'create_record')).toBe(false);
  });
});

describe('plant lock in summary tools', () => {
  it('a plant-locked user asking for another plant still sees only their own plant', async () => {
    const pune = await contextFor('plant_manager_1@acme.test');
    const chennai = await contextFor('plant_manager_2@acme.test');
    expect(pune.plantLock).toBeTruthy();
    const tool = getTool('work_orders_summary');
    const io = { emit: () => {}, results: new Map(), callId: 't' };
    const total = async (args) => {
      const out = await tool.run(pune, tool.schema.parse({ groupBy: 'plant', scope: 'all', ...args }), io);
      return out.data.rows.reduce((n, r) => n + r.count, 0);
    };
    const own = await getModule('workorders').Model.countDocuments({
      companyId: pune.companyId,
      plantId: pune.plantLock,
      deleted: { $ne: true },
    });
    expect(own).toBeGreaterThan(0);
    expect(await total({ plantId: String(chennai.plantLock) })).toBe(own);
    expect(await total({})).toBe(own);
  });
});
