import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { subtractIntervals } from '../src/planning/intervals.js';
import { planProduction, proposeProduction } from '../src/planning/production.js';
import { contextFor, NOW, setupDatabase, teardownDatabase } from './helpers/db.js';

const H = 3_600_000;
const T0 = new Date('2026-10-19T00:00:00Z');
const t = (h) => new Date(T0.getTime() + h * H);
const span = (a, b) => ({ start: t(a), end: t(b) });

/** A machine working `working` (hours from T0), at 100 % efficiency unless told otherwise. */
const machine = (assetId, { working = [span(0, 1000)], bookings = [], ...rest } = {}) => ({
  assetId,
  name: assetId.toUpperCase(),
  assetTag: assetId,
  typeOfAsset: 'Injection Moulding Machine',
  plantId: 'p1',
  efficiency: 1,
  efficiencySource: 'history',
  mountedToolId: null,
  openAnomalies: [],
  dueTasks: [],
  working,
  bookings,
  free: subtractIntervals(working, bookings),
  ...rest,
});
/** A mould: 1 part per 36 s shot = 100 pcs/h at full efficiency. */
const tool = (toolId, assets, { perShot = 1, cycleSec = 36, setupMin = 60, busy = [], ...rest } = {}) => ({
  toolId,
  toolNumber: toolId.toUpperCase(),
  name: `${toolId} mould`,
  status: 'In Service',
  assets,
  cycleSec,
  setupMin,
  parts: [{ id: `${toolId}-part`, partName: 'Housing-A', perShot, weight: 85 }],
  shotCount: 0,
  maxShotLife: null,
  busy,
  free: subtractIntervals([span(0, 1000)], busy),
  ...rest,
});
const calendar = (machines, tools) => ({
  start: T0,
  end: t(1000),
  timeZone: 'UTC',
  dateFormat: 'DD-MM-YYYY',
  machines,
  tools,
});
const plan = (cal, input) =>
  planProduction(cal, { partName: 'Housing-A', rejectionPct: 0, ...input }, { now: T0 });

describe('planProduction', () => {
  it('meets the due date with slack and emits plan + job card ops', () => {
    const p = plan(calendar([machine('m1')], [tool('t1', ['m1'])]), { quantity: 1000, dueDate: t(20) });
    expect(p.feasibility).toMatchObject({ feasible: true, slackHours: 9, shortfall: 0 });
    expect(p.feasibility.projectedFinish).toEqual(t(11)); // 1 h changeover + 10 h moulding
    expect(p.ops.map((o) => [o.seq, o.op, o.module])).toEqual([
      [0, 'create', 'productionplans'],
      [1, 'create', 'jobcards'],
    ]);
    expect(p.ops[1].data).toMatchObject({
      asset: 'm1',
      tool: 't1',
      productionPlanId: '$op:0',
      target: 1000,
      startDate: t(0),
      endDate: t(11),
      jobName: 'Housing-A – stock',
      operations: [{ operationName: 'Moulding', assetId: 'm1', cycleTime: 36 }],
    });
    expect(p.diff.bars.map((b) => [b.kind, b.ghost, b.change])).toEqual([
      ['setup', true, 'new'],
      ['jobcard', true, 'new'],
    ]);
    expect(p.alternatives).toEqual([]);
  });

  it('reports a shortfall with alternatives (extra shift, partial delivery)', () => {
    const dayShifts = [span(0, 12), span(24, 36), span(48, 60), span(72, 84)];
    const cal = calendar([machine('m1', { working: dayShifts })], [tool('t1', ['m1'])]);
    const extra = calendar([machine('m1')], [tool('t1', ['m1'])]);
    const p = planProduction(
      cal,
      { partName: 'housing-a', quantity: 2000, dueDate: t(22), rejectionPct: 0 },
      { now: T0, extraCalendar: extra },
    );
    expect(p.feasibility).toMatchObject({ feasible: false, shortfall: 900, slackHours: -11 });
    expect(p.feasibility.projectedFinish).toEqual(t(33));
    expect(p.risks).toContainEqual(expect.objectContaining({ kind: 'late', severity: 'critical' }));
    const kinds = Object.fromEntries(p.alternatives.map((a) => [a.kind, a]));
    expect(kinds.extra_shift.projectedFinish).toEqual(t(21));
    expect(kinds.extra_shift.text).toContain('(on time)');
    expect(kinds.partial_delivery).toMatchObject({ extraParts: 1100, projectedFinish: t(33) });
  });

  it('puts one mould per machine and lists the mould left out', () => {
    const p = plan(calendar([machine('m1')], [tool('t1', ['m1']), tool('t2', ['m1'])]), {
      quantity: 500,
      dueDate: t(48),
    });
    expect(p.jobCards).toHaveLength(1);
    const both = plan(
      calendar(
        [machine('m1', { efficiency: 0.8 }), machine('m2')],
        [tool('t1', ['m1']), tool('t2', ['m1', 'm2'])],
      ),
      { quantity: 4000, dueDate: t(48) },
    );
    expect(both.jobCards.map((j) => [j.toolId, j.assetId]).sort()).toEqual([
      ['t1', 'm1'],
      ['t2', 'm2'],
    ]);
  });

  it('keeps one plan in one plant (the strongest mould’s)', () => {
    const p = plan(
      calendar(
        [machine('m1'), machine('m2', { plantId: 'p2', efficiency: 0.5 })],
        [tool('t1', ['m1']), tool('t2', ['m2'])],
      ),
      { quantity: 500, dueDate: t(48) },
    );
    expect(p.jobCards.map((j) => j.assetId)).toEqual(['m1']);
    expect(p).toMatchObject({ plantId: 'p1', assetIds: ['m1'] });
  });

  it('counts setup only on a mould change and appends after the last job card', () => {
    const booking = { kind: 'jobcard', id: 'jc1', code: 'JC-1', start: t(0), end: t(5), toolId: 't1' };
    const p = plan(
      calendar(
        [machine('m1', { bookings: [booking], mountedToolId: 't9' }), machine('m2', { mountedToolId: 't2' })],
        [tool('t1', ['m1'], { busy: [{ ...booking, assetId: 'm1', jobCardId: 'jc1' }] }), tool('t2', ['m2'])],
      ),
      { quantity: 1000, dueDate: t(100) },
    );
    const byTool = Object.fromEntries(p.jobCards.map((j) => [j.toolId, j]));
    expect(byTool.t1).toMatchObject({ assetId: 'm1', setupMin: 0, start: t(5) }); // T1 still mounted after JC-1
    expect(byTool.t2).toMatchObject({ assetId: 'm2', setupMin: 0, start: t(0) });
    const change = plan(calendar([machine('m1', { mountedToolId: 't9' })], [tool('t1', ['m1'])]), {
      quantity: 100,
      dueDate: t(100),
    });
    expect(change.jobCards[0].setupMin).toBe(60);
  });

  it('splits across the three Housing-A moulds by capacity so they finish together', () => {
    const cal = calendar(
      ['m1', 'm2', 'm3'].map((id) => machine(id, { mountedToolId: `t${id.slice(1)}` })),
      [
        tool('t1', ['m1'], { perShot: 2, cycleSec: 32 }),
        tool('t2', ['m2'], { perShot: 2, cycleSec: 30 }),
        tool('t3', ['m3'], { perShot: 4, cycleSec: 38 }),
      ],
    );
    const p = plan(cal, { quantity: 50_000, dueDate: t(100) });
    expect(p.jobCards).toHaveLength(3);
    expect(p.jobCards.reduce((s, j) => s + j.target, 0)).toBe(50_000);
    const ends = p.jobCards.map((j) => j.end.getTime());
    expect(Math.max(...ends) - Math.min(...ends)).toBeLessThan(0.1 * H);
    const t3 = p.jobCards.find((j) => j.toolId === 't3');
    expect(t3.target).toBeGreaterThan(p.jobCards.find((j) => j.toolId === 't1').target);
    expect(p.feasibility.feasible).toBe(true);
  });

  it('avoids a machine with a critical anomaly and flags risks on the chosen one', () => {
    const p = plan(
      calendar(
        [
          machine('m1', {
            openAnomalies: [{ id: 'a1', code: 'ANM-5', severity: 'critical', summary: 'Hot' }],
          }),
          machine('m2', {
            openAnomalies: [{ id: 'a2', code: 'ANM-2', severity: 'warning', summary: 'Noisy' }],
            dueTasks: [{ kind: 'pm', id: 'pm1', code: 'PM-1', name: 'Monthly PM', due: t(3) }],
          }),
        ],
        [tool('t1', ['m1', 'm2'])],
      ),
      { quantity: 500, dueDate: t(48) },
    );
    expect(p.jobCards[0].assetId).toBe('m2');
    expect(p.risks.map((r) => r.kind).sort()).toEqual(['anomaly', 'pm_due']);
    expect(p.risks.find((r) => r.kind === 'pm_due').text).toBe(
      'PM-1 (Monthly PM) is due on M2 on 19-10-2026',
    );
  });

  it('refuses a part no mould makes', () => {
    expect(() =>
      plan(calendar([machine('m1')], [tool('t1', ['m1'])]), {
        partName: 'Widget',
        quantity: 1,
        dueDate: t(9),
      }),
    ).toThrow('No mould makes "Widget"');
  });
});

describe('proposeProduction (seeded Acme)', () => {
  let owner;
  beforeAll(async () => {
    await setupDatabase();
    owner = await contextFor('owner_1@acme.test');
  });
  afterAll(teardownDatabase);

  it('plans Housing-A on the Pune moulds as a draft proposal', async () => {
    const dueDate = new Date(NOW.getTime() + 10 * 86_400_000);
    const p = await proposeProduction(
      owner,
      { partName: 'housing-a', quantity: 5000, dueDate },
      { now: NOW },
    );
    expect(p).toMatchObject({ kind: 'production', status: 'draft', proposalCode: 'PLN-1' });
    expect(p.title).toMatch(/^5,000 × Housing-A by /);
    const cards = p.ops.filter((o) => o.module === 'jobcards');
    expect(cards.length).toBeGreaterThan(0);
    expect(cards.reduce((s, o) => s + o.data.target, 0)).toBe(5000);
    expect(new Set(cards.map((o) => o.data.asset)).size).toBe(cards.length);
    expect(p.feasibility.feasible).toBe(true);
    expect(p.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('answers 400 with the known parts for an unknown part', async () => {
    await expect(
      proposeProduction(
        owner,
        { partName: 'Widget', quantity: 10, dueDate: new Date(NOW.getTime() + 86_400_000) },
        { now: NOW },
      ),
    ).rejects.toMatchObject({ status: 400, details: { parts: expect.arrayContaining(['Housing-A']) } });
  });
});
