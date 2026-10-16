import { DateTime } from 'luxon';
import mongoose from 'mongoose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { costSummary } from '../src/costs/engine.js';
import { periodRange } from '../src/costs/periods.js';
import { tariffOn } from '../src/costs/tariffs.js';
import { costTools } from '../src/costs/tools.js';
import { getModule } from '../src/modules/registry.js';
import { contextFor, NOW, setupDatabase, systemContext, teardownDatabase } from './helpers/db.js';

const ZONE = 'Asia/Kolkata';
const Model = (name) => getModule(name).Model;
const noEnergy = { energySeries: async () => ({ series: [] }) };
const at = (iso) => new Date(iso);

let acme;
let beta;
let sys;
let pune;
let chennai;
let cmp1; // Compressor 1, ₹2000/h downtime
let cmp2;
let incomer; // Main Incomer, no override → company default ₹3000/h
let woId;
let consumable;

beforeAll(async () => {
  ({ acme, beta } = await setupDatabase());
  sys = await systemContext(acme.companyId);
  pune = sys.plants.find((p) => p.name === 'Pune Plant');
  chennai = sys.plants.find((p) => p.name === 'Chennai Plant');
  const asset = (name) => Model('assets').findOne({ companyId: acme.companyId, name }).lean();
  [cmp1, cmp2, incomer] = await Promise.all([
    asset('Compressor 1'),
    asset('Compressor 2'),
    asset('Main Incomer'),
  ]);
  consumable = await Model('consumables')
    .findOne({ companyId: acme.companyId, price: { $gt: 0 } })
    .lean();
  const people = await Model('users').find({ companyId: acme.companyId }).limit(2).lean();

  // March 2026 holds nothing from the seed: only these rows count there.
  woId = new mongoose.Types.ObjectId();
  await Model('workorders').collection.insertOne({
    _id: woId,
    companyId: acme.companyId,
    plantId: pune._id,
    name: 'Replace coupling',
    asset: cmp1._id,
    category: 'Mechanical',
    people: people.map((u) => u._id),
    consumablesAndTools: [{ consumable: consumable._id, quantity: 3 }],
    durations: { timeInProgress: '02:35:48', timeOnHold: '00:00:00' },
    trackProcess: { completedAt: at('2026-03-02T06:00:00Z') },
    deleted: false,
  });
  await Model('sparepartstransactions').collection.insertMany([
    {
      companyId: acme.companyId,
      type: 'used',
      quantity: 2,
      unitCost: 450,
      reason: { workOrderId: woId },
      createdAt: at('2026-03-02T07:00:00Z'),
    },
    {
      companyId: acme.companyId,
      type: 'used',
      quantity: 1,
      unitCost: 100,
      createdAt: at('2026-03-02T08:00:00Z'),
    },
    {
      companyId: acme.companyId,
      type: 'add',
      quantity: 9,
      unitCost: 100,
      createdAt: at('2026-03-02T08:00:00Z'),
    },
  ]);
  const downtime = (asset, startedAt, endedAt) => ({
    companyId: acme.companyId,
    plantId: asset.plantId,
    assetId: asset._id,
    startedAt: at(startedAt),
    endedAt: endedAt ? at(endedAt) : null,
  });
  await Model('downtimes').collection.insertMany([
    downtime(cmp1, '2026-03-10T05:00:00Z', '2026-03-10T07:00:00Z'), // 1 h inside 06:00–10:00
    downtime(incomer, '2026-03-10T09:00:00Z', null), // still open: until now = 09:30
    downtime(cmp1, '2026-03-10T04:00:00Z', '2026-03-10T05:00:00Z'), // before the range
    downtime(cmp2, '2026-04-10T18:00:00Z', '2026-04-10T19:00:00Z'), // 23:30–00:30 IST
  ]);
});
afterAll(teardownDatabase);

describe('tariffs and periods', () => {
  const dayMs = (iso) => DateTime.fromISO(iso, { zone: ZONE }).startOf('day').toMillis();

  it('picks the tariff valid on the local day', () => {
    expect(tariffOn(pune, dayMs('2026-06-30'))).toBe(7.8);
    expect(tariffOn(pune, dayMs('2026-07-01'))).toBe(8.4);
    expect(tariffOn(pune, dayMs('2025-12-31'))).toBeNull();
    const deleted = {
      energyData: { energyCostHistory: [{ value: 9, addedDate: '2026-01-01', deleted: true }] },
    };
    expect(tariffOn(deleted, dayMs('2026-03-01'))).toBeNull();
  });

  it('builds period-to-date and previous periods in the company zone', () => {
    expect(periodRange('day', ZONE, NOW)).toMatchObject({ key: 'day:2026-10-15', stop: NOW });
    const week = periodRange('week', ZONE, NOW);
    expect(week.key).toBe('week:2026-W42');
    expect(week.start.toISOString()).toBe('2026-10-11T18:30:00.000Z'); // Monday 00:00 IST
    const lastMonth = periodRange('month', ZONE, NOW, { previous: true });
    expect(lastMonth).toMatchObject({ key: 'month:2026-09', label: 'September 2026' });
    expect(lastMonth.stop.toISOString()).toBe('2026-09-30T18:30:00.000Z');
  });
});

describe('energy', () => {
  it('prices each 15-minute window at the tariff of its day across the 1 Jul change', async () => {
    const energySeries = vi.fn(async (_companyId, ids) => ({
      series: [
        {
          assetId: ids[0],
          field: 'ENERGY CONSUMPTION',
          points: [
            [Date.parse('2026-06-30T18:30:00Z'), 10], // stamped 1 Jul 00:00 IST = window 23:45–00:00 of 30 Jun
            [Date.parse('2026-06-30T18:45:00Z'), 10], // 1 Jul 00:00–00:15
          ],
        },
      ],
    }));
    const summary = await costSummary(
      sys,
      {
        start: '2026-06-30T00:00:00+05:30',
        stop: '2026-07-02T00:00:00+05:30',
        groupBy: 'day',
        components: ['energy'],
      },
      { energySeries },
    );
    expect(energySeries.mock.calls[0][1]).not.toContain(String(incomer._id)); // the incomer double counts
    expect(summary.rows.map((r) => [r.key, r.energy])).toEqual([
      ['2026-06-30', 78],
      ['2026-07-01', 84],
    ]);
    expect(summary.totals).toMatchObject({
      energy: 162,
      total: 162,
      kwh: 20,
      spares: null,
      maintenance: null,
    });
    expect(summary.currency.symbol).toBe('₹');
  });

  it('notes days without a tariff and an unreachable Influx', async () => {
    const point = {
      energySeries: async (_c, ids) => ({
        series: [{ assetId: ids[0], points: [[Date.parse('2025-12-31T06:00:00Z'), 5]] }],
      }),
    };
    const noTariff = await costSummary(
      sys,
      { start: '2025-12-31T00:00:00Z', stop: '2026-01-01T00:00:00Z', components: ['energy'] },
      point,
    );
    expect(noTariff.totals).toMatchObject({ energy: 0, kwh: 5 });
    expect(noTariff.notes[0]).toMatch(/No energy tariff for 2025-12-31/);

    const offline = await costSummary(
      sys,
      { start: '2026-03-02T00:00:00Z', stop: '2026-03-03T00:00:00Z' },
      { energySeries: async () => Promise.reject(new Error('ECONNREFUSED')) },
    );
    expect(offline.totals.energy).toBeNull();
    expect(offline.notes).toContain('Energy unavailable (telemetry offline)');
    expect(offline.totals.labour).toBe(1817.67);
  });

  it('ends a range reaching now at the next 15-minute boundary, so open ranges share one query', async () => {
    const energySeries = vi.fn(async () => ({ series: [] }));
    const now = '2026-03-10T09:37:12.345Z';
    const start = '2026-03-01T00:00:00Z';
    await costSummary(sys, { start, stop: now, now, components: ['energy'] }, { energySeries });
    await costSummary(
      sys,
      { start, stop: '2026-04-01T00:00:00Z', now, components: ['energy'] },
      { energySeries },
    );
    await costSummary(
      sys,
      { start, stop: '2026-03-05T00:00:00Z', now, components: ['energy'] },
      { energySeries },
    );
    expect(energySeries.mock.calls.map((c) => c[3].stop.toISOString())).toEqual([
      '2026-03-10T09:45:00.000Z',
      '2026-03-10T09:45:00.000Z',
      '2026-03-05T00:00:00.000Z',
    ]);
  });
});

describe('maintenance costs', () => {
  const range = { start: '2026-03-02T00:00:00Z', stop: '2026-03-03T00:00:00Z' };

  it('labour = HH:MM:SS × people × labour rate', async () => {
    const summary = await costSummary(sys, { ...range, components: ['labour'] }, noEnergy);
    expect(summary.totals).toMatchObject({
      labour: 1817.67,
      maintenance: 1817.67,
      total: 1817.67,
      labourHours: 5.19,
    });
  });

  it('groups spares, consumables and labour by asset, category, plant and component', async () => {
    const opts = { ...range, components: ['spares', 'consumables', 'labour'] };
    const consumables = 3 * consumable.price;
    const byAsset = await costSummary(sys, { ...opts, groupBy: 'asset' }, noEnergy);
    expect(byAsset.rows).toEqual([
      expect.objectContaining({
        key: String(cmp1._id),
        label: 'Compressor 1',
        spares: 900,
        consumables,
        labour: 1817.67,
        energy: null,
        total: Number((900 + consumables + 1817.67).toFixed(2)),
      }),
      expect.objectContaining({ key: 'unassigned', label: 'Unassigned', spares: 100, total: 100 }),
    ]);
    const byCategory = await costSummary(sys, { ...opts, groupBy: 'category' }, noEnergy);
    expect(byCategory.rows.map((r) => r.label)).toEqual(['Mechanical', 'Uncategorised']);
    const byPlant = await costSummary(sys, { ...opts, groupBy: 'plant' }, noEnergy);
    expect(byPlant.rows.map((r) => r.label)).toEqual(['Pune Plant', 'No plant']);
    const byComponent = await costSummary(sys, { ...opts, groupBy: 'component' }, noEnergy);
    expect(byComponent.rows.map((r) => [r.key, r.total]).sort()).toEqual(
      [
        ['consumables', consumables],
        ['labour', 1817.67],
        ['spares', 1000],
      ].sort(),
    );
    const totals = byComponent.rows.map((r) => r.total);
    expect(totals).toEqual([...totals].sort((a, b) => b - a));
    expect(byComponent.totals.maintenance).toBe(byAsset.totals.maintenance);
  });

  it('a deleted work order adds no labour or consumables, but its used spares still count', async () => {
    const deletedWo = new mongoose.Types.ObjectId();
    await Model('workorders').collection.insertOne({
      _id: deletedWo,
      companyId: acme.companyId,
      plantId: pune._id,
      name: 'Created by mistake',
      asset: cmp1._id,
      people: [],
      consumablesAndTools: [{ consumable: consumable._id, quantity: 5 }],
      durations: { timeInProgress: '03:00:00' },
      trackProcess: { completedAt: at('2026-02-10T06:00:00Z') },
      deleted: true,
    });
    await Model('sparepartstransactions').collection.insertOne({
      companyId: acme.companyId,
      type: 'used',
      quantity: 1,
      unitCost: 200,
      reason: { workOrderId: deletedWo },
      createdAt: at('2026-02-10T07:00:00Z'),
    });
    const summary = await costSummary(
      sys,
      {
        start: '2026-02-10T00:00:00Z',
        stop: '2026-02-11T00:00:00Z',
        components: ['spares', 'consumables', 'labour'],
      },
      noEnergy,
    );
    expect(summary.totals).toMatchObject({ labour: 0, consumables: 0, spares: 200, labourHours: 0 });
    expect(summary.rows.map((r) => r.label)).toEqual(['Compressor 1']);
  });
});

describe('downtime', () => {
  it('clips downtime to the range and uses the asset rate, else the company default', async () => {
    const summary = await costSummary(
      sys,
      {
        start: '2026-03-10T06:00:00Z',
        stop: '2026-03-10T10:00:00Z',
        now: '2026-03-10T09:30:00Z',
        components: ['downtime'],
      },
      noEnergy,
    );
    expect(summary.totals).toMatchObject({ downtime: 2000 + 1500, downtimeHours: 1.5, total: 3500 });
    expect(summary.rows.map((r) => [r.label, r.downtime])).toEqual([
      ['Compressor 1', 2000],
      ['Main Incomer', 1500],
    ]);
  });

  it('splits a stop across local midnight for groupBy day', async () => {
    const summary = await costSummary(
      sys,
      {
        start: '2026-04-10T00:00:00Z',
        stop: '2026-04-12T00:00:00Z',
        groupBy: 'day',
        components: ['downtime'],
        assetIds: [String(cmp2._id)], // the incomer stop opened in March is still running
      },
      noEnergy,
    );
    expect(summary.rows.map((r) => [r.key, r.downtime])).toEqual([
      ['2026-04-10', 1000],
      ['2026-04-11', 1000],
    ]);
  });
});

describe('tenancy', () => {
  const march = {
    start: '2026-03-01T00:00:00Z',
    stop: '2026-03-31T00:00:00Z',
    components: ['spares', 'labour', 'downtime'],
  };

  it('another company sees none of these costs', async () => {
    const summary = await costSummary(await systemContext(beta.companyId), march, noEnergy);
    expect(summary.rows).toEqual([]);
    expect(summary.totals.total).toBe(0);
  });

  it('a plant lock keeps other plants and unassigned stock movements out, even when asked by plantId', async () => {
    const puneAdmin = await contextFor('plant_manager_1@acme.test');
    const mine = await costSummary(puneAdmin, march, noEnergy);
    expect(mine.rows.map((r) => r.key)).not.toContain('unassigned');
    expect(mine.totals.spares).toBe(900);
    const chennaiAdmin = await contextFor('plant_manager_2@acme.test');
    const other = await costSummary(chennaiAdmin, { ...march, plantId: String(pune._id) }, noEnergy);
    expect(other.totals.total).toBe(0);
    const own = await costSummary(chennaiAdmin, { ...march, plantId: String(chennai._id) }, noEnergy);
    expect(own.totals.total).toBe(0);
  });

  it('rejects bad input', async () => {
    await expect(costSummary(sys, { start: '2026-03-02', stop: '2026-03-01' })).rejects.toMatchObject({
      status: 400,
    });
    await expect(costSummary(sys, { ...march, components: ['tea'] })).rejects.toMatchObject({ status: 400 });
    await expect(costSummary(sys, { ...march, assetIds: ['nope'] })).rejects.toMatchObject({ status: 400 });
  });
});

describe('cost_summary tool', () => {
  it('returns rows, money totals for the model and a stacked bar by component', async () => {
    const tool = costTools.find((t) => t.name === 'cost_summary');
    const args = tool.schema.parse({
      start: '2026-03-02T00:00:00Z',
      stop: '2026-03-03T00:00:00Z',
      components: ['spares', 'labour'],
    });
    const out = await tool.run(sys, args);
    expect(out.forModel.totalsText).toMatchObject({ labour: '₹1,818', spares: '₹1,000', energy: null });
    expect(out.data.rows).toHaveLength(2);
    expect(out.data.columns).toEqual([
      { key: 'label', label: 'Asset' },
      { key: 'spares', label: 'Spare parts', unit: '₹' },
      { key: 'labour', label: 'Labour', unit: '₹' },
      { key: 'total', label: 'Total', unit: '₹' },
    ]);
    expect(out.blocks[0].payload).toMatchObject({ type: 'stackedBar', xKey: 'label' });
    expect(out.blocks[0].payload.series.map((s) => s.key)).toEqual(['spares', 'labour']);
  });
});
