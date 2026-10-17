import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getModule } from '../src/modules/registry.js';
import {
  availableUsers,
  bookPerson,
  freeFor,
  loadPeople,
  pickPerson,
  rank,
  shiftSegments,
  skillsForTask,
} from '../src/planning/people.js';
import { contextFor, NOW, setupDatabase, teardownDatabase } from './helpers/db.js';

const ZONE = 'Asia/Kolkata';
const HOUR = 3_600_000;
const ist = (local) => new Date(`${local}:00+05:30`);
const PLANT = {
  shifts: [
    { _id: 'A', shiftName: 'A', shiftStartTime: '06:00', shiftEndTime: '14:00', breaks: [] },
    {
      _id: 'C',
      shiftName: 'C',
      shiftStartTime: '22:00',
      shiftEndTime: '06:00',
      breaks: [{ breakStartTime: '01:00', breakEndTime: '01:15' }],
    },
  ],
  runningSchedule: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'],
  holidays: [],
};
const person = (name, extra = {}) => ({
  userId: name.toLowerCase(),
  name,
  skills: [],
  onShift: [{ start: ist('2026-10-15T06:00'), end: ist('2026-10-15T14:00') }],
  bookings: [],
  loadHours: 0,
  shiftName: 'A',
  ...extra,
});

describe('people (pure)', () => {
  it('skillsForTask joins the category and asset skills', () => {
    expect(skillsForTask({ category: 'Electrical', assetType: 'Energy Meter' })).toEqual([
      'electrical',
      'plc',
      'drives',
      'instrumentation',
    ]);
    expect(skillsForTask({ category: 'Inspection' })).toEqual([]);
  });

  it('shiftSegments clips the overnight C shift to the window and keeps its break inside', () => {
    const segments = shiftSegments(
      PLANT,
      { start: ist('2026-10-15T23:00'), end: ist('2026-10-16T08:00') },
      ZONE,
    );
    expect(segments.map((s) => [s.shiftName, s.start, s.end])).toEqual([
      ['C', ist('2026-10-15T23:00'), ist('2026-10-16T06:00')],
      ['A', ist('2026-10-16T06:00'), ist('2026-10-16T08:00')],
    ]);
  });

  it('freeFor needs the whole interval inside one shift window and no booking on it', () => {
    const p = person('Asha', {
      bookings: [
        {
          kind: 'workorder',
          id: 'w',
          code: 'WO-1',
          start: ist('2026-10-15T10:00'),
          end: ist('2026-10-15T11:00'),
        },
      ],
    });
    expect(freeFor(p, { start: ist('2026-10-15T08:00'), end: ist('2026-10-15T09:00') })).toBe(true);
    expect(freeFor(p, { start: ist('2026-10-15T10:30'), end: ist('2026-10-15T11:30') })).toBe(false);
    expect(freeFor(p, { start: ist('2026-10-15T13:00'), end: ist('2026-10-15T15:00') })).toBe(false);
  });

  it('rank puts skill matches first, then the lightest load, then the name; pickPerson books the winner', () => {
    const people = [
      person('Zara', { skills: ['electrical'], loadHours: 3 }),
      person('Ravi', { skills: ['mechanical'], loadHours: 0 }),
      person('Amit', { skills: ['mechanical'], loadHours: 0 }),
      person('Busy', { skills: ['mechanical'], onShift: [] }),
    ];
    const slot = { start: ist('2026-10-15T08:00'), end: ist('2026-10-15T09:00') };
    expect(rank(people, slot, { skills: ['mechanical'] }).map((p) => p.name)).toEqual([
      'Amit',
      'Ravi',
      'Zara',
    ]);
    const pick = pickPerson(people, slot, { skills: ['mechanical'], exclude: new Set(['amit']) });
    expect(pick.name).toBe('Ravi');
    bookPerson(pick, { kind: 'workorder', id: 't-1', code: 'WO-9', ...slot });
    expect(people[1].loadHours).toBe(1);
    expect(pickPerson(people, slot, { skills: ['mechanical'] }).name).toBe('Amit');
    expect(freeFor(people[1], slot)).toBe(false);
  });
});

describe('people on the seeded plant', () => {
  let ctx;
  let plant;
  let ramesh;
  let suresh;
  const window = { start: NOW, end: new Date(NOW.getTime() + 10 * HOUR) };

  beforeAll(async () => {
    const { acme } = await setupDatabase();
    ctx = await contextFor('owner_1@acme.test');
    const Users = getModule('users').Model;
    ramesh = await Users.findOne({
      companyId: acme.companyId,
      email: 'maintenance_technician_1@acme.test',
    }).lean();
    suresh = await Users.findOne({
      companyId: acme.companyId,
      email: 'maintenance_technician_2@acme.test',
    }).lean();
    plant = ctx.plants.find((p) => String(p._id) === String(ramesh.plantId));
    const press2 = await getModule('assets')
      .Model.findOne({ companyId: acme.companyId, assetTag: 'PRS-02' })
      .lean();
    await getModule('workorders').Model.create({
      companyId: acme.companyId,
      plantId: plant._id,
      workOrderId: 'WO-900',
      name: 'Guard check',
      asset: press2._id,
      workStatus: 'Open',
      people: [ramesh._id],
      plannedStart: new Date(NOW.getTime() + HOUR),
      plannedEnd: new Date(NOW.getTime() + 2 * HOUR),
    });
    await getModule('jobcards').Model.updateOne(
      { companyId: acme.companyId, jobCardId: 'JC-15' },
      {
        $set: {
          assignedTo: [ramesh._id, suresh._id],
          operatorPlan: [
            {
              user: suresh._id,
              shiftName: 'B',
              start: ist('2026-10-15T14:00'),
              end: ist('2026-10-15T22:00'),
            },
          ],
        },
      },
    );
  });
  afterAll(teardownDatabase);

  it('loadPeople gives shift time, job-card bookings (operatorPlan rows first) and work orders', async () => {
    const people = await loadPeople(ctx, { department: 'Maintenance', plantId: plant._id, window });
    const r = people.find((p) => p.userId === String(ramesh._id));
    expect(r).toMatchObject({ name: 'Ramesh Kumar', shiftName: 'A', skills: ['mechanical', 'hydraulics'] });
    // Shift A until 14:00; the window starts at 12:00 (right after lunch).
    expect(r.onShift).toEqual([{ start: ist('2026-10-15T12:00'), end: ist('2026-10-15T14:00') }]);
    expect(r.bookings.map((b) => [b.kind, b.code])).toEqual([
      ['jobcard', 'JC-15'], // no operatorPlan row for Ramesh → the whole card window
      ['workorder', 'WO-900'],
    ]);
    const s = people.find((p) => p.userId === String(suresh._id));
    expect(s.bookings).toEqual([
      {
        kind: 'jobcard',
        id: expect.any(String),
        code: 'JC-15',
        start: ist('2026-10-15T14:00'),
        end: ist('2026-10-15T22:00'),
      },
    ]);
    expect(s.loadHours).toBe(8);
    expect(freeFor(r, { start: NOW, end: new Date(NOW.getTime() + HOUR) })).toBe(false); // JC-15 runs now
    const excluded = await loadPeople(ctx, {
      department: 'Maintenance',
      plantId: plant._id,
      window,
      excludeBookings: [{ module: 'jobcards', id: r.bookings[0].id }],
    });
    expect(excluded.find((p) => p.userId === r.userId).bookings.map((b) => b.code)).toEqual(['WO-900']);
  });

  it('staffs with the trade: technicians with skills, not the manager or the store keeper', async () => {
    const people = await loadPeople(ctx, { department: 'Maintenance', window });
    const names = people.map((p) => p.name);
    expect(names).toEqual(expect.arrayContaining(['Ramesh Kumar', 'Suresh Patil', 'Priya Nair']));
    expect(names).not.toContain('Rajesh Joshi'); // Maintenance Manager, no trade skill
    expect(names).not.toContain('Ganesh Jadhav'); // Store Keeper
    // Nobody in Production has an operator skill recorded here, so everyone of the department stays.
    const operators = await loadPeople(ctx, { department: 'Production', window });
    expect(operators.map((p) => p.name)).toContain('Sachin Pawar');
  });

  it('a plant-locked viewer never sees another plant’s people, whatever plantId is asked for', async () => {
    const other = ctx.plants.find((p) => String(p._id) !== String(plant._id));
    const open = await loadPeople(ctx, { department: 'Maintenance', plantId: other._id, window });
    expect(open.map((p) => p.name)).toContain('Arjun Rao'); // an unlocked owner may ask for that plant
    const locked = { ...ctx, plantLock: plant._id };
    // The lock wins over the asked plant: only the viewer's own plant comes back.
    for (const plantId of [other._id, undefined]) {
      const seen = await loadPeople(locked, { department: 'Maintenance', plantId, window });
      expect(seen.map((p) => p.name)).not.toContain('Arjun Rao');
      expect(seen.every((p) => p.plantId === String(plant._id))).toBe(true);
    }
    await expect(
      loadPeople(ctx, {
        department: 'Maintenance',
        window: { start: NOW, end: new Date('2099-12-31T00:00:00Z') },
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('breaks keep people on shift: a whole shift segment with tea and lunch inside is free', async () => {
    const shiftA = { start: ist('2026-10-15T06:00'), end: ist('2026-10-15T14:00') };
    const people = await loadPeople(ctx, { department: 'Maintenance', plantId: plant._id, window: shiftA });
    const priya = people.find((p) => p.name === 'Priya Nair');
    expect(priya.shiftName).toBe('A');
    expect(priya.onShift).toEqual([shiftA]);
    // Working time leaves the breaks out (tea 09:00–09:15, lunch 11:30–12:00).
    expect(priya.working).toEqual([
      { start: ist('2026-10-15T06:00'), end: ist('2026-10-15T09:00') },
      { start: ist('2026-10-15T09:15'), end: ist('2026-10-15T11:30') },
      { start: ist('2026-10-15T12:00'), end: ist('2026-10-15T14:00') },
    ]);
    expect(freeFor({ ...priya, bookings: [] }, shiftA)).toBe(true);
    const [segment] = shiftSegments(plant, shiftA, ZONE);
    expect(freeFor({ ...priya, bookings: [] }, segment)).toBe(true);
  });

  it('availableUsers marks free people and keeps company B invisible', async () => {
    const slot = { start: ist('2026-10-15T12:00'), end: ist('2026-10-15T13:00') };
    const people = await availableUsers(ctx, {
      department: 'Maintenance',
      skills: ['mechanical'],
      window: slot,
    });
    expect(people.length).toBeGreaterThan(2);
    const r = people.find((p) => p.userId === String(ramesh._id));
    expect(r).toMatchObject({ free: false, skillMatch: true, shift: 'A' });
    expect(r.busy[0].code).toBe('JC-15');
    expect(people.filter((p) => p.free).length).toBeGreaterThan(0);
    expect(people.findIndex((p) => p.free)).toBe(0);
    const beta = await availableUsers(await contextFor('owner_1@beta.test'), {
      department: 'Maintenance',
      window: slot,
    });
    expect(beta.length).toBeGreaterThan(0);
    expect(beta.map((p) => p.userId)).not.toContain(String(ramesh._id));
  });
});
