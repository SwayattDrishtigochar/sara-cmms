import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { demoChat } from '../src/ai/mockChat.js';
import { mockLive, mockLiveTiming, spoken, toneFor } from '../src/ai/mockLive.js';
import { clearScripts, script } from './helpers/mockGemini.js';

const TOOL_NAMES = [
  'work_orders_summary',
  'mongo_aggregate',
  'render_kpis',
  'resolve',
  'telemetry_latest',
  'create_record',
  'plan_production',
  'check_plan',
  'apply_plan',
  'confirm_action',
  'reject_action',
];
const TOOLS = [{ functionDeclarations: TOOL_NAMES.map((name) => ({ name, description: name })) }];
const PENDING = `A change is waiting for the user's answer: "Create 1 work order" (actionId act9).`;

const kind = (m) =>
  m.toolCall
    ? 'toolCall'
    : m.usageMetadata
      ? 'usage'
      : m.sessionResumptionUpdate
        ? 'resume'
        : m.setupComplete
          ? 'setup'
          : Object.keys(m.serverContent)[0];
const tick = (ms = 1) => new Promise((r) => setTimeout(r, ms));
const until = async (pred, ms = 3000) => {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting for the mock session');
    await tick();
  }
};

/** A mock Live session that answers each tool call with `answer(call)` (null = leave it unanswered). */
const open = async ({ system = 'You are SARA.', answer = () => ({}) } = {}) => {
  const messages = [];
  const closes = [];
  const h = { messages, closes, session: null };
  h.session = await mockLive.connect({
    model: 'mock-live',
    config: { systemInstruction: system, tools: TOOLS },
    callbacks: {
      onmessage: (m) => {
        messages.push(m);
        if (!m.toolCall) return;
        const functionResponses = m.toolCall.functionCalls.map((c) => ({
          id: c.id,
          name: c.name,
          response: answer(c),
        }));
        if (functionResponses.every((r) => r.response)) {
          setTimeout(() => h.session.sendToolResponse({ functionResponses }), 0);
        }
      },
      onclose: (e) => closes.push(e),
    },
  });
  await until(() => messages.length > 0);
  /** Sends text and resolves with this turn's messages once its resumption handle arrives. */
  h.say = async (text) => {
    const from = messages.length;
    const resumes = messages.filter((m) => m.sessionResumptionUpdate).length;
    h.session.sendRealtimeInput({ text });
    await until(() => messages.filter((m) => m.sessionResumptionUpdate).length > resumes);
    return messages.slice(from);
  };
  return h;
};
const transcript = (msgs) =>
  msgs
    .filter((m) => m.serverContent?.outputTranscription)
    .map((m) => m.serverContent.outputTranscription.text)
    .join('');
const audioOf = (msgs) =>
  msgs.flatMap((m) => m.serverContent?.modelTurn?.parts ?? []).map((p) => p.inlineData);
const callsOf = (msgs) => msgs.filter((m) => m.toolCall).flatMap((m) => m.toolCall.functionCalls);

beforeAll(() => {
  mockLiveTiming.chunkMs = 0;
});
afterEach(() => {
  clearScripts();
  demoChat.enabled = false;
});

describe('mockLive session', () => {
  it('connects with setupComplete and closes once', async () => {
    const h = await open();
    await until(() => h.messages.length === 1);
    expect(kind(h.messages[0])).toBe('setup');
    h.session.close();
    h.session.close();
    await tick(5);
    expect(h.closes).toEqual([{ code: 1000, reason: '' }]);
    h.session.sendRealtimeInput({ text: 'hello' });
    await tick(5);
    expect(h.messages).toHaveLength(1);
  });

  it('answers text with transcripts, a 24 kHz tone, then completion, usage, turnComplete and a handle', async () => {
    const h = await open();
    const msgs = await h.say('Hello there');
    const text = "I'm SARA in mock mode: type or use Say something.";
    expect(transcript(msgs)).toBe(text);
    expect(msgs.filter((m) => m.serverContent?.outputTranscription).length).toBeLessThanOrEqual(3);
    const audio = audioOf(msgs);
    expect(audio.length).toBeGreaterThan(0);
    expect(new Set(audio.map((a) => a.mimeType))).toEqual(new Set(['audio/pcm;rate=24000']));
    const pcm = audio.map((a) => Buffer.from(a.data, 'base64'));
    expect(Math.max(...pcm.map((b) => b.length))).toBeLessThanOrEqual(9600);
    expect(Buffer.concat(pcm).equals(toneFor(text))).toBe(true);
    expect(msgs.slice(-4).map(kind)).toEqual(['generationComplete', 'usage', 'turnComplete', 'resume']);
    expect(kind(msgs[0])).toBe('outputTranscription');
    const usage = msgs.find((m) => m.usageMetadata).usageMetadata;
    expect(usage.responseTokenCount).toBe(Math.ceil(text.length / 4));
    expect(usage.totalTokenCount).toBe(usage.promptTokenCount + usage.responseTokenCount);
    expect(msgs.at(-1).sessionResumptionUpdate).toEqual({ newHandle: 'mock-1', resumable: true });
    const again = await h.say('Hi');
    expect(again.at(-1).sessionResumptionUpdate.newHandle).toBe('mock-2');
  });

  it('runs a script: tool call, waits for the response, then speaks the answer', async () => {
    script(/open work orders/i, [
      { calls: [{ name: 'work_orders_summary', args: { scope: 'open' } }] },
      ({ responses }) => ({ text: `You have **${responses[0].response.result.total}** open work orders.` }),
    ]);
    const h = await open({ answer: () => null });
    h.session.sendRealtimeInput({ text: 'How many open work orders?' });
    await until(() => h.messages.some((m) => m.toolCall));
    await tick(10);
    const [call] = callsOf(h.messages);
    expect(call).toEqual({
      id: expect.stringMatching(/^mock-fc-\d+$/),
      name: 'work_orders_summary',
      args: { scope: 'open' },
    });
    expect(h.messages.some((m) => m.serverContent?.outputTranscription)).toBe(false);
    h.session.sendToolResponse({ functionResponses: [{ id: 'other', name: 'x', response: {} }] });
    await tick(10);
    expect(h.messages.some((m) => m.serverContent?.outputTranscription)).toBe(false);
    h.session.sendToolResponse({
      functionResponses: [{ id: call.id, name: call.name, response: { ref: call.id, result: { total: 7 } } }],
    });
    await until(() => h.messages.some((m) => m.sessionResumptionUpdate));
    expect(transcript(h.messages)).toBe('You have 7 open work orders.');
  });

  it('asks before a write, then confirms on a later "yes"', async () => {
    script(/create a work order/i, [
      { calls: [{ name: 'resolve', args: { kind: 'asset', query: 'Press 2' } }] },
      {
        calls: [
          { name: 'create_record', args: { module: 'workorders', items: [{ name: 'Hydraulic leak' }] } },
        ],
      },
    ]);
    const answer = (c) =>
      ({
        resolve: { ref: c.id, result: { matches: [{ id: 'a2' }] } },
        create_record: { status: 'awaiting_confirmation', actionId: 'act1', label: 'Create 1 work order' },
        confirm_action: {
          status: 'confirmed',
          summary: 'Created 1 work order',
          result: { created: [{ label: 'WO-9 · Hydraulic leak – Press 2' }] },
        },
      })[c.name];
    const h = await open({ answer });
    const ask = await h.say('Create a work order for Press 2: hydraulic leak, high priority');
    expect(callsOf(ask).map((c) => c.name)).toEqual(['resolve', 'create_record']);
    expect(transcript(ask)).toBe('Create 1 work order. Shall I go ahead?');
    const yes = await h.say('Yes, go ahead');
    expect(callsOf(yes)).toEqual([
      { id: expect.any(String), name: 'confirm_action', args: { actionId: 'act1' } },
    ]);
    expect(transcript(yes)).toBe('Done: Created 1 work order, WO-9.');
    // The action is used up: a second "yes" is just text.
    const again = await h.say('yes');
    expect(callsOf(again)).toEqual([]);
  });

  it.each(['yes', 'हाँ', 'haan ji', 'ठीक है, कर दो', 'okay'])(
    '"%s" confirms the pending action',
    async (word) => {
      const h = await open({
        system: `You are SARA.\n${PENDING}`,
        answer: () => ({ status: 'confirmed', summary: 'Created 1 work order' }),
      });
      const msgs = await h.say(word);
      expect(callsOf(msgs)).toEqual([
        { id: expect.any(String), name: 'confirm_action', args: { actionId: 'act9' } },
      ]);
      // The answer follows the language of the "yes" itself.
      const done = /[ऀ-ॿ]/.test(word) ? 'हो गया' : 'Done';
      expect(transcript(msgs)).toBe(`${done}: Created 1 work order.`);
    },
  );

  it.each(['no', 'नहीं', 'nahi, rehne do', "don't"])('"%s" rejects the pending action', async (word) => {
    const h = await open({ system: `You are SARA.\n${PENDING}`, answer: () => ({ status: 'rejected' }) });
    const msgs = await h.say(word);
    expect(callsOf(msgs)).toEqual([
      { id: expect.any(String), name: 'reject_action', args: { actionId: 'act9' } },
    ]);
    expect(transcript(msgs)).toBe("Okay, I won't make that change.");
  });

  it.each(["yesterday's output", 'nobody', 'जीत'])(
    '"%s" is not an answer to the pending action',
    async (word) => {
      const h = await open({ system: `You are SARA.\n${PENDING}` });
      expect(callsOf(await h.say(word))).toEqual([]);
    },
  );

  it.each([
    'ok, how many machines are running?',
    'sure, but first show IMM 3',
    'No problem, show me IMM 2',
    "Stop. What's IMM 2 doing?",
  ])('"%s" starts like an answer but does not settle the pending action', async (words) => {
    const h = await open({ system: `You are SARA.\n${PENDING}`, answer: () => ({ status: 'confirmed' }) });
    const names = callsOf(await h.say(words)).map((c) => c.name);
    expect(names).not.toContain('confirm_action');
    expect(names).not.toContain('reject_action');
  });

  it('acknowledges App notes from a click and forgets the pending action', async () => {
    const h = await open({ system: `You are SARA.\n${PENDING}` });
    const note = await h.say(
      'App note: the user confirmed "Create 1 work order" on screen. Result: Created 1 work order. Tell them in one short sentence.',
    );
    expect(callsOf(note)).toEqual([]);
    expect(transcript(note)).toBe('Done: Created 1 work order.');
    expect(callsOf(await h.say('yes'))).toEqual([]);
    const rejected = await h.say(
      'App note: the user rejected "Create 1 work order"; nothing was saved. Acknowledge briefly.',
    );
    expect(transcript(rejected)).toBe("Okay, I've cancelled that. Nothing was saved.");
  });

  it('says the refusal when a confirmation is not accepted', async () => {
    const error = 'No such pending change, or the user has not answered yet. Ask them first.';
    const h = await open({ system: `You are SARA.\n${PENDING}`, answer: () => ({ error }) });
    expect(transcript(await h.say('yes'))).toBe(error);
  });

  it.each([
    [
      { status: 'gone', error: 'This action has expired; ask SARA again' },
      'That change expired before you answered, so nothing was saved. Ask me again if you still need it.',
    ],
    [
      { status: 'gone', error: 'This action was already confirmed' },
      'That change was already handled, so there is nothing left to confirm.',
    ],
    [
      { status: 'forbidden', error: 'You are not allowed to run this action' },
      "You're not allowed to make that change, so I didn't save it.",
    ],
    [
      { status: 'failed', error: 'create_record is not available to Kavita (role view)' },
      "I couldn't make that change: your role doesn't allow that. A manager or an admin can do it, or I can note the details for them.",
    ],
  ])('says a confirmation that did not go through in plain words (%o)', async (response, said) => {
    const h = await open({ system: `You are SARA.\n${PENDING}`, answer: () => response });
    expect(transcript(await h.say('yes'))).toBe(said);
  });

  it.each([
    ['yes', "There's nothing waiting for your answer right now. What would you like to do?"],
    ['हाँ', 'अभी कोई बदलाव आपके जवाब का इंतज़ार नहीं कर रहा। बताइए, क्या करना है?'],
  ])('a bare "%s" with nothing pending says so', async (word, said) => {
    const h = await open();
    const msgs = await h.say(word);
    expect(callsOf(msgs)).toEqual([]);
    expect(transcript(msgs)).toBe(said);
  });

  it('never reads the chat demo help or a "Here is…" line before the lookup', async () => {
    demoChat.enabled = true;
    const h = await open();
    expect(transcript(await h.say('hello'))).toBe("I'm SARA in mock mode: type or use Say something.");
    script(/create a work order/i, [
      {
        text: 'Here is the work order. Confirm to create it.',
        calls: [{ name: 'create_record', args: { module: 'workorders', items: [{ name: 'Leak' }] } }],
      },
      { text: 'Okay.' },
    ]);
    const viewer = await open({
      answer: () => ({ error: 'create_record is not available to Kavita (role view)' }),
    });
    expect(transcript(await viewer.say('Create a work order for Press 2'))).toBe('Okay.');
  });

  it('ignores audio input and client content', async () => {
    const h = await open();
    await tick(5);
    h.session.sendRealtimeInput({
      audio: { data: Buffer.alloc(1280).toString('base64'), mimeType: 'audio/pcm;rate=16000' },
    });
    h.session.sendRealtimeInput({ audioStreamEnd: true });
    h.session.sendClientContent({ turns: [{ role: 'user', parts: [{ text: 'hi' }] }], turnComplete: true });
    await tick(20);
    expect(h.messages.map(kind)).toEqual(['setup']);
  });

  it('interrupts a turn that is still speaking when new text arrives', async () => {
    const h = await open();
    await tick(5);
    h.session.sendRealtimeInput({ text: 'Hello' });
    await until(() => h.messages.some((m) => m.serverContent?.modelTurn));
    h.session.sendRealtimeInput({ text: 'Hi again' });
    await until(() => h.messages.some((m) => m.sessionResumptionUpdate));
    const kinds = h.messages.map(kind);
    const cut = kinds.indexOf('interrupted');
    expect(cut).toBeGreaterThan(0);
    expect(kinds[cut + 1]).toBe('turnComplete');
    expect(kinds.filter((k) => k === 'generationComplete')).toHaveLength(1);
    expect(kinds.filter((k) => k === 'resume')).toHaveLength(1);
  });

  it('interrupts a turn waiting for a tool response and ignores the late response', async () => {
    script(/open work orders/i, [{ calls: [{ name: 'work_orders_summary', args: {} }] }, { text: 'Seven.' }]);
    const h = await open({ answer: () => null });
    h.session.sendRealtimeInput({ text: 'open work orders' });
    await until(() => h.messages.some((m) => m.toolCall));
    h.session.sendRealtimeInput({ text: 'never mind' });
    const [call] = callsOf(h.messages);
    h.session.sendToolResponse({ functionResponses: [{ id: call.id, name: call.name, response: {} }] });
    await until(() => h.messages.some((m) => m.sessionResumptionUpdate));
    expect(h.messages.map(kind)).toContain('interrupted');
    expect(transcript(h.messages)).not.toContain('Seven');
  });
});

describe('voice flows', () => {
  const statusRows = [
    { _id: 'Running', count: 12 },
    { _id: 'Stopped', count: 5 },
    { _id: 'Idle', count: 3 },
  ];
  const answer = (c) =>
    ({
      mongo_aggregate: { ref: c.id, result: { count: 3, module: 'assets', rows: statusRows } },
      render_kpis: { ref: c.id, result: { rendered: 'kpis', items: 3 } },
      resolve: { ref: c.id, result: { matches: [{ id: 'a3', label: 'Asset · IMM 3' }] } },
      telemetry_latest: {
        ref: c.id,
        result: {
          count: 1,
          rows: [{ asset: 'IMM 3', status: 'Running', oilTempPv: 45.1, vibration: 4.234 }],
        },
      },
    })[c.name];

  it('machines running: mongo_aggregate on assets → KPI tiles → spoken count', async () => {
    const h = await open({ answer });
    const msgs = await h.say('How many machines are running right now?');
    const [agg, kpis] = callsOf(msgs);
    expect(agg.name).toBe('mongo_aggregate');
    expect(agg.args).toEqual({
      module: 'assets',
      pipeline: [{ $group: { _id: '$assetStatus', count: { $sum: 1 } } }, { $sort: { count: -1 } }],
    });
    expect(kpis.name).toBe('render_kpis');
    expect(kpis.args.items).toEqual([
      { label: 'Running', value: 12, tone: 'good' },
      { label: 'Stopped', value: 5, tone: 'bad' },
      { label: 'Idle', value: 3, tone: 'warning' },
    ]);
    expect(transcript(msgs)).toBe(
      "12 of your 20 machines are running right now; 5 are stopped and 3 are idle. I've put the numbers on your screen.",
    );
  });

  it('machines running in Hindi is answered in Hindi', async () => {
    const h = await open({ answer });
    const msgs = await h.say('अभी कितनी मशीनें चल रही हैं?');
    expect(callsOf(msgs)[0].name).toBe('mongo_aggregate');
    expect(transcript(msgs)).toBe(
      'अभी 20 में से 12 मशीनें चल रही हैं; 5 बंद हैं और 3 idle हैं। मैंने गिनती स्क्रीन पर दिखा दी है।',
    );
  });

  it('a Hindi machine question resolves the machine, reads it live and answers in Hindi', async () => {
    const h = await open({ answer });
    const msgs = await h.say('IMM 3 का vibration कैसा है?');
    expect(callsOf(msgs).map((c) => [c.name, c.args])).toEqual([
      ['resolve', { kind: 'asset', query: 'IMM 3' }],
      ['telemetry_latest', { assetIds: ['a3'] }],
    ]);
    expect(transcript(msgs)).toBe('IMM 3 का वाइब्रेशन अभी 4.2 है, और मशीन चल रही है।');
    expect(audioOf(msgs).length).toBeGreaterThan(0);
  });

  it('open work orders: summary by priority → KPI tiles → spoken count (a test script takes precedence)', async () => {
    const summary = {
      total: 14,
      rows: [
        { priority: 'High', count: 4, overdue: 1, highPriority: 4 },
        { priority: 'Medium', count: 10, overdue: 0, highPriority: 0 },
      ],
    };
    const h = await open({
      answer: (c) => ({
        ref: c.id,
        result: c.name === 'work_orders_summary' ? summary : { rendered: 'kpis' },
      }),
    });
    const msgs = await h.say('How many open work orders?');
    expect(callsOf(msgs).map((c) => [c.name, c.args.groupBy ?? c.args.items.length])).toEqual([
      ['work_orders_summary', 'priority'],
      ['render_kpis', 2],
    ]);
    expect(transcript(msgs)).toBe(
      "You have 14 open work orders: 4 high priority and 1 overdue. I've put the breakdown on your screen.",
    );
    script(/open work orders/i, [{ text: 'Scripted.' }]);
    expect(transcript(await h.say('How many open work orders?'))).toBe('Scripted.');
  });

  it('assets needing attention: list_anomalies → render_table by sourceRef → spoken names', async () => {
    const anomalies = [
      { code: 'AN-1', asset: 'IMM 3', severity: 'critical' },
      { code: 'AN-2', asset: 'Press 2', severity: 'warning' },
    ];
    const h = await open({
      answer: (c) => ({
        ref: c.id,
        result: c.name === 'list_anomalies' ? { count: 2, rows: anomalies } : { rendered: 'table', rows: 2 },
      }),
    });
    const msgs = await h.say('Which assets need attention?');
    const [listCall, table] = callsOf(msgs);
    expect(listCall).toMatchObject({ name: 'list_anomalies', args: { state: 'active' } });
    expect(table).toMatchObject({
      name: 'render_table',
      args: { title: 'Machines needing attention', sourceRef: listCall.id },
    });
    expect(transcript(msgs)).toBe(
      "2 machines need attention: IMM 3 and Press 2. I've put the list on your screen.",
    );
    const none = await open({ answer: (c) => ({ ref: c.id, result: { count: 0, rows: [] } }) });
    const quiet = await none.say('Is there any asset that needs attention right now?');
    expect(callsOf(quiet).map((c) => c.name)).toEqual(['list_anomalies']);
    expect(transcript(quiet)).toBe('No machine needs attention right now: there are no active anomalies.');
  });

  it('"show my machines" claims the list is on the screen without any render call (safety-net flow)', async () => {
    const h = await open({ answer: (c) => ({ ref: c.id, result: { count: 20, rows: [] } }) });
    const msgs = await h.say('Show my machines');
    expect(callsOf(msgs).map((c) => [c.name, c.args])).toEqual([
      ['mongo_find', { module: 'assets', limit: 20 }],
    ]);
    expect(transcript(msgs)).toBe("You have 20 machines. I've listed them on your screen.");
  });

  it('a failed lookup is said, not hidden, in plain words', async () => {
    const h = await open({
      answer: () => ({ error: 'mongo_aggregate is not available to Ravi (role viewer)' }),
    });
    expect(transcript(await h.say('How many machines are running?'))).toBe(
      "I couldn't finish that: your role doesn't allow that. A manager or an admin can do it, or I can note the details for them.",
    );
    const other = await open({ answer: () => ({ error: 'The machine list is empty.' }) });
    expect(transcript(await other.say('How many machines are running?'))).toBe(
      "I couldn't finish that: The machine list is empty.",
    );
  });

  it('plans production through the chat demo flow and asks before applying', async () => {
    demoChat.enabled = true;
    const plan = {
      code: 'PP-4',
      proposalId: 'prop1',
      feasible: true,
      jobCards: [
        { asset: 'IMM 5', target: 3000, tool: 'M-12', start: 'Mon 08:00', end: 'Wed 14:00' },
        { asset: 'IMM 3', target: 2000, tool: 'M-07', start: 'Mon 08:00', end: 'Tue 20:00' },
      ],
      projectedFinish: 'Wed 14:00',
      slackHours: 50,
      dueDate: 'Fri 24 Oct',
      risks: [],
      alternatives: [],
    };
    const responses = {
      plan_production: { result: plan },
      check_plan: { result: { verdict: 'doable', issues: [], adjustments: [], jobCards: plan.jobCards } },
      apply_plan: { status: 'awaiting_confirmation', actionId: 'act7', label: 'Create production plan PP-4' },
      confirm_action: { status: 'confirmed', summary: 'Applied PP-4: 1 plan and 2 job cards created' },
    };
    const h = await open({ answer: (c) => ({ ref: c.id, ...responses[c.name] }) });
    const msgs = await h.say('Plan 5000 Housing-A parts due next Friday');
    const calls = callsOf(msgs);
    expect(calls.map((c) => c.name)).toEqual(['plan_production', 'check_plan', 'apply_plan']);
    expect(calls[0].args).toEqual({ part: 'Housing-A', quantity: 5000, dueDate: 'next Friday' });
    const said = transcript(msgs);
    expect(said).toMatch(/^PP-4 makes the due date: 2 job cards/);
    expect(said).not.toMatch(/\*\*|Confirm below/);
    expect(said).toMatch(/Create production plan PP-4\. Shall I go ahead\?$/);
    const yes = await h.say('haan, kar do');
    expect(callsOf(yes)).toEqual([
      { id: expect.any(String), name: 'confirm_action', args: { actionId: 'act7' } },
    ]);
    expect(transcript(yes)).toBe('Ho gaya: Applied PP-4: 1 plan and 2 job cards created.');
  });
});

describe('toneFor and spoken', () => {
  const samples = (buf) => Array.from({ length: buf.length / 2 }, (_, i) => buf.readInt16LE(i * 2));

  it('makes 120 ms per word with 40 ms gaps, at least 0.3 s and at most 4 s', () => {
    expect(toneFor('one two three').length).toBe((3 * 2880 + 2 * 960) * 2);
    expect(toneFor('').length).toBe(7200 * 2);
    expect(toneFor('hi').length).toBe(7200 * 2);
    expect(toneFor('word '.repeat(200)).length).toBeLessThanOrEqual(4 * 24000 * 2);
    expect(toneFor('one two three', { rate: 16000 }).length).toBe((3 * 1920 + 2 * 640) * 2);
    expect(toneFor('IMM 3 का वाइब्रेशन').equals(toneFor('IMM 3 का वाइब्रेशन'))).toBe(true);
  });

  it('is soft, and fades in and out of every word', () => {
    const s = samples(toneFor('one two three'));
    expect(Math.max(...s.map(Math.abs))).toBeLessThanOrEqual(Math.ceil(0.06 * 32767));
    expect(Math.max(...s.map(Math.abs))).toBeGreaterThan(0.05 * 32767);
    for (const start of [0, 2880 + 960, 2 * (2880 + 960)]) {
      expect(Math.abs(s[start])).toBeLessThan(5);
      expect(Math.abs(s[start + 2879])).toBeLessThan(5);
      expect(s.slice(start + 2880, start + 2880 + 960).every((x) => x === 0) || start > 2880).toBe(true);
    }
    expect(Math.abs(s.at(-1))).toBeLessThan(5);
  });

  it('turns markdown into plain speech of at most 400 characters', () => {
    const md = [
      '## Plan',
      '**PP-3** makes the due date: 2 job cards, Mon 08:00 → Wed 14:00.',
      '',
      '- **IMM 5**: 3,000 pcs · M-12',
      '1. See [WO-4](/m/workorders/abc) _today_',
      '| a | b |',
      '|---|---|',
      '```json\n{"x":1}\n```',
    ].join('\n');
    expect(spoken(md)).toBe(
      'Plan. PP-3 makes the due date: 2 job cards, Mon 08:00 to Wed 14:00. IMM 5: 3,000 pcs, M-12. See WO-4 today.',
    );
    const long = spoken(`${'This sentence is about the plant. '.repeat(30)}`);
    expect(long.length).toBeLessThanOrEqual(400);
    expect(long).toMatch(/plant\.$/);
    expect(spoken('word'.repeat(150)).length).toBeLessThanOrEqual(400);
    expect(spoken('work_orders_summary')).toBe('work_orders_summary.');
  });
});

describe('decisive voice flows (the chat demo flows by voice)', () => {
  const answer = (c) => ({
    ref: c.id,
    ...{
      resolve: { result: { matches: [{ id: 'f2', label: 'FUR-02 · Furnace 2' }] } },
      available_people: { result: { rows: [{ id: 'u7', name: 'Ramesh Kumar' }] } },
      telemetry_latest: { result: { rows: [{ asset: 'Furnace 2', status: 'Stopped', currentTemp: 619 }] } },
      create_record: { status: 'awaiting_confirmation', actionId: 'act3', label: 'Create 1 work order' },
      assign_work_order: { status: 'awaiting_confirmation', actionId: 'act4', label: 'Assign WO-163' },
      confirm_action: { status: 'confirmed', summary: 'Created 1 work order' },
      open_page: { result: { url: '/m/workorders/x', label: 'WO-163 · Low injection pressure' } },
    }[c.name],
  });

  it('a Hinglish breakdown ask drafts the work order, says the decision in Hinglish and asks in Hinglish', async () => {
    demoChat.enabled = true;
    const h = await open({ answer });
    const msgs = await h.say('Furnace 2 ke liye breakdown work order banao');
    expect(callsOf(msgs).map((c) => c.name)).toEqual([
      'resolve',
      'available_people',
      'telemetry_latest',
      'create_record',
    ]);
    const said = transcript(msgs);
    expect(said).toMatch(
      /^Maine tay kiya: priority High \(breakdown\), category Breakdown, aaj tak, 120 min, Ramesh Kumar ko assign \(abhi free\)\./,
    );
    expect(said).not.toMatch(/confirm|Yeh raha|Decided|Here is/i);
    expect(said).toMatch(/Create 1 work order\. Aage badhun\?$/);
    const yes = await h.say('haan, kar do');
    expect(callsOf(yes)).toEqual([
      { id: expect.any(String), name: 'confirm_action', args: { actionId: 'act3' } },
    ]);
    expect(transcript(yes)).toBe('Ho gaya: Created 1 work order.');
  });

  it('a Hindi (Devanagari) breakdown ask is not read as a machine question and is answered in Hindi', async () => {
    demoChat.enabled = true;
    const h = await open({ answer });
    const msgs = await h.say('Furnace 2 के लिए breakdown work order बनाओ');
    expect(callsOf(msgs).map((c) => c.name)).toEqual([
      'resolve',
      'available_people',
      'telemetry_latest',
      'create_record',
    ]);
    expect(transcript(msgs)).toMatch(
      /^मैंने तय किया: priority High \(breakdown\).*Create 1 work order\. आगे बढ़ूँ\?$/,
    );
  });

  it('"assign whoever is free" and "open WO-163" run without a question', async () => {
    demoChat.enabled = true;
    const h = await open({ answer });
    const assign = await h.say('Assign whoever is free to WO-163');
    expect(callsOf(assign)).toEqual([
      { id: expect.any(String), name: 'assign_work_order', args: { workOrder: 'WO-163', people: 'auto' } },
    ]);
    expect(transcript(assign)).toBe(
      'Decided: whoever is free now takes WO-163. Assign WO-163. Shall I go ahead?',
    );
    const other = await open({ answer });
    const msgs = await other.say('Open WO-163');
    expect(callsOf(msgs)).toEqual([
      {
        id: expect.any(String),
        name: 'open_page',
        args: { page: 'record', module: 'workorders', recordId: 'WO-163' },
      },
    ]);
    expect(transcript(msgs)).toBe('Opened WO-163, Low injection pressure on your screen.');
  });
});
