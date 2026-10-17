import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { execute } from '../src/agent/loop.js';
import { coerceDate, completeRecord, findRef } from '../src/agent/tools/defaults.js';
import { peopleTools } from '../src/agent/tools/people.js';
import { getTool, unknownToolError } from '../src/agent/tools/registry.js';
import { writeTools } from '../src/agent/tools/write.js';
import { records } from '../src/modules/records.js';
import { getModule } from '../src/modules/registry.js';
import { contextFor, NOW, setupDatabase, teardownDatabase } from './helpers/db.js';

/**
 * Replays the exact tool calls that failed in owner_1's chat and voice history (the audit of 2026-10-17)
 * against the tool functions: each one must now succeed or fail with a hint the model can act on.
 */

vi.mock('../src/telemetry/queries.js', async (importOriginal) => ({
  ...(await importOriginal()),
  seriesFor: async (_companyId, assetIds, fields, { start }) => {
    const t0 = new Date(start).getTime();
    return {
      series: assetIds.flatMap((assetId) =>
        fields.map((field) => ({ assetId, field, measurement: 'energy', points: [[t0 + 3_600_000, 4]] })),
      ),
    };
  },
  statusTimeline: async () => ({
    runs: [{ status: 'Running', start: NOW, end: new Date(NOW.getTime() + 3_600_000), seconds: 3600 }],
    totals: { Running: 3600 },
    availability: 1,
  }),
}));

const Model = (name) => getModule(name).Model;
const io = () => ({ emit: () => {}, signal: undefined, results: new Map(), callId: 't', context: null });
/** zod check + run, like the loop does; returns `{ value }` or `{ error }`. */
const call = (ctx, name, args, extra = {}) => {
  const tool = getTool(name);
  if (!tool) throw new Error(`no tool ${name}`);
  return execute({ tool, args, ctx, io: { ...io(), ...extra } });
};
let acme;
let owner;
let imm1;
let uniqueWo;

beforeAll(async () => {
  ({ acme } = await setupDatabase());
  owner = await contextFor('owner_1@acme.test');
  imm1 = await Model('assets').findOne({ companyId: acme.companyId, name: 'IMM 1' }).lean();
  // The fixture repeats WO codes per plant; the audit's WO-163 is unique in the user's company.
  const all = await Model('workorders').find({ companyId: acme.companyId }, { workOrderId: 1 }).lean();
  const seen = new Map();
  for (const w of all) seen.set(w.workOrderId, (seen.get(w.workOrderId) ?? 0) + 1);
  uniqueWo = all.find((w) => seen.get(w.workOrderId) === 1);
});
afterAll(teardownDatabase);

describe('(a) time ranges', () => {
  it('"$start"/"$stop" placeholders, "today" and company-format dates are read, not rejected', async () => {
    for (const args of [
      { start: '$start', stop: '$stop' },
      { start: 'today', stop: 'today' },
      { start: '17-10-2026', stop: '17-10-2026' },
      { start: '2026-10-10', stop: 'now' },
    ]) {
      const out = await call(owner, 'cost_summary', { ...args, groupBy: 'asset' });
      expect(out.error, JSON.stringify(args)).toBeUndefined();
    }
    const attendance = await call(owner, 'attendance_summary', { start: 'yesterday', stop: 'today' });
    expect(attendance.error).toBeUndefined();
  });

  it('resolve_time_range reads "this past year" and "next 2 days"', async () => {
    for (const text of ['this past year', 'next 2 days', 'last 3 days', 'pichle 2 din']) {
      const out = await call(owner, 'resolve_time_range', { text });
      expect(out.error, text).toBeUndefined();
      expect(out.value.data.assumed, text).not.toBe(true);
    }
  });
});

describe('(b) asset references', () => {
  it('codes, names, lowercase and "all" work on energy, timeline and health tools', async () => {
    expect(
      (await call(owner, 'energy_consumption', { assetIds: ['IMM-01'], start: 'today' })).error,
    ).toBeUndefined();
    expect(
      (await call(owner, 'energy_consumption', { assetIds: ['all'], start: 'today' })).error,
    ).toBeUndefined();
    expect(
      (await call(owner, 'telemetry_status_timeline', { assetId: 'imm 1', start: 'today' })).error,
    ).toBeUndefined();
    expect((await call(owner, 'machine_health', { assetId: 'IMM-01' })).error).toBeUndefined();
    const miss = await call(owner, 'machine_health', { assetId: 'Boiler 77' });
    expect(miss.error.error).toMatch(/not found|No asset/i);
  });

  it('job_card_progress takes a part name mangled into a code (JC-BracketC)', async () => {
    const out = await call(owner, 'job_card_progress', { jobCard: 'JC-BracketC' });
    expect(out.error).toBeUndefined();
    expect(out.value.forModel.partName ?? JSON.stringify(out.value.forModel)).toMatch(/Bracket-?C/i);
  });
});

describe('(c) open_page', () => {
  it('a code alone opens the record; a bare id on an open record page too', async () => {
    const out = await call(owner, 'open_page', { page: 'record', recordId: uniqueWo.workOrderId });
    expect(out.error).toBeUndefined();
    expect(out.value.forModel.url).toMatch(new RegExp(`/workorders/${uniqueWo._id}`));
    const ctxPage = { context: { recordRef: { module: 'workorders', id: String(uniqueWo._id) } } };
    const byId = await call(owner, 'open_page', { page: 'record', recordId: String(uniqueWo._id) }, ctxPage);
    expect(byId.error).toBeUndefined();
  });

  it('page machine with q: "furnace 2"; People page text filters become the search', async () => {
    const machine = await call(owner, 'open_page', { page: 'machine', q: 'furnace 2' });
    expect(machine.error).toBeUndefined();
    expect(machine.value.forModel.label).toMatch(/Furnace 2/);
    for (const field of ['q', 'employeeId', 'firstName']) {
      const out = await call(owner, 'open_page', {
        page: 'list',
        module: 'users',
        filters: [{ field, value: 'Ramesh' }],
      });
      expect(out.error, field).toBeUndefined();
      expect(out.value.forModel.url).toMatch(/q=Ramesh/);
    }
  });
});

describe('(d) mongo extended JSON', () => {
  it('{ $date } inside a $match is unwrapped', async () => {
    const out = await call(owner, 'mongo_aggregate', {
      module: 'workorders',
      pipeline: [
        { $match: { createdAt: { $gte: { $date: '2026-01-01T00:00:00.000Z' } } } },
        { $group: { _id: '$priority', n: { $sum: 1 } } },
      ],
    });
    expect(out.error).toBeUndefined();
    expect(out.value.rowCount).toBeGreaterThan(0);
    const find = await call(owner, 'mongo_find', {
      module: 'workorders',
      filter: { createdAt: { $gte: { $date: '2026-01-01T00:00:00.000Z' } } },
      limit: 2,
    });
    expect(find.error).toBeUndefined();
  });

  it('still rejects what the allow-lists forbid', async () => {
    const where = await call(owner, 'mongo_find', { module: 'workorders', filter: { $where: '1' } });
    expect(where.error).toBeDefined();
    // A tenant key the model writes is dropped and the session tenant re-injected: own rows, never another's.
    const tenant = await call(owner, 'mongo_find', {
      module: 'workorders',
      filter: { companyId: 'x' },
      limit: 2,
    });
    expect(tenant.error).toBeUndefined();
    expect(tenant.value.rowCount).toBeGreaterThan(0);
    const lookup = await call(owner, 'mongo_aggregate', {
      module: 'workorders',
      pipeline: [{ $lookup: { from: 'users', pipeline: [], as: 'u' } }],
    });
    expect(lookup.error).toBeDefined();
  });
});

describe('(e) unknown tools', () => {
  it('plantId_context → use the context; usergroups_schema → module_schema', () => {
    expect(unknownToolError('plantId_context').hint).toMatch(/already in your context/);
    expect(unknownToolError('usergroups_schema').hint).toBe('Use module_schema({ module: "usergroups" })');
    expect(unknownToolError('list_workorders').hint).toMatch(/Did you mean/);
  });
});

describe('(g) decisions', () => {
  const tool = (name) => writeTools.find((t) => t.name === name);

  it('a work order with only the asset and "breakdown": everything else is decided and the preview says so', async () => {
    const preview = await tool('create_record').preview(owner, {
      module: 'workorders',
      items: [{ asset: 'IMM-01' }],
      context: 'IMM 1 breakdown',
    });
    const [item] = preview.payload.items;
    expect(item.doc).toMatchObject({ category: 'Breakdown', priority: 'High', workStatus: 'Open' });
    expect(item.doc.saraDecided).toMatch(/assigned|unassigned/);
    expect(item.doc.description).toBe('IMM 1 breakdown');
  });

  it('due date in the company format and as words; "Rakesh Kumar" → Ramesh Kumar', async () => {
    const { item, decided } = await completeRecord(
      owner,
      'workorders',
      { asset: 'IMM 1', dueDate: '17-10-2026', assignee: 'Rakesh Kumar' },
      { now: NOW },
    );
    expect(item.dueDate.toISOString()).toMatch(/^2026-10-17T/);
    expect(decided.find((d) => d.field === 'people')).toMatchObject({ value: 'Ramesh Kumar' });
    const ramesh = await Model('users').findOne({ companyId: acme.companyId, firstName: 'Ramesh' }).lean();
    expect(item.people).toEqual([String(ramesh._id)]);
  });

  it('a checklist is added through update_record addTasks on a record with stored rows', async () => {
    const wo = await Model('workorders').findOne({ _id: uniqueWo._id }).lean();
    const before = (wo.taskAndChecklist ?? []).flatMap((g) => g.tasks).length;
    const out = await tool('update_record').run(owner, {
      module: 'workorders',
      updates: [{ id: String(wo._id), data: { addTasks: ['Clean the nozzle', 'Check heater bands'] } }],
    });
    expect(out.ok).not.toBe(false);
    const after = await Model('workorders').findById(wo._id).lean();
    expect(after.taskAndChecklist.flatMap((g) => g.tasks).length).toBe(before + 2);
  });

  it('"assign whoever is free" through the loop: auto picks and the card explains', async () => {
    const wo = await records.create(
      owner,
      'workorders',
      { name: 'Replay', asset: String(imm1._id), category: 'Mechanical' },
      { source: 'agent' },
    );
    const out = await execute({
      tool: getTool('assign_work_order'),
      args: { workOrder: wo.workOrderId, people: 'auto' },
      ctx: owner,
      io: io(),
      mode: 'preview',
    });
    expect(out.error).toBeUndefined();
    expect(out.value.payload.decided).toMatch(/^SARA decided: /);
  });

  it('people: "auto" / "whoever is free" on a create or an update lets SARA pick, never "No person matches auto"', async () => {
    const { item, decided } = await completeRecord(
      owner,
      'workorders',
      { asset: 'IMM 1', people: 'auto' },
      { hints: 'breakdown', now: NOW },
    );
    expect(item.$autoPeople).toBeUndefined();
    expect(item.people).toHaveLength(1);
    expect(decided.find((d) => d.field === 'people').why).toMatch(/free|least loaded/);

    const wo = await records.create(
      owner,
      'workorders',
      { name: 'Auto update', asset: String(imm1._id), category: 'Electrical' },
      { source: 'agent' },
    );
    const update = tool('update_record');
    const preview = await update.preview(owner, {
      module: 'workorders',
      updates: [{ id: String(wo._id), data: { people: 'whoever is free' } }],
    });
    expect(preview.payload.items[0].note).toMatch(/^SARA decided: /);
    const out = await update.run(owner, {
      module: 'workorders',
      updates: [{ id: String(wo._id), data: { addPeople: ['auto'] } }],
    });
    expect(out.ok).not.toBe(false);
    const after = await Model('workorders').findById(wo._id).lean();
    expect(after.people).toHaveLength(1);
    // A second "auto" adds a different person.
    await update.run(owner, {
      module: 'workorders',
      updates: [{ id: String(wo._id), data: { addPeople: ['auto'] } }],
    });
    expect((await Model('workorders').findById(wo._id).lean()).people).toHaveLength(2);
  });

  it('due-date words of a Hinglish user: kal, parso, in 2 days, next Friday (the update_record example)', () => {
    const day = (d) => d.toISOString().slice(0, 10);
    expect(day(coerceDate(owner, 'kal', NOW))).toBe('2026-10-16');
    expect(day(coerceDate(owner, 'parso', NOW))).toBe('2026-10-17');
    expect(day(coerceDate(owner, 'in 2 days', NOW))).toBe('2026-10-17');
    expect(day(coerceDate(owner, 'next Friday', NOW))).toBe('2026-10-16'); // NOW is a Thursday
    expect(day(coerceDate(owner, 'Monday', NOW))).toBe('2026-10-19');
    expect(coerceDate(owner, 'tomorrow 2 pm', NOW).toISOString()).toBe('2026-10-16T08:30:00.000Z');
    expect(() => coerceDate(owner, 'whenever', NOW)).toThrow(/could not understand/);
  });

  it('available_people: "now" means the next 8 hours and an odd phrase falls back to today', async () => {
    const people = peopleTools.find((t) => t.name === 'available_people');
    const now = await people.run(owner, { department: 'Maintenance', window: 'now' });
    expect(now.forModel.window).toBe('next 8 hours');
    const odd = await people.run(owner, { department: 'Maintenance', window: 'whenever' });
    expect(odd.forModel.window).toMatch(/could not read "whenever"/);
  });

  it('findRef never hands back a password hash', async () => {
    const { doc } = await findRef(owner, 'users', 'Ramesh Kumar');
    expect(doc.password).toBeUndefined();
    expect((await findRef(owner, 'users', doc._id.toString())).doc.password).toBeUndefined();
  });

  it('"delete all work orders" is refused once with the open-ones alternative, never silently', async () => {
    const out = await call(owner, 'delete_record', { module: 'workorders', reason: 'cleanup' });
    expect(out.error.issues[0].message).toMatch(/workStatus: "Open"/);
  });
});
