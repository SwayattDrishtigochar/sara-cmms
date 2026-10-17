import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { getTool } from '../src/agent/tools/registry.js';
import { coerceSourceArgs, runKpi, validateKpi } from '../src/kpis/runner.js';
import { kpiTools, resolveSourceRefs } from '../src/kpis/tools.js';
import { records } from '../src/modules/records.js';
import { getModule } from '../src/modules/registry.js';
import { contextFor, NOW, setupDatabase, systemContext, teardownDatabase } from './helpers/db.js';

/** KPI creation asks that used to be refused: energy per day/asset by name, anomalies over a range, availability. */

vi.mock('../src/telemetry/queries.js', async (importOriginal) => ({
  ...(await importOriginal()),
  // 4 kWh per hour for the 3 hours after the window start, for every asset asked.
  seriesFor: async (_companyId, assetIds, fields, { start }) => {
    const t0 = new Date(start).getTime();
    return {
      series: assetIds.flatMap((assetId) =>
        fields.map((field) => ({
          assetId,
          field,
          measurement: 'energy',
          points: [1, 2, 3].map((h) => [t0 + h * 3_600_000, 4]),
        })),
      ),
    };
  },
  statusTimeline: async () => ({
    runs: [{ status: 'Running', start: NOW, end: new Date(NOW.getTime() + 3_600_000), seconds: 3600 }],
    totals: { Running: 3600, Stopped: 1200 },
    availability: 0.75,
  }),
}));

const Model = (name) => getModule(name).Model;
const DAY = 86_400_000;
const io = { emit: () => {}, signal: undefined, results: new Map(), callId: 't' };
const tool = (name) => kpiTools.find((t) => t.name === name);
let acme;
let owner;
let imm1;
let press2;

beforeAll(async () => {
  ({ acme } = await setupDatabase());
  owner = await contextFor('owner_1@acme.test');
  imm1 = await Model('assets').findOne({ companyId: acme.companyId, name: 'IMM 1' }).lean();
  press2 = await Model('assets').findOne({ companyId: acme.companyId, name: 'Press 2' }).lean();
  const sys = await systemContext(acme.companyId);
  for (const [daysAgo, severity] of [
    [1, 'critical'],
    [2, 'warning'],
    [10, 'critical'], // outside "last 3 days"
  ]) {
    const a = await records.create(
      sys,
      'anomalies',
      { assetId: String(press2._id), type: 'vibration_high', severity, summary: `test ${daysAgo}` },
      { source: 'system' },
    );
    await Model('anomalies').updateOne(
      { _id: a._id },
      { $set: { detectedAt: new Date(NOW.getTime() - daysAgo * DAY) } },
    );
  }
});
afterAll(teardownDatabase);

describe('coerceSourceArgs', () => {
  it('maps assetId ↔ assetIds to what the tool takes and groupBy words to the allowed values', () => {
    const energy = getTool('energy_consumption');
    const onlyIds = {
      name: 'x',
      schema: z.object({ assetIds: z.array(z.string()), groupBy: z.enum(['asset', 'day']) }),
    };
    expect(coerceSourceArgs(onlyIds, { assetId: 'a', groupBy: 'daily' })).toEqual({
      assetIds: ['a'],
      groupBy: 'day',
    });
    expect(coerceSourceArgs(energy, { assetIds: ['a'], groupBy: 'per hour' })).toEqual({
      assetIds: ['a'],
      groupBy: 'hour',
    });
    expect(coerceSourceArgs(energy, { assetIds: ['a'], groupBy: 'machine' }).groupBy).toBe('asset');
    expect(coerceSourceArgs(energy, { assetIds: ['a'], groupBy: 'week' }).groupBy).toBe('week'); // left for the schema error
    const timeline = getTool('telemetry_status_timeline');
    expect(coerceSourceArgs(timeline, { assetIds: ['a', 'b'] })).toEqual({ assetId: 'a' });
    expect(coerceSourceArgs(getTool('list_anomalies'), {})).toEqual({ limit: 100 });
  });
});

describe('resolveSourceRefs', () => {
  it('turns asset names, codes and "all" into ids before the KPI is stored', async () => {
    const def = {
      sources: [
        { key: 'e', tool: 'energy_consumption', args: { assetIds: 'IMM 1' } },
        { key: 'p', tool: 'telemetry_status_timeline', args: { asset: 'Press 2' } },
        { key: 'all', tool: 'energy_consumption', args: { assetIds: ['all'], groupBy: 'asset' } },
      ],
    };
    const out = await resolveSourceRefs(owner, def);
    expect(out.sources[0].args).toEqual({ assetIds: [String(imm1._id)] });
    expect(out.sources[1].args).toEqual({ assetId: String(press2._id) });
    const energyAssets = await Model('assets').countDocuments({
      companyId: acme.companyId,
      isEnergyAsset: true,
      deleted: { $ne: true },
    });
    expect(out.sources[2].args.assetIds).toHaveLength(Math.min(20, energyAssets));
    await expect(
      resolveSourceRefs(owner, {
        sources: [{ key: 'x', tool: 'energy_consumption', args: { assetIds: ['Pressy 9'] } }],
      }),
    ).rejects.toThrow(/"Pressy 9" could be .*Press 1 or .*Press 2; say which one/);
    await expect(
      resolveSourceRefs(owner, {
        sources: [{ key: 'x', tool: 'energy_consumption', args: { assetIds: ['Boiler 7'] } }],
      }),
    ).rejects.toThrow(/No asset matches "Boiler 7"/);
  });
});

describe('the asks that were refused', () => {
  it('energy of Press 2 per day for the last 3 days', async () => {
    const preview = await tool('create_kpi').preview(
      owner,
      {
        title: 'Press 2 energy per day',
        viz: 'line',
        unit: 'kWh',
        timeRange: { text: 'last 3 days' },
        sources: [
          { key: 'energy', tool: 'energy_consumption', args: { assetId: 'Press 2', groupBy: 'daily' } },
        ],
        encoding: { source: 'energy', x: 'day', y: 'kwh' },
      },
      io,
    );
    expect(preview.payload.kpi.sources[0].args).toEqual({ assetIds: [String(press2._id)], groupBy: 'day' });
    expect(preview.payload.kpi.sources[0].args.assetId).toBeUndefined();
    expect(preview.payload.result.error).toBeUndefined();
    expect(preview.payload.result.stats.count).toBeGreaterThan(0);
  });

  it('anomalies of the last 3 days (list_anomalies has no range: the runner cuts the rows)', async () => {
    const def = validateKpi(owner, {
      title: 'Press 2 anomalies',
      viz: 'number',
      timeRange: { text: 'last 3 days' },
      sources: [
        { key: 'anomalies', tool: 'list_anomalies', args: { assetId: String(press2._id), state: 'all' } },
      ],
    });
    expect(def.sources[0].args.limit).toBe(100);
    const result = await runKpi(owner, def, { now: NOW });
    expect(result.error).toBeUndefined();
    expect(result.value).toBe(2);
    const week = await runKpi(owner, { ...def, timeRange: { text: 'last 30 days' } }, { now: NOW });
    expect(week.value).toBe(3);
  });

  it('availability of one machine as a number card', async () => {
    const def = validateKpi(owner, {
      title: 'Press 2 availability',
      viz: 'number',
      unit: '%',
      timeRange: { text: 'yesterday' },
      sources: [
        {
          key: 'a',
          tool: 'telemetry_status_timeline',
          args: { assetId: String(press2._id) },
          pick: 'forModel.availabilityPct',
        },
      ],
    });
    const result = await runKpi(owner, def, { now: NOW });
    expect(result.error).toBeUndefined();
    expect(result.value).toBe(75);
  });
});
