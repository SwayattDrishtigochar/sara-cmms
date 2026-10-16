import { DateTime } from 'luxon';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { toDeclaration, toJsonSchema } from '../src/agent/declarations.js';
import { assistantContents, relaxSignatures } from '../src/agent/history.js';
import { friendlyAiError, setLlm } from '../src/agent/llm.js';
import { heuristicRoute, route, tierFor } from '../src/agent/router.js';
import { allGroups, allTools, groupsFor, toolsFor } from '../src/agent/tools/registry.js';
import { resolveTimeRange } from '../src/agent/tools/resolve.js';
import { fieldLabel } from '../src/agent/tools/telemetry.js';
import { shownFields } from '../src/agent/tools/write.js';

const ctx = {
  companyId: 'c1',
  role: 'admin',
  modules: ['workorders', 'assets', 'users', 'anomalies', 'jobcards', 'downtimes'],
  company: { features: { productionEnabled: true } },
};

const walk = (node, visit) => {
  if (!node || typeof node !== 'object') return;
  visit(node);
  for (const v of Object.values(node)) walk(v, visit);
};

describe('declarations', () => {
  it('cleans zod JSON Schema for Gemini', () => {
    const schema = toJsonSchema(
      z.object({
        n: z.int().default(3),
        kind: z.literal('asset'),
        free: z.record(z.string(), z.any()),
        list: z.array(z.object({ a: z.string() })).optional(),
      }),
    );
    expect(schema.$schema).toBeUndefined();
    expect(schema.properties.n).toEqual({ type: 'integer' }); // default + ±2^53 bounds gone
    expect(schema.properties.kind).toEqual({ type: 'string', enum: ['asset'] });
    expect(schema.properties.free).toEqual({ type: 'object' });
    expect(schema.properties.list.items.properties.a).toEqual({ type: 'string' });
  });

  it('needs an object at the top level', () => {
    expect(() => toDeclaration({ name: 'x', description: 'x', schema: z.string() })).toThrow(/object/);
  });

  it('every tool declares cleanly', () => {
    for (const tool of allTools()) {
      const decl = toDeclaration(tool);
      expect(decl.parametersJsonSchema.type, tool.name).toBe('object');
      expect(decl.description.length, tool.name).toBeGreaterThan(20);
      walk(decl.parametersJsonSchema, (node) => {
        for (const bad of ['$schema', 'propertyNames', 'default', 'const'])
          expect(node[bad], `${tool.name} ${bad}`).toBeUndefined();
        if (node.type === 'object' && !node.properties)
          expect(node.additionalProperties, tool.name).toBeUndefined();
      });
    }
  });
});

describe('tool registry', () => {
  it('sends core plus the asked groups, filtered by features and permission', () => {
    const core = toolsFor(ctx).map((t) => t.name);
    expect(core).toEqual(
      expect.arrayContaining(['resolve', 'mongo_find', 'render_table', 'load_tools', 'export_csv']),
    );
    expect(core).not.toContain('create_record');
    expect(toolsFor(ctx, ['write']).map((t) => t.name)).toContain('create_record');
    expect(toolsFor({ ...ctx, role: 'view' }, ['write']).some((t) => t.group === 'write')).toBe(false);
    const noProduction = { ...ctx, company: { features: { productionEnabled: false } } };
    expect(toolsFor(noProduction, ['production']).some((t) => t.group === 'production')).toBe(false);
    expect(groupsFor(noProduction)).not.toContain('production');
    expect(allGroups[0]).toBe('core');
  });
});

describe('router', () => {
  afterEach(() => setLlm(null));

  it('maps intents and complexity to tiers', () => {
    expect(tierFor({ intent: 'smalltalk', complexity: 'low' })).toBe('fast');
    expect(tierFor({ intent: 'lookup', complexity: 'low' })).toBe('fast');
    expect(tierFor({ intent: 'lookup', complexity: 'medium' })).toBe('balanced');
    expect(tierFor({ intent: 'analytics', complexity: 'low' })).toBe('balanced');
    expect(tierFor({ intent: 'timeseries', complexity: 'medium' })).toBe('balanced');
    for (const intent of ['diagnosis', 'report', 'write', 'planning'])
      expect(tierFor({ intent, complexity: 'low' })).toBe('deep');
    expect(tierFor({ intent: 'lookup', complexity: 'high' })).toBe('deep');
  });

  it('uses the model decision and the tier map', async () => {
    setLlm({
      generate: async () => ({
        json: {
          intent: 'timeseries',
          complexity: 'medium',
          needsInflux: true,
          isFollowUp: false,
          suggestedTier: 'deep',
          groups: ['telemetry', 'production'],
          confident: true,
        },
      }),
    });
    const d = await route({
      ctx,
      conversation: { tierPreference: 'auto' },
      text: 'plot oil temperature of Press 1',
    });
    expect(d).toMatchObject({
      intent: 'timeseries',
      tier: 'balanced',
      pinned: false,
      heuristic: false,
      confident: true,
    });
    expect(d.groups).toEqual(['telemetry', 'production']);
  });

  it('lets a pinned tier win', async () => {
    setLlm({ generate: async () => ({ json: { intent: 'smalltalk' } }) });
    const d = await route({ ctx, conversation: { tierPreference: 'deep' }, text: 'hi' });
    expect(d).toMatchObject({ tier: 'deep', pinned: true });
  });

  it('falls back to keyword heuristics when the model fails or answers badly', async () => {
    setLlm({
      generate: async () => {
        throw new Error('quota');
      },
    });
    const d = await route({
      ctx,
      conversation: {},
      text: 'Create a work order for Chiller 1, high priority',
    });
    expect(d).toMatchObject({ intent: 'write', heuristic: true, confident: false, tier: 'deep' });
    expect(d.groups).toEqual(expect.arrayContaining(['write', 'maintenance']));
    setLlm({ generate: async () => ({ json: { intent: 'nonsense' } }) });
    expect((await route({ ctx, conversation: {}, text: 'hello there' })).intent).toBe('smalltalk');
  });

  it('heuristics classify the §13 questions sensibly', () => {
    expect(heuristicRoute('How many open work orders do we have, grouped by priority?').groups).toContain(
      'maintenance',
    );
    expect(heuristicRoute('Plot the oil temperature of Press 1 for the last 2 hours.')).toMatchObject({
      intent: 'timeseries',
      needsInflux: true,
    });
    expect(heuristicRoute('Why was Machine 3 stopped yesterday between 2 and 4 pm?').intent).toBe(
      'diagnosis',
    );
    expect(heuristicRoute('and last week?').isFollowUp).toBe(true);
    expect(heuristicRoute('thanks!').suggestedTier).toBe('fast');
  });
});

describe('history contents', () => {
  const call = (name, extra = {}) => ({ functionCall: { name, args: {} }, ...extra });
  const answer = (name, ref, result) => ({ functionResponse: { name, response: { ref, result } } });

  it('drops thought text, keeps signatures and answers unanswered calls with not_confirmed', () => {
    const message = {
      text: 'Done',
      parts: [],
      gemini: [
        {
          role: 'model',
          parts: [
            { text: 'thinking…', thought: true, thoughtSignature: 'sig1' },
            { text: 'private', thought: true },
            call('create_record', { thoughtSignature: 'sig2' }),
            call('resolve'),
          ],
        },
        { role: 'user', parts: [answer('resolve', 't1', { matches: [] })] },
      ],
    };
    const out = assistantContents(message);
    expect(out[0].parts[0]).toEqual({ thoughtSignature: 'sig1', text: '' });
    expect(out[0].parts).toHaveLength(3);
    expect(out[1].parts.map((p) => p.functionResponse.name)).toEqual(['create_record', 'resolve']);
    expect(out[1].parts[0].functionResponse.response).toEqual({ status: 'not_confirmed' });
    expect(out.at(-1)).toEqual({ role: 'model', parts: [{ text: 'Done' }] }); // closed with the final text
    expect(assistantContents(message, { open: true }).at(-1).role).toBe('user');
  });

  it('shrinks old function responses to summary and rowCount', () => {
    const message = {
      text: '23 open',
      parts: [{ type: 'tool_result', id: 't1', summary: '23 work orders', rowCount: 23 }],
      gemini: [
        { role: 'model', parts: [call('mongo_find')] },
        { role: 'user', parts: [answer('mongo_find', 't1', { rows: new Array(23).fill({ a: 1 }) })] },
        { role: 'model', parts: [{ text: '23 open' }] },
      ],
    };
    const old = assistantContents(message, { full: false });
    expect(old[1].parts[0].functionResponse.response).toEqual({
      ref: 't1',
      summary: '23 work orders',
      rowCount: 23,
    });
    expect(assistantContents(message)[1].parts[0].functionResponse.response.result.rows).toHaveLength(23);
  });

  it('relaxes signatures for another model', () => {
    const contents = relaxSignatures([{ role: 'model', parts: [{ text: '', thoughtSignature: 'abc' }] }]);
    expect(contents[0].parts[0].thoughtSignature).toBe('skip_thought_signature_validator');
  });
});

describe('resolve_time_range', () => {
  const plant = {
    _id: 'p1',
    name: 'Pune',
    shifts: [
      { shiftName: 'A', shiftStartTime: '06:00', shiftEndTime: '14:00' },
      { shiftName: 'B', shiftStartTime: '14:00', shiftEndTime: '22:00' },
      { shiftName: 'C', shiftStartTime: '22:00', shiftEndTime: '06:00' },
    ],
  };
  const tctx = {
    company: { timeZone: 'Asia/Kolkata', dateFormat: 'DD-MM-YYYY' },
    plants: [plant],
    plantId: 'p1',
  };
  const now = DateTime.fromISO('2026-10-15T06:30:00Z'); // Thursday 12:00 IST
  const r = (text) => resolveTimeRange({ text }, tctx, now);

  it.each([
    ['today', '2026-10-14T18:30:00.000Z', '2026-10-15T18:30:00.000Z'],
    ['yesterday', '2026-10-13T18:30:00.000Z', '2026-10-14T18:30:00.000Z'],
    ['last 2 hours', '2026-10-15T04:30:00.000Z', '2026-10-15T06:30:00.000Z'],
    ['Q3 2026', '2026-06-30T18:30:00.000Z', '2026-09-30T18:30:00.000Z'],
    ['shift A yesterday', '2026-10-14T00:30:00.000Z', '2026-10-14T08:30:00.000Z'],
    ['shift C yesterday', '2026-10-14T16:30:00.000Z', '2026-10-15T00:30:00.000Z'],
    ['yesterday between 2 and 4 pm', '2026-10-14T08:30:00.000Z', '2026-10-14T10:30:00.000Z'],
    ['12-10-2026', '2026-10-11T18:30:00.000Z', '2026-10-12T18:30:00.000Z'],
  ])('%s', (text, start, stop) => {
    expect(r(text)).toMatchObject({ start, stop, timeZone: 'Asia/Kolkata' });
  });

  it('labels ranges and rejects nonsense', () => {
    expect(r('last month').label).toBe('Last month (01-09-2026 – 30-09-2026)');
    expect(r('current shift').shift ?? r('current shift').label).toMatch(/A/);
    expect(() => r('whenever it suits')).toThrow(/could not understand/);
  });
});

describe('user-facing words', () => {
  it('turns raw Gemini failures into plain sentences', () => {
    const raw = (body) => ({ code: 'AI_ERROR', message: `The AI service failed: ${body}` });
    expect(friendlyAiError(raw('{"error":{"code":402,"status":"RESOURCE_EXHAUSTED"}}'))).toMatch(/quota/);
    expect(friendlyAiError(raw('{"error":{"code":503,"status":"UNAVAILABLE"}}'))).toMatch(/busy/);
    expect(friendlyAiError(raw('{"error":{"code":403,"status":"PERMISSION_DENIED"}}'))).toMatch(/API key/);
    expect(friendlyAiError(raw('socket hang up'))).toMatch(/had a problem/);
    // gemini.js's own sentences pass through.
    const busy = 'The AI models are busy right now. Please try again in a minute.';
    expect(friendlyAiError({ code: 'AI_QUOTA', message: busy })).toBe(busy);
  });

  it('labels telemetry fields for charts', () => {
    expect(fieldLabel('vibration')).toBe('Vibration');
    expect(fieldLabel('oilTempPv')).toBe('Oil temp PV');
    expect(fieldLabel('energyKwh')).toBe('Energy kWh');
  });

  it('keeps only the asked-for fields and the status in a create preview', () => {
    const doc = {
      name: 'Leak',
      priority: 'High',
      workStatus: 'Open',
      companyId: 'c',
      trackProcess: {},
      comments: [],
    };
    expect(shownFields(doc, { name: 'Leak', priority: 'High' })).toEqual({
      name: 'Leak',
      priority: 'High',
      workStatus: 'Open',
    });
  });
});
