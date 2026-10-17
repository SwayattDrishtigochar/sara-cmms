import { DateTime } from 'luxon';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { shiftWindows } from '../src/lib/shifts.js';
import { getModule } from '../src/modules/registry.js';
import { subtractIntervals } from '../src/planning/intervals.js';
import { planProduction, proposeProduction } from '../src/planning/production.js';
import { checkPlan, checkProductionPlan, editedFromProposal } from '../src/planning/productionCheck.js';
import { assignOperators } from '../src/planning/productionOperators.js';
import { applyProposal, getProposal } from '../src/planning/proposals.js';
import { dueDateOf, planningTools } from '../src/planning/tools.js';
import { planningRouter } from '../src/routes/planning.js';
import { contextFor, NOW, PASSWORD, setupDatabase, teardownDatabase } from './helpers/db.js';

/**
 * Production plan check (phase 7 §3.3). people.js keeps its pure helpers; `loadPeople` answers with a
 * fixture roster (shift windows without breaks) so the seeded tests are deterministic.
 */

const roster = { people: [] };
vi.mock('../src/planning/people.js', async (importOriginal) => ({
  ...(await importOriginal()),
  loadPeople: async () => structuredClone(roster.people),
}));

const H = 3_600_000;
const DAY = 24 * H;
const T0 = new Date('2026-10-19T00:00:00Z'); // a Monday
const t = (h) => new Date(T0.getTime() + h * H);
const span = (a, b) => ({ start: t(a), end: t(b) });
const iso = (d) => new Date(d).toISOString();

const plant = {
  _id: 'p1',
  shifts: [
    { _id: 'sA', shiftName: 'A', shiftStartTime: '06:00', shiftEndTime: '14:00', breaks: [] },
    { _id: 'sB', shiftName: 'B', shiftStartTime: '14:00', shiftEndTime: '22:00', breaks: [] },
    { _id: 'sC', shiftName: 'C', shiftStartTime: '22:00', shiftEndTime: '06:00', breaks: [] },
  ],
  runningSchedule: [],
  holidays: [],
};
const person = (
  userId,
  shiftId,
  skills = ['moulding'],
  plantDoc = plant,
  window = span(-24, 200),
  zone = 'UTC',
) => ({
  userId,
  name: userId,
  title: 'Machine Operator',
  role: 'technician',
  department: 'Production',
  skills,
  shiftId,
  shiftName: plantDoc.shifts.find((s) => String(s._id) === String(shiftId))?.shiftName ?? null,
  plantId: String(plantDoc._id),
  onShift: shiftWindows(
    { ...plantDoc, shifts: plantDoc.shifts.filter((s) => String(s._id) === String(shiftId)) },
    window.start,
    window.end,
    zone,
  ).map(({ start, end }) => ({ start, end })),
  bookings: [],
  loadHours: 0,
});
const crew = () => [
  person('ravi', 'sC'),
  person('sachin', 'sA'),
  person('vijay', 'sB'),
  person('deepak', 'sA', ['press']),
];

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
  now: T0,
  machines,
  tools,
});
/** Plans with the phase-5 planner, assigns operators and returns the EditedProductionPlan of it. */
const fresh = (cal, { quantity = 1000, dueDate = t(48) } = {}) => {
  const plan = planProduction(
    cal,
    { partName: 'Housing-A', quantity, dueDate, rejectionPct: 0 },
    { now: T0 },
  );
  const machinesById = new Map(cal.machines.map((m) => [m.assetId, m]));
  const assigned = assignOperators(plan.jobCards, { people: crew(), plant, zone: 'UTC', machinesById });
  return {
    partName: 'Housing-A',
    quantity,
    dueDate: iso(dueDate),
    rejectionPct: 0,
    jobCards: plan.jobCards.map((j) => ({
      key: j.key,
      assetId: j.assetId,
      toolId: j.toolId,
      target: j.target,
      start: iso(j.start),
      end: iso(j.end),
      operators: assigned.get(j.key).operators.map(({ userId, shiftName, start, end }) => ({
        userId,
        shiftName,
        start: iso(start),
        end: iso(end),
      })),
    })),
  };
};
const check = (cal, edited) => checkPlan(cal, edited, { now: T0, plant, zone: 'UTC', people: crew() });
/** The UI's "Apply suggestion": merges an adjustment's patch by key. */
const applyAdjustment = (edited, adj) => ({
  ...edited,
  ...(adj.patch.dueDate ? { dueDate: adj.patch.dueDate } : {}),
  ...(adj.patch.quantity ? { quantity: adj.patch.quantity } : {}),
  jobCards: edited.jobCards.map((c) => ({
    ...c,
    ...(adj.patch.jobCards?.find((p) => p.key === c.key) ?? {}),
  })),
});
const kinds = (list) => list.map((x) => x.kind);

describe('checkPlan (pure)', () => {
  it('finds a fresh plan doable with its operators on shift', () => {
    const cal = calendar([machine('m1')], [tool('t1', ['m1'])]);
    const edited = fresh(cal);
    const out = check(cal, edited);
    expect(out.verdict).toBe('doable');
    expect(out.issues).toEqual([]);
    expect(out.jobCards[0]).toMatchObject({
      key: 'op-1',
      asset: 'M1',
      tool: 'T1',
      setupMin: 60,
      shots: 1000,
      shifts: 2,
    });
    expect(out.jobCards[0].finishAt).toEqual(t(11));
    expect(out.jobCards[0].operators.map((o) => o.userId)).toEqual(['ravi', 'sachin']);
    expect(out.feasibility).toMatchObject({
      feasible: true,
      verdict: 'doable',
      slackHours: 37,
      shortfall: 0,
    });
    expect(out.bars.map((b) => [b.kind, b.conflict ?? false])).toEqual([
      ['setup', false],
      ['jobcard', false],
    ]);
  });

  it('flags a card moved onto a booked machine and the move_start suggestion makes it doable', () => {
    const booking = { kind: 'jobcard', id: 'jc1', code: 'JC-1', start: t(0), end: t(5), toolId: 't9' };
    const cal = calendar(
      [machine('m1', { bookings: [booking] }), machine('m2')],
      [
        tool('t1', ['m1', 'm2'], { busy: [] }),
        tool('t9', ['m1'], {
          busy: [{ ...booking, assetId: 'm1', jobCardId: 'jc1' }],
          parts: [{ id: 'x', partName: 'Other', perShot: 1 }],
        }),
      ],
    );
    const edited = fresh(cal);
    expect(edited.jobCards[0].assetId).toBe('m2'); // the planner avoided the booked machine
    const moved = { ...edited, jobCards: [{ ...edited.jobCards[0], assetId: 'm1' }] };
    const out = check(cal, moved);
    expect(out.verdict).toBe('adjust');
    const overlap = out.issues.find((i) => i.kind === 'machine_overlap');
    expect(overlap).toMatchObject({ severity: 'critical', jobCard: 'op-1', assetId: 'm1' });
    expect(overlap.text).toContain('JC-1');
    expect(out.jobCards[0].issues).toContain(out.issues.indexOf(overlap));
    expect(out.bars.find((b) => b.id === 'op-1').conflict).toBe(true);
    const move = out.adjustments.find((a) => a.kind === 'move_start');
    expect(move.resolves).toContain(out.issues.indexOf(overlap));
    expect(move.patch.jobCards[0]).toMatchObject({ key: 'op-1', start: iso(t(5)), end: iso(t(16)) });
    expect(out.adjustments.find((a) => a.kind === 'move_machine').patch.jobCards[0]).toMatchObject({
      assetId: 'm2',
    });
    const again = check(cal, applyAdjustment(moved, move));
    expect(again.verdict).toBe('doable');
    expect(again.issues).toEqual([]);
    expect(again.jobCards[0].operators.map((o) => o.shiftName)).toEqual(['C', 'A', 'B']);
  });

  it('lists the suggestion that resolves the most critical issues first (ids renumbered)', () => {
    const booking = { kind: 'jobcard', id: 'jc1', code: 'JC-1', start: t(0), end: t(5), toolId: 't9' };
    const cal = calendar(
      [machine('m1', { bookings: [booking] }), machine('m2')],
      [tool('t1', ['m1', 'm2'], { busy: [] })],
    );
    const edited = fresh(cal);
    // Onto the booked machine and too short: move_end alone fixes one issue, move_start fixes both.
    const card = { ...edited.jobCards[0], assetId: 'm1', start: iso(t(1)), end: iso(t(2)) };
    const out = check(cal, { ...edited, jobCards: [card] });
    const critical = (a) => a.resolves.filter((i) => out.issues[i].severity === 'critical').length;
    expect(out.adjustments.map(critical)).toEqual([...out.adjustments.map(critical)].sort((a, b) => b - a));
    expect(out.adjustments[0].kind).not.toBe('move_end');
    expect(critical(out.adjustments[0])).toBeGreaterThan(1);
    expect(out.adjustments.map((a) => a.id)).toEqual(out.adjustments.map((_, i) => `adj-${i + 1}`));
  });

  it('makes an unresolvable mould conflict not doable', () => {
    const cal = calendar(
      [machine('m1')],
      [tool('t1', ['m1']), tool('t2', ['m1'], { parts: [{ id: 'y', partName: 'Cap-B', perShot: 8 }] })],
    );
    const edited = fresh(cal);
    const out = check(cal, { ...edited, jobCards: [{ ...edited.jobCards[0], toolId: 't2' }] });
    expect(out.verdict).toBe('not_doable');
    expect(out.issues[0]).toMatchObject({ kind: 'tool_incapable', severity: 'critical' });
    expect(out.adjustments).toEqual([]);
  });

  it('catches an end that is too early and suggests the computed finish', () => {
    const cal = calendar([machine('m1')], [tool('t1', ['m1'])]);
    const edited = fresh(cal);
    const out = check(cal, { ...edited, jobCards: [{ ...edited.jobCards[0], end: iso(t(3)) }] });
    expect(kinds(out.issues)).toEqual(['too_short']);
    expect(out.verdict).toBe('adjust');
    expect(out.adjustments[0]).toMatchObject({
      kind: 'move_end',
      patch: { jobCards: [{ key: 'op-1', end: iso(t(11)) }] },
      resolves: [0],
    });
    expect(out.feasibility.projectedFinish).toEqual(t(11)); // the real finish, not the edited end
  });

  it('reports a late due date with extend_due and reduce_quantity', () => {
    const cal = calendar([machine('m1')], [tool('t1', ['m1'])]);
    const edited = fresh(cal);
    const out = check(cal, { ...edited, dueDate: iso(t(6)) });
    expect(out.verdict).toBe('adjust');
    expect(kinds(out.issues)).toEqual(['late']);
    expect(kinds(out.adjustments)).toEqual(['extend_due', 'reduce_quantity']);
    expect(out.adjustments[0].patch).toEqual({ dueDate: iso(t(11)) });
    // 1 h changeover + 5 h moulding by the due date: 500 pcs, and the card ends there.
    expect(out.adjustments[1].patch).toEqual({
      quantity: 500,
      jobCards: [{ key: 'op-1', target: 500, end: iso(t(6)) }],
    });
    expect(out.feasibility).toMatchObject({ feasible: false, shortfall: 500, slackHours: -5 });
    const fixed = check(cal, applyAdjustment({ ...edited, dueDate: iso(t(6)) }, out.adjustments[0]));
    expect(fixed.verdict).toBe('doable');
    // Taking reduce_quantity resolves the late issue too (it used to leave the card ending after the due date).
    const trimmed = check(cal, applyAdjustment({ ...edited, dueDate: iso(t(6)) }, out.adjustments[1]));
    expect(kinds(trimmed.issues)).not.toContain('late');
    expect(trimmed.verdict).toBe('doable');
    // The over-quantity trim ends each card at its new finish as well.
    const over = check(cal, { ...edited, quantity: 500 });
    expect(over.adjustments.find((a) => a.kind === 'reduce_quantity').patch.jobCards).toEqual([
      { key: 'op-1', target: 500, end: iso(t(6)) },
    ]);
  });

  it('a plan that runs around a planned work order checks unchanged as doable', () => {
    const wo = { kind: 'workorder', id: 'wo1', code: 'WO-1', start: t(10), end: t(12) };
    const cal = calendar([machine('m1', { bookings: [wo] })], [tool('t1', ['m1'])]);
    const edited = fresh(cal);
    // 1 h changeover + 10 h moulding, paused 2 h for WO-1.
    expect(edited.jobCards[0]).toMatchObject({ start: iso(t(0)), end: iso(t(13)) });
    const out = check(cal, edited);
    expect(kinds(out.issues)).not.toContain('machine_overlap');
    expect(out.verdict).toBe('doable');
    // A job card in the window is still a clash.
    const card = { kind: 'jobcard', id: 'jc1', code: 'JC-1', start: t(10), end: t(12), toolId: 't9' };
    const busy = calendar([machine('m1', { bookings: [card] })], [tool('t1', ['m1'])]);
    expect(kinds(check(busy, edited).issues)).toContain('machine_overlap');
  });

  it('counts shots at the planner’s rejection rate, not a flat 2 %', () => {
    const cal = calendar([machine('m1')], [tool('t1', ['m1'])]);
    const plan = planProduction(
      cal,
      { partName: 'Housing-A', quantity: 5000, dueDate: t(100) },
      { now: T0, rejectionRate: 0.001 },
    );
    const edited = {
      partName: 'Housing-A',
      quantity: 5000,
      dueDate: iso(t(100)),
      jobCards: plan.jobCards.map((j) => ({ ...j, start: iso(j.start), end: iso(j.end), operators: [] })),
    };
    const opts = { now: T0, plant, zone: 'UTC', people: crew() };
    const planned = checkPlan(cal, edited, { ...opts, rejectionRate: 0.001 });
    expect(kinds(planned.issues)).not.toContain('too_short');
    expect(planned.rejectionRate).toBe(0.001);
    expect(kinds(checkPlan(cal, edited, opts).issues)).toContain('too_short'); // the old flat 2 %
  });

  it('checks quantities and operators: short, busy and off-shift people get swaps', () => {
    const cal = calendar([machine('m1'), machine('m2')], [tool('t1', ['m1']), tool('t2', ['m2'])]);
    const edited = fresh(cal, { quantity: 2000 });
    expect(edited.jobCards).toHaveLength(2);
    const [a, b] = edited.jobCards;
    const out = check(cal, {
      ...edited,
      jobCards: [
        { ...a, target: a.target - 100, operators: [{ userId: 'vijay' }, { userId: 'sachin' }] }, // vijay (B) on the C segment
        { ...b, operators: [{ userId: 'ravi' }, { userId: 'sachin' }] }, // sachin twice in shift A
      ],
    });
    expect(out.issues.find((i) => i.kind === 'short')).toMatchObject({ severity: 'critical' });
    expect(out.adjustments.find((a) => a.kind === 'fill_quantity').patch.jobCards[0].target).toBeGreaterThan(
      a.target - 100,
    );
    expect(out.issues.find((i) => i.kind === 'operator_off_shift')).toMatchObject({
      userId: 'vijay',
      jobCard: 'op-1',
    });
    expect(out.issues.find((i) => i.kind === 'operator_busy')).toMatchObject({
      userId: 'sachin',
      jobCard: 'op-2',
    });
    const swaps = out.adjustments.filter((a) => a.kind === 'swap_operator');
    expect(swaps).toHaveLength(2);
    expect(swaps[0].patch.jobCards[0].operators.map((o) => o.userId)).toEqual(['ravi', 'sachin']);
    expect(swaps[1].patch.jobCards[0].operators.map((o) => o.userId)).toEqual(['ravi', 'deepak']);
    expect(out.verdict).toBe('adjust');
  });
});

describe('checkProductionPlan (seeded Acme)', () => {
  let owner;
  let pune;
  let edited;
  let proposal;
  beforeAll(async () => {
    await setupDatabase();
    owner = await contextFor('owner_1@acme.test');
    pune = owner.plants.find((p) => p.name.startsWith('Pune'));
    const users = await getModule('users')
      .Model.find({
        companyId: owner.companyId,
        department: 'Production',
        role: 'technician',
        plantId: pune._id,
      })
      .lean();
    roster.people = users.map((u) =>
      Object.assign(
        person(
          String(u._id),
          String(u.shiftId),
          ['moulding'],
          pune,
          { start: new Date(NOW.getTime() - DAY), end: new Date(NOW.getTime() + 30 * DAY) },
          'Asia/Kolkata',
        ),
        {
          name: `${u.firstName} ${u.lastName}`,
        },
      ),
    );
    proposal = await proposeProduction(
      owner,
      { partName: 'Housing-A', quantity: 3000, dueDate: new Date(NOW.getTime() + 10 * DAY) },
      { now: NOW },
    );
    edited = editedFromProposal(proposal);
  });
  afterAll(teardownDatabase);

  it('rewrites the proposal’s ops and diff from the edited cards and stores the explanation', async () => {
    const out = await checkProductionPlan(owner, edited, { now: NOW });
    expect(out.proposal._id).toEqual(proposal._id);
    expect(out.jobCards.map((c) => c.key)).toEqual(edited.jobCards.map((c) => c.key));
    expect(out.plan.proposal.code).toBe(proposal.proposalCode);
    expect(out.plan.bars.filter((b) => b.ghost).length).toBeGreaterThan(0);
    expect(out.explanation).toMatchObject({
      mock: true,
      text: expect.stringMatching(/^(Doable|Needs adjustment):/),
    });
    const stored = await getProposal(owner, proposal._id);
    expect(stored.ops).toHaveLength(edited.jobCards.length + 1);
    expect(stored.ops[1].data).toMatchObject({
      assignedTo: expect.any(Array),
      operatorPlan: expect.any(Array),
    });
    expect(stored.diff.jobCards.map((c) => c.key)).toEqual(edited.jobCards.map((c) => c.key));
    expect(stored.input.edited.quantity).toBe(3000);
    expect(stored.explanation.text).toBe(out.explanation.text);
    expect(stored.feasibility.verdict).toBe(out.verdict);
    // The check keeps the planner's rejection rate (stored with the input), never a flat 2 %.
    expect(stored.input.rejectionRate).toBe(proposal.diff.rejectionRate);
    expect(stored.diff.rejectionRate).toBe(proposal.diff.rejectionRate);
  });

  it('refuses to edit a partly applied plan (409) and dates past the planning horizon (400)', async () => {
    const other = await proposeProduction(
      owner,
      { partName: 'Housing-A', quantity: 500, dueDate: new Date(NOW.getTime() + 5 * DAY) },
      { now: NOW },
    );
    const far = { ...editedFromProposal(other), dueDate: '2099-12-31T00:00:00.000Z' };
    await expect(checkProductionPlan(owner, far, { now: NOW })).rejects.toMatchObject({ status: 400 });
    await getModule('planproposals').Model.updateOne(
      { _id: other._id },
      { $set: { status: 'failed', appliedOps: 2 } },
    );
    await expect(checkProductionPlan(owner, editedFromProposal(other), { now: NOW })).rejects.toMatchObject({
      status: 409,
      message: expect.stringMatching(/partly applied/),
    });
  });

  it('says "Needs adjustment:" for a due date the plan cannot meet', async () => {
    const out = await checkProductionPlan(
      owner,
      { ...edited, dueDate: new Date(NOW.getTime() + 2 * H).toISOString() },
      { now: NOW },
    );
    expect(out.verdict).toBe('adjust');
    expect(out.issues.map((i) => i.kind)).toContain('late');
    expect(out.adjustments.map((a) => a.kind)).toContain('extend_due');
    expect(out.explanation.text).toMatch(/^Needs adjustment:/);
  });

  it('refuses to apply a not-doable plan unless forced, then links the job cards to the plan', async () => {
    const capB = await getModule('tools')
      .Model.findOne({ companyId: owner.companyId, toolNumber: 'T-201' })
      .lean();
    const broken = {
      ...edited,
      jobCards: edited.jobCards.map((c, i) => (i === 0 ? { ...c, toolId: String(capB._id) } : c)),
    };
    const out = await checkProductionPlan(owner, broken, { now: NOW });
    expect(out.verdict).toBe('not_doable');
    expect(out.explanation.text).toMatch(/^Not doable:/);
    // Chat: no confirm card for an apply that would fail; force (the user's explicit wish) gets one.
    const apply = planningTools.find((x) => x.name === 'apply_plan');
    await expect(apply.preview(owner, { proposalId: proposal.proposalCode })).rejects.toMatchObject({
      status: 409,
      code: 'PLAN_NOT_DOABLE',
    });
    expect((await apply.preview(owner, { proposalId: proposal.proposalCode, force: true })).type).toBe(
      'confirm',
    );
    await expect(applyProposal(owner, proposal._id)).rejects.toMatchObject({
      status: 409,
      code: 'PLAN_NOT_DOABLE',
    });
    const done = await applyProposal(owner, proposal._id, { force: true });
    expect(done.proposal.status).toBe('applied');
    const planRef = done.created.find((c) => c.module === 'productionplans');
    const cards = await getModule('jobcards')
      .Model.find({ proposalId: String(proposal._id) })
      .lean();
    expect(cards).toHaveLength(edited.jobCards.length);
    expect(cards.every((c) => String(c.productionPlanId) === planRef.id)).toBe(true);
    expect(cards.some((c) => c.assignedTo.length > 0 && c.operatorPlan.length > 0)).toBe(true);
    const plan = await getModule('productionplans').Model.findById(planRef.id).lean();
    expect(plan.feasibility.verdict).toBe('not_doable');
    expect(plan.feasibility.issues.some((i) => i.severity === 'critical' && i.text)).toBe(true);
    const again = await applyProposal(owner, proposal.proposalCode, { force: true });
    expect(again.created.map((c) => c.id)).toEqual(done.created.map((c) => c.id));
    await expect(checkProductionPlan(owner, edited, { now: NOW })).rejects.toMatchObject({
      status: 409,
      code: 'CONFLICT',
    });
  });

  it('check_plan merges the chat edits into the stored plan', async () => {
    const tool = (name) => planningTools.find((t) => t.name === name);
    const planned = await tool('plan_production').run(owner, {
      part: 'Housing-A',
      quantity: 2000,
      dueDate: new Date(Date.now() + 12 * DAY).toISOString().slice(0, 10),
    });
    expect(planned.summary).toMatch(/^PLN-\d+ · \d job cards? · (doable \(|needs adjustment)/);
    expect(planned.forModel.jobCards[0]).toMatchObject({ key: 'op-1', operators: expect.any(Array) });
    const key = planned.forModel.jobCards[0].key;
    const out = await tool('check_plan').run(owner, {
      proposalId: planned.forModel.code,
      edits: { quantity: 1, jobCards: [{ key, operatorIds: [] }] },
    });
    expect(out.forModel.issues.some((t) => /job cards make/.test(t))).toBe(true);
    expect(out.forModel.adjustments.some((a) => a.kind === 'reduce_quantity')).toBe(true);
    expect(out.summary).toMatch(
      new RegExp(`^${planned.forModel.code} · (needs adjustment|not doable) · \\d+ issues?$`),
    );
    expect(out.blocks[0].payload.bars.some((b) => b.ghost)).toBe(true);
    // The model takes a suggestion by id: the stored patch is merged and the over-quantity issue is gone.
    const trim = out.forModel.adjustments.find((a) => a.kind === 'reduce_quantity');
    const taken = await tool('check_plan').run(owner, {
      proposalId: planned.forModel.code,
      edits: { adjustmentIds: [trim.id] },
    });
    expect(taken.forModel.issues.some((t) => /job cards make/.test(t))).toBe(false);
    expect(taken.forModel.verdict).not.toBe('not_doable');
    expect(taken.forModel.jobCards.reduce((s, c) => s + c.target, 0)).toBe(1);
    await expect(
      tool('check_plan').run(owner, {
        proposalId: planned.forModel.code,
        edits: { adjustmentIds: ['adj-99'] },
      }),
    ).rejects.toMatchObject({ status: 400 });
    // A check without edits adds no second copy of the plan block the plan tool showed.
    const same = await tool('check_plan').run(owner, { proposalId: planned.forModel.code, edits: {} });
    expect(same.blocks).toEqual([]);
    expect(same.forModel.verdict).toBeTruthy();
    await expect(
      tool('check_plan').run(owner, {
        proposalId: planned.forModel.code,
        edits: { jobCards: [{ key: 'op-9', target: 5 }] },
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  describe('routes', () => {
    let app;
    let token;
    beforeAll(async () => {
      app = createApp({ routers: [{ path: '/api', router: planningRouter }] });
      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: 'owner_1@acme.test', password: PASSWORD });
      token = res.body.token;
    });
    const as = () => ({ authorization: `Bearer ${token}` });

    it('plans with a check and checks an edited plan', async () => {
      const res = await request(app)
        .post('/api/planning/production')
        .set(as())
        .send({
          partName: 'Housing-A',
          quantity: 1500,
          dueDate: new Date(Date.now() + 12 * DAY).toISOString(),
        });
      expect(res.status).toBe(200);
      expect(res.body.check).toMatchObject({
        verdict: expect.stringMatching(/^(doable|adjust)$/),
        jobCards: expect.any(Array),
      });
      expect(res.body.proposal.explanation.text).toMatch(/^(Doable|Needs adjustment):/);
      expect(res.body.plan.proposal.code).toBe(res.body.proposal.proposalCode);
      const body = { ...editedFromProposal(res.body.proposal), quantity: 1 };
      const checked = await request(app).post('/api/planning/production/check').set(as()).send(body);
      expect(checked.status).toBe(200);
      expect(checked.body.issues.map((i) => i.kind)).toContain('over_quantity');
      expect(checked.body.proposal.input.edited.quantity).toBe(1);
      const bad = await request(app)
        .post('/api/planning/production/check')
        .set(as())
        .send({ ...body, jobCards: [] });
      expect(bad.status).toBe(400);
      const missing = await request(app)
        .post('/api/planning/production/check')
        .set(as())
        .send({ ...body, proposalId: 'PLN-999' });
      expect(missing.status).toBe(404);
      // A typo'd year must not make the API walk decades of shifts.
      const farEnd = { ...body.jobCards[0], end: '2099-12-31T00:00:00.000Z' };
      const far = await request(app)
        .post('/api/planning/production/check')
        .set(as())
        .send({ ...body, jobCards: [farEnd] });
      expect(far.status).toBe(400);
      const farDue = await request(app)
        .post('/api/planning/production')
        .set(as())
        .send({ partName: 'Housing-A', quantity: 10, dueDate: '2099-12-31' });
      expect(farDue.status).toBe(400);
      expect(farDue.body.error?.message ?? farDue.body.message).toMatch(/at most 90 days/);
    });
  });
});

describe('dueDateOf', () => {
  const ctx = { company: { timeZone: 'Asia/Kolkata' } };
  const saturday = DateTime.fromISO('2026-10-17T02:15:00', { zone: 'Asia/Kolkata' });
  const day = (text) =>
    DateTime.fromJSDate(dueDateOf(ctx, text, saturday), { zone: 'Asia/Kolkata' }).toFormat(
      'yyyy-MM-dd HH:mm:ss',
    );

  it('reads weekdays and "in N days" as the end of that local day', () => {
    expect(day('next Friday')).toBe('2026-10-23 23:59:59');
    expect(day('Friday')).toBe('2026-10-23 23:59:59');
    expect(day('this saturday')).toBe('2026-10-17 23:59:59');
    expect(day('next Saturday')).toBe('2026-10-24 23:59:59');
    expect(day('in 9 days')).toBe('2026-10-26 23:59:59');
    expect(day('2026-10-25')).toBe('2026-10-25 23:59:59');
  });
});
