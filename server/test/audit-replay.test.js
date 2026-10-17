import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execute } from '../src/agent/loop.js';
import { buildSystemPrompt, DECISIVE_POLICY } from '../src/agent/systemPrompt.js';
import { getTool, unknownToolError } from '../src/agent/tools/registry.js';
import { getModule } from '../src/modules/registry.js';
import { contextFor, setupDatabase, teardownDatabase } from './helpers/db.js';

/**
 * owner_1's chat audit, replayed: the exact arguments the live model sent (placeholders, phrases, company-format
 * dates, extended JSON, codes, names, "all", a part typed as a job card, a code without its module) go through
 * the loop's execute() — zod, placeholder filling, the tool — and must come back usable, not as an error.
 */

let ctx;
let wo;
const io = (extra = {}) => ({ emit: () => {}, results: new Map(), callId: 't_v', ...extra });
const call = (name, args, { mode, ...extra } = {}) =>
  execute({ tool: getTool(name), args, ctx, io: io(extra), mode });
const ok = async (name, args, extra) => {
  const out = await call(name, args, extra);
  expect(out.error, `${name} ${JSON.stringify(args)} → ${JSON.stringify(out.error)}`).toBeUndefined();
  return out.value;
};
const anomaliesKpi = {
  title: 'Anomalies by severity',
  viz: 'bar',
  timeRange: { text: 'last 3 days' },
  sources: [
    {
      key: 'anomalies',
      tool: 'mongo_aggregate',
      args: {
        module: 'anomalies',
        pipeline: [
          { $match: { detectedAt: { $gte: '$start', $lt: '$stop' } } },
          { $group: { _id: '$severity', count: { $sum: 1 } } },
          { $project: { _id: 0, severity: '$_id', count: 1 } },
        ],
      },
    },
  ],
  encoding: { source: 'anomalies', x: 'severity', series: [{ key: 'count', label: 'Anomalies' }] },
};

beforeAll(async () => {
  await setupDatabase();
  ctx = await contextFor('owner_1@acme.test');
  // An open work order whose code is unique in the company (fixture codes restart per plant).
  const WorkOrder = getModule('workorders').Model;
  const codes = await WorkOrder.aggregate([
    { $match: { companyId: ctx.companyId } },
    {
      $group: {
        _id: '$workOrderId',
        n: { $sum: 1 },
        open: { $max: { $cond: [{ $eq: ['$workStatus', 'Open'] }, 1, 0] } },
      },
    },
    { $match: { n: 1, open: 1 } },
    { $sort: { _id: 1 } },
    { $limit: 1 },
  ]);
  wo = await WorkOrder.findOne({ companyId: ctx.companyId, workOrderId: codes[0]._id }).lean();
});
afterAll(teardownDatabase);

describe('time ranges as the model sent them', () => {
  it.each([
    ['cost_summary', { start: '$start', stop: '$stop', groupBy: 'asset' }],
    ['rejection_summary', { start: 'today', stop: 'today', groupBy: 'reason' }],
    ['downtime_summary', { start: '17-10-2026', stop: '17-10-2026', groupBy: 'asset' }],
    ['attendance_summary', { start: '$start', stop: '$stop' }],
    ['telemetry_shot_counts', { assetId: 'IMM-01', start: '$start', stop: '$stop', groupBy: 'day' }],
    ['energy_consumption', { assetIds: ['all'], start: 'last 3 days', stop: 'now', groupBy: 'day' }],
  ])('%s %j', async (name, args) => {
    expect(await ok(name, args)).toBeTruthy();
  });

  it('a year of 15-minute energy is refused with a plain hint, not a date error', async () => {
    const out = await call('energy_consumption', { assetIds: ['all'], start: 'this past year', stop: 'now' });
    expect(out.error.error).toMatch(/92 days or less/);
  });

  it('"$start"/"$stop" mean the range resolved earlier in the turn', async () => {
    const results = new Map();
    const range = await ok('resolve_time_range', { text: 'last 3 days' });
    results.set('t_1', range);
    const v = await ok('list_anomalies', { state: 'all', start: '$start', stop: '$stop' }, { results });
    expect(v.forModel.start).toBe(range.data.start);
    expect(v.forModel.stop).toBe(range.data.stop);
  });
});

describe('records as the model referenced them', () => {
  it('mongo_aggregate takes extended JSON dates', async () => {
    const v = await ok('mongo_aggregate', {
      module: 'anomalies',
      pipeline: [
        { $match: { detectedAt: { $gte: { $date: '2026-01-01T00:00:00Z' } } } },
        { $group: { _id: '$severity', count: { $sum: 1 } } },
      ],
    });
    expect(Array.isArray(v.data.rows)).toBe(true);
  });

  it('asset tools take codes, names and "all"; a part typed as a job card finds its card', async () => {
    expect((await ok('machine_health', { assetId: 'Furnace 2' })).forModel.asset.name).toBe('Furnace 2');
    expect(
      (await ok('telemetry_status_timeline', { assetId: 'IMM-01', start: 'today' })).forModel.asset,
    ).toBe('IMM 1');
    expect(
      (await ok('energy_consumption', { assetIds: ['all'], start: 'last 3 days' })).forModel.assets.length,
    ).toBeGreaterThan(1);
    expect((await ok('job_card_progress', { jobCard: 'JC-BracketC' })).forModel.partName).toBe('Bracket-C');
  });

  it('list_anomalies narrows to a time range (the KPI the voice model refused)', async () => {
    const v = await ok('list_anomalies', { state: 'all', start: 'last 3 days' });
    expect(v.forModel.start).toMatch(/^\d{4}-/);
    for (const row of v.data.rows) expect(row.detectedAt >= v.forModel.start).toBe(true);
    const kpi = await ok('create_kpi', anomaliesKpi, { mode: 'preview' });
    expect(kpi.payload.label).toBe('Create KPI "Anomalies by severity"');
  });

  it('open_page infers the module of a code, searches the People page, finds a machine by name', async () => {
    const rec = await ok('open_page', { page: 'record', recordId: wo.workOrderId });
    expect(rec.blocks[0].payload.url).toBe(`/m/workorders/${wo._id}`);
    const people = await ok('open_page', {
      page: 'list',
      module: 'users',
      filters: [{ field: 'q', value: 'Ramesh' }],
    });
    expect(people.blocks[0].payload.url).toBe('/m/users?q=Ramesh');
    const machine = await ok('open_page', { page: 'machine', q: 'furnace 2' });
    expect(machine.blocks[0].payload.url).toMatch(/^\/machines\/[0-9a-f]{24}$/);
  });

  it('a misspelt person resolves to the closest one; invented tools get a pointer', async () => {
    const v = await ok('resolve', { kind: 'user', query: 'Rakesh Kumar' });
    expect(v.forModel.matches[0].label).toMatch(/Ramesh Kumar/);
    expect(v.forModel.fuzzy).toBe(true);
    expect(unknownToolError('plantId_context').hint).toMatch(/already in your context/);
    expect(unknownToolError('usergroups_schema').hint).toMatch(/module_schema/);
  });
});

describe('decisions the model refused to make', () => {
  it('a work order with only an asset and "breakdown" previews with every field decided', async () => {
    const v = await ok(
      'create_record',
      { module: 'workorders', items: [{ name: 'Breakdown', asset: 'Furnace 2' }] },
      { mode: 'preview' },
    );
    const [item] = v.payload.items;
    expect(item.doc).toMatchObject({ priority: 'High', category: 'Breakdown', workStatus: 'Open' });
    expect(item.doc.dueDate).toBeTruthy();
    expect(item.doc.people).toHaveLength(1);
    expect(item.doc.saraDecided).toMatch(/assigned/);
  });

  it('"assign whoever is free" previews an auto pick that says why', async () => {
    const v = await ok(
      'assign_work_order',
      { workOrder: wo.workOrderId, people: 'auto' },
      { mode: 'preview' },
    );
    expect(v.payload.decided).toMatch(/^SARA decided: .+ \((free|least loaded)/);
  });

  it('the policy and the tool descriptions agree: phrases, names and "all" are fine', async () => {
    const prompt = await buildSystemPrompt({ ctx, groups: ['telemetry', 'kpi', 'write'] });
    expect(prompt).toContain(DECISIVE_POLICY);
    expect(DECISIVE_POLICY).toMatch(/never dates you computed/);
    expect(DECISIVE_POLICY).toMatch(/tools resolve names, codes and "all"/);
    expect(DECISIVE_POLICY).not.toMatch(/never codes, names or "all"/);
  });
});
