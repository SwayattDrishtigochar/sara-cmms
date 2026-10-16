import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { normalize, toneOf } from '../src/kpis/normalize.js';
import { runKpi, validateKpi } from '../src/kpis/runner.js';
import { records } from '../src/modules/records.js';
import { getModule } from '../src/modules/registry.js';
import { contextFor, NOW, setupDatabase, systemContext, teardownDatabase } from './helpers/db.js';

const { seriesCalls } = vi.hoisted(() => ({ seriesCalls: [] }));
vi.mock('../src/telemetry/queries.js', async (importOriginal) => ({
  ...(await importOriginal()),
  // Two 15-min energy readings per asset an hour into the window: 10 + 20 kWh.
  seriesFor: async (_companyId, assetIds, fields, { start, stop }) => {
    seriesCalls.push({ start: new Date(start).toISOString(), stop: new Date(stop).toISOString() });
    const t0 = new Date(start).getTime() + 3_600_000;
    return {
      series: assetIds.flatMap((assetId) =>
        fields.map((field) => ({
          assetId,
          field,
          measurement: 'energy',
          points: [
            [t0, 10],
            [t0 + 900_000, 20],
          ],
        })),
      ),
    };
  },
}));

const Model = (name) => getModule(name).Model;
const DAY = 86_400_000;
let acme;
let beta;
let imm1;
const ctx = {};

const kpi = (overrides) => ({
  title: 'Test KPI',
  viz: 'number',
  timeRange: { text: 'last 7 days' },
  ...overrides,
});

beforeAll(async () => {
  ({ acme, beta } = await setupDatabase());
  ctx.owner = await contextFor('owner_1@acme.test');
  ctx.pune = await contextFor('plant_manager_1@acme.test');
  ctx.chennai = await contextFor('plant_manager_2@acme.test');
  ctx.viewer = await contextFor('viewer_1@acme.test');
  ctx.beta = await contextFor('owner_1@beta.test');
  imm1 = await Model('assets').findOne({ companyId: acme.companyId, name: 'IMM 1' }).lean();
  const sys = await systemContext(acme.companyId);
  for (const [daysAgo, produced] of [
    [1, 100],
    [2, 50],
    [10, 999], // outside "last 7 days"
  ]) {
    await records.create(
      sys,
      'partcounts',
      { assetId: String(imm1._id), date: new Date(NOW.getTime() - daysAgo * DAY), shiftName: 'A', produced },
      { source: 'system' },
    );
  }
});
afterAll(teardownDatabase);

describe('runKpi tenancy', () => {
  const openWorkOrders = kpi({
    sources: [{ key: 'open', tool: 'mongo_count', args: { module: 'workorders', filter: {} } }],
  });

  it("runs in the viewer's company: company B never sees company A's data", async () => {
    const countOf = (companyId) => Model('workorders').countDocuments({ companyId, deleted: { $ne: true } });
    const a = await runKpi(ctx.owner, openWorkOrders, { now: NOW });
    const b = await runKpi(ctx.beta, openWorkOrders, { now: NOW });
    expect(a.error).toBeUndefined();
    expect(a.value).toBe(await countOf(acme.companyId));
    expect(b.value).toBe(await countOf(beta.companyId));
    expect(a.value).not.toBe(b.value);
  });

  it("fails cleanly when B runs a KPI that names A's asset", async () => {
    const energy = kpi({
      sources: [{ key: 'energy', tool: 'energy_consumption', args: { assetIds: [String(imm1._id)] } }],
      encoding: { value: 'kwh' },
    });
    const mine = await runKpi(ctx.owner, energy, { now: NOW });
    expect(mine.error).toBeUndefined();
    expect(mine.value).toBe(30);
    const theirs = await runKpi(ctx.beta, energy, { now: NOW });
    expect(theirs.error).toMatch(/not found/i);
    expect(theirs.value).toBeUndefined();
  });

  it("follows the viewer's plant lock", async () => {
    const assets = kpi({ sources: [{ key: 'n', tool: 'mongo_count', args: { module: 'assets' } }] });
    const count = (plantId) =>
      Model('assets').countDocuments({
        companyId: acme.companyId,
        deleted: { $ne: true },
        ...(plantId ? { plantId } : {}),
      });
    expect((await runKpi(ctx.owner, assets, { now: NOW })).value).toBe(await count());
    expect((await runKpi(ctx.pune, assets, { now: NOW })).value).toBe(await count(ctx.pune.plantLock));
    expect((await runKpi(ctx.chennai, assets, { now: NOW })).value).toBe(await count(ctx.chennai.plantLock));
  });
});

describe('time range', () => {
  it('re-resolves the text on every run and injects start/stop', async () => {
    const def = kpi({
      viz: 'bar',
      sources: [
        { key: 'energy', tool: 'energy_consumption', args: { assetIds: [String(imm1._id)], groupBy: 'day' } },
      ],
    });
    seriesCalls.length = 0;
    const first = await runKpi(ctx.owner, def, { now: NOW });
    const later = await runKpi(ctx.owner, def, { now: new Date(NOW.getTime() + 2 * DAY) });
    expect(seriesCalls).toHaveLength(2);
    expect(seriesCalls[0]).toEqual({ start: first.timeRange.start, stop: first.timeRange.stop });
    expect(seriesCalls[1]).toEqual({ start: later.timeRange.start, stop: later.timeRange.stop });
    expect(Date.parse(later.timeRange.start) - Date.parse(first.timeRange.start)).toBe(2 * DAY);
    expect(first.timeRange.label).toMatch(/7 days/i);
    expect(def.sources[0].args).toEqual({ assetIds: [String(imm1._id)], groupBy: 'day' });
  });

  it('replaces "$start"/"$stop" inside mongo filters and computes kWh per part across sources', async () => {
    const def = kpi({
      title: 'kWh per part – IMM 1',
      unit: 'kWh/pc',
      sources: [
        { key: 'energy', tool: 'energy_consumption', args: { assetIds: [String(imm1._id)] } },
        {
          key: 'parts',
          tool: 'mongo_aggregate',
          args: {
            module: 'partcounts',
            pipeline: [
              { $match: { assetId: String(imm1._id), date: { $gte: '$start', $lt: '$stop' } } },
              { $group: { _id: null, produced: { $sum: '$produced' } } },
            ],
          },
        },
      ],
      formula: 'sum(energy.kwh) / sum(parts.produced)',
    });
    const result = await runKpi(ctx.owner, validateKpi(ctx.owner, def, { now: NOW }), { now: NOW });
    expect(result.error).toBeUndefined();
    expect(result.value).toBeCloseTo(30 / 150, 4);
    expect(result.tone).toBe('neutral');
  });
});

describe('validation', () => {
  it('rejects tools outside the allow-list, at validation and at run time', async () => {
    for (const tool of ['influx_flux', 'render_table', 'create_record', 'nope']) {
      const def = kpi({ sources: [{ key: 'x', tool, args: {} }] });
      expect(() => validateKpi(ctx.owner, def)).toThrow(/sources\.0\.tool/);
      expect((await runKpi(ctx.owner, def, { now: NOW })).error).toMatch(/can't feed a KPI/);
    }
  });

  it('re-validates stored args with the tool schema on every run', async () => {
    const def = kpi({
      sources: [{ key: 'energy', tool: 'energy_consumption', args: { assetIds: 'IMM 1' } }],
    });
    try {
      validateKpi(ctx.owner, def);
      throw new Error('expected a 400');
    } catch (err) {
      expect(err.status).toBe(400);
      expect(err.details.issues[0].path).toBe('sources.0.args.assetIds');
    }
    expect((await runKpi(ctx.owner, def, { now: NOW })).error).toMatch(/invalid arguments/);
  });

  it('checks keys, formula identifiers, encoding source, range text and permissions', () => {
    const src = { key: 'n', tool: 'mongo_count', args: { module: 'workorders' } };
    const issues = (def, c = ctx.owner) => {
      try {
        validateKpi(c, kpi(def));
        return [];
      } catch (err) {
        return err.details.issues.map((i) => i.path);
      }
    };
    expect(issues({ sources: [src, src] })).toEqual(['sources.1.key']);
    expect(issues({ sources: [src], formula: 'n / other' })).toEqual(['formula']);
    expect(issues({ sources: [src], formula: 'n +' })).toEqual(['formula']);
    expect(issues({ sources: [src], encoding: { source: 'x' } })).toEqual(['encoding.source']);
    expect(issues({ sources: [src], timeRange: { text: 'banana' } })).toEqual(['timeRange.text']);
    expect(issues({ sources: [] })).toEqual(['sources']);
    expect(issues({ sources: [{ ...src, key: 'Bad-Key' }] })).toEqual(['sources.0.key']);
    expect(
      issues({ sources: [{ key: 'p', tool: 'job_card_progress', args: { jobCard: 'JC-1' } }] }, ctx.beta),
    ).toEqual(['sources.0.tool']); // production is off for Beta
    const clean = validateKpi(
      ctx.owner,
      kpi({ sources: [{ ...src, args: { ...src.args, start: 'x', stop: 'y' } }] }),
    );
    expect(clean.sources[0].args).toEqual({ module: 'workorders' });
  });
});

describe('normalize', () => {
  const range = {
    start: '2026-10-08T00:00:00.000Z',
    stop: '2026-10-15T00:00:00.000Z',
    label: 'Last 7 days',
    timeZone: 'Asia/Kolkata',
  };
  const rows = [
    { asset: 'IMM 1', day: '2026-10-13', kwh: 30, cost: 252 },
    { asset: 'IMM 2', day: '2026-10-14', kwh: 50, cost: 420 },
    { asset: 'IMM 3', day: '2026-10-15', kwh: 20, cost: 168 },
  ];
  const run = (def, values = { r: rows }, columns) =>
    normalize(
      { title: 'T', timeRange: { text: 'last 7 days' }, sources: [{ key: 'r' }], ...def },
      values,
      range,
      columns,
    );

  it('number and gauge: value, tone, gauge max', () => {
    expect(run({ viz: 'number', encoding: { value: 'kwh' } }).value).toBe(100);
    expect(run({ viz: 'number' }).value).toBe(3);
    expect(run({ viz: 'number' }, { r: 42 }).value).toBe(42);
    const gauge = run({ viz: 'gauge', target: 85, unit: '%' }, { r: 82 });
    expect(gauge).toMatchObject({ value: 82, tone: 'warn', min: 0, max: 100 });
    expect(run({ viz: 'gauge', thresholds: { warn: 80, critical: 60 } }, { r: 70 })).toMatchObject({
      tone: 'warn',
      max: 100,
    });
    expect(toneOf(5, { thresholds: { warn: 3, critical: 6, direction: 'lower_is_better' } })).toBe('warn');
    expect(toneOf(7, { thresholds: { warn: 3, critical: 6, direction: 'lower_is_better' } })).toBe(
      'critical',
    );
    expect(toneOf(90, { target: 85 })).toBe('good');
    expect(toneOf(null, { target: 85 })).toBe('neutral');
  });

  it('series charts: x, series, stats, sort and limit', () => {
    const r = run({
      viz: 'combo',
      encoding: { x: 'day', series: [{ key: 'kwh' }, { key: 'cost', axis: 'right', type: 'line' }] },
    });
    expect(r.xKey).toBe('x');
    expect(r.series.map((s) => [s.key, s.axis])).toEqual([
      ['kwh', 'left'],
      ['cost', 'right'],
    ]);
    expect(r.data[0]).toEqual({ x: '2026-10-13', kwh: 30, cost: 252 });
    expect(r.xType).toBe('category');
    expect(r.stats).toMatchObject({ count: 3, sum: 100, min: 20, max: 50, first: 30, last: 20 });
    expect(r.stats.top[0]).toEqual({ label: '2026-10-14', value: 50 });
    const sorted = run({ viz: 'bar', encoding: { x: 'asset', value: 'kwh', sort: 'desc', limit: 2 } });
    expect(sorted.data.map((d) => d.x)).toEqual(['IMM 2', 'IMM 1']);
    // A stacked bar ranks by the stack total, not by its first series.
    const stacked = run(
      { viz: 'stackedBar', encoding: { x: 'asset', series: [{ key: 'spares' }, { key: 'labour' }] } },
      {
        r: [
          { asset: 'CNC 4', spares: 37000, labour: 818 },
          { asset: 'IMM 1', spares: 3600, labour: 1949 },
          { asset: 'Compressor 2', spares: 4000, labour: 442 },
        ],
      },
    );
    expect(stacked.stats.top.map((t) => [t.label, t.value])).toEqual([
      ['CNC 4', 37818],
      ['IMM 1', 5549],
      ['Compressor 2', 4442],
    ]);
    const timed = run({ viz: 'line' }, { r: [{ at: '2026-10-14T10:00:00Z', v: 1 }] });
    expect(timed.xType).toBe('time');
  });

  it('pie, heatmap (hour buckets), timeline and table', () => {
    expect(run({ viz: 'pie', encoding: { label: 'asset', value: 'kwh' } }).slices[1]).toEqual({
      label: 'IMM 2',
      value: 50,
    });
    const heat = run(
      { viz: 'heatmap', encoding: { x: 'hour', value: 'kwh' } },
      {
        r: [
          { hour: '2026-10-14 10:00', kwh: 5 },
          { hour: '2026-10-14 11:00', kwh: 7 },
          { hour: '2026-10-15 10:00', kwh: 9 },
        ],
      },
    );
    expect(heat.xLabels).toEqual(['10:00', '11:00']);
    expect(heat.yLabels).toEqual(['2026-10-14', '2026-10-15']);
    expect(heat.cells).toContainEqual({ x: '10:00', y: '2026-10-15', value: 9 });
    expect([heat.cellMin, heat.cellMax]).toEqual([5, 9]);
    const timeline = run(
      { viz: 'timeline' },
      {
        r: [
          { status: 'Running', start: '2026-10-14T10:00:00Z', end: '2026-10-14T11:00:00Z', minutes: 60 },
          { status: 'Idle', start: '2026-10-14T11:00:00Z', end: '2026-10-14T11:30:00Z', minutes: 30 },
        ],
      },
    );
    expect(timeline.lanes).toHaveLength(1);
    expect(timeline.lanes[0].runs[1]).toMatchObject({ status: 'Idle' });
    const table = run(
      { viz: 'table' },
      { r: [{ asset: { id: 'a1', label: 'IMM 1' }, kwh: 3 }] },
      {
        r: [
          { key: 'asset', label: 'Asset' },
          { key: 'kwh', label: 'kWh' },
        ],
      },
    );
    expect(table.columns.map((c) => c.key)).toEqual(['asset', 'kwh']);
    expect(table.rows[0]).toEqual({ asset: 'IMM 1', kwh: 3 });
  });

  it('caps points and warns on empty data', () => {
    const many = Array.from({ length: 2500 }, (_, i) => ({ x: i, v: i }));
    const r = run({ viz: 'line', encoding: { x: 'x', value: 'v' } }, { r: many });
    expect(r.data).toHaveLength(2000);
    expect(r.warnings[0]).toMatch(/first 2000/);
    expect(run({ viz: 'bar' }, { r: null }).warnings).toEqual(['No data in Last 7 days']);
  });
});
