import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { toDeclaration } from '../src/agent/declarations.js';
import { buildPage } from '../src/agent/tools/navigate.js';
import { getTool, toolsFor } from '../src/agent/tools/registry.js';
import { _resetBudget } from '../src/ai/budget.js';
import { demoChat, demoStep } from '../src/ai/mockChat.js';
import { getAiSettings, saveAiSettings } from '../src/ai/settings.js';
import { userFromToken } from '../src/auth/middleware.js';
import { getModule } from '../src/modules/registry.js';
import { _setLiveClient } from '../src/voice/liveClient.js';
import { buildVoicePrompt } from '../src/voice/prompt.js';
import { createVoiceSession } from '../src/voice/session.js';
import { contextFor, setupDatabase, teardownDatabase } from './helpers/db.js';
import {
  createFakeLive,
  fakeSocket,
  hear,
  say,
  signIn,
  toolCall,
  turnComplete,
  until,
} from './helpers/fakeLive.js';

const OWNER = 'owner_1@acme.test';
const fake = createFakeLive();
const opened = [];
let ctx;
let imm3;
let press1;
let settings;

const page = (args) => buildPage(ctx, args);
const fails = (args) => expect(page(args)).rejects.toThrow();

beforeAll(async () => {
  await setupDatabase();
  ctx = await contextFor(OWNER);
  const Asset = getModule('assets').Model;
  imm3 = await Asset.findOne({ name: 'IMM 3' }).lean();
  press1 = await Asset.findOne({ name: 'Press 1' }).lean();
  _setLiveClient(fake.client);
  _resetBudget();
  const { voice } = await getAiSettings();
  settings = await saveAiSettings({ limits: { [voice.model]: { rpm: 10_000, rpd: 100_000 } } });
  demoChat.enabled = true;
});
afterEach(async () => {
  await Promise.all(opened.splice(0).map((s) => s.close()));
});
afterAll(async () => {
  demoChat.enabled = false;
  _setLiveClient(null);
  await teardownDatabase();
});

describe('open_page URLs', () => {
  it('builds every page kind as an app-relative URL', async () => {
    expect(await page({ page: 'home' })).toEqual({ url: '/', label: 'Command Center' });
    expect(await page({ page: 'kpis' })).toEqual({ url: '/kpis', label: 'KPI Builder' });
    expect(await page({ page: 'chat' })).toEqual({ url: '/chat', label: 'Chat' });
    expect(await page({ page: 'costs', period: 'week' })).toEqual({
      url: '/costs?period=week',
      label: 'Costs · this week',
    });
    expect(
      await page({
        page: 'machines',
        filters: [
          { field: 'type', value: 'power press' },
          { field: 'status', value: 'on' },
        ],
        q: 'shop',
      }),
    ).toEqual({
      url: '/machines?type=Power+Press&status=Running&q=shop',
      label: 'Machines · Power Press · running',
    });
    expect(await page({ page: 'machine', recordId: String(imm3._id) })).toEqual({
      url: `/machines/${imm3._id}`,
      label: 'IMM-03 · IMM 3',
    });
    expect(
      await page({
        page: 'anomalies',
        filters: [
          { field: 'state', value: 'Open' },
          { field: 'severity', value: 'critical' },
        ],
        assetId: 'Press 1',
      }),
    ).toEqual({
      url: `/anomalies?state=open&severity=critical&asset=${press1._id}`,
      label: 'Anomalies · open · critical · PRS-01 · Press 1',
    });
    expect(await page({ page: 'planner', tab: 'production' })).toEqual({
      url: '/planner?tab=production',
      label: 'Production planner',
    });
    expect(await page({ page: 'planner', assetId: 'Press 1' })).toEqual({
      url: `/planner?maintenance=${press1._id}`,
      label: 'Maintenance planner · PRS-01 · Press 1',
    });
    expect(
      await page({
        page: 'list',
        module: 'workorders',
        filters: [
          { field: 'priority', value: 'high' },
          { field: 'workStatus', value: 'open' },
        ],
        sort: '-dueDate',
        q: 'leak',
      }),
    ).toEqual({
      url: '/m/workorders?priority=High&workStatus=Open&q=leak&sort=-dueDate',
      label: 'Work Orders · priority High · status Open',
    });
    expect(
      await page({
        page: 'list',
        module: 'assets',
        filters: [{ field: 'typeOfAsset', value: 'CNC Machine' }],
      }),
    ).toEqual({
      url: '/machines?type=CNC+Machine',
      label: 'Machines · CNC Machine',
    });
  });

  it('resolves records by id, code and name', async () => {
    const [{ wo }] = await getModule('workorders').Model.aggregate([
      { $match: { companyId: ctx.companyId } },
      { $group: { _id: '$workOrderId', n: { $sum: 1 }, wo: { $first: '$$ROOT' } } },
      { $match: { n: 1 } },
      { $limit: 1 },
    ]);
    expect(await page({ page: 'record', module: 'workorders', recordId: wo.workOrderId })).toEqual({
      url: `/m/workorders/${wo._id}`,
      label: `${wo.workOrderId} · ${wo.name}`,
    });
    expect((await page({ page: 'record', module: 'workorders', recordId: String(wo._id) })).url).toBe(
      `/m/workorders/${wo._id}`,
    );
    expect((await page({ page: 'machine', recordId: 'imm 3' })).url).toBe(`/machines/${imm3._id}`);
    expect((await page({ page: 'record', module: 'assets', recordId: 'IMM-03' })).url).toBe(
      `/machines/${imm3._id}`,
    );
  });

  it('refuses unknown modules, fields, enum values, sorts, pages and ambiguous names', async () => {
    await expect(page({ page: 'list', module: 'nope' })).rejects.toThrow(/Unknown module/);
    await expect(
      page({ page: 'list', module: 'workorders', filters: [{ field: 'nonsense', value: 'x' }] }),
    ).rejects.toThrow(/not a filter/);
    // a text field is not a column filter but a search: it becomes q instead of an error
    expect(
      (await page({ page: 'list', module: 'workorders', filters: [{ field: 'name', value: 'leak' }] })).url,
    ).toBe('/m/workorders?q=leak');
    await expect(
      page({ page: 'list', module: 'workorders', filters: [{ field: 'priority', value: 'Urgent' }] }),
    ).rejects.toThrow(/not a Priority/);
    await expect(page({ page: 'list', module: 'workorders', sort: 'people' })).rejects.toThrow(/Cannot sort/);
    await expect(page({ page: 'machines', filters: [{ field: 'plant', value: 'x' }] })).rejects.toThrow(
      /not a filter/,
    );
    await expect(page({ page: 'kpis', filters: [{ field: 'a', value: 'b' }] })).rejects.toThrow(/no filters/);
    await expect(page({ page: 'kpis', q: 'x' })).rejects.toThrow(/no search/);
    await expect(page({ page: 'machine', recordId: 'Nothing like this' })).rejects.toThrow(/Asset not found/);
    await expect(page({ page: 'machine', recordId: 'IMM' })).rejects.toThrow(/Several assets match "IMM"/);
    await expect(page({ page: 'record', module: 'workorders' })).rejects.toThrow(/id, code or name/);
    await fails({ page: 'record', recordId: 'x' });
    await fails({ page: 'list' });
    await fails({ page: 'elsewhere' });
    // Free text never becomes a path: q is a query value, ids are validated or resolved.
    const built = await page({ page: 'list', module: 'workorders', q: 'https://evil.example/x' });
    expect(built.url).toBe('/m/workorders?q=https%3A%2F%2Fevil.example%2Fx');
    await expect(page({ page: 'machine', recordId: '//evil.example' })).rejects.toThrow();
  });

  it('is a core tool that returns a navigate block and declares cleanly', async () => {
    const tool = getTool('open_page');
    expect(tool.group).toBe('core');
    expect(toolsFor(ctx).map((t) => t.name)).toContain('open_page');
    expect(toDeclaration(tool).parametersJsonSchema.properties.page.enum).toContain('list');
    const out = await tool.run(ctx, {
      page: 'list',
      module: 'workorders',
      filters: [{ field: 'priority', value: 'High' }],
      reason: 'High priority first',
    });
    expect(out).toEqual({
      forModel: {
        url: '/m/workorders?priority=High',
        label: 'Work Orders · priority High',
        summary: "Work Orders · priority High is now open on the user's screen",
      },
      summary: 'Opened Work Orders · priority High',
      blocks: [
        {
          type: 'navigate',
          payload: {
            url: '/m/workorders?priority=High',
            label: 'Work Orders · priority High',
            reason: 'High priority first',
          },
        },
      ],
    });
    // A viewer may read work orders but the registry still gates the module.
    const viewer = await contextFor('viewer_1@acme.test');
    expect((await buildPage(viewer, { page: 'list', module: 'workorders' })).url).toBe('/m/workorders');
  });
});

describe('mock chat scripts', () => {
  const turn = (name, args, result) => [
    { role: 'model', parts: [{ functionCall: { name, args } }] },
    { role: 'user', parts: [{ functionResponse: { name, response: { result } } }] },
  ];
  it('opens pages, machines and the planner, then says what is shown', () => {
    expect(demoStep({ text: 'open high priority work orders', history: [] }).calls).toEqual([
      {
        name: 'open_page',
        args: { page: 'list', module: 'workorders', filters: [{ field: 'priority', value: 'High' }] },
      },
    ]);
    expect(demoStep({ text: 'Show me IMM 3', history: [] }).calls).toEqual([
      { name: 'open_page', args: { page: 'machine', recordId: 'IMM 3' } },
    ]);
    expect(demoStep({ text: 'Take me to the maintenance planner for Press 1', history: [] }).calls).toEqual([
      { name: 'open_page', args: { page: 'planner', tab: 'maintenance', assetId: 'Press 1' } },
    ]);
    expect(demoStep({ text: 'open the costs page', history: [] }).calls[0].args).toEqual({ page: 'costs' });
    expect(demoStep({ text: 'go to anomalies', history: [] }).calls[0].args).toEqual({ page: 'anomalies' });
    const done = demoStep({
      text: 'Show me IMM 3',
      history: turn(
        'open_page',
        { page: 'machine', recordId: 'IMM 3' },
        { url: '/machines/1', label: 'IMM 3' },
      ),
    });
    expect(done).toEqual({ text: 'Opened **IMM 3** on your screen.' });
    // Questions keep their analytic flows.
    expect(demoStep({ text: 'Show me the energy of IMM 3 today', history: [] }).calls[0].name).not.toBe(
      'open_page',
    );
    expect(demoStep({ text: 'Show its key trends', history: [] }).calls?.[0]?.name).not.toBe('open_page');
    // "Open a work order …" creates one (createWoFlow); only "open the work orders" navigates.
    for (const text of [
      'Open a work order for Press 1: oil leak',
      'Open 2 work orders: oil leak at Press 1, belt check',
      'Open a new work order for IMM 3',
    ]) {
      expect(demoStep({ text, history: [] }).calls[0].name, text).toBe('resolve');
    }
  });
});

describe('voice relay', () => {
  it('sends a navigate message next to the block and tells the prompt about open_page', async () => {
    const { token } = await signIn(OWNER);
    const auth = await userFromToken(token);
    const socket = fakeSocket();
    const session = createVoiceSession({ socket, auth, start: { type: 'start', token }, settings });
    opened.push(session);
    await session.ready;
    const live = fake.last();
    expect(live.config.systemInstruction ?? JSON.stringify(live.config)).toMatch(/Opening pages/);
    expect(await buildVoicePrompt({ ctx, language: 'auto' })).toMatch(/call open_page/);
    const call = toolCall(['open_page', { page: 'machine', recordId: 'IMM 3' }]);
    live.emit(hear('Show me IMM 3', true), say('Opening IMM 3.'), call);
    await until(() => live.toolResponses.length >= 1, { what: 'tool response' });
    const [answer] = live.toolResponses[0].functionResponses;
    expect(answer.response.result).toMatchObject({ url: `/machines/${imm3._id}`, label: 'IMM-03 · IMM 3' });
    expect(socket.of('block')[0]).toMatchObject({
      turnId: 't1',
      data: { type: 'navigate', payload: { url: `/machines/${imm3._id}` } },
    });
    expect(socket.of('navigate')[0]).toEqual({
      type: 'navigate',
      turnId: 't1',
      data: { url: `/machines/${imm3._id}`, label: 'IMM-03 · IMM 3' },
    });
    live.emit(say('IMM 3 is on your screen.'), turnComplete());
    await socket.next('turn_complete');
  });
});
