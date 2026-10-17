import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { records } from '../src/modules/records.js';
import { getModule } from '../src/modules/registry.js';
import { explainProposal } from '../src/planning/explain.js';
import { planMaintenance } from '../src/planning/maintenance.js';
import {
  buildMaintenancePlan,
  chooseOption,
  explainMaintenancePlan,
  impactOf,
  maintenancePlanTasks,
  naiveSchedule,
  proposeMaintenancePlan,
  scoreOption,
  summarise,
} from '../src/planning/maintenancePlan.js';
import { checkMaintenancePlan } from '../src/planning/maintenancePlanCheck.js';
import { maintenancePlanningTools } from '../src/planning/maintenanceTool.js';
import { applyProposal, getProposal, planBlockFor } from '../src/planning/proposals.js';
import { planningMaintenanceRouter } from '../src/routes/planningMaintenance.js';
import { contextFor, NOW, PASSWORD, setupDatabase, teardownDatabase } from './helpers/db.js';

const ai = vi.hoisted(() => ({ fail: false }));
vi.mock('../src/ai/gemini.js', async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    generate: async (args) => {
      if (ai.fail) throw new real.AiUnavailableError('AI_QUOTA', 'The AI is busy');
      return real.generate(args);
    },
  };
});

const HOUR = 3_600_000;
const ist = (local) => new Date(`${local}:00+05:30`);
const Model = (name) => getModule(name).Model;
const t = (d) => new Date(d).getTime();
const overlap = (x, y) => t(x.start) < t(y.end) && t(y.start) < t(x.end);

describe('objective scoring (pure)', () => {
  const task = { assetId: 'M1', priority: 'Medium', severity: 'warning' };
  const cost = (id) => ({ M1: 5000, M2: 3800 })[id];
  const opt = (id, extra) => ({
    id,
    start: NOW,
    lateHours: 0,
    delayHours: 0,
    maintenanceLateHours: 0,
    delays: [],
    ...extra,
  });

  it('impactOf counts only the job-card hours the block overlaps, at the machine rate', () => {
    const machine = {
      assetId: 'M1',
      bookings: [
        { kind: 'jobcard', start: ist('2026-10-15T10:00'), end: ist('2026-10-15T12:30') },
        { kind: 'workorder', start: ist('2026-10-15T12:30'), end: ist('2026-10-15T13:00') },
      ],
    };
    expect(impactOf(machine, { start: ist('2026-10-15T12:00'), end: ist('2026-10-15T13:00') }, cost)).toEqual(
      {
        hours: 0.5,
        cost: 2500,
      },
    );
  });

  it('picks the cheaper machine’s window: pushing on IMM 5 at ₹3800/h beats IMM 3 at ₹5000/h', () => {
    const insert = opt('insert', { delayHours: 1, delays: [{ rowId: 'M1', hours: 1, late: false }] });
    const move = opt('move', { delayHours: 1, delays: [{ rowId: 'M2', hours: 1, late: false }] });
    const scoring = { weight: 0, costPerHour: cost, now: NOW };
    expect(scoreOption(insert, task, scoring)).toBe(5000);
    expect(scoreOption(move, task, scoring)).toBe(3800);
    expect(chooseOption(task, [insert, move], scoring).id).toBe('move');
  });

  it('protect_production takes the zero-impact window or defers; fix_fast takes the earlier window with impact', () => {
    const zero = opt('zero_impact', { start: new Date(NOW.getTime() + 20 * HOUR) });
    const insert = opt('insert', {
      delayHours: 2,
      lateHours: 1,
      delays: [{ rowId: 'M1', hours: 2, late: true }],
    });
    const defer = opt('defer', { start: new Date(NOW.getTime() + 30 * HOUR), maintenanceLateHours: 22 });
    expect(chooseOption(task, [zero, insert, defer], { weight: 0, costPerHour: cost, now: NOW }).id).toBe(
      'zero_impact',
    );
    expect(chooseOption(task, [insert, defer], { weight: 0, costPerHour: cost, now: NOW }).id).toBe('defer');
    expect(chooseOption(task, [insert, defer], { weight: 1, costPerHour: cost, now: NOW }).id).toBe('insert');
    // A critical anomaly is never deferred.
    expect(
      chooseOption({ ...task, severity: 'critical' }, [insert, defer], {
        weight: 0,
        costPerHour: cost,
        now: NOW,
      }).id,
    ).toBe('insert');
  });

  it('the objective matters when a free window exists: fix_fast inserts now, protect_production waits', () => {
    // M1 runs a job card for 20 h; its free window opens after it, inside the 24 h deadline.
    const at = (h) => new Date(NOW.getTime() + h * HOUR);
    const calendar = {
      end: at(200),
      tools: [],
      machines: [
        {
          assetId: 'M1',
          working: [{ start: NOW, end: at(200) }],
          bookings: [{ kind: 'jobcard', id: 'jc1', code: 'JC-1', start: NOW, end: at(20) }],
        },
      ],
    };
    const urgent = { ...task, refId: 'a1', priority: 'High', durationMin: 60, deadline: at(24) };
    const plan = (weight) =>
      planMaintenance(calendar, [urgent], {
        now: NOW,
        allOptions: weight > 0,
        choose: (x, options) => chooseOption(x, options, { weight, costPerHour: cost, now: NOW }),
      }).tasks[0];
    const fast = plan(1);
    expect(fast.options.map((o) => o.id)).toEqual(expect.arrayContaining(['zero_impact', 'insert']));
    expect(fast.recommended).toBe('insert');
    expect(fast.options.find((o) => o.id === 'insert').start).toEqual(NOW);
    const careful = plan(0);
    expect(careful.options.map((o) => o.id)).toEqual(['zero_impact']);
    expect(careful.recommended).toBe('zero_impact');
  });

  it('naiveSchedule stacks tasks as soon as possible per machine and prices every overlapped card', () => {
    const working = [{ start: ist('2026-10-15T12:00'), end: ist('2026-10-15T22:00') }];
    const calendar = {
      machines: [
        {
          assetId: 'M1',
          working,
          bookings: [{ kind: 'jobcard', start: ist('2026-10-15T08:00'), end: ist('2026-10-15T20:00') }],
        },
        { assetId: 'M2', working, bookings: [] },
      ],
    };
    const tasks = [
      { assetId: 'M1', durationMin: 60 },
      { assetId: 'M1', durationMin: 30 },
      { assetId: 'M2', durationMin: 60 },
    ];
    expect(naiveSchedule(calendar, tasks, { now: NOW, costPerHour: cost })).toEqual({
      productionHoursLost: 1.5,
      productionImpactCost: 7500,
    });
  });
});

describe('maintenance plan on the seeded plant', () => {
  let ctx;
  let acme;
  let plant;
  let imm3;
  let press2;
  let ramesh;
  let app;
  const tokens = {};
  const anomaly = async (asset, code, category, extra = {}) =>
    (
      await Model('anomalies').create({
        companyId: acme.companyId,
        plantId: asset.plantId,
        anomalyCode: code,
        assetId: asset._id,
        type: 'vibration_high',
        severity: 'warning',
        state: 'open',
        summary: 'Vibration is climbing.',
        urgencyHours: 8,
        detectedAt: new Date(NOW.getTime() - HOUR),
        investigation: {
          suggestedWorkOrder: {
            name: `${category} check – ${asset.name}`,
            description: 'Inspect and correct.',
            priority: 'Medium',
            category,
            estimatedDurationMin: 60,
          },
        },
        ...extra,
      })
    ).toObject();

  beforeAll(async () => {
    ({ acme } = await setupDatabase());
    ctx = await contextFor('owner_1@acme.test');
    const asset = (tag) => Model('assets').findOne({ companyId: acme.companyId, assetTag: tag }).lean();
    [imm3, press2] = await Promise.all([asset('IMM-03'), asset('PRS-02')]);
    plant = ctx.plants.find((p) => String(p._id) === String(imm3.plantId));
    ramesh = await Model('users')
      .findOne({ companyId: acme.companyId, email: 'maintenance_technician_1@acme.test' })
      .lean();
    // Only the anomalies below are due on these two machines: close their seeded work and schedules.
    const ids = [imm3._id, press2._id];
    await Model('workorders').updateMany(
      { companyId: acme.companyId, asset: { $in: ids }, workStatus: { $nin: ['Completed', 'Closed'] } },
      { $set: { workStatus: 'Closed' } },
    );
    for (const name of ['preventivemaintenances', 'calibrations'])
      await Model(name).updateMany(
        { companyId: acme.companyId, assetAllocation: { $in: ids } },
        { $set: { isActive: false } },
      );
    await anomaly(imm3, 'ANM-901', 'Mechanical');
    await anomaly(press2, 'ANM-902', 'Mechanical');
    app = createApp({ routers: [{ path: '/api', router: planningMaintenanceRouter }] });
    for (const [who, email] of Object.entries({ owner: 'owner_1@acme.test', viewer: 'viewer_1@acme.test' })) {
      const res = await request(app).post('/api/auth/login').send({ email, password: PASSWORD });
      tokens[who] = res.body.token;
    }
  });
  afterAll(teardownDatabase);

  it('collects tasks for chosen assets and for the whole plant (anomaly first)', async () => {
    const own = await maintenancePlanTasks(ctx, { scope: 'assets', assetIds: [String(imm3._id)] }, NOW);
    expect(own.map((x) => x.code)).toContain('ANM-901');
    expect(own.every((x) => x.assetId === String(imm3._id))).toBe(true);
    // No plantId: the sweep follows the anomaly's plant (Pune), not the viewer's first plant.
    const all = await maintenancePlanTasks(
      ctx,
      {
        scope: 'plant',
        anomalyId: String((await Model('anomalies').findOne({ anomalyCode: 'ANM-902' }))._id),
      },
      NOW,
    );
    expect(all[0].code).toBe('ANM-902');
    expect(all.map((x) => x.code)).toContain('ANM-901');
    expect(all.length).toBeGreaterThan(own.length);
    expect(all.length).toBeLessThanOrEqual(20);
    await expect(maintenancePlanTasks(ctx, { scope: 'assets', assetIds: [] }, NOW)).rejects.toMatchObject({
      status: 400,
    });
  });

  it('places idle machines in free windows with a skilled technician on shift and never double-books anyone', async () => {
    // Ramesh (mechanical, shift A) is already booked 12:00–13:00 on an existing work order.
    const busy = await Model('workorders').create({
      companyId: acme.companyId,
      plantId: plant._id,
      workOrderId: 'WO-950',
      name: 'Pump seal',
      asset: imm3._id,
      workStatus: 'In Progress',
      people: [ramesh._id],
      plannedStart: ist('2026-10-15T12:00'),
      plannedEnd: ist('2026-10-15T13:00'),
    });
    const plan = await buildMaintenancePlan(
      ctx,
      { scope: 'assets', assetIds: [String(imm3._id), String(press2._id)], horizonDays: 3 },
      { now: NOW },
    ).finally(() => Model('workorders').deleteOne({ _id: busy._id }));
    const [first, second] = plan.tasks;
    expect(plan.tasks.map((x) => x.code).sort()).toEqual(['ANM-901', 'ANM-902']);
    // IMM 3 holds WO-950 until 13:00, Press 2 is idle: both land in zero-impact windows before the 8 h deadline.
    expect(plan.tasks.every((x) => x.zeroImpact && x.optionId === 'zero_impact' && !x.late)).toBe(true);
    expect(plan.metrics).toMatchObject({
      tasks: 2,
      zeroImpactTasks: 2,
      productionHoursLost: 0,
      currency: '₹',
    });
    expect(plan.metrics.downtimeCostAvoided).toBeGreaterThanOrEqual(0);
    expect(plan.verdict).toBe('doable');
    // Technicians: Maintenance, on shift for the whole block, never on two things at once.
    const people = new Map();
    for (const x of plan.tasks) {
      expect(x.technician, x.title).not.toBeNull();
      expect(['A', 'B']).toContain(x.technician.shiftName);
      people.set(x.technician.userId, [...(people.get(x.technician.userId) ?? []), x]);
    }
    for (const blocks of people.values())
      for (const [i, a] of blocks.entries())
        for (const b of blocks.slice(i + 1)) expect(overlap(a, b), `${a.title} / ${b.title}`).toBe(false);
    // Ramesh is the only mechanical fitter: he takes the IMM 3 task once WO-950 frees him (13:00), not Press 2 at 12:00.
    const rameshTask = plan.tasks.find((x) => x.technician.userId === String(ramesh._id));
    expect(rameshTask).toMatchObject({ code: 'ANM-901', start: ist('2026-10-15T13:00') });
    expect(overlap(rameshTask, { start: busy.plannedStart, end: busy.plannedEnd })).toBe(false);
    expect(plan.tasks.find((x) => x.code === 'ANM-902')).toMatchObject({ start: ist('2026-10-15T12:00') });
    // Ops: the plan record first, every work order linked to it with its technician and window.
    expect(plan.ops[0]).toMatchObject({
      seq: 0,
      op: 'create',
      module: 'maintenanceplans',
      data: { scope: 'assets', status: 'planned' },
    });
    const woOps = plan.ops.filter((o) => o.module === 'workorders');
    expect(woOps).toHaveLength(2);
    for (const op of woOps) {
      const task = plan.tasks.find((x) => x.start.getTime() === op.data.plannedStart.getTime());
      expect(op.data).toMatchObject({
        maintenancePlanId: '$op:0',
        people: [task.technician.userId],
        plannedStart: task.start,
        plannedEnd: task.end,
        estimatedDurationMin: 60,
      });
    }
    expect(plan.ops.map((o) => o.seq)).toEqual(plan.ops.map((_, i) => i));
    expect(first.start >= NOW && second.start >= NOW).toBe(true);
    expect(plan.diff.bars.filter((b) => b.kind === 'maintenance')).toHaveLength(2);
  });

  it('waits for the first free technician before the deadline; past it, flags the task with the next window', async () => {
    // A Calibration on the chiller at 12:00 wants instrumentation skills; everybody free then lacks them, but
    // someone is free, so it is assigned. Take every Maintenance person off shift instead: nobody is free.
    const Users = Model('users');
    const staff = await Users.find({
      companyId: acme.companyId,
      plantId: plant._id,
      department: 'Maintenance',
    }).lean();
    const shiftB = String(plant.shifts.find((s) => s.shiftName === 'B')._id);
    await Users.updateMany({ _id: { $in: staff.map((u) => u._id) } }, { $set: { shiftId: shiftB } });
    try {
      const plan = await buildMaintenancePlan(
        ctx,
        { scope: 'assets', assetIds: [String(imm3._id)], horizonDays: 2 },
        { now: NOW },
      );
      // Shift B people only: the staffed time starts 14:00, so the block lands there and someone is free.
      expect(plan.tasks[0].start).toEqual(ist('2026-10-15T14:00'));
      expect(plan.tasks[0].technician).not.toBeNull();
      // Book everyone of shift B at 14:00–15:00: SARA waits for the first person free before the deadline.
      const book = (until) =>
        Promise.all(
          staff.map((u, i) =>
            Model('workorders').create({
              companyId: acme.companyId,
              plantId: plant._id,
              workOrderId: `WO-96${i}`,
              name: 'Line walk',
              asset: press2._id,
              workStatus: 'Open',
              people: [u._id],
              plannedStart: ist('2026-10-15T14:00'),
              plannedEnd: ist(until),
            }),
          ),
        );
      const input = { scope: 'assets', assetIds: [String(imm3._id)], horizonDays: 2 };
      let wos = await book('2026-10-15T15:00');
      const waited = await buildMaintenancePlan(ctx, input, { now: NOW });
      expect(waited.tasks[0].start).toEqual(ist('2026-10-15T15:00'));
      expect(waited.tasks[0].technician).not.toBeNull();
      expect(waited.issues).toEqual([]);
      await Model('workorders').deleteMany({ _id: { $in: wos.map((w) => w._id) } });
      // Booked until 19:00, past the 8 h deadline: nobody is free in time → the issue and the later window.
      wos = await book('2026-10-15T19:00');
      const short = await buildMaintenancePlan(ctx, input, { now: NOW });
      expect(short.tasks[0].technician).toBeNull();
      expect(short.issues[0]).toMatchObject({ kind: 'technician_missing', severity: 'warning', task: 't-1' });
      expect(short.adjustments[0]).toMatchObject({ kind: 'move_start', resolves: [0] });
      expect(short.adjustments[0].patch.tasks[0]).toMatchObject({
        key: 't-1',
        start: ist('2026-10-15T19:00'),
      });
      expect(short.adjustments[0].patch.tasks[0].technicianId).toBeTruthy();
      expect(short.verdict).toBe('adjust');
      await Model('workorders').deleteMany({ _id: { $in: wos.map((w) => w._id) } });
    } finally {
      for (const u of staff) await Users.updateOne({ _id: u._id }, { $set: { shiftId: u.shiftId } });
    }
  });

  it('staffs the scarce trade first: an off-trade pick never takes the one person a later task needs', async () => {
    // Shift A only, at 12:00: Priya is the only electrician; nobody has calibration skills. The calibration task
    // (deadline first) must not take Priya, or the Electrical task waits for her.
    const Users = Model('users');
    const Anomalies = Model('anomalies');
    const staff = await Users.find({
      companyId: acme.companyId,
      plantId: plant._id,
      department: 'Maintenance',
    }).lean();
    const byName = (first) => staff.find((u) => u.firstName === first);
    const shiftA = String(plant.shifts.find((s) => s.shiftName === 'A')._id);
    await Users.updateMany({ _id: { $in: staff.map((u) => u._id) } }, { $set: { shiftId: shiftA } });
    await Users.updateOne({ _id: byName('Priya')._id }, { $set: { skills: ['electrical'] } });
    await Users.updateOne({ _id: byName('Suresh')._id }, { $set: { skills: ['hydraulics'] } });
    await Anomalies.updateMany(
      { anomalyCode: { $in: ['ANM-901', 'ANM-902'] } },
      { $set: { state: 'resolved' } },
    );
    const cal = await anomaly(imm3, 'ANM-904', 'Calibration', { urgencyHours: 6 });
    const elec = await anomaly(press2, 'ANM-905', 'Electrical', { urgencyHours: 8 });
    try {
      const plan = await buildMaintenancePlan(
        ctx,
        { scope: 'assets', assetIds: [String(imm3._id), String(press2._id)], horizonDays: 2 },
        { now: NOW },
      );
      const electrical = plan.tasks.find((x) => x.code === 'ANM-905');
      const calibration = plan.tasks.find((x) => x.code === 'ANM-904');
      expect(electrical.technician?.userId).toBe(String(byName('Priya')._id));
      expect(electrical.start).toEqual(ist('2026-10-15T12:00'));
      expect(calibration.technician).not.toBeNull();
      expect(calibration.technician.userId).not.toBe(String(byName('Priya')._id));
      expect(plan.issues.filter((i) => i.kind === 'technician_missing')).toEqual([]);
    } finally {
      await Anomalies.deleteMany({ _id: { $in: [cal._id, elec._id] } });
      await Anomalies.updateMany(
        { anomalyCode: { $in: ['ANM-901', 'ANM-902'] } },
        { $set: { state: 'open' } },
      );
      for (const u of staff)
        await Users.updateOne({ _id: u._id }, { $set: { shiftId: u.shiftId, skills: u.skills } });
    }
  });

  it('suggested slots for unstaffed tasks never name one person twice at the same time', async () => {
    // Shift B only, everyone busy 14:00–19:00 on another machine: both 8 h tasks (IMM 3, Press 2) are unstaffed
    // and each gets a move suggestion; the second must not reuse the first one's person and slot.
    const Users = Model('users');
    const staff = await Users.find({
      companyId: acme.companyId,
      plantId: plant._id,
      department: 'Maintenance',
    }).lean();
    const shiftB = String(plant.shifts.find((s) => s.shiftName === 'B')._id);
    const elsewhere = await Model('assets')
      .findOne({ companyId: acme.companyId, plantId: plant._id, _id: { $nin: [imm3._id, press2._id] } })
      .lean();
    await Users.updateMany({ _id: { $in: staff.map((u) => u._id) } }, { $set: { shiftId: shiftB } });
    const wos = await Model('workorders').insertMany(
      staff.map((u, i) => ({
        companyId: acme.companyId,
        plantId: plant._id,
        workOrderId: `WO-98${i}`,
        name: 'Line walk',
        asset: elsewhere._id,
        workStatus: 'Open',
        people: [u._id],
        plannedStart: ist('2026-10-15T14:00'),
        plannedEnd: ist('2026-10-15T19:00'),
      })),
    );
    try {
      const plan = await buildMaintenancePlan(
        ctx,
        { scope: 'assets', assetIds: [String(imm3._id), String(press2._id)], horizonDays: 2 },
        { now: NOW },
      );
      const moves = plan.adjustments.map((a) => a.patch.tasks[0]);
      expect(moves.length).toBeGreaterThanOrEqual(2);
      for (const [i, a] of moves.entries())
        for (const b of moves.slice(i + 1))
          expect(a.technicianId === b.technicianId && overlap(a, b), `${a.key} / ${b.key}`).toBe(false);
    } finally {
      await Model('workorders').deleteMany({ _id: { $in: wos.map((w) => w._id) } });
      for (const u of staff) await Users.updateOne({ _id: u._id }, { $set: { shiftId: u.shiftId } });
    }
  });

  it('a start in the past plans from now: nothing is booked before now', async () => {
    const plan = await buildMaintenancePlan(
      ctx,
      {
        scope: 'assets',
        assetIds: [String(imm3._id), String(press2._id)],
        start: new Date(NOW.getTime() - 48 * HOUR),
      },
      { now: NOW },
    );
    expect(plan.tasks.length).toBeGreaterThan(0);
    for (const x of plan.tasks) expect(x.start.getTime(), x.title).toBeGreaterThanOrEqual(NOW.getTime());
    expect(new Date(plan.horizon.start).getTime()).toBe(NOW.getTime());
  });

  it('waits for a free window a skilled technician can take instead of sending another trade (not for fix_fast)', async () => {
    // Press 2 is idle; Ramesh (the plant's only mechanical fitter) is booked 12:00–14:00, others are free at 12:00.
    const Anomalies = Model('anomalies');
    await Anomalies.updateOne({ anomalyCode: 'ANM-902' }, { $set: { state: 'resolved' } });
    const own = await anomaly(press2, 'ANM-903', 'Mechanical', { urgencyHours: 48 });
    const busy = await Model('workorders').create({
      companyId: acme.companyId,
      plantId: plant._id,
      workOrderId: 'WO-951',
      name: 'Gearbox oil',
      asset: imm3._id,
      workStatus: 'Open',
      people: [ramesh._id],
      plannedStart: ist('2026-10-15T12:00'),
      plannedEnd: ist('2026-10-15T14:00'),
    });
    try {
      const input = { scope: 'assets', assetIds: [String(press2._id)], horizonDays: 3 };
      const fast = await buildMaintenancePlan(ctx, { ...input, objective: 'fix_fast' }, { now: NOW });
      const quick = fast.tasks.find((x) => x.code === 'ANM-903');
      expect(quick.start).toEqual(ist('2026-10-15T12:00'));
      expect(quick.technician?.userId).not.toBe(String(ramesh._id));

      const plan = await buildMaintenancePlan(ctx, input, { now: NOW });
      const task = plan.tasks.find((x) => x.code === 'ANM-903');
      expect(task.technician?.userId).toBe(String(ramesh._id));
      expect(task).toMatchObject({ zeroImpact: true, late: false, optionId: 'zero_impact' });
      expect(task.start.getTime()).toBeGreaterThanOrEqual(ist('2026-10-15T14:00').getTime());
      expect(task.end.getTime()).toBeLessThanOrEqual(task.deadline.getTime());
      expect(plan.issues).toEqual([]);
    } finally {
      await Anomalies.deleteOne({ _id: own._id });
      await Anomalies.updateOne({ anomalyCode: 'ANM-902' }, { $set: { state: 'open' } });
      await Model('workorders').deleteOne({ _id: busy._id });
    }
  });

  it('re-plans an open work order whose window passed without anyone starting it', async () => {
    const missed = await Model('workorders').create({
      companyId: acme.companyId,
      plantId: plant._id,
      workOrderId: 'WO-952',
      name: 'Monthly PM – Press 2',
      asset: press2._id,
      category: 'Preventive',
      workStatus: 'Open',
      plannedStart: ist('2026-10-15T08:00'),
      plannedEnd: ist('2026-10-15T09:00'),
      dueDate: ist('2026-10-16T12:00'),
    });
    const started = await Model('workorders').create({
      companyId: acme.companyId,
      plantId: plant._id,
      workOrderId: 'WO-953',
      name: 'Belt change – Press 2',
      asset: press2._id,
      workStatus: 'In Progress',
      plannedStart: ist('2026-10-15T08:00'),
      plannedEnd: ist('2026-10-15T09:00'),
    });
    try {
      const tasks = await maintenancePlanTasks(ctx, { scope: 'assets', assetIds: [String(press2._id)] }, NOW);
      expect(tasks.map((x) => x.code)).toContain('WO-952');
      expect(tasks.map((x) => x.code)).not.toContain('WO-953');
    } finally {
      await Model('workorders').deleteMany({ _id: { $in: [missed._id, started._id] } });
    }
  });

  it('proposes, summarises (mock), applies: plan record + linked work orders, metrics, aiSummary, proposal', async () => {
    const draft = await proposeMaintenancePlan(
      ctx,
      { scope: 'assets', assetIds: [String(imm3._id), String(press2._id)] },
      { now: NOW },
    );
    expect(draft).toMatchObject({
      kind: 'maintenance_plan',
      status: 'draft',
      options: [],
      recommendedOption: null,
    });
    expect(draft.title).toBe('Maintenance plan – IMM 3, Press 2');
    expect(draft.feasibility.verdict).toBe('doable');
    expect(draft.diff.tasks).toHaveLength(2);
    const { proposal } = await summarise(ctx, draft);
    expect(proposal.explanation.mock).toBe(true);
    expect(proposal.explanation.text).toMatch(/^Doable: 2 tasks on IMM 3, Press 2, 2 in free windows/);
    const block = await planBlockFor(ctx, proposal);
    expect(block.tasks).toHaveLength(2);
    expect(block.verdict).toBe('doable');
    expect(block.metrics.tasks).toBe(2);
    expect(block.bars.filter((b) => b.ghost && b.kind === 'maintenance')).toHaveLength(2);

    const { created, proposal: applied } = await applyProposal(ctx, proposal.proposalCode);
    expect(created.map((c) => c.module)).toEqual(['maintenanceplans', 'workorders', 'workorders']);
    const plan = await Model('maintenanceplans').findById(created[0].id).lean();
    expect(plan).toMatchObject({
      planCode: expect.stringMatching(/^MP-\d+$/),
      status: 'planned',
      scope: 'assets',
    });
    expect(plan.metrics).toMatchObject({ tasks: 2, zeroImpactTasks: 2 });
    expect(plan.aiSummary.text).toBe(proposal.explanation.text);
    expect(String(plan.proposal)).toBe(String(proposal._id));
    expect(String(applied.maintenancePlanId)).toBe(created[0].id);
    const wos = await Model('workorders').find({ maintenancePlanId: plan._id }).lean();
    expect(wos).toHaveLength(2);
    for (const wo of wos) {
      const task = proposal.diff.tasks.find((x) => x.title === wo.name);
      expect(task).toBeTruthy();
      expect(wo.plannedStart).toEqual(new Date(task.start));
      expect(wo.plannedEnd).toEqual(new Date(task.end));
      expect(wo.people.map(String)).toEqual([task.technician.userId]);
      expect(String(wo.anomalyId)).toBe(task.refId);
    }
  });

  it('re-plans a stale plan (PLAN_CHANGED) and refuses a not-doable plan unless forced', async () => {
    await Model('anomalies').updateMany(
      { companyId: acme.companyId },
      { $set: { state: 'open', workOrderId: null } },
    );
    await Model('workorders').updateMany(
      { companyId: acme.companyId, maintenancePlanId: { $ne: null } },
      { $set: { workStatus: 'Closed' } },
    );
    const p = await proposeMaintenancePlan(ctx, { scope: 'plant', plantId: String(plant._id) }, { now: NOW });
    expect(p.input).toMatchObject({ scope: 'plant', objective: 'protect_production', horizonDays: 7 });
    await records.create(ctx, 'workorders', { name: 'Unplanned breakdown' }); // bumps scheduleVersion
    const err = await applyProposal(ctx, p._id).catch((e) => e);
    expect(err).toMatchObject({ status: 409, code: 'PLAN_CHANGED' });
    const fresh = await getProposal(ctx, err.details.proposalId);
    expect(fresh).toMatchObject({ kind: 'maintenance_plan', status: 'draft' });
    await Model('planproposals').updateOne(
      { _id: fresh._id },
      { $set: { 'feasibility.verdict': 'not_doable' } },
    );
    await expect(applyProposal(ctx, fresh._id)).rejects.toMatchObject({
      status: 409,
      code: 'PLAN_NOT_DOABLE',
      details: { verdict: 'not_doable' },
    });
    const forced = await applyProposal(ctx, fresh._id, { force: true });
    expect(forced.proposal.status).toBe('applied');
  });

  it('plan_maintenance with a scope returns the plan summary, and the summary falls back when the AI is out', async () => {
    await Model('anomalies').updateMany(
      { companyId: acme.companyId },
      { $set: { state: 'open', workOrderId: null } },
    );
    await Model('workorders').updateMany(
      { companyId: acme.companyId, maintenancePlanId: { $ne: null } },
      { $set: { workStatus: 'Closed' } },
    );
    const [tool] = maintenancePlanningTools;
    const result = await tool.run(
      ctx,
      tool.schema.parse({ scope: 'assets', assetIds: ['IMM-03'], objective: 'balanced' }),
    );
    expect(result.forModel).toMatchObject({ kind: 'maintenance_plan', verdict: expect.any(String) });
    expect(result.forModel.tasks[0]).toHaveProperty('technician');
    expect(result.summary).toMatch(/^PLN-\d+ · \d+ tasks? · \d+ zero-impact · ₹[\d,]+ avoided$/);
    expect(result.blocks[0].payload.tasks.length).toBeGreaterThan(0);
    const proposal = await getProposal(ctx, result.forModel.proposalId);
    expect(proposal.input.objective).toBe('balanced');
    ai.fail = true;
    const down = await summarise(ctx, proposal);
    ai.fail = false;
    expect(down.proposal.explanation).toBeNull();
    expect(down.aiError.code).toBe('AI_QUOTA');
    expect((await explainMaintenancePlan(ctx, proposal)).explanation.text).toContain('•');
    // POST /planning/proposals/:id/explain dispatches a maintenance_plan to its own summary and stores it.
    const explained = await explainProposal(ctx, proposal);
    expect(explained.text).toMatch(/^(Doable|Needs adjustment|Not doable):/);
    expect((await getProposal(ctx, proposal._id)).explanation.text).toBe(explained.text);
  });

  it('POST /api/planning/maintenance/plan answers { proposal, plan, check } and refuses viewers; GET /planning/people', async () => {
    const auth = (who) => ({ authorization: `Bearer ${tokens[who]}` });
    await Model('anomalies').updateMany(
      { companyId: acme.companyId },
      { $set: { state: 'open', workOrderId: null } },
    );
    const ok = await request(app)
      .post('/api/planning/maintenance/plan')
      .set(auth('owner'))
      .send({ scope: 'assets', assetIds: [String(press2._id)], horizonDays: 3, objective: 'fix_fast' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.proposal.kind).toBe('maintenance_plan');
    expect(ok.body.check).toMatchObject({ verdict: expect.any(String), impactDelta: { hours: 0, cost: 0 } });
    expect(ok.body.check.tasks.length).toBeGreaterThan(0);
    expect(ok.body.plan.tasks).toEqual(ok.body.check.tasks);
    expect(ok.body.proposal.explanation.text).toMatch(/^(Doable|Needs adjustment|Not doable):/);
    const bad = await request(app)
      .post('/api/planning/maintenance/plan')
      .set(auth('owner'))
      .send({ scope: 'assets', assetIds: ['x'] });
    expect(bad.status).toBe(400);
    expect(
      (await request(app).post('/api/planning/maintenance/plan').set(auth('viewer')).send({})).status,
    ).toBe(403);
    const people = await request(app)
      .get(
        `/api/planning/people?department=Maintenance&from=${NOW.toISOString()}&to=${new Date(NOW.getTime() + 2 * HOUR).toISOString()}&skills=mechanical`,
      )
      .set(auth('viewer'));
    expect(people.status).toBe(200);
    expect(people.body.people.find((p) => p.name === 'Ramesh Kumar')).toMatchObject({
      skillMatch: true,
      shift: 'A',
    });
    expect(
      (await request(app).get('/api/planning/people?from=2026-01-01&to=2026-03-01').set(auth('owner')))
        .status,
    ).toBe(400);
  });

  it('a whole-plant plan re-checks unchanged without working-time issues (breaks count in neither)', async () => {
    await Model('anomalies').updateMany(
      { companyId: acme.companyId },
      { $set: { state: 'open', workOrderId: null } },
    );
    const proposal = await proposeMaintenancePlan(ctx, { scope: 'plant', horizonDays: 7 }, { now: NOW });
    const tasks = proposal.diff.tasks.map((x) => ({
      key: x.key,
      start: x.start,
      end: x.end,
      durationMin: x.durationMin,
      technicianId: x.technician?.userId ?? null,
    }));
    expect(tasks.length).toBeGreaterThan(2);
    const check = await checkMaintenancePlan(ctx, { proposalId: String(proposal._id), tasks }, { now: NOW });
    const kinds = check.issues.map((i) => i.kind);
    expect(kinds).not.toContain('too_short');
    expect(kinds).not.toContain('outside_working');
    // A technician on shift through a break is free for a block that spans it.
    for (const x of check.tasks.filter((t) => t.technician))
      expect(x.issues.map((i) => check.issues[i].kind)).not.toContain('technician_off_shift');
  });
});
