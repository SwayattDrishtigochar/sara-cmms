import mongoose from 'mongoose';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { _resetBudget, canSpend, pacificDay, recordUsage, usageToday } from '../src/ai/budget.js';
import {
  _setClient,
  AiUnavailableError,
  generate,
  generateStream,
  isMock,
  parseRetryDelaySec,
} from '../src/ai/gemini.js';
import { mockGenerate, mockScripts, mockStream } from '../src/ai/mock.js';
import { listModels, thinkingConfigFor } from '../src/ai/models.js';
import { DEFAULT_AI, getAiSettings, invalidateAiSettings, saveAiSettings } from '../src/ai/settings.js';
import { connectMongo } from '../src/config/mongo.js';
import { AiUsage } from '../src/db/models/AiUsage.js';
import { PlatformSettings } from '../src/db/models/PlatformSettings.js';
import { ANOMALY_TYPES } from '../src/modules/defs/maintenance.js';

const FAST = 'gemini-3.6-flash';
const FALLBACK = 'gemini-3.8-flash';
const BALANCED = 'gemini-3.8-flash';
const BACKGROUND = 'gemini-3.5-flash-lite';

const usage = { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 };
const reply = (text) => ({
  text,
  usageMetadata: usage,
  candidates: [{ content: { role: 'model', parts: [{ text }] } }],
});
/** The error the SDK throws for a 429: the JSON body as the message plus `status`. */
const quota = (retryDelay) =>
  Object.assign(
    new Error(
      JSON.stringify({
        error: {
          code: 429,
          message: 'You exceeded your current quota',
          status: 'RESOURCE_EXHAUSTED',
          details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay }],
        },
      }),
    ),
    { status: 429 },
  );
/** A fake SDK client answering from a script of responses / errors and remembering the models it was asked. */
const fakeClient = (script) => {
  const calls = [];
  const next = (model) => {
    calls.push(model);
    const item = script.shift();
    if (item instanceof Error) throw item;
    return item;
  };
  return {
    calls,
    models: {
      generateContent: async ({ model }) => next(model),
      generateContentStream: async ({ model }) => {
        const chunks = next(model);
        return (async function* () {
          yield* chunks;
        })();
      },
    },
  };
};
const docs = async () =>
  (await AiUsage.find().sort({ createdAt: 1, _id: 1 }).lean()).map((r) => [r.model, r.status]);

const anomalySchema = z.toJSONSchema(
  z.object({
    assets: z.array(
      z.object({
        assetId: z.string(),
        healthScore: z.number().min(0).max(100),
        state: z.enum(['normal', 'watch', 'anomalous']),
        summary: z.string(),
        anomalies: z.array(
          z.object({
            type: z.enum(ANOMALY_TYPES),
            severity: z.enum(['info', 'warning', 'critical']),
            confidence: z.number().min(0).max(1),
            parameters: z.array(
              z.object({
                field: z.string(),
                observed: z.number(),
                expected: z.number(),
                deviation: z.string(),
              }),
            ),
            explanation: z.string(),
            likelyCauses: z.array(z.string()),
            recommendedActions: z.array(z.string()),
            urgencyHours: z.number(),
          }),
        ),
      }),
    ),
  }),
  { io: 'input', unrepresentable: 'any' },
);

const field = (name, z, extra = {}) => ({
  measurement: 'machineParams',
  field: name,
  unit: 'mm/s',
  last: 4.9,
  mean: 4.7,
  min: 4.2,
  max: 5.1,
  std: 0.2,
  slopePerHour: 0.3,
  n: 10,
  baseline: { mean: 2.2, std: 0.6, p5: 1.4, p95: 3.1, source: 'history' },
  z,
  band: z != null && Math.abs(z) > 2 ? 'above' : null,
  spikes: 0,
  flatline: false,
  flags: z != null && Math.abs(z) >= 3 ? ['z'] : [],
  ...extra,
});
const asset = (assetId, name, type, fields, extra = {}) => ({
  assetId,
  name,
  type,
  status: 'Running',
  transition: false,
  fields,
  rejectionRate: null,
  idlePowerRatio: null,
  flags: [...new Set(fields.flatMap((f) => f.flags))],
  ...extra,
});
const features = [
  asset('a1', 'Press 1', 'Power Press', [
    field('vibration', 4.5),
    field('motor_current', 3.2, { unit: 'A' }),
    field('oilTempPv', 0.4),
  ]),
  asset('a2', 'CNC 1', 'CNC Machine', [field('spindleTemp', 0.2, { flatline: true, flags: ['flatline'] })]),
  asset('a3', 'Chiller 1', 'Chiller', [field('POWER TOTAL', 1.1, { unit: 'kW', last: 9.4 })], {
    status: 'Idle',
    idlePowerRatio: 2.4,
    flags: ['idle_power'],
  }),
  asset('a4', 'IMM 2', 'Injection Moulding Machine', [field('injectionPressure', 6)], { transition: true }),
  asset('a5', 'IMM 3', 'Injection Moulding Machine', [field('cycleTime', 2.3)]),
];

beforeAll(async () => {
  await connectMongo();
  await mongoose.connection.dropDatabase();
  await saveAiSettings({
    tiers: {
      fast: { model: FAST, fallback: FALLBACK },
      balanced: { model: BALANCED, fallback: FAST },
      background: { model: BACKGROUND },
    },
  });
});
afterAll(async () => {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});
afterEach(async () => {
  _setClient(null);
  _resetBudget();
  mockScripts.length = 0;
  await AiUsage.deleteMany({});
  await saveAiSettings({ limits: {}, chatReservePct: DEFAULT_AI.chatReservePct });
});

describe('models', () => {
  it('clamps thinking levels to what the model supports', () => {
    expect(thinkingConfigFor('gemini-3.6-flash', 'minimal')).toEqual({
      thinkingLevel: 'MINIMAL',
      includeThoughts: false,
    });
    expect(thinkingConfigFor('gemini-4-argon', 'minimal')).toEqual({
      thinkingLevel: 'LOW',
      includeThoughts: false,
    });
    expect(thinkingConfigFor('gemini-3.8-flash', 'high', { includeThoughts: true })).toEqual({
      thinkingLevel: 'HIGH',
      includeThoughts: true,
    });
    expect(thinkingConfigFor('gemini-3.8-flash', 'MEDIUM')).toEqual({
      thinkingLevel: 'MEDIUM',
      includeThoughts: false,
    });
    expect(thinkingConfigFor('gemini-2.5-flash', 'high')).toEqual({ includeThoughts: false });
    expect(thinkingConfigFor('gemini-3.8-flash', null)).toEqual({ includeThoughts: false });
    expect(thinkingConfigFor('gemini-3.8-flash', 'ultra')).toEqual({ includeThoughts: false });
  });

  it('lists the known models without an API call in mock mode', async () => {
    expect(isMock()).toBe(true);
    const models = await listModels();
    expect(models.find((m) => m.id === FAST)).toMatchObject({
      free: true,
      thinking: ['minimal', 'low', 'medium', 'high'],
      displayName: FAST,
    });
    expect(models.find((m) => m.id === 'gemini-4-argon')).toMatchObject({
      free: false,
      thinking: ['low', 'medium', 'high'],
    });
    expect(models.map((m) => m.id)).toContain(BACKGROUND);
  });

  it('reads the retry delay of a 429 body', () => {
    expect(parseRetryDelaySec(quota('12s'))).toBe(12);
    expect(parseRetryDelaySec(quota('0.8s'))).toBe(0.8);
    expect(parseRetryDelaySec(new Error('boom'))).toBeNull();
    expect(parseRetryDelaySec(undefined)).toBeNull();
  });
});

describe('settings', () => {
  it('creates the document from env, merges patches and validates them', async () => {
    const settings = await getAiSettings();
    expect(settings.tiers.fast).toEqual({ model: FAST, thinkingLevel: 'low', fallback: FALLBACK });
    expect(settings.anomaly).toEqual(DEFAULT_AI.anomaly);
    expect(await PlatformSettings.countDocuments({ _id: 'platform' })).toBe(1);

    const saved = await saveAiSettings({
      tiers: { fast: { thinkingLevel: 'high' } },
      limits: { [FAST]: { rpm: 5, rpd: 100 } },
      anomaly: { tickSec: 120 },
    });
    expect(saved.tiers.fast).toEqual({ model: FAST, thinkingLevel: 'high', fallback: FALLBACK });
    expect(saved.anomaly).toEqual({ ...DEFAULT_AI.anomaly, tickSec: 120 });
    expect(saved.limits).toEqual({ [FAST]: { rpm: 5, rpd: 100 } });
    invalidateAiSettings();
    expect((await getAiSettings()).tiers.fast.thinkingLevel).toBe('high');

    // limits are replaced as a whole, so a model's limits can be removed
    expect((await saveAiSettings({ limits: {} })).limits).toEqual({});
    const bad = [
      { tiers: { fast: { model: 'Bad Model!' } } },
      { tiers: { fast: { thinkingLevel: 'ultra' } } },
      { tiers: { turbo: { model: 'x' } } },
      { nope: 1 },
      { chatReservePct: 95 },
      { limits: { [FAST]: { rpm: 0, rpd: 10 } } },
      { anomaly: { tickSec: 5 } },
      'text',
    ];
    for (const patch of bad) await expect(saveAiSettings(patch)).rejects.toMatchObject({ status: 400 });
    await saveAiSettings({
      tiers: { fast: { thinkingLevel: 'low' } },
      anomaly: { tickSec: DEFAULT_AI.anomaly.tickSec },
    });
  });
});

describe('budget', () => {
  it('keeps the chat reserve for background purposes and refuses once the day is spent', async () => {
    await saveAiSettings({ limits: { [FAST]: { rpm: 100, rpd: 10 } }, chatReservePct: 40 });
    for (let i = 0; i < 6; i++) await recordUsage({ model: FAST, purpose: 'chat', status: 'ok', usage });
    await recordUsage({ model: FAST, purpose: 'chat', status: 'rate_limited' }); // refused requests do not count
    expect(await canSpend(FAST, 'anomaly')).toMatchObject({
      ok: false,
      reason: expect.stringContaining('chat'),
    });
    expect(await canSpend(FAST, 'chat')).toEqual({ ok: true });
    for (let i = 0; i < 4; i++) await recordUsage({ model: FAST, purpose: 'chat', status: 'ok', usage });
    expect(await canSpend(FAST, 'chat')).toMatchObject({
      ok: false,
      reason: expect.stringContaining('daily'),
    });
    expect(await canSpend(FALLBACK, 'chat')).toEqual({ ok: true }); // another model, its own quota

    const today = await usageToday();
    expect(today.find((m) => m.model === FAST)).toMatchObject({
      calls: 10,
      tokens: 150,
      rateLimited: 1,
      errors: 0,
      limits: { rpm: 100, rpd: 10 },
      free: true,
    });
    expect(today.find((m) => m.model === BACKGROUND)).toMatchObject({
      calls: 0,
      limits: { rpm: 10, rpd: 250 },
    });
  });

  it('counts requests in flight against the daily cap', async () => {
    await saveAiSettings({ limits: { [FAST]: { rpm: 100, rpd: 4 } }, chatReservePct: 50 });
    // Two background calls pass before either is recorded; the third must not eat the chat reserve.
    expect((await canSpend(FAST, 'anomaly')).ok).toBe(true);
    expect((await canSpend(FAST, 'kpi')).ok).toBe(true);
    expect((await canSpend(FAST, 'briefing')).ok).toBe(false);
    // A refused (429) request gives its slot back; an answered one keeps it.
    await recordUsage({ model: FAST, purpose: 'anomaly', status: 'rate_limited' });
    expect((await canSpend(FAST, 'briefing')).ok).toBe(true);
    await recordUsage({ model: FAST, purpose: 'kpi', status: 'ok', usage });
    await recordUsage({ model: FAST, purpose: 'briefing', status: 'ok', usage });
    expect((await canSpend(FAST, 'anomaly')).ok).toBe(false);
    expect((await canSpend(FAST, 'chat')).ok).toBe(true);
  });

  it('limits requests per minute per model', async () => {
    await saveAiSettings({ limits: { [FAST]: { rpm: 2, rpd: 100 } } });
    expect((await canSpend(FAST, 'chat')).ok).toBe(true);
    expect((await canSpend(FAST, 'chat')).ok).toBe(true);
    expect(await canSpend(FAST, 'chat')).toMatchObject({
      ok: false,
      reason: expect.stringContaining('minute'),
    });
    expect((await canSpend(FALLBACK, 'chat')).ok).toBe(true);
  });

  it('resets the daily count at midnight Pacific', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-10-15T06:50:00Z')); // 23:50 on 14 Oct in Los Angeles
      await saveAiSettings({ limits: { [FAST]: { rpm: 100, rpd: 2 } } });
      expect(pacificDay()).toBe('2026-10-14');
      await recordUsage({ model: FAST, purpose: 'chat', status: 'ok', usage });
      await recordUsage({ model: FAST, purpose: 'chat', status: 'error', error: 'boom' });
      expect((await canSpend(FAST, 'chat')).ok).toBe(false);

      vi.setSystemTime(new Date('2026-10-15T07:10:00Z')); // 00:10 on 15 Oct
      expect(pacificDay()).toBe('2026-10-15');
      expect((await canSpend(FAST, 'chat')).ok).toBe(true);
      expect((await usageToday()).find((m) => m.model === FAST).calls).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('mock model', () => {
  it('derives anomaly decisions from the feature table', () => {
    const { json, text } = mockGenerate({ purpose: 'anomaly', mockInput: features, schema: anomalySchema });
    const byId = Object.fromEntries(json.assets.map((a) => [a.assetId, a]));
    expect(byId.a1.state).toBe('anomalous');
    expect(byId.a1.anomalies.map((a) => [a.type, a.severity, a.parameters.map((p) => p.field)])).toEqual([
      ['vibration_high', 'warning', ['vibration']],
      ['current_high', 'warning', ['motor_current']],
    ]);
    expect(byId.a1.anomalies[0]).toMatchObject({
      parameters: [{ field: 'vibration', observed: 4.7, expected: 2.2, deviation: '+4.5σ' }],
      likelyCauses: expect.arrayContaining(['Bearing wear']),
      urgencyHours: 24,
    });
    // z is computed from the window mean (4.7), so the text quotes it, not the last reading (4.9).
    expect(byId.a1.anomalies[0].explanation).toMatch(
      /^vibration on Press 1 averages 4\.7 mm\/s over the last 10 min, \+4\.5σ/,
    );
    expect(byId.a1.healthScore).toBeLessThan(60);
    expect(byId.a2.anomalies.map((a) => a.type)).toEqual(['sensor_flatline']);
    expect(byId.a3.anomalies.map((a) => a.type)).toEqual(['idle_power_high']);
    expect(byId.a4).toMatchObject({ state: 'normal', anomalies: [] }); // just switched on: z is not reliable
    expect(byId.a5).toMatchObject({ state: 'watch', anomalies: [] });
    expect(byId.a5.healthScore).toBeGreaterThanOrEqual(70);
    expect(JSON.parse(text)).toEqual(json);
    expect(mockGenerate({ purpose: 'anomaly', mockInput: features, schema: anomalySchema }).text).toBe(text);
  });

  it('reads cool-down after a break as settling, and one 2σ field as noise', () => {
    const judge = (a) =>
      mockGenerate({ purpose: 'anomaly', mockInput: [a], schema: anomalySchema }).json.assets[0];
    const minutesAgo = (m) => new Date(Date.now() - m * 60_000).toISOString();
    const oil = (z, slopePerHour) =>
      field('oilTempPv', z, { unit: '°C', label: 'Oil temperature', slopePerHour });
    // 33 min after the machine went Idle, still 1.3 °C warm but falling: cooling down, not a fault.
    const cooling = asset('t1', 'IMM 4', 'Injection Moulding Machine', [oil(10, -4)], {
      status: 'Idle',
      statusSince: minutesAgo(33),
    });
    expect(judge(cooling)).toMatchObject({ state: 'normal', anomalies: [] });
    // Hot and still rising after the same change: a real overheat, named by its label.
    const heating = judge({ ...cooling, fields: [oil(10, 4)] });
    expect(heating.anomalies.map((a) => [a.type, a.severity])).toEqual([['temperature_high', 'critical']]);
    expect(heating.anomalies[0].explanation).toMatch(/^Oil temperature on IMM 4 averages/);
    expect(heating.summary).toBe('Temperature high (Oil temperature)');
    // Long after the change a warm, falling temperature counts again.
    expect(judge({ ...cooling, statusSince: minutesAgo(90) }).state).toBe('anomalous');

    const quiet = (z) => field('spindleSpeed', z, { band: null });
    expect(judge(asset('n1', 'CNC 4', 'CNC Machine', [quiet(2.2)])).state).toBe('normal');
    expect(judge(asset('n2', 'CNC 4', 'CNC Machine', [quiet(2.6), quiet(-2.7)])).state).toBe('watch');
  });

  it('reports an energy leak once and a phase imbalance as current imbalance', () => {
    const judge = (a) =>
      mockGenerate({ purpose: 'anomaly', mockInput: [a], schema: anomalySchema }).json.assets[0];
    const energy = (name, z, extra = {}) =>
      field(name, z, { measurement: 'energy', unit: 'kW', band: null, slopePerHour: 0, ...extra });
    const leak = asset(
      'e1',
      'CNC 2',
      'CNC Machine',
      [
        energy('POWER TOTAL', 99, { last: 6.2 }),
        energy('POWER PH-1', 99),
        energy('CURRENT AVERAGE', 60, { unit: 'A' }),
        energy('CURRENT PH-2', 40, { unit: 'A' }),
      ],
      { status: 'Idle', idlePowerRatio: 4.1, flags: ['z', 'idle_power'] },
    );
    const leaked = judge(leak);
    expect(leaked.anomalies.map((a) => a.type)).toEqual(['idle_power_high']);
    expect(leaked.anomalies[0].parameters.map((p) => p.field)).toEqual([
      'POWER TOTAL',
      'POWER PH-1',
      'CURRENT AVERAGE',
    ]);

    const imbalance = asset('e2', 'IMM 1', 'Injection Moulding Machine', [
      energy('CURRENT PH-2', 6, { unit: 'A' }),
      energy('CURRENT PH-3', -6, { unit: 'A' }),
      energy('POWER FACTOR TOTAL', -4, { unit: '' }),
    ]);
    const judged = judge(imbalance);
    expect(judged.anomalies.map((a) => [a.type, a.parameters.length])).toEqual([['current_imbalance', 3]]);
    // A current below its baseline is no "current high".
    const low = judge(
      asset('e3', 'Press 2', 'Power Press', [field('motor_current', -4), field('vibration', 4)]),
    );
    expect(low.anomalies.map((a) => a.type)).not.toContain('current_high');
  });

  it('names the parameter by its label in the investigation', () => {
    const { text } = mockGenerate({
      purpose: 'investigation',
      mockInput: {
        anomaly: {
          type: 'temperature_high',
          severity: 'critical',
          parameters: [
            { field: 'oilTempPv', label: 'Oil temperature', observed: 44.2, expected: 42, deviation: '+16σ' },
          ],
        },
        asset: { name: 'IMM 4' },
      },
    });
    expect(JSON.parse(text).summary).toBe(
      'Temperature high on IMM 4: Oil temperature at 44.2 against an expected 42 (+16σ).',
    );
  });

  it('shapes its output to the response schema', () => {
    const schema = z.toJSONSchema(
      z.object({
        intent: z.enum(['lookup', 'write']),
        complexity: z.enum(['low', 'medium', 'high']),
        groups: z.array(z.string()).max(1),
        extra: z.object({ note: z.string(), n: z.number().int().min(5) }),
        flag: z.boolean().nullable(),
      }),
      { io: 'input', unrepresentable: 'any' },
    );
    const { json, text } = mockGenerate({
      purpose: 'router',
      mockInput: { text: 'why is press 1 vibrating?' },
      schema,
    });
    expect(json).toEqual({
      intent: 'lookup',
      complexity: 'high',
      groups: ['telemetry'],
      extra: { note: expect.any(String), n: 5 },
      flag: false,
    });
    expect(JSON.parse(text)).toEqual(json);
    expect(mockGenerate({ purpose: 'router', contents: 'how many open work orders?' }).text).toContain(
      '"analytics"',
    );
    expect(
      mockGenerate({ purpose: 'title', contents: 'show me the overdue work orders in Pune please' }).text,
    ).toBe('{"title":"Show me the overdue work orders"}');
  });
});

describe('generate', () => {
  it('answers from the mock with a parsed schema and logs the call', async () => {
    const res = await generate({
      tier: 'background',
      purpose: 'anomaly',
      contents: 'judge these',
      schema: anomalySchema,
      mockInput: features,
    });
    expect(res).toMatchObject({ mock: true, model: BACKGROUND, tier: 'background' });
    expect(res.json.assets[0].state).toBe('anomalous');
    expect(res.usage.total).toBeGreaterThan(0);
    expect(await docs()).toEqual([[BACKGROUND, 'mock']]);
    expect((await generate({ tier: 'fast', purpose: 'test', contents: 'hi' })).text).toContain('mock');
  });

  it('waits and retries once on a short 429, then succeeds on the same model', async () => {
    const client = fakeClient([quota('0s'), reply('{"ok":true}')]);
    _setClient(client);
    expect(isMock()).toBe(false);
    const attempts = [];
    const res = await generate({
      tier: 'fast',
      purpose: 'chat',
      contents: 'hi',
      schema: { type: 'object' },
      onAttempt: (a) => attempts.push(a),
    });
    expect(res).toMatchObject({
      model: FAST,
      json: { ok: true },
      mock: false,
      usage: { prompt: 10, candidates: 5, total: 15 },
    });
    expect(client.calls).toEqual([FAST, FAST]);
    expect(attempts.map((a) => [a.model, a.fallbackFrom, a.thinkingLevel])).toEqual([
      [FAST, null, 'low'],
      [FAST, null, 'low'],
    ]);
    expect(await docs()).toEqual([
      [FAST, 'rate_limited'],
      [FAST, 'ok'],
    ]);
  });

  it('switches to the fallback model on a long 429', async () => {
    const client = fakeClient([quota('30s'), reply('fine')]);
    _setClient(client);
    const attempts = [];
    const res = await generate({
      tier: 'fast',
      purpose: 'chat',
      contents: 'hi',
      onAttempt: (a) => attempts.push(a),
    });
    expect(res).toMatchObject({ model: FALLBACK, text: 'fine', json: undefined });
    expect(client.calls).toEqual([FAST, FALLBACK]);
    expect(attempts.at(-1)).toMatchObject({ model: FALLBACK, fallbackFrom: FAST });
    expect(await docs()).toEqual([
      [FAST, 'rate_limited'],
      [FALLBACK, 'ok'],
    ]);
  });

  it('never moves background work into the chat models', async () => {
    const client = fakeClient([quota('30s')]);
    _setClient(client);
    const err = await generate({ tier: 'background', purpose: 'anomaly', contents: 'x' }).catch((e) => e);
    expect(err).toBeInstanceOf(AiUnavailableError);
    expect(err).toMatchObject({ code: 'AI_QUOTA', status: 429 });
    expect(client.calls).toEqual([BACKGROUND]);
    expect(await docs()).toEqual([[BACKGROUND, 'rate_limited']]);
  });

  it('falls back when the budget refuses the primary model, and fails cleanly on API errors', async () => {
    await saveAiSettings({ limits: { [FAST]: { rpm: 100, rpd: 1 } } });
    await recordUsage({ model: FAST, purpose: 'chat', status: 'ok', usage });
    const client = fakeClient([
      reply('from fallback'),
      Object.assign(new Error('{"error":{"code":500,"message":"Internal error"}}'), { status: 500 }),
      reply('not json'),
    ]);
    _setClient(client);
    expect((await generate({ tier: 'fast', purpose: 'chat', contents: 'hi' })).model).toBe(FALLBACK);
    expect(client.calls).toEqual([FALLBACK]);
    await expect(generate({ tier: 'balanced', purpose: 'chat', contents: 'hi' })).rejects.toMatchObject({
      code: 'AI_ERROR',
      status: 502,
      message: 'The AI service failed: Internal error',
    });
    await expect(
      generate({ tier: 'balanced', purpose: 'kpi', contents: 'hi', schema: { type: 'object' } }),
    ).rejects.toMatchObject({ code: 'AI_ERROR' });
    expect(await docs()).toEqual([
      [FAST, 'ok'],
      [FAST, 'blocked'],
      [FALLBACK, 'ok'],
      [BALANCED, 'error'],
      [BALANCED, 'error'],
    ]);
  });
});

describe('generateStream', () => {
  const chunk = (text, extra = {}) => ({
    text,
    candidates: [{ content: { role: 'model', parts: [{ text }] } }],
    ...extra,
  });

  it('yields the SDK chunks, records the final usage and falls back like generate', async () => {
    const final = {
      promptTokenCount: 7,
      candidatesTokenCount: 2,
      thoughtsTokenCount: 3,
      totalTokenCount: 12,
    };
    const client = fakeClient([quota('30s'), [chunk('Hel'), chunk('lo', { usageMetadata: final })]]);
    _setClient(client);
    const attempts = [];
    const out = [];
    const stream = generateStream({
      tier: 'fast',
      purpose: 'chat',
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
      tools: [],
      onAttempt: (a) => attempts.push(a),
    });
    for await (const c of stream) out.push(c.text);
    expect(out).toEqual(['Hel', 'lo']);
    expect(client.calls).toEqual([FAST, FALLBACK]);
    expect(attempts.map((a) => a.model)).toEqual([FAST, FALLBACK]);
    const rows = await AiUsage.find().sort({ _id: 1 }).lean();
    expect(rows.map((r) => [r.model, r.status])).toEqual([
      [FAST, 'rate_limited'],
      [FALLBACK, 'ok'],
    ]);
    expect(rows[1].tokens).toEqual({ prompt: 7, thoughts: 3, candidates: 2, total: 12 });
  });

  it('streams a scripted mock turn: thought and function call, then text after the tool result', async () => {
    mockScripts.push({
      match: /open work orders/i,
      steps: [
        {
          thought: 'Need the summary tool.',
          calls: [{ name: 'work_orders_summary', args: { status: 'open' } }],
        },
        ({ responses }) => ({ text: `There are ${responses[0].response.count} open work orders.` }),
      ],
    });
    const user = { role: 'user', parts: [{ text: 'How many open work orders?' }] };
    const first = [];
    for await (const c of generateStream({ tier: 'fast', purpose: 'chat', contents: [user] })) first.push(c);
    const parts = first.flatMap((c) => c.candidates[0].content.parts);
    expect(parts).toEqual([
      { text: 'Need the summary tool.', thought: true },
      {
        functionCall: { name: 'work_orders_summary', args: { status: 'open' } },
        thoughtSignature: 'mock-signature',
      },
    ]);
    expect(first.at(-1)).toMatchObject({
      candidates: [{ finishReason: 'STOP' }],
      usageMetadata: { totalTokenCount: expect.any(Number) },
    });
    expect(first[1].functionCalls).toEqual([{ name: 'work_orders_summary', args: { status: 'open' } }]);
    expect(first[0].text).toBeUndefined(); // thoughts are not answer text

    const contents = [
      user,
      { role: 'model', parts },
      {
        role: 'user',
        parts: [{ functionResponse: { name: 'work_orders_summary', response: { count: 23 } } }],
      },
    ];
    const second = [];
    for await (const c of generateStream({ tier: 'fast', purpose: 'chat', contents }))
      second.push(c.text ?? '');
    expect(second.length).toBeGreaterThan(1);
    expect(second.join('')).toBe('There are 23 open work orders.');
    expect(await docs()).toEqual([
      [FAST, 'mock'],
      [FAST, 'mock'],
    ]);
  });

  it('calls a fitting tool by default when one is offered, otherwise answers in text', async () => {
    const declaration = {
      name: 'work_orders_summary',
      description: '',
      parametersJsonSchema: { type: 'object' },
    };
    const chunks = [];
    for await (const c of mockStream({
      contents: 'show me the work orders',
      tools: [{ functionDeclarations: [declaration] }],
    })) {
      chunks.push(c);
    }
    expect(chunks.flatMap((c) => c.functionCalls ?? [])).toEqual([{ name: 'work_orders_summary', args: {} }]);
    const plain = [];
    for await (const c of mockStream({ contents: 'hello there' })) plain.push(c.text ?? '');
    expect(plain.join('')).toContain('mock mode');
  });
});
