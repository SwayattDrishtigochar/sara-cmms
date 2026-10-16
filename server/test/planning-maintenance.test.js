import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { workingIntervals } from '../src/lib/shifts.js';
import { getModule } from '../src/modules/registry.js';
import { explainMaintenance } from '../src/planning/explain.js';
import {
  maintenanceTasks,
  planMaintenance,
  planMaintenanceProposal,
  rescheduleForward,
} from '../src/planning/maintenance.js';
import { maintenancePlanningTools } from '../src/planning/maintenanceTool.js';
import { applyProposal, planBlockFor } from '../src/planning/proposals.js';
import { planningMaintenanceRouter } from '../src/routes/planningMaintenance.js';
import { contextFor, NOW, PASSWORD, setupDatabase, teardownDatabase } from './helpers/db.js';

const ai = vi.hoisted(() => ({ fail: false, pick: null }));
vi.mock('../src/ai/gemini.js', async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    generate: async (args) => {
      if (ai.fail) throw new real.AiUnavailableError('AI_QUOTA', 'The AI is busy');
      if (ai.pick)
        return {
          json: { recommendedOption: ai.pick, summary: 'Defer it.', reasons: ['x'] },
          model: 'm',
          mock: true,
        };
      return real.generate(args);
    },
  };
});

const ZONE = 'Asia/Kolkata';
const HOUR = 3_600_000;
const ist = (local) => new Date(`${local}:00+05:30`);
const SHIFTS = [
  {
    _id: 'A',
    shiftName: 'A',
    shiftStartTime: '06:00',
    shiftEndTime: '14:00',
    breaks: [
      { breakStartTime: '09:00', breakEndTime: '09:15' },
      { breakStartTime: '11:30', breakEndTime: '12:00' },
    ],
  },
  {
    _id: 'B',
    shiftName: 'B',
    shiftStartTime: '14:00',
    shiftEndTime: '22:00',
    breaks: [
      { breakStartTime: '17:00', breakEndTime: '17:15' },
      { breakStartTime: '19:30', breakEndTime: '20:00' },
    ],
  },
  {
    _id: 'C',
    shiftName: 'C',
    shiftStartTime: '22:00',
    shiftEndTime: '06:00',
    breaks: [
      { breakStartTime: '01:00', breakEndTime: '01:15' },
      { breakStartTime: '02:00', breakEndTime: '02:30' },
    ],
  },
];
const PLANT = {
  shifts: SHIFTS,
  runningSchedule: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'],
  holidays: [],
};
const END = new Date(NOW.getTime() + 10 * 24 * HOUR);
const working = (plant = PLANT) => workingIntervals(plant, NOW, END, ZONE);
const machine = (assetId, bookings = []) => ({
  assetId,
  name: `Press ${assetId.slice(1)}`,
  efficiency: 0.85,
  working: working(),
  bookings,
});
const card = (id, start, end, extra = {}) => ({
  kind: 'jobcard',
  id,
  code: id,
  label: `Job ${id}`,
  start: ist(start),
  end: ist(end),
  ...extra,
});
const calendar = (machines, tools = []) => ({
  start: NOW,
  end: END,
  now: NOW,
  timeZone: ZONE,
  machines,
  tools,
});
const anomalyTask = (extra = {}) => ({
  kind: 'anomaly',
  refId: 'a1',
  code: 'ANM-1',
  assetId: 'M1',
  assetName: 'Press 1',
  title: 'Bearing inspection',
  durationMin: 60,
  deadline: ist('2026-10-15T20:00'),
  priority: 'Medium',
  category: 'Mechanical',
  severity: 'warning',
  urgencyHours: 8,
  ...extra,
});

describe('planMaintenance (pure)', () => {
  it('finds the earliest zero-impact window before the deadline', () => {
    const cal = calendar([machine('M1', [card('JC-1', '2026-10-15T08:00', '2026-10-15T20:00')])]);
    const [plan] = planMaintenance(
      cal,
      [anomalyTask({ durationMin: 90, deadline: ist('2026-10-16T06:00') })],
      {
        now: NOW,
      },
    ).tasks;
    expect(plan.options.map((o) => o.id)).toEqual(['zero_impact']);
    expect(plan.recommended).toBe('zero_impact');
    const [o] = plan.options;
    expect(o.start).toEqual(ist('2026-10-15T20:00')); // after the 19:30–20:00 dinner break
    expect(o.end).toEqual(ist('2026-10-15T21:30'));
    expect(o.lateHours).toBe(0);
    expect(o.ops[0]).toMatchObject({
      seq: 0,
      op: 'create',
      module: 'workorders',
      data: {
        name: 'Bearing inspection',
        asset: 'M1',
        anomalyId: 'a1',
        plannedStart: o.start,
        plannedEnd: o.end,
      },
    });
    expect(o.diff.bars[0]).toMatchObject({ kind: 'maintenance', ghost: true, change: 'new', rowId: 'M1' });
  });

  const pushedMachine = () =>
    machine('M1', [
      card('JC-1', '2026-10-15T08:00', '2026-10-16T14:00', { dueDate: ist('2026-10-19T18:00') }),
      card('JC-2', '2026-10-16T14:00', '2026-10-17T18:00', { dueDate: ist('2026-10-17T18:00') }),
    ]);

  it('insert shifts the overlapping and later job cards by the block and flags the plan that turns late', () => {
    const [plan] = planMaintenance(calendar([pushedMachine()]), [anomalyTask({ severity: 'critical' })], {
      now: NOW,
    }).tasks;
    const insert = plan.options.find((o) => o.id === 'insert');
    expect(insert.start).toEqual(NOW);
    expect(insert.end).toEqual(new Date(NOW.getTime() + HOUR));
    expect(insert.delays).toEqual([
      {
        jobCardId: 'JC-1',
        code: 'JC-1',
        rowId: 'M1',
        hours: 1,
        late: false,
        dueDate: ist('2026-10-19T18:00'),
      },
      {
        jobCardId: 'JC-2',
        code: 'JC-2',
        rowId: 'M1',
        hours: 1,
        late: true,
        dueDate: ist('2026-10-17T18:00'),
      },
    ]);
    expect(insert.lateHours).toBe(1);
    expect(insert.delayHours).toBe(2);
    const jcOps = insert.ops.filter((op) => op.module === 'jobcards');
    expect(jcOps[0].data).toEqual({ startDate: ist('2026-10-15T08:00'), endDate: ist('2026-10-16T15:00') });
    expect(jcOps[1].data).toEqual({ startDate: ist('2026-10-16T15:00'), endDate: ist('2026-10-17T19:00') });
    expect(insert.diff.bars.slice(1).map((b) => [b.id, b.change, b.late ?? false])).toEqual([
      ['JC-1', 'extended', false],
      ['JC-2', 'moved', true],
    ]);
    // A critical anomaly is never deferred, even though the insert makes a plan late.
    expect(plan.recommended).toBe('insert');
  });

  it('defers a non-critical task when every push makes a plan late, and states the risk', () => {
    const [plan] = planMaintenance(calendar([pushedMachine()]), [anomalyTask()], { now: NOW }).tasks;
    const defer = plan.options.find((o) => o.id === 'defer');
    expect(defer.start).toEqual(ist('2026-10-17T18:00'));
    expect(defer.end).toEqual(ist('2026-10-17T19:00'));
    expect(defer.maintenanceLateHours).toBe(47);
    expect(defer.risk).toBe('Runs 47 h after the AI deadline (urgency 8 h)');
    expect(plan.recommended).toBe('defer');
  });

  const tool = (assets) => ({
    toolId: 'T1',
    assets,
    cycleSec: 30,
    setupMin: 30,
    parts: [{ partName: 'Bracket', perShot: 2 }],
    busy: [
      { start: ist('2026-10-15T06:00'), end: ist('2026-10-16T14:00'), assetId: 'M1', jobCardId: 'JC-1' },
    ],
  });
  const runningCard = () =>
    card('JC-1', '2026-10-15T06:00', '2026-10-16T14:00', {
      toolId: 'T1',
      target: 1000,
      partsOut: 200,
      template: {
        jobName: 'Bracket – stock',
        partName: 'Bracket',
        operationName: 'Pressing',
        rejectionPercentage: 0,
      },
    });
  const pmTask = {
    kind: 'pm',
    refId: 'pm1',
    code: 'PM-7',
    assetId: 'M1',
    assetName: 'Press 1',
    title: 'Monthly PM – Press 1',
    durationMin: 60,
    deadline: ist('2026-10-15T20:00'),
    priority: 'Medium',
    category: 'Preventive',
    dueDate: ist('2026-10-15T20:00'),
    nextGenerationDate: ist('2026-11-15T20:00'),
  };

  it('move stops the card at the block and runs the remaining parts on the free machine', () => {
    const cal = calendar([machine('M1', [runningCard()]), machine('M2')], [tool(['M1', 'M2'])]);
    const [plan] = planMaintenance(cal, [pmTask], { now: NOW }).tasks;
    expect(plan.options.map((o) => o.id)).toEqual(['insert', 'move', 'defer']);
    const move = plan.options.find((o) => o.id === 'move');
    expect(move.label).toBe('Move the rest of JC-1 to Press 2');
    const [, pmOp, stop, created] = move.ops;
    // The PM moves to its next cycle so the simulator does not generate a second work order.
    expect(pmOp).toMatchObject({
      op: 'update',
      module: 'preventivemaintenances',
      id: 'pm1',
      data: { nextGenerationDate: ist('2026-11-15T20:00') },
    });
    expect(stop).toMatchObject({ op: 'update', id: 'JC-1', data: { endDate: NOW, target: 200 } });
    // 30 min setup + 400 shots × 30 s ÷ 0.85 = 4.42 working hours from 12:00 → 16:25:18 (before the 17:00 tea break).
    expect(created).toMatchObject({
      op: 'create',
      module: 'jobcards',
      data: { asset: 'M2', tool: 'T1', target: 800, jobName: 'Bracket – stock', startDate: NOW },
    });
    expect(created.data.endDate.getTime()).toBe(ist('2026-10-15T16:25').getTime() + 17_647);
    expect(created.data.operations).toEqual([{ operationName: 'Pressing', assetId: 'M2', cycleTime: 30 }]);
    expect(move.lateHours).toBe(0);
    expect(move.delayHours).toBe(0);
    expect(plan.recommended).toBe('move'); // insert delays JC-1 by 1 h, move by nothing
  });

  it('skips move when the tool has no other machine', () => {
    const cal = calendar([machine('M1', [runningCard()])], [tool(['M1'])]);
    const [plan] = planMaintenance(cal, [pmTask], { now: NOW }).tasks;
    expect(plan.options.map((o) => o.id)).toEqual(['insert', 'defer']);
    expect(plan.recommended).toBe('insert');
  });

  it('plans inside an overnight shift, across its after-midnight break', () => {
    const staff = workingIntervals({ ...PLANT, shifts: [SHIFTS[2]] }, NOW, END, ZONE);
    const task = anomalyTask({ durationMin: 200, deadline: ist('2026-10-16T12:00') });
    const [plan] = planMaintenance(calendar([machine('M1')]), [task], { now: NOW, staff }).tasks;
    expect(plan.recommended).toBe('zero_impact');
    expect(plan.options[0].start).toEqual(ist('2026-10-15T22:00'));
    expect(plan.options[0].end).toEqual(ist('2026-10-16T01:35')); // 180 min, the 01:00–01:15 tea break, 20 min
  });

  it('books each chosen window before planning the next task', () => {
    const tasks = [
      anomalyTask({ deadline: ist('2026-10-16T12:00') }),
      { ...pmTask, deadline: ist('2026-10-16T12:00') },
    ];
    const [first, second] = planMaintenance(calendar([machine('M1')]), tasks, { now: NOW }).tasks;
    expect(first.options[0].end).toEqual(ist('2026-10-15T13:00'));
    expect(second.options[0].start).toEqual(ist('2026-10-15T13:00'));
  });

  it('insert and the pushed cards run around work orders that are already planned', () => {
    const wo = (id, start, end) => ({ kind: 'workorder', id, code: id, start: ist(start), end: ist(end) });
    const m = machine('M1', [
      card('JC-1', '2026-10-15T08:00', '2026-10-16T14:00'),
      wo('WO-1', '2026-10-15T12:00', '2026-10-15T13:00'),
      wo('WO-2', '2026-10-16T14:00', '2026-10-16T15:00'),
    ]);
    const task = anomalyTask({ severity: 'critical', deadline: ist('2026-10-15T14:00') });
    const [plan] = planMaintenance(calendar([m]), [task], { now: NOW }).tasks;
    const insert = plan.options.find((o) => o.id === 'insert');
    expect([insert.start, insert.end]).toEqual([ist('2026-10-15T13:00'), ist('2026-10-15T14:00')]);
    // JC-1 already ran around WO-1; it now also runs around the new block and WO-2.
    expect(insert.ops.find((op) => op.id === 'JC-1').data.endDate).toEqual(ist('2026-10-16T16:00'));
  });

  it('rescheduleForward leaves the plan alone when the block sits in a gap', () => {
    const m = machine('M1', [card('JC-1', '2026-10-15T14:00', '2026-10-15T18:00')]);
    expect(rescheduleForward(m, { start: NOW, end: ist('2026-10-15T13:00') }, { now: NOW })).toMatchObject({
      moves: [],
      delays: [],
    });
  });
});

describe('maintenance planning on the seeded plant', () => {
  let ctx;
  let press1;
  let anomaly;
  let app;
  const tokens = {};

  beforeAll(async () => {
    const { acme } = await setupDatabase();
    ctx = await contextFor('owner_1@acme.test');
    press1 = await getModule('assets')
      .Model.findOne({ companyId: acme.companyId, assetTag: 'PRS-01' })
      .lean();
    anomaly = (
      await getModule('anomalies').Model.create({
        companyId: acme.companyId,
        plantId: press1.plantId,
        anomalyCode: 'ANM-900',
        assetId: press1._id,
        type: 'quality_degradation',
        severity: 'warning',
        state: 'open',
        summary: 'Rejections are climbing.',
        urgencyHours: 8,
        detectedAt: new Date(NOW.getTime() - HOUR),
        investigation: {
          suggestedWorkOrder: {
            name: 'Bearing inspection – Press 1',
            description: 'Check the crank bearing.',
            priority: 'Medium',
            category: 'Mechanical',
            estimatedDurationMin: 45,
          },
        },
      })
    ).toObject();
    app = createApp({ routers: [{ path: '/api', router: planningMaintenanceRouter }] });
    for (const [who, email] of Object.entries({ owner: 'owner_1@acme.test', viewer: 'viewer_1@acme.test' })) {
      const res = await request(app).post('/api/auth/login').send({ email, password: PASSWORD });
      tokens[who] = res.body.token;
    }
  });
  afterAll(teardownDatabase);

  it('turns an anomaly into a task with the deadline from its urgency', async () => {
    const [task] = await maintenanceTasks(ctx, { anomalyId: String(anomaly._id) }, NOW);
    expect(task).toMatchObject({
      kind: 'anomaly',
      code: 'ANM-900',
      assetId: String(press1._id),
      title: 'Bearing inspection – Press 1',
      durationMin: 45,
      priority: 'Medium',
      category: 'Mechanical',
    });
    expect(task.deadline).toEqual(new Date(NOW.getTime() + 7 * HOUR));
  });

  it('collects every task of an asset, ordered by deadline, with the PM’s next cycle', async () => {
    const tasks = await maintenanceTasks(ctx, { assetId: String(press1._id) }, NOW);
    expect(tasks.map((t) => t.code)).toContain('ANM-900');
    const pm = tasks.find((t) => t.kind === 'pm');
    expect(pm.durationMin).toBe(90);
    expect(pm.nextGenerationDate.getTime()).toBeGreaterThan(pm.dueDate.getTime() + 27 * 24 * HOUR);
    const deadlines = tasks.map((t) => t.deadline.getTime());
    expect(deadlines).toEqual([...deadlines].sort((a, b) => a - b));
  });

  it('re-plans the other tasks around each option of the first, so no option double-books Press 1', async () => {
    const { proposal, calendar: cal } = await planMaintenanceProposal(
      ctx,
      { assetId: String(press1._id) },
      { now: NOW },
    );
    const row = String(press1._id);
    const cards = cal.machines
      .find((m) => String(m.assetId) === row)
      .bookings.filter((b) => b.kind === 'jobcard');
    const t = (d) => new Date(d).getTime();
    const overlap = (x, y) => t(x.start) < t(y.end) && t(y.start) < t(x.end);
    expect(proposal.options.length).toBeGreaterThan(1);
    for (const option of proposal.options) {
      const blocks = option.ops
        .filter((op) => op.module === 'workorders')
        .map(({ data }) => ({
          start: data.plannedStart,
          end: data.plannedEnd,
          min: data.estimatedDurationMin,
        }));
      expect(blocks.length, option.id).toBeGreaterThan(1);
      blocks.forEach((x, i) => {
        for (const y of blocks.slice(i + 1))
          expect(overlap(x, y), `${option.id}: two work orders at once`).toBe(false);
      });
      // A card a block lands on must be pushed by at least every block inside it.
      for (const c of cards) {
        // Replays run in order, so the card's last update wins.
        const op = option.ops
          .filter((o) => o.module === 'jobcards' && o.op === 'update' && o.id === c.id)
          .at(-1);
        const span = { start: op?.data.startDate ?? c.start, end: op?.data.endDate ?? c.end };
        const inside = blocks.filter((x) => overlap(x, span));
        const pushed = t(span.end) - t(c.end);
        // A card stopped early hands its remaining parts to a new card on another machine.
        if (pushed < 0) {
          expect(option.ops.some((o) => o.module === 'jobcards' && o.op === 'create')).toBe(true);
          continue;
        }
        const needed = inside.reduce((sum, x) => sum + x.min * 60_000, 0);
        expect(pushed, `${option.id}: ${c.code} runs during maintenance`).toBeGreaterThanOrEqual(
          needed - 60_000,
        );
      }
      expect(option.ops.map((op) => op.seq)).toEqual(option.ops.map((_, i) => i));
    }
  });

  it('proposes push options for the running job card and stores one draft', async () => {
    const { proposal, planned } = await planMaintenanceProposal(
      ctx,
      { anomalyId: String(anomaly._id) },
      { now: NOW },
    );
    const ids = planned.tasks[0].options.map((o) => o.id);
    expect(ids).toContain('insert');
    expect(ids).toContain('move'); // T-301 also fits Press 2
    expect(proposal).toMatchObject({ kind: 'maintenance', title: 'Bearing inspection – Press 1' });
    expect(proposal.recommendedOption).toBe(planned.tasks[0].recommended);
    expect(proposal.ops[0]).toMatchObject({ seq: 0, op: 'create', module: 'workorders' });
    expect(String(proposal.ops[0].data.anomalyId)).toBe(String(anomaly._id));
    expect(proposal.status).toBe('draft');
    // The stored plan block draws a row for every ghost, incl. the move option's new card on Press 2.
    const move = proposal.options.find((o) => o.id === 'move');
    const block = await planBlockFor(ctx, { ...proposal, diff: move.diff });
    const rows = new Set(block.rows.map((r) => r.id));
    const ghosts = block.bars.filter((b) => b.ghost);
    expect(ghosts.some((b) => b.rowId !== String(press1._id))).toBe(true);
    for (const b of ghosts) expect(rows.has(b.rowId), b.id).toBe(true);
  });

  it('applies the move option: work order in the window, job card stopped, remainder on Press 2', async () => {
    const { proposal } = await planMaintenanceProposal(ctx, { anomalyId: String(anomaly._id) }, { now: NOW });
    const move = proposal.options.find((o) => o.id === 'move');
    const { created, updated } = await applyProposal(ctx, proposal.proposalCode, { option: 'move' });
    expect(created.map((r) => r.module).sort()).toEqual(['jobcards', 'workorders']);
    expect(updated.map((r) => r.module)).toContain('jobcards');
    const wo = await getModule('workorders')
      .Model.findById(created.find((r) => r.module === 'workorders').id)
      .lean();
    expect(wo).toMatchObject({ name: 'Bearing inspection – Press 1', estimatedDurationMin: 45 });
    expect(wo.plannedStart).toEqual(new Date(move.start));
    const rest = await getModule('jobcards')
      .Model.findById(created.find((r) => r.module === 'jobcards').id)
      .lean();
    expect(String(rest.asset)).not.toBe(String(press1._id));
    const stop = move.ops.find((op) => op.module === 'jobcards' && op.op === 'update');
    const original = await getModule('jobcards').Model.findById(stop.id).lean();
    expect(original.target + rest.target).toBe(stop.before.target);
  });

  it('plans an anomaly through the work order an earlier plan made; the asset sweep skips it once booked', async () => {
    const wo = await getModule('workorders').Model.findOne({ anomalyId: anomaly._id }).lean();
    const [task] = await maintenanceTasks(ctx, { anomalyId: String(anomaly._id) }, NOW);
    expect(task.workOrderId).toBe(String(wo._id));
    const sweep = await maintenanceTasks(ctx, { assetId: String(press1._id) }, NOW);
    expect(sweep.map((x) => x.code)).not.toContain('ANM-900');
  });

  it('never lets the AI defer a critical anomaly while a push option exists', async () => {
    const options = [
      { id: 'insert', label: 'Insert', lateHours: 2, ops: [], diff: { bars: [] } },
      { id: 'defer', label: 'Defer', lateHours: 0, ops: [], diff: { bars: [] } },
    ];
    const proposal = { kind: 'maintenance', anomalyId: anomaly._id, options, recommendedOption: 'insert' };
    ai.pick = 'defer';
    try {
      expect((await explainMaintenance(ctx, proposal)).recommendedOption).toBe('defer'); // warning: allowed
      await getModule('anomalies').Model.updateOne({ _id: anomaly._id }, { severity: 'critical' });
      expect((await explainMaintenance(ctx, proposal)).recommendedOption).toBeUndefined();
    } finally {
      ai.pick = null;
      await getModule('anomalies').Model.updateOne({ _id: anomaly._id }, { severity: 'warning' });
    }
  });

  it('plan_maintenance resolves codes and returns the options with a plan block', async () => {
    const [tool] = maintenancePlanningTools;
    const result = await tool.run(ctx, tool.schema.parse({ anomaly: 'ANM-900' }));
    expect(result.forModel.code).toMatch(/^PLN-/);
    // Runs on the wall clock after the move above freed Press 1, so the option count is not fixed.
    expect(result.forModel.options.map((o) => o.id)).toContain(result.forModel.recommended);
    expect(result.summary).toMatch(/^PLN-\d+ · \d options? · recommended /);
    expect(result.blocks[0].type).toBe('plan');
  });

  it('POST /api/planning/maintenance explains the pick, falls back when the AI is out, and refuses viewers', async () => {
    const auth = (who) => ({ authorization: `Bearer ${tokens[who]}` });
    const body = { anomalyId: String(anomaly._id) };
    const ok = await request(app).post('/api/planning/maintenance').set(auth('owner')).send(body);
    expect(ok.status).toBe(200);
    expect(ok.body.proposal.explanation.text.length).toBeGreaterThan(10);
    expect(ok.body.proposal.explanation.mock).toBe(true);
    expect(ok.body.plan.bars.length).toBeGreaterThan(0);

    ai.fail = true;
    const down = await request(app).post('/api/planning/maintenance').set(auth('owner')).send(body);
    ai.fail = false;
    expect(down.status).toBe(200);
    expect(down.body.aiError.code).toBe('AI_QUOTA');
    expect(down.body.proposal.explanation.text).toMatch(/^Least delay: /);

    const viewer = await request(app).post('/api/planning/maintenance').set(auth('viewer')).send(body);
    expect(viewer.status).toBe(403);
  });
});
