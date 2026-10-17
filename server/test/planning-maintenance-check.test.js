import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { getModule } from '../src/modules/registry.js';
import { proposeMaintenancePlan } from '../src/planning/maintenancePlan.js';
import { checkMaintenancePlan } from '../src/planning/maintenancePlanCheck.js';
import { applyProposal, getProposal } from '../src/planning/proposals.js';
import { planningMaintenanceRouter } from '../src/routes/planningMaintenance.js';
import { contextFor, NOW, PASSWORD, setupDatabase, teardownDatabase } from './helpers/db.js';

const HOUR = 3_600_000;
const ist = (local) => new Date(`${local}:00+05:30`);
const Model = (name) => getModule(name).Model;

describe('checking an edited maintenance plan', () => {
  afterEach(() => vi.useRealTimers());
  let ctx;
  let acme;
  let press1;
  let ramesh;
  let priya;
  let proposal;
  let task;
  const edit = (patch, extra = {}) => ({
    proposalId: String(proposal._id),
    tasks: [
      {
        key: task.key,
        start: task.start,
        end: task.end,
        technicianId: task.technician?.userId ?? null,
        ...patch,
      },
    ],
    ...extra,
  });

  beforeAll(async () => {
    ({ acme } = await setupDatabase());
    ctx = await contextFor('owner_1@acme.test');
    press1 = await Model('assets').findOne({ companyId: acme.companyId, assetTag: 'PRS-01' }).lean();
    const user = (email) => Model('users').findOne({ companyId: acme.companyId, email }).lean();
    [ramesh, priya] = await Promise.all([
      user('maintenance_technician_1@acme.test'),
      user('maintenance_technician_3@acme.test'),
    ]);
    // Only the anomaly below is due on Press 1: close its seeded work and schedules.
    await Model('workorders').updateMany(
      { companyId: acme.companyId, asset: press1._id, workStatus: { $nin: ['Completed', 'Closed'] } },
      { $set: { workStatus: 'Closed' } },
    );
    for (const name of ['preventivemaintenances', 'calibrations'])
      await Model(name).updateMany(
        { companyId: acme.companyId, assetAllocation: press1._id },
        { $set: { isActive: false } },
      );
    await Model('anomalies').create({
      companyId: acme.companyId,
      plantId: press1.plantId,
      anomalyCode: 'ANM-910',
      assetId: press1._id,
      type: 'vibration_high',
      severity: 'warning',
      state: 'open',
      summary: 'Crank bearing noise.',
      urgencyHours: 48,
      detectedAt: new Date(NOW.getTime() - HOUR),
      investigation: {
        suggestedWorkOrder: {
          name: 'Bearing check – Press 1',
          priority: 'Medium',
          category: 'Mechanical',
          estimatedDurationMin: 60,
        },
      },
    });
    // JC-15 runs on Press 1 until Friday 12:00 IST; with a 48 h deadline the planner waits for the free window.
    proposal = await proposeMaintenancePlan(
      ctx,
      { scope: 'assets', assetIds: [String(press1._id)], horizonDays: 3 },
      { now: NOW },
    );
    [task] = proposal.diff.tasks;
  });
  afterAll(teardownDatabase);

  it('starts from a zero-impact window after the running job card, with Ramesh (mechanical, shift A)', () => {
    expect(task).toMatchObject({
      key: 't-1',
      code: 'ANM-910',
      zeroImpact: true,
      optionId: 'zero_impact',
      late: false,
    });
    expect(task.start).toEqual(ist('2026-10-16T12:00'));
    expect(task.technician).toMatchObject({
      userId: String(ramesh._id),
      name: 'Ramesh Kumar',
      shiftName: 'A',
    });
  });

  it('an unchanged plan checks as doable with no impact delta', async () => {
    const check = await checkMaintenancePlan(ctx, edit({}), { now: NOW });
    expect(check).toMatchObject({
      verdict: 'doable',
      issues: [],
      adjustments: [],
      impactDelta: { hours: 0, cost: 0 },
    });
    expect(check.tasks[0]).toMatchObject({ key: 't-1', technician: { name: 'Ramesh Kumar' }, issues: [] });
    expect(check.explanation.text).toMatch(/^Doable:/);
    expect(check.plan.bars.some((b) => b.id === `mnt-${task.refId}`)).toBe(true);
  });

  it('moving the task onto the running job card → jobcard_overlap; the move_start suggestion resolves it', async () => {
    const onCard = { start: ist('2026-10-15T12:00'), end: ist('2026-10-15T13:00') };
    const check = await checkMaintenancePlan(ctx, edit(onCard), { now: NOW });
    expect(check.verdict).toBe('adjust');
    expect(check.issues).toHaveLength(1);
    expect(check.issues[0]).toMatchObject({ kind: 'jobcard_overlap', severity: 'warning', task: 't-1' });
    expect(check.issues[0].text).toMatch(/pushes JC-15 on Press 1: 1 h of production \(₹3,500\)/);
    expect(check.tasks[0]).toMatchObject({
      impactHours: 1,
      impactCost: 3500,
      zeroImpact: false,
      issues: [0],
    });
    expect(check.tasks[0].delays[0]).toMatchObject({ code: 'JC-15', hours: 1 });
    expect(check.impactDelta).toEqual({ hours: 1, cost: 3500 });
    expect(check.metrics).toMatchObject({ productionHoursLost: 1, productionImpactCost: 3500 });
    const [adj] = check.adjustments;
    expect(adj).toMatchObject({ id: 'adj-1', kind: 'move_start', resolves: [0] });
    expect(adj.patch.tasks[0]).toMatchObject({ key: 't-1', start: ist('2026-10-16T12:00') });
    // The proposal now carries the edited ops (what Apply would book) and the recomputed job-card move.
    const stored = await getProposal(ctx, proposal._id);
    expect(stored.ops.find((o) => o.module === 'workorders').data).toMatchObject({
      plannedStart: onCard.start,
      plannedEnd: onCard.end,
    });
    expect(stored.ops.some((o) => o.module === 'jobcards' && o.op === 'update')).toBe(true);
    expect(stored.input.edited.tasks[0].key).toBe('t-1');
    expect(check.explanation.text).toMatch(/^Needs adjustment:/);

    const fixed = await checkMaintenancePlan(ctx, edit(adj.patch.tasks[0]), { now: NOW });
    expect(fixed.verdict).toBe('doable');
    // Each check saves the plan, so the delta is against the last checked version (the one on the card).
    expect(fixed.impactDelta).toEqual({ hours: -1, cost: -3500 });
    expect((await getProposal(ctx, proposal._id)).ops.some((o) => o.module === 'jobcards')).toBe(false);
  });

  it('a technician who is busy or off shift gets a swap suggestion; a second task of the plan counts as a booking', async () => {
    const busy = await Model('workorders').create({
      companyId: acme.companyId,
      plantId: press1.plantId,
      workOrderId: 'WO-955',
      name: 'Guard check',
      asset: press1._id,
      workStatus: 'Open',
      people: [ramesh._id],
      plannedStart: ist('2026-10-16T12:00'),
      plannedEnd: ist('2026-10-16T12:30'),
    });
    try {
      const check = await checkMaintenancePlan(ctx, edit({ technicianId: String(ramesh._id) }), { now: NOW });
      const kinds = check.issues.map((i) => i.kind);
      expect(kinds).toContain('technician_busy');
      // The existing work order also sits on Press 1 at that time.
      expect(kinds).toContain('asset_overlap');
      const swap = check.adjustments.find((a) => a.kind === 'swap_technician');
      expect(swap.patch.tasks[0].technicianId).not.toBe(String(ramesh._id));
      expect(check.issues.find((i) => i.kind === 'technician_busy').text).toMatch(
        /Ramesh Kumar is busy with WO-955/,
      );
      const move = check.adjustments.find((a) => a.kind === 'move_start');
      expect(move.patch.tasks[0].start).toEqual(ist('2026-10-16T12:30'));
    } finally {
      await Model('workorders').deleteOne({ _id: busy._id });
    }
    const off = await checkMaintenancePlan(
      ctx,
      edit({ technicianId: String(priya._id), start: ist('2026-10-16T15:00'), end: ist('2026-10-16T16:00') }),
      { now: NOW },
    );
    expect(off.issues.map((i) => i.kind)).toEqual(['technician_off_shift']);
    expect(off.adjustments[0]).toMatchObject({ kind: 'swap_technician', resolves: [0] });
    expect(off.verdict).toBe('adjust');
    const none = await checkMaintenancePlan(ctx, edit({ technicianId: null }), { now: NOW });
    expect(none.issues[0].kind).toBe('technician_missing');
    expect(none.adjustments[0]).toMatchObject({
      kind: 'assign_technician',
      patch: { tasks: [{ technicianId: String(ramesh._id) }] },
    });
  });

  it('outside working time, too short and past the deadline are reported with fixes; the plan is not doable without one', async () => {
    // Saturday 03:00: nobody is on shift (A/B only), and Ramesh is off shift too.
    const night = await checkMaintenancePlan(
      ctx,
      edit({ start: ist('2026-10-17T03:00'), end: ist('2026-10-17T04:00') }),
      { now: NOW },
    );
    expect(night.issues.map((i) => i.kind)).toEqual(['outside_working', 'technician_off_shift']);
    const nightMove = night.adjustments.find((a) => a.kind === 'move_start');
    expect(nightMove).toMatchObject({
      resolves: [0],
      patch: { tasks: [{ start: ist('2026-10-17T06:00') }] },
    });
    expect(night.adjustments).toHaveLength(1); // nobody is on shift at 03:00, so there is no one to swap to
    expect(night.verdict).toBe('adjust');
    const short = await checkMaintenancePlan(ctx, edit({ end: ist('2026-10-16T12:30') }), { now: NOW });
    expect(short.issues.map((i) => i.kind)).toEqual(['too_short']);
    expect(short.adjustments[0]).toMatchObject({
      kind: 'move_end',
      patch: { tasks: [{ end: ist('2026-10-16T13:00') }] },
    });
    const late = await checkMaintenancePlan(
      ctx,
      edit({ start: ist('2026-10-19T12:00'), end: ist('2026-10-19T13:00') }),
      { now: NOW },
    );
    expect(late.issues.map((i) => i.kind)).toEqual(['past_deadline']);
    expect(late.adjustments[0].patch.tasks[0].start).toEqual(ist('2026-10-16T12:00'));
    // Apply honours the last check: a critical issue without a fix blocks it until forced.
    await Model('planproposals').updateOne(
      { _id: proposal._id },
      { $set: { 'feasibility.verdict': 'not_doable' } },
    );
    await expect(applyProposal(ctx, proposal._id)).rejects.toMatchObject({ code: 'PLAN_NOT_DOABLE' });
    await checkMaintenancePlan(ctx, edit({}), { now: NOW });
    expect((await getProposal(ctx, proposal._id)).feasibility.verdict).toBe('doable');
  });

  it('SARA’s own unavoidable push is not an issue; a bigger push by an edit is flagged', async () => {
    // Due in 4 h while JC-15 runs on Press 1 until Friday 12:00: the only way is to push production.
    const urgent = await Model('anomalies').create({
      companyId: acme.companyId,
      plantId: press1.plantId,
      anomalyCode: 'ANM-911',
      assetId: press1._id,
      type: 'current_high',
      severity: 'warning',
      state: 'open',
      summary: 'Motor current climbing.',
      urgencyHours: 4,
      detectedAt: NOW,
      investigation: {
        suggestedWorkOrder: {
          name: 'Motor check – Press 1',
          category: 'Electrical',
          estimatedDurationMin: 60,
        },
      },
    });
    try {
      const draft = await proposeMaintenancePlan(
        ctx,
        { scope: 'assets', assetIds: [String(press1._id)], horizonDays: 3 },
        { now: NOW },
      );
      const pushed = draft.diff.tasks.find((x) => x.code === 'ANM-911');
      expect(pushed.impactHours).toBeGreaterThan(0);
      const rows = draft.diff.tasks.map((x) => ({
        key: x.key,
        start: x.start,
        end: x.end,
        technicianId: x.technician?.userId ?? null,
      }));
      const same = await checkMaintenancePlan(
        ctx,
        { proposalId: String(draft._id), tasks: rows },
        { now: NOW },
      );
      expect(same.issues.filter((i) => i.kind === 'jobcard_overlap')).toEqual([]);
      expect(same.impactDelta).toEqual({ hours: 0, cost: 0 });

      const longer = rows.map((r) =>
        r.key === pushed.key
          ? { ...r, end: new Date(new Date(r.end).getTime() + HOUR), durationMin: 120 }
          : r,
      );
      const worse = await checkMaintenancePlan(
        ctx,
        { proposalId: String(draft._id), tasks: longer },
        { now: NOW },
      );
      const flagged = worse.issues.find((i) => i.kind === 'jobcard_overlap');
      expect(flagged).toMatchObject({ task: pushed.key, severity: 'warning' });
      expect(worse.impactDelta.hours).toBeGreaterThan(0);
    } finally {
      await Model('anomalies').deleteOne({ _id: urgent._id });
    }
  });

  it('an urgent push nobody can staff now is offered the soonest staffed slot before its deadline', async () => {
    const urgent = await Model('anomalies').create({
      companyId: acme.companyId,
      plantId: press1.plantId,
      anomalyCode: 'ANM-912',
      assetId: press1._id,
      type: 'current_high',
      severity: 'warning',
      state: 'open',
      summary: 'Motor current climbing.',
      urgencyHours: 4,
      detectedAt: NOW,
      investigation: {
        suggestedWorkOrder: {
          name: 'Motor check – Press 1',
          category: 'Electrical',
          estimatedDurationMin: 60,
        },
      },
    });
    // Every Maintenance person is busy 12:00–13:00 (on another machine).
    const staff = await Model('users')
      .find({ companyId: acme.companyId, plantId: press1.plantId, department: 'Maintenance' })
      .lean();
    const other = await Model('assets').findOne({ companyId: acme.companyId, assetTag: 'IMM-03' }).lean();
    const busy = await Model('workorders').insertMany(
      staff.map((u, i) => ({
        companyId: acme.companyId,
        plantId: press1.plantId,
        workOrderId: `WO-97${i}`,
        name: 'Line walk',
        asset: other._id,
        workStatus: 'Open',
        people: [u._id],
        plannedStart: NOW,
        plannedEnd: new Date(NOW.getTime() + HOUR),
      })),
    );
    try {
      const draft = await proposeMaintenancePlan(
        ctx,
        { scope: 'assets', assetIds: [String(press1._id)], horizonDays: 3 },
        { now: NOW },
      );
      const task = draft.diff.tasks.find((x) => x.code === 'ANM-912');
      expect(task.impactHours).toBeGreaterThan(0);
      expect(task.technician).toBeNull();
      const idx = draft.issues.findIndex((i) => i.kind === 'technician_missing' && i.task === task.key);
      const adj = draft.adjustments.find((a) => a.resolves.includes(idx));
      // 13:00, when people are free again — not Friday after JC-15, long past the 4 h deadline.
      expect(adj.patch.tasks[0].start).toEqual(ist('2026-10-15T13:00'));
      expect(new Date(adj.patch.tasks[0].end).getTime()).toBeLessThanOrEqual(
        new Date(task.deadline).getTime(),
      );
      // The check of the same plan offers the same move (it used to offer nothing once nobody was free).
      const rows = draft.diff.tasks.map((x) => ({
        key: x.key,
        start: x.start,
        end: x.end,
        technicianId: x.technician?.userId ?? null,
      }));
      const check = await checkMaintenancePlan(
        ctx,
        { proposalId: String(draft._id), tasks: rows },
        { now: NOW },
      );
      const missing = check.issues.findIndex((i) => i.kind === 'technician_missing' && i.task === task.key);
      const move = check.adjustments.find((a) => a.resolves.includes(missing));
      expect(move).toMatchObject({ kind: 'move_start' });
      expect(move.patch.tasks[0].start).toEqual(ist('2026-10-15T13:00'));
      expect(move.patch.tasks[0].technicianId).toBeTruthy();
      // One ghost bar per pushed job card, however many tasks push it.
      const ids = check.plan.bars.filter((b) => b.ghost).map((b) => `${b.kind}:${b.id}`);
      expect(new Set(ids).size).toBe(ids.length);
    } finally {
      await Model('anomalies').deleteOne({ _id: urgent._id });
      await Model('workorders').deleteMany({ _id: { $in: busy.map((w) => w._id) } });
    }
  });

  it('a suggested move names a technician on shift when the chosen one is not', async () => {
    const suresh = await Model('users')
      .findOne({ companyId: acme.companyId, email: 'maintenance_technician_2@acme.test' })
      .lean();
    // Thursday 15:00 on the running JC-15 with Suresh (shift B): the free window is Friday 12:00, shift A.
    const check = await checkMaintenancePlan(
      ctx,
      edit({
        start: ist('2026-10-15T15:00'),
        end: ist('2026-10-15T16:00'),
        technicianId: String(suresh._id),
      }),
      { now: NOW },
    );
    const move = check.adjustments.find(
      (a) => a.kind === 'move_start' && a.resolves.some((i) => check.issues[i].kind === 'jobcard_overlap'),
    );
    expect(move.patch.tasks[0].start).toEqual(ist('2026-10-16T12:00'));
    expect(move.patch.tasks[0].technicianId).toBe(String(ramesh._id));
  });

  it('a suggested move avoids every other task of the plan, later ones included; a partly applied plan is 409', async () => {
    const second = await Model('anomalies').create({
      companyId: acme.companyId,
      plantId: press1.plantId,
      anomalyCode: 'ANM-913',
      assetId: press1._id,
      type: 'vibration_high',
      severity: 'warning',
      state: 'open',
      summary: 'Ram guide wear.',
      urgencyHours: 30,
      detectedAt: NOW,
      investigation: {
        suggestedWorkOrder: {
          name: 'Guide check – Press 1',
          category: 'Mechanical',
          estimatedDurationMin: 60,
        },
      },
    });
    try {
      const draft = await proposeMaintenancePlan(
        ctx,
        { scope: 'assets', assetIds: [String(press1._id)], horizonDays: 3 },
        { now: NOW },
      );
      const [first, later] = draft.diff.tasks;
      expect(draft.diff.tasks).toHaveLength(2);
      // The first task goes onto the running JC-15; the later one takes the free Friday 12:00 slot.
      const friday = { start: ist('2026-10-16T12:00'), end: ist('2026-10-16T13:00') };
      const rows = [
        { key: first.key, start: ist('2026-10-15T12:00'), end: ist('2026-10-15T13:00') },
        { key: later.key, ...friday },
      ];
      const check = await checkMaintenancePlan(
        ctx,
        { proposalId: String(draft._id), tasks: rows },
        { now: NOW },
      );
      const moves = check.adjustments.filter(
        (a) => a.kind === 'move_start' && a.patch.tasks[0].key === first.key,
      );
      expect(moves.length).toBeGreaterThan(0);
      for (const m of moves) {
        const { start, end } = m.patch.tasks[0];
        expect(new Date(start) < friday.end && friday.start < new Date(end), m.label).toBe(false);
      }
      await Model('planproposals').updateOne(
        { _id: draft._id },
        { $set: { status: 'failed', appliedOps: 1 } },
      );
      await expect(
        checkMaintenancePlan(ctx, { proposalId: String(draft._id), tasks: rows }, { now: NOW }),
      ).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/partly applied/) });
    } finally {
      await Model('anomalies').deleteOne({ _id: second._id });
    }
  });

  it('POST /api/planning/maintenance/check validates, checks and refuses viewers; unknown plans are 404', async () => {
    const app = createApp({ routers: [{ path: '/api', router: planningMaintenanceRouter }] });
    const tokens = {};
    for (const [who, email] of Object.entries({ owner: 'owner_1@acme.test', viewer: 'viewer_1@acme.test' })) {
      const res = await request(app).post('/api/auth/login').send({ email, password: PASSWORD });
      tokens[who] = res.body.token;
    }
    // The route reads the clock itself while the fixture is pinned to NOW: run the requests on that clock.
    vi.useFakeTimers({ toFake: ['Date'], now: NOW });
    const auth = (who) => ({ authorization: `Bearer ${tokens[who]}` });
    const body = {
      ...edit({}),
      tasks: [
        {
          key: 't-1',
          start: task.start.toISOString(),
          end: task.end.toISOString(),
          technicianId: task.technician.userId,
        },
      ],
    };
    const ok = await request(app).post('/api/planning/maintenance/check').set(auth('owner')).send(body);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({
      verdict: expect.any(String),
      impactDelta: { hours: expect.any(Number) },
    });
    expect(ok.body.proposal.proposalCode).toBe(proposal.proposalCode);
    expect(
      (await request(app).post('/api/planning/maintenance/check').set(auth('viewer')).send(body)).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .post('/api/planning/maintenance/check')
          .set(auth('owner'))
          .send({ proposalId: 'PLN-999', tasks: [] })
      ).status,
    ).toBe(404);
    expect(
      (await request(app).post('/api/planning/maintenance/check').set(auth('owner')).send({ tasks: [] }))
        .status,
    ).toBe(400);
    await applyProposal(ctx, proposal._id);
    const applied = await request(app).post('/api/planning/maintenance/check').set(auth('owner')).send(body);
    expect(applied.status).toBe(409);
  });
});
