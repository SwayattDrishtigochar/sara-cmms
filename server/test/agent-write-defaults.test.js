import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  completeRecord,
  decidedText,
  findRef,
  parseFrequency,
  similarity,
} from '../src/agent/tools/defaults.js';
import { peopleTools } from '../src/agent/tools/people.js';
import { writeTools } from '../src/agent/tools/write.js';
import { records } from '../src/modules/records.js';
import { getModule } from '../src/modules/registry.js';
import { contextFor, NOW, setupDatabase, systemContext, teardownDatabase } from './helpers/db.js';

/** Decisive writes (T2): smart defaults, coercion by name/code, precise field errors, assignees, bulk deletes. */

const tool = (name) => [...writeTools, ...peopleTools].find((t) => t.name === name);
const Model = (name) => getModule(name).Model;
const DAY = 86_400_000;
let acme;
let owner;
let furnace2;
let imm1;
let imm2;
let puneTechs; // ids of the Pune maintenance technicians

beforeAll(async () => {
  ({ acme } = await setupDatabase());
  owner = await contextFor('owner_1@acme.test');
  furnace2 = await Model('assets').findOne({ companyId: acme.companyId, name: 'Furnace 2' }).lean();
  imm1 = await Model('assets').findOne({ companyId: acme.companyId, name: 'IMM 1' }).lean();
  imm2 = await Model('assets').findOne({ companyId: acme.companyId, name: 'IMM 2' }).lean();
  const techs = await Model('users')
    .find({ companyId: acme.companyId, role: 'technician', department: 'Maintenance', plantId: imm1.plantId })
    .lean();
  puneTechs = new Set(techs.map((u) => String(u._id)));
});
afterAll(teardownDatabase);

describe('name matching', () => {
  it('scores exact, prefix, contains and typos', () => {
    expect(similarity('Furnace 2', 'furnace 2')).toBe(1);
    expect(similarity('Ramesh', 'Ramesh Kumar')).toBeGreaterThanOrEqual(0.9);
    expect(similarity('Rakesh Kumar', 'Ramesh Kumar')).toBeGreaterThan(0.7);
    expect(similarity('Rahul', 'Arjun Rao')).toBeLessThan(0.5);
  });

  it('findRef takes codes, names and close typos, and says "did you mean" otherwise', async () => {
    expect((await findRef(owner, 'assets', 'IMM-01')).id).toBe(String(imm1._id));
    expect((await findRef(owner, 'assets', String(imm1._id))).label).toMatch(/IMM 1$/);
    const ramesh = await findRef(owner, 'users', 'Rakesh Kumar');
    expect(ramesh.label).toBe('Ramesh Kumar');
    expect(ramesh.exact).toBe(false);
    await expect(findRef(owner, 'users', 'Rahul')).rejects.toThrow(/No person matches "Rahul"/);
  });
});

describe('completeRecord: work orders', () => {
  it('decides category, priority, due date, duration, checklist and a technician from the asset alone', async () => {
    const { item, decided } = await completeRecord(
      owner,
      'workorders',
      { asset: 'Furnace 2' },
      { hints: 'Furnace 2 breakdown: it stopped suddenly, door temp 54 °C', now: NOW },
    );
    expect(item.asset).toBe(String(furnace2._id));
    expect(item.category).toBe('Breakdown');
    expect(item.priority).toBe('High');
    expect(item.name).toBe('Breakdown – Furnace 2');
    expect(item.description).toMatch(/door temp 54/);
    expect(item.dueDate.getTime()).toBe(NOW.getTime() + DAY);
    expect(item.estimatedDurationMin).toBe(90);
    expect(item.taskAndChecklist[0].tasks.length).toBeGreaterThanOrEqual(3);
    expect(item.people).toHaveLength(1);
    expect(puneTechs.has(item.people[0])).toBe(true);
    const fields = Object.fromEntries(decided.map((d) => [d.field, d.why]));
    expect(fields.priority).toBe('breakdown');
    expect(fields.people).toMatch(/free|least loaded/);
    const text = decidedText(owner, decided, { [item.people[0]]: 'Tech' });
    expect(text).toMatch(/priority High \(breakdown\)/);
    expect(text).toMatch(/assigned Tech \((free|least loaded)/);
    expect(text).toMatch(/due \d\d-\d\d-\d{4} \d\d:\d\d \(High priority\)/);
  });

  it('prefers a technician with the skills of the category when one is free', async () => {
    const { item } = await completeRecord(
      owner,
      'workorders',
      { asset: 'IMM 1', category: 'Hydraulic' },
      { now: NOW },
    );
    const tech = await Model('users').findById(item.people[0]).lean();
    expect(tech.department).toBe('Maintenance');
    expect(String(tech.plantId)).toBe(String(imm1.plantId));
    // Ramesh Kumar (mechanical, hydraulics) is on shift A at NOW; he wins unless already booked.
    const ramesh = await Model('users').findOne({ companyId: acme.companyId, firstName: 'Ramesh' }).lean();
    const booked = await Model('workorders').exists({
      people: ramesh._id,
      workStatus: { $nin: ['Completed', 'Closed'] },
      plannedStart: { $lt: new Date(NOW.getTime() + 2 * 3_600_000) },
      plannedEnd: { $gt: NOW },
    });
    if (!booked) expect(item.people[0]).toBe(String(ramesh._id));
  });

  it('coerces loose field names, people by name (typo tolerant), lowercase enums, text dates and string checklists', async () => {
    const { item, decided } = await completeRecord(
      owner,
      'workorders',
      {
        title: 'Coolant leak',
        machine: 'IMM-02',
        technician: 'Rakesh Kumar',
        priority: 'high',
        due: 'tomorrow',
        tasks: ['Check hose', 'Replace seal'],
        status: 'Open',
      },
      { now: NOW },
    );
    expect(item.name).toBe('Coolant leak');
    expect(item.asset).toBe(String(imm2._id));
    const ramesh = await Model('users').findOne({ companyId: acme.companyId, firstName: 'Ramesh' }).lean();
    expect(item.people).toEqual([String(ramesh._id)]);
    expect(item.priority).toBe('High');
    expect(item.dueDate.getTime()).toBeGreaterThan(NOW.getTime() + DAY / 2);
    expect(item.dueDate.getTime()).toBeLessThan(NOW.getTime() + 2 * DAY);
    expect(item.taskAndChecklist).toEqual([
      { topic: 'Checklist', tasks: [{ task: 'Check hose' }, { task: 'Replace seal' }] },
    ]);
    expect(item.status).toBeUndefined();
    expect(decided).toContainEqual({
      field: 'people',
      value: 'Ramesh Kumar',
      why: 'closest match to "Rakesh Kumar"',
    });
    expect(decided.find((d) => d.field === 'status').why).toMatch(/update_work_order_status/);
  });

  it('maps "urgent" to High and rejects a value that is not a priority with the allowed list', async () => {
    const { item } = await completeRecord(
      owner,
      'workorders',
      { name: 'x', priority: 'urgent' },
      { now: NOW },
    );
    expect(item.priority).toBe('High');
    await expect(
      completeRecord(owner, 'workorders', { name: 'x', priority: 'Extreme' }, { now: NOW }),
    ).rejects.toThrow(/priority: "Extreme" is not one of Low, Medium, High/);
  });

  it('takes category, priority, asset and description from the anomaly when anomalyId is set', async () => {
    const sys = await systemContext(acme.companyId);
    const anomaly = await records.create(
      sys,
      'anomalies',
      {
        assetId: String(imm1._id),
        type: 'pressure_low',
        severity: 'critical',
        summary: 'Injection pressure 20% below normal',
        explanation: 'Hydraulic pressure has dropped since shift A.',
      },
      { source: 'system' },
    );
    const { item } = await completeRecord(
      owner,
      'workorders',
      { anomalyId: String(anomaly._id) },
      { now: NOW },
    );
    expect(item.asset).toBe(String(imm1._id));
    expect(item.category).toBe('Hydraulic');
    expect(item.priority).toBe('High');
    expect(item.name).toMatch(/Pressure low on IMM 1/);
    expect(item.description).toMatch(/Hydraulic pressure has dropped/);
  });
});

describe('completeRecord: PMs and requests', () => {
  it('reads the frequency words', () => {
    expect(parseFrequency('monthly cleaning')).toEqual({ everyNumber: 1, duration: 'Months' });
    expect(parseFrequency('every 2 weeks')).toEqual({ everyNumber: 2, duration: 'Weeks' });
    expect(parseFrequency('quarterly')).toEqual({ everyNumber: 3, duration: 'Months' });
    expect(parseFrequency('whenever')).toBeNull();
  });

  it('builds a monthly PM with schedule, next due, template checklist and assignee from "monthly cleaning of Furnace 2"', async () => {
    const { item, decided } = await completeRecord(
      owner,
      'preventivemaintenances',
      { asset: 'Furnace 2', frequency: 'monthly' },
      { hints: 'for the cleaning purpose', now: NOW },
    );
    expect(item.assetAllocation).toBe(String(furnace2._id));
    expect(item.trigger).toMatchObject({
      scheduleType: 'Regular',
      cycle: { everyNumber: 1, duration: 'Months' },
    });
    expect(item.name).toBe('Monthly cleaning – Furnace 2');
    expect(item.nextGenerationDate.getTime()).toBe(NOW.getTime() + 30 * DAY);
    expect(item.estimatedDurationMin).toBe(40);
    expect(item.selectWorkOrder.taskAndChecklist[0].tasks.length).toBeGreaterThan(2);
    expect(item.selectWorkOrder.people).toHaveLength(1);
    expect(decided.map((d) => d.field)).toEqual(
      expect.arrayContaining(['trigger', 'name', 'nextGenerationDate', 'selectWorkOrder.people']),
    );
    // The module schema accepts it as is.
    const { doc } = await records.create(owner, 'preventivemaintenances', item, {
      source: 'agent',
      dryRun: true,
    });
    expect(doc.name).toBe(item.name);
  });

  it('builds a request from the asset and the symptoms and drops the priority with a note', async () => {
    const { item, decided } = await completeRecord(
      owner,
      'requests',
      { asset: 'IMM 1', priority: 'High' },
      { hints: 'main motor tripping twice per shift', now: NOW },
    );
    expect(item.type).toBe('Electrical');
    expect(item.name).toBe('Electrical – IMM 1');
    expect(item.description).toMatch(/motor tripping/);
    expect(item.priority).toBeUndefined();
    expect(decided.find((d) => d.field === 'priority').why).toMatch(/High priority/);
  });
});

describe('create_record tool', () => {
  const create = tool('create_record');

  it('previews the completed work order with a "SARA decided" line, then creates exactly that', async () => {
    const args = {
      module: 'workorders',
      items: [{ asset: 'Furnace 2' }],
      context: 'Furnace 2 breakdown: stopped suddenly at 619 °C',
    };
    const preview = await create.preview(owner, args);
    expect(preview.type).toBe('confirm');
    const [item] = preview.payload.items;
    expect(item.doc.priority).toBe('High');
    expect(item.doc.category).toBe('Breakdown');
    expect(item.doc.workStatus).toBe('Open');
    expect(item.doc.saraDecided).toMatch(/priority High \(breakdown\)/);
    expect(item.doc.saraDecided).toMatch(/assigned [A-Z][a-z]+ [A-Z][a-z]+ \((free|least loaded)/);
    expect(item.doc.saraDecided).toMatch(/due .* \(High priority\)/);
    expect(item.decided.length).toBeGreaterThan(3);

    const out = await create.run(owner, args);
    expect(out.ok).not.toBe(false);
    const wo = await Model('workorders').findById(out.forModel.created[0].id).lean();
    expect(wo).toMatchObject({ category: 'Breakdown', priority: 'High', workStatus: 'Open' });
    expect(String(wo.asset)).toBe(String(furnace2._id));
    expect(wo.people).toHaveLength(1);
    expect(wo.taskAndChecklist[0].tasks.length).toBeGreaterThanOrEqual(3);
    expect(wo.description).toMatch(/619/);
    expect(out.forModel.created[0].decided).toMatch(/assigned/);
  });

  it('turns schema errors into one plain line per field with the allowed values', async () => {
    await expect(
      create.preview(owner, { module: 'workorders', items: [{ name: 'x', priority: 'Extreme' }] }),
    ).rejects.toThrow(/Item 1: priority: "Extreme" is not one of Low, Medium, High/);
    await expect(
      create.preview(owner, { module: 'spareparts', items: [{ name: 'Seal kit', foo: 1 }] }),
    ).rejects.toThrow(/Item 1: .*"foo".*Fields of Spare Parts: /);
  });

  it('a person nobody has is a clear miss, not a crash', async () => {
    await expect(
      create.preview(owner, {
        module: 'workorders',
        items: [{ name: 'x', asset: 'IMM 1', people: ['Rahul'] }],
      }),
    ).rejects.toThrow(/No person matches "Rahul"/);
  });
});

describe('update_record: assignees and checklist', () => {
  const update = tool('update_record');
  let wo;
  let ramesh;
  let suresh;

  beforeAll(async () => {
    ramesh = await Model('users').findOne({ companyId: acme.companyId, firstName: 'Ramesh' }).lean();
    suresh = await Model('users').findOne({ companyId: acme.companyId, firstName: 'Suresh' }).lean();
    wo = await records.create(
      owner,
      'workorders',
      { name: 'Assignee test', asset: String(imm1._id), people: [String(ramesh._id)], taskAndChecklist: [] },
      { source: 'agent' },
    );
  });

  it('addPeople by name keeps the current assignees; the preview shows both', async () => {
    const args = {
      module: 'workorders',
      updates: [{ id: String(wo._id), data: { addPeople: ['Suresh Patil'] } }],
    };
    const preview = await update.preview(owner, args);
    const change = preview.payload.items[0].changes.find((c) => c.field === 'people');
    expect(change.to.map(String).sort()).toEqual([String(ramesh._id), String(suresh._id)].sort());
    expect(preview.payload.items[0].labels[String(suresh._id)]).toBe('Suresh Patil');
    const out = await update.run(owner, args);
    expect(out.ok).not.toBe(false);
    const after = await Model('workorders').findById(wo._id).lean();
    expect(after.people.map(String).sort()).toEqual([String(ramesh._id), String(suresh._id)].sort());
  });

  it('removePeople takes one off; people as a plain list (names ok) replaces', async () => {
    await update.run(owner, {
      module: 'workorders',
      updates: [{ id: String(wo._id), data: { removePeople: ['Ramesh'] } }],
    });
    let after = await Model('workorders').findById(wo._id).lean();
    expect(after.people.map(String)).toEqual([String(suresh._id)]);
    await update.run(owner, {
      module: 'workorders',
      updates: [{ id: String(wo._id), data: { people: ['Rakesh Kumar'] } }],
    });
    after = await Model('workorders').findById(wo._id).lean();
    expect(after.people.map(String)).toEqual([String(ramesh._id)]);
  });

  it('addTasks appends to the checklist; dueDate accepts words', async () => {
    const out = await update.run(owner, {
      module: 'workorders',
      updates: [
        { id: String(wo._id), data: { addTasks: ['Check hose', 'Replace seal'], dueDate: 'tomorrow' } },
      ],
    });
    expect(out.ok).not.toBe(false);
    const after = await Model('workorders').findById(wo._id).lean();
    expect(after.taskAndChecklist.flatMap((g) => g.tasks.map((t) => t.task))).toEqual([
      'Check hose',
      'Replace seal',
    ]);
    expect(after.dueDate.getTime()).toBeGreaterThan(Date.now());
    const more = await update.run(owner, {
      module: 'workorders',
      updates: [{ id: String(wo._id), data: { addTasks: ['Trial run'] } }],
    });
    expect(more.ok).not.toBe(false);
    const again = await Model('workorders').findById(wo._id).lean();
    expect(again.taskAndChecklist.flatMap((g) => g.tasks.map((t) => t.task))).toHaveLength(3);
  });
});

describe('assign_work_order and available_people', () => {
  it('lists free people with skills, freeUntil and load', async () => {
    const out = await tool('available_people').run(owner, {
      department: 'Maintenance',
      asset: 'IMM 1',
      category: 'Hydraulic',
      window: 'now',
    });
    expect(out.rowCount).toBeGreaterThan(0);
    const row = out.data.rows[0];
    expect(row).toMatchObject({ department: 'Maintenance' });
    expect(Object.keys(row)).toEqual(
      expect.arrayContaining(['id', 'name', 'title', 'skills', 'freeUntil', 'load', 'free', 'skillMatch']),
    );
    expect(out.forModel.skillsWanted).toContain('hydraulics');
  });

  it('"auto" picks a technician and the card says why; the run assigns', async () => {
    const assign = tool('assign_work_order');
    const wo = await records.create(
      owner,
      'workorders',
      { name: 'Unassigned job', asset: String(imm1._id), category: 'Electrical' },
      { source: 'agent' },
    );
    const preview = await assign.preview(owner, { workOrder: wo.workOrderId, people: 'auto', mode: 'add' });
    expect(preview.payload.label).toMatch(new RegExp(`^Assign ${wo.workOrderId} to [A-Z]`));
    expect(preview.payload.decided).toMatch(/^SARA decided: .+ \((free|least loaded)/);
    const out = await assign.run(owner, { workOrder: wo.workOrderId, people: 'auto', mode: 'add' });
    expect(out.rowCount).toBe(1);
    const after = await Model('workorders').findById(wo._id).lean();
    expect(after.people).toHaveLength(1);
    expect(puneTechs.has(String(after.people[0]))).toBe(true);
    // A second "auto" adds someone else, never the same person twice.
    const again = await assign.preview(owner, { workOrder: wo.workOrderId, people: 'auto', mode: 'add' });
    const next = again.payload.items[0].changes.find((c) => c.field === 'people').to.map(String);
    expect(next).toHaveLength(2);
    expect(next).toContain(String(after.people[0]));
  });
});

describe('delete_record: bulk by filter', () => {
  const del = tool('delete_record');

  it('refuses "all" without a scope and offers the open ones', () => {
    const parsed = del.schema.safeParse({ module: 'workorders', reason: 'cleanup' });
    expect(parsed.success).toBe(false);
    expect(parsed.error.issues[0].message).toMatch(/workStatus: "Open"/);
  });

  it('previews every open work order of one asset with count and names, then deletes them', async () => {
    for (const n of [1, 2]) {
      await records.create(
        owner,
        'workorders',
        { name: `Bulk ${n}`, asset: String(imm2._id) },
        { source: 'agent' },
      );
    }
    const expected = await Model('workorders').countDocuments({
      companyId: acme.companyId,
      asset: imm2._id,
      workStatus: 'Open',
      deleted: { $ne: true },
    });
    const args = { module: 'workorders', filter: { status: 'open', asset: 'IMM 2' }, reason: 'Test data' };
    const preview = await del.preview(owner, args);
    expect(preview.payload.count).toBe(expected);
    expect(preview.payload.items.length).toBe(expected);
    const labels = preview.payload.items.map((i) => i.label);
    expect(labels.some((l) => /^WO-\d+ · Bulk 1$/.test(l))).toBe(true);
    expect(labels.some((l) => /^WO-\d+ · Bulk 2$/.test(l))).toBe(true);
    expect(preview.payload.filter).toEqual({ workStatus: 'Open', asset: String(imm2._id) });
    expect(preview.payload.label).toBe(`Delete ${expected} work orders`);
    const out = await del.run(owner, args);
    expect(out.rowCount).toBe(expected);
    expect(
      await Model('workorders').countDocuments({
        companyId: acme.companyId,
        asset: imm2._id,
        workStatus: 'Open',
        deleted: { $ne: true },
      }),
    ).toBe(0);
  });
});
