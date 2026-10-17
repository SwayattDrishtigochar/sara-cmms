import { DateTime } from 'luxon';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assetRef,
  assetRefs,
  closest,
  editDistance,
  fillPlaceholders,
  fuzzyScore,
  refKey,
  timeWindow,
} from '../src/agent/tools/common.js';
import { buildPage, moduleOfCode } from '../src/agent/tools/navigate.js';
import { getTool, unknownToolError } from '../src/agent/tools/registry.js';
import { resolveRecords } from '../src/agent/tools/resolve.js';
import { getModule } from '../src/modules/registry.js';
import { contextFor, setupDatabase, teardownDatabase } from './helpers/db.js';

/** Forgiving tool inputs: the live model sends codes, names, phrases and placeholders; tools must cope. */

let ctx;
let imm1;
let imm2;
let fur2;
let wo;
const io = () => ({ emit: () => {}, results: new Map(), callId: 't_x' });
const run = (name, args, extra = {}) => {
  const tool = getTool(name);
  const parsed = tool.schema.parse(args);
  return tool.run(ctx, parsed, { ...io(), ...extra });
};

beforeAll(async () => {
  await setupDatabase();
  ctx = await contextFor('owner_1@acme.test');
  const Asset = getModule('assets').Model;
  imm1 = await Asset.findOne({ companyId: ctx.companyId, name: 'IMM 1' }).lean();
  imm2 = await Asset.findOne({ companyId: ctx.companyId, name: 'IMM 2' }).lean();
  fur2 = await Asset.findOne({ companyId: ctx.companyId, name: 'Furnace 2' }).lean();
  // A work order whose code is unique in the company (fixture codes restart per plant).
  const WorkOrder = getModule('workorders').Model;
  const codes = await WorkOrder.aggregate([
    { $match: { companyId: ctx.companyId, asset: { $exists: true } } },
    { $group: { _id: '$workOrderId', n: { $sum: 1 } } },
    { $match: { n: 1 } },
    { $limit: 1 },
  ]);
  wo = await WorkOrder.findOne({ companyId: ctx.companyId, workOrderId: codes[0]._id }).lean();
});
afterAll(teardownDatabase);

describe('time windows', () => {
  const day = (d) => DateTime.fromJSDate(d, { zone: 'Asia/Kolkata' });

  it('accepts ISO, date-only, company-format dates, epochs and a missing stop', () => {
    const w = timeWindow({ start: '2026-10-01T00:00:00Z', stop: '2026-10-02T00:00:00Z' }, { ctx });
    expect(w.stop - w.start).toBe(86_400_000);
    const dmy = timeWindow({ start: '17-10-2026', stop: '17-10-2026' }, { ctx });
    expect(day(dmy.start).toISODate()).toBe('2026-10-17');
    expect(day(dmy.stop).toISODate()).toBe('2026-10-18'); // stop on a date = end of that day
    const ymd = timeWindow({ start: '2026-10-10', stop: '2026-10-12' }, { ctx });
    expect(day(ymd.stop).toISODate()).toBe('2026-10-13');
    const open = timeWindow({ start: '2026-10-01' }, { ctx });
    expect(open.stop.getTime()).toBeGreaterThan(Date.now() - 5000);
    const secs = timeWindow({ start: String(Math.floor(Date.now() / 1000) - 3600) }, { ctx });
    expect(Date.now() - secs.start.getTime()).toBeLessThan(3_700_000);
  });

  it('understands phrases and swaps a reversed pair instead of refusing', () => {
    const today = timeWindow({ start: 'today' }, { ctx });
    expect(day(today.start).toISODate()).toBe(day(new Date()).toISODate());
    expect(today.label).toMatch(/^Today/);
    const three = timeWindow({ start: 'last 3 days', stop: 'now' }, { ctx });
    expect(Math.round((three.stop - three.start) / 3_600_000)).toBe(72);
    const swapped = timeWindow({ start: '2026-10-05', stop: '2026-10-01' }, { ctx });
    expect(swapped.start < swapped.stop).toBe(true);
    const defaults = timeWindow({}, { ctx, defaultDays: 7 });
    expect(Math.round((defaults.stop - defaults.start) / 86_400_000)).toBe(7);
  });

  it('reads "$start"/"$stop" from the latest resolve_time_range of the turn, else today', () => {
    const results = new Map();
    results.set('t_1', {
      data: {
        start: '2026-09-01T00:00:00.000Z',
        stop: '2026-09-08T00:00:00.000Z',
        label: 'x',
        timeZone: 'Asia/Kolkata',
      },
    });
    const w = timeWindow({ start: '$start', stop: '$stop' }, { ctx, io: { results } });
    expect(w.start.toISOString()).toBe('2026-09-01T00:00:00.000Z');
    expect(w.stop.toISOString()).toBe('2026-09-08T00:00:00.000Z');
    const bare = timeWindow({ start: '$start', stop: '$end' }, { ctx });
    expect(day(bare.start).toISODate()).toBe(day(new Date()).toISODate());
    expect(bare.stop.getTime()).toBeGreaterThan(Date.now() - 5000);
    const filled = fillPlaceholders(
      {
        module: 'workorders',
        filter: { createdAt: { $gte: '$start', $lt: '$stop' } },
        keep: ['$notaplaceholder'],
      },
      { ctx, io: { results } },
    );
    expect(filled.filter.createdAt).toEqual({
      $gte: '2026-09-01T00:00:00.000Z',
      $lt: '2026-09-08T00:00:00.000Z',
    });
    expect(filled.keep).toEqual(['$notaplaceholder']);
  });
});

describe('fuzzy helpers', () => {
  it('normalises references and measures closeness', () => {
    expect(refKey('IMM-01')).toBe('imm1');
    expect(refKey(' Imm 1 ')).toBe('imm1');
    expect(refKey('Furnace 2')).toBe('furnace2');
    expect(editDistance('rakesh', 'ramesh')).toBe(1);
    expect(fuzzyScore('Rakesh Kumar', 'Ramesh Kumar')).toBe(1);
    expect(fuzzyScore('Rakesh Kumar', 'Ganesh Jadhav')).toBe(0);
    expect(closest('IMM 9', ['IMM 1', 'IMM 2', 'Press 1'])).toEqual(['IMM 1', 'IMM 2']);
    expect(closest('zzqqxx', ['IMM 1', 'Press 1'])).toEqual([]);
  });
});

describe('asset references', () => {
  it('accepts ids, codes, names in any spelling, lists mixing them and "all"', async () => {
    expect(String((await assetRef(ctx, String(imm1._id)))._id)).toBe(String(imm1._id));
    expect((await assetRef(ctx, 'IMM-01')).name).toBe('IMM 1');
    expect((await assetRef(ctx, 'imm 1')).name).toBe('IMM 1');
    expect((await assetRef(ctx, 'Imm01')).name).toBe('IMM 1');
    expect((await assetRef(ctx, 'furnace 2')).name).toBe('Furnace 2');
    const mixed = await assetRefs(ctx, ['IMM-02', 'imm 1', String(fur2._id), 'IMM 1']);
    expect(mixed.map((a) => a.name).sort()).toEqual(['Furnace 2', 'IMM 1', 'IMM 2']);
    const all = await assetRefs(ctx, 'all', { max: 5 });
    expect(all).toHaveLength(5);
    expect((await assetRefs(ctx, undefined, { max: 3 })).length).toBe(3);
    const compressors = await assetRefs(ctx, 'compressors');
    expect(compressors.length).toBeGreaterThan(1);
    expect(compressors.every((a) => a.typeOfAsset === 'Compressor')).toBe(true);
  });

  it('follows the id of a record that points at an asset, and suggests names for unknown refs', async () => {
    const viaWo = await assetRef(ctx, String(wo._id));
    expect(String(viaWo._id)).toBe(String(wo.asset));
    await expect(assetRef(ctx, 'IMM 9')).rejects.toThrow(/did you mean IMM 1/);
    await expect(assetRef(ctx, 'zzqqxx')).rejects.toThrow(/Asset not found: "zzqqxx"\. Assets: /);
    await expect(assetRef(ctx, '6ad2fa11aeb74d7544981197')).rejects.toThrow(
      /not one of your assets|Asset not found/,
    );
  });

  it('every asset-taking tool resolves names and codes', async () => {
    const latest = await run('telemetry_latest', { assetIds: ['imm 1', 'IMM-02'] });
    expect(latest.data.rows.map((r) => r.asset).sort()).toEqual(['IMM 1', 'IMM 2']);
    const one = await run('telemetry_latest', { assetId: 'furnace 2' });
    expect(one.data.rows[0].asset).toBe('Furnace 2');
    const health = await run('machine_health', { assetId: 'IMM-02' });
    expect(health.forModel.asset.name).toBe('IMM 2');
    const timeline = await run('telemetry_status_timeline', { assetId: 'imm 2', start: 'today' });
    expect(timeline.forModel.asset).toBe('IMM 2');
    const energy = await run('energy_consumption', { assetIds: ['all'], start: 'yesterday', stop: 'today' });
    expect(energy.forModel.assets.length).toBeGreaterThan(2);
    const downtime = await run('downtime_summary', { start: 'last 7 days', assetId: 'IMM 1' });
    expect(downtime.forModel.timeRange).toBeTruthy();
    const anomalies = await run('list_anomalies', { assetId: 'IMM-01' });
    expect(anomalies.forModel.state).toBe('active');
  });
});

describe('resolve', () => {
  it('matches exactly when it can and fuzzily when it must', async () => {
    const exact = await resolveRecords(ctx, { kind: 'user', query: 'Ramesh Kumar' });
    expect(exact.matches[0].label).toMatch(/Ramesh Kumar/);
    expect(exact.fuzzy).toBeUndefined();
    const typo = await resolveRecords(ctx, { kind: 'user', query: 'Rakesh Kumar' });
    expect(typo.matches[0].label).toMatch(/Ramesh Kumar/);
    expect(typo.fuzzy).toBe(true);
    expect(typo.hint).toMatch(/closest is .*Ramesh Kumar/);
    const code = await resolveRecords(ctx, { kind: 'asset', query: 'IMM-01' });
    expect(code.matches[0].label).toMatch(/IMM 1/);
    const none = await resolveRecords(ctx, { kind: 'asset', query: 'zzqqxx' });
    expect(none.matches).toEqual([]);
    expect(none.hint).toMatch(/No assets match/);
  });

  it('job_card_progress takes a code, a part name or a machine', async () => {
    const JobCard = getModule('jobcards').Model;
    const live = await JobCard.findOne({
      companyId: ctx.companyId,
      asset: imm1._id,
      jobStatus: 'In Progress',
    }).lean();
    expect(live).toBeTruthy();
    const byCode = await run('job_card_progress', { jobCard: live.jobCardId });
    expect(byCode.forModel.jobCard).toBe(live.jobCardId);
    const byMachine = await run('job_card_progress', { jobCard: 'IMM 1' });
    expect(byMachine.forModel.jobCard).toBe(live.jobCardId);
    if (live.partName) {
      const byPart = await run('job_card_progress', { jobCard: `JC-${live.partName.replace(/\s+/g, '')}` });
      expect(byPart.forModel.partName).toBe(live.partName);
    }
    await expect(run('job_card_progress', { jobCard: 'JC-zzqq' })).rejects.toThrow(/not found/);
  });
});

describe('unknown tool hints', () => {
  it('points at the context, module_schema or the closest tool with an example', () => {
    expect(unknownToolError('plantId_context').hint).toMatch(/already in your context/);
    expect(unknownToolError('get_current_user').hint).toMatch(/already in your context/);
    expect(unknownToolError('usergroups_schema').hint).toBe('Use module_schema({ module: "usergroups" })');
    const near = unknownToolError('mongo_fnd');
    expect(near.error).toBe('Unknown tool "mongo_fnd"');
    expect(near.hint).toMatch(/Did you mean mongo_find\? Example: \{ module: "workorders"/);
    expect(unknownToolError('list_work_orders').hint).toMatch(/Did you mean/);
  });
});

describe('open_page inference', () => {
  it('infers the module from a code prefix or the open page, and searches text filters', async () => {
    expect(moduleOfCode('WO-163')).toBe('workorders');
    expect(moduleOfCode('jc-12')).toBe('jobcards');
    expect(moduleOfCode('PM-3')).toBe('preventivemaintenances');
    expect(moduleOfCode('nope')).toBeNull();
    const byCode = await buildPage(ctx, { page: 'record', recordId: wo.workOrderId });
    expect(byCode.url).toBe(`/m/workorders/${wo._id}`);
    const context = { recordRef: { module: 'workorders', id: String(wo._id) } };
    const byContext = await buildPage(ctx, { page: 'record', recordId: String(wo._id) }, { context });
    expect(byContext.url).toBe(`/m/workorders/${wo._id}`);
    const openOne = await buildPage(ctx, { page: 'record' }, { context });
    expect(openOne.url).toBe(`/m/workorders/${wo._id}`);
    // a bare id with no module and no open page (the voice context is fixed at session start)
    const bareId = await buildPage(ctx, { page: 'record', recordId: String(wo._id) });
    expect(bareId.url).toBe(`/m/workorders/${wo._id}`);
    await expect(buildPage(ctx, { page: 'record', recordId: '6ad32be3bbb376d66e4d76e8' })).rejects.toThrow(
      /module/,
    );
    const byQ = await buildPage(ctx, {
      page: 'list',
      module: 'users',
      filters: [{ field: 'q', value: 'Amit Verma' }],
    });
    expect(byQ.url).toBe('/m/users?q=Amit+Verma');
    const people = await buildPage(ctx, {
      page: 'list',
      module: 'users',
      filters: [
        { field: 'firstName', value: 'Ramesh' },
        { field: 'employeeId', value: 'EMP-101' },
      ],
    });
    expect(people.url).toBe('/m/users?q=Ramesh+EMP-101');
    expect(people.label).toContain('"Ramesh EMP-101"');
    const machine = await buildPage(ctx, { page: 'machine', q: 'furnace 2' });
    expect(machine.url).toBe(`/machines/${fur2._id}`);
    const asRecord = await buildPage(ctx, { page: 'record', module: 'assets', recordId: 'IMM-02' });
    expect(asRecord.url).toBe(`/machines/${imm2._id}`);
    const machines = await buildPage(ctx, { page: 'machines', filters: [{ field: 'name', value: 'IMM' }] });
    expect(machines.url).toBe('/machines?q=IMM');
    const mod = getModule('workorders');
    const columns = mod.list.filter((k) => mod.fields[k]?.type === 'enum').slice(0, 3);
    const other = Object.keys(mod.fields).find((k) => mod.fields[k].type === 'enum' && !columns.includes(k));
    if (other) {
      await expect(
        buildPage(ctx, { page: 'list', module: 'workorders', filters: [{ field: other, value: 'x' }] }),
      ).rejects.toThrow(/not a filter/);
    }
  });
});

describe('audit replays', () => {
  /** The exact failing calls of owner_1's chat audit, as the live model sent them. */
  it('time phrases, placeholders and company-format dates reach every window-taking tool', async () => {
    const dt = await run('downtime_summary', { stop: 'today', start: 'today', groupBy: 'asset' });
    const today = DateTime.now().setZone('Asia/Kolkata').startOf('day');
    expect(dt.forModel.timeRange).toBe(
      `${today.toFormat('dd-MM-yyyy')} 00:00 – ${today.plus({ days: 1 }).toFormat('dd-MM-yyyy')} 00:00`,
    );
    const att = await run('attendance_summary', { start: 'today', stop: 'today' });
    expect(att.summary).toBeDefined();
    const rej = await run('rejection_summary', { groupBy: 'reason', stop: '$stop', start: '$start' });
    expect(rej.summary).toBeDefined();
    const shots = await run('telemetry_shot_counts', {
      assetId: String(imm1._id),
      start: '$start',
      groupBy: 'day',
      stop: '$stop',
    });
    expect(shots.forModel.asset).toBe('IMM 1');
    // the audit asked for a year; the cost engine caps a range at 92 days, so a month in the company format
    const cost = await run('cost_summary', { stop: '17-10-2026', groupBy: 'asset', start: '01-10-2026' });
    expect(cost.summary).toBeDefined();
    await expect(
      run('cost_summary', { stop: '17-10-2026', groupBy: 'asset', start: '17-10-2025' }),
    ).rejects.toThrow(/92 days or less/);
    for (const text of ['this past year', 'next 2 days', 'today', 'last 3 days']) {
      const range = await run('resolve_time_range', { text });
      expect(range.forModel.assumed, text).toBeUndefined();
    }
  });

  it('asset references in the audit resolve or name the alternatives', async () => {
    const energy = await run('energy_consumption', {
      assetIds: ['IMM-01'],
      groupBy: 'day',
      start: '$start',
      stop: '$stop',
    });
    expect(energy.forModel.assets).toEqual(['IMM 1']);
    const timeline = await run('telemetry_status_timeline', {
      start: '$start',
      assetId: 'IMM-01',
      stop: '$stop',
    });
    expect(timeline.forModel.asset).toBe('IMM 1');
    const all = await run('energy_consumption', {
      stop: '$stop',
      assetIds: ['all'],
      start: '$start',
      groupBy: 'asset',
    });
    expect(all.forModel.assets.length).toBeGreaterThan(2);
    // a type word where one machine is wanted: the candidates are named, not guessed
    await expect(run('machine_health', { assetId: 'compressor' })).rejects.toThrow(/Several assets match/);
    expect((await run('telemetry_latest', { assetIds: ['compressors'] })).data.rows.length).toBeGreaterThan(
      1,
    );
  });

  it('extended JSON dates in a mongo_aggregate $match work', async () => {
    const out = await run('mongo_aggregate', {
      module: 'workorders',
      pipeline: [
        {
          $match: {
            createdAt: {
              $lt: { $date: '2026-10-17T18:30:00.000Z' },
              $gte: { $date: '2020-10-16T18:30:00.000Z' },
            },
          },
        },
        { $group: { _id: '$workStatus', n: { $sum: 1 } } },
      ],
    });
    expect(out.rowCount).toBeGreaterThan(0);
  });
});
