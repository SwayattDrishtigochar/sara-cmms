import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { records } from '../src/modules/records.js';
import { getModule } from '../src/modules/registry.js';
import { buildCalendar, calendarToGantt, plantWorking } from '../src/planning/capacity.js';
import {
  advanceWorking,
  intersectIntervals,
  mergeIntervals,
  subtractIntervals,
  totalSeconds,
} from '../src/planning/intervals.js';
import { contextFor, NOW, setupDatabase, teardownDatabase } from './helpers/db.js';

const ZONE = 'Asia/Kolkata';
const ist = (s) => new Date(`${s}+05:30`);
const iv = (a, b) => ({ start: ist(a), end: ist(b) });
const plain = (list) => list.map((i) => [i.start.toISOString(), i.end.toISOString()]);
const plant = {
  runningSchedule: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'],
  holidays: [{ date: ist('2026-10-19T00:00:00'), description: 'Plant holiday' }],
  shifts: [
    { shiftName: 'A', shiftStartTime: '06:00', shiftEndTime: '14:00', breaks: [] },
    {
      shiftName: 'C',
      shiftStartTime: '22:00',
      shiftEndTime: '06:00',
      breaks: [
        { breakStartTime: '01:00', breakEndTime: '01:15' },
        { breakStartTime: '02:00', breakEndTime: '02:30' },
      ],
    },
  ],
};

describe('intervals', () => {
  const a = [iv('2026-10-16T10:00', '2026-10-16T12:00'), iv('2026-10-16T08:00', '2026-10-16T10:30')];

  it('merges, subtracts and intersects', () => {
    expect(plain(mergeIntervals(a))).toEqual(plain([iv('2026-10-16T08:00', '2026-10-16T12:00')]));
    const cut = [iv('2026-10-16T09:00', '2026-10-16T09:30'), iv('2026-10-16T11:00', '2026-10-16T13:00')];
    expect(plain(subtractIntervals(a, cut))).toEqual(
      plain([iv('2026-10-16T08:00', '2026-10-16T09:00'), iv('2026-10-16T09:30', '2026-10-16T11:00')]),
    );
    expect(plain(intersectIntervals(a, cut))).toEqual(
      plain([iv('2026-10-16T09:00', '2026-10-16T09:30'), iv('2026-10-16T11:00', '2026-10-16T12:00')]),
    );
    expect(totalSeconds(a)).toBe(4 * 3600);
  });

  it('advances through working time and runs out', () => {
    const free = [iv('2026-10-16T08:00', '2026-10-16T09:00'), iv('2026-10-16T10:00', '2026-10-16T12:00')];
    const r = advanceWorking(free, ist('2026-10-16T08:30'), 3600);
    expect(r.end).toEqual(ist('2026-10-16T10:30'));
    expect(r.segments).toHaveLength(2);
    expect(advanceWorking(free, ist('2026-10-16T08:00'), 4 * 3600)).toBeNull();
    expect(advanceWorking(free, ist('2026-10-16T08:00'), 0).end).toEqual(ist('2026-10-16T08:00'));
  });
});

describe('plantWorking', () => {
  it('puts the 02:00 break of the 22:00–06:00 shift on the next day', () => {
    const w = plantWorking(plant, ist('2026-10-16T18:00:00'), ist('2026-10-17T07:00:00'), ZONE);
    expect(plain(w)).toEqual(
      plain([
        iv('2026-10-16T22:00', '2026-10-17T01:00'),
        iv('2026-10-17T01:15', '2026-10-17T02:00'),
        iv('2026-10-17T02:30', '2026-10-17T07:00'), // night shift runs into shift A at 06:00
      ]),
    );
  });

  it('skips Sunday and holidays (the shift start date decides), unless asked to include them', () => {
    const from = ist('2026-10-17T12:00:00'); // Saturday
    const to = ist('2026-10-20T00:00:00'); // Monday 19 is a holiday
    const w = plantWorking(plant, from, to, ZONE);
    expect(plain(w)).toEqual(
      plain([
        iv('2026-10-17T12:00', '2026-10-17T14:00'),
        iv('2026-10-17T22:00', '2026-10-18T01:00'), // Saturday's night shift ends on Sunday morning
        iv('2026-10-18T01:15', '2026-10-18T02:00'),
        iv('2026-10-18T02:30', '2026-10-18T06:00'),
      ]),
    );
    const all = plantWorking(plant, from, to, ZONE, { includeNonRunningDays: true });
    expect(totalSeconds(all)).toBeGreaterThan(totalSeconds(w) + 2 * 8 * 3600);
  });
});

describe('buildCalendar (seeded Acme)', () => {
  let owner;
  let calendar;
  const machine = (name) => calendar.machines.find((m) => m.name === name);

  beforeAll(async () => {
    await setupDatabase();
    owner = await contextFor('owner_1@acme.test');
    const imm3 = await getModule('assets')
      .Model.findOne({ companyId: owner.companyId, name: 'IMM 3' })
      .lean();
    await records.create(owner, 'workorders', {
      name: 'Heater band check',
      asset: String(imm3._id),
      plannedStart: new Date(NOW.getTime() + 2 * 3600e3),
      plannedEnd: new Date(NOW.getTime() + 4 * 3600e3),
    });
    calendar = await buildCalendar(owner, {
      start: NOW,
      end: new Date(NOW.getTime() + 7 * 86_400_000),
      now: NOW,
      plantId: String(imm3.plantId),
    });
  });
  afterAll(teardownDatabase);

  it('lists the plant’s production machines with bookings subtracted from working time', () => {
    expect(calendar.machines.map((m) => m.name)).toEqual(expect.arrayContaining(['IMM 1', 'IMM 2', 'IMM 3']));
    expect(calendar.machines.every((m) => m.plantId === calendar.plantId)).toBe(true);
    const imm1 = machine('IMM 1');
    expect(imm1.bookings.map((b) => b.code)).toEqual(expect.arrayContaining(['JC-12', 'JC-14']));
    for (const m of calendar.machines) {
      expect(totalSeconds(intersectIntervals(m.free, m.bookings))).toBe(0);
      expect(totalSeconds(subtractIntervals(m.free, m.working))).toBe(0);
    }
    const imm3 = machine('IMM 3');
    const wo = imm3.bookings.find((b) => b.kind === 'workorder');
    expect(wo.label).toBe('Heater band check');
    expect(totalSeconds(intersectIntervals(imm3.free, [wo]))).toBe(0);
    expect(calendar.shifts.map((s) => s.name)).toEqual(expect.arrayContaining(['A', 'B', 'C']));
  });

  it('uses job-card history for efficiency and 0.85 without it', () => {
    expect(machine('IMM 1')).toMatchObject({ efficiencySource: 'history' });
    expect(machine('IMM 1').efficiency).toBeGreaterThan(0.5);
    expect(machine('IMM 3')).toMatchObject({ efficiency: 0.85, efficiencySource: 'default' });
  });

  it('builds mould calendars: busy where their job cards run', () => {
    const t101 = calendar.tools.find((t) => t.toolNumber === 'T-101');
    expect(t101.busy.length).toBeGreaterThan(0);
    expect(totalSeconds(intersectIntervals(t101.free, t101.busy))).toBe(0);
    expect(machine('IMM 1').mountedToolId).toBe(t101.toolId);
  });

  it('turns into Gantt data with links', () => {
    const gantt = calendarToGantt(owner, calendar);
    expect(gantt.rows.length).toBe(calendar.machines.length);
    const bar = gantt.bars.find((b) => b.code === 'JC-12');
    expect(bar).toMatchObject({ kind: 'jobcard', href: `/m/jobcards/${bar.id}` });
    expect(gantt.bars.some((b) => b.kind === 'maintenance' && b.href.startsWith('/m/workorders/'))).toBe(
      true,
    );
  });

  // Runs last: it rewrites JC-12 and JC-14.
  it('books a running card behind schedule until it finishes and keeps an overdue waiting card', async () => {
    const JobCard = getModule('jobcards').Model;
    const hour = 3600e3;
    await JobCard.updateOne(
      { companyId: owner.companyId, jobCardId: 'JC-12' },
      {
        jobStatus: 'In Progress',
        startDate: new Date(NOW.getTime() - 2 * hour),
        endDate: new Date(NOW.getTime() + hour),
        target: 1000,
        idealCycleTime: 36,
        'mouldParts.0.assignedPartPerShot': 1,
        'operations.0.progress.partsOut': 100,
      },
    );
    await JobCard.updateOne(
      { companyId: owner.companyId, jobCardId: 'JC-14' },
      {
        jobStatus: 'Open',
        startDate: new Date(NOW.getTime() - 3 * hour),
        endDate: new Date(NOW.getTime() - hour),
      },
    );
    const cal = await buildCalendar(owner, {
      start: NOW,
      end: new Date(NOW.getTime() + 7 * 86_400_000),
      now: NOW,
      plantId: calendar.plantId,
    });
    const imm1 = cal.machines.find((m) => m.name === 'IMM 1');
    const jc12 = imm1.bookings.find((b) => b.code === 'JC-12');
    // 900 parts × 36 s ÷ efficiency is at least 9 h, far past the planned end in 1 h.
    expect(jc12.end.getTime()).toBeGreaterThanOrEqual(
      NOW.getTime() + (900 * 36 * 1000) / imm1.efficiency - 1,
    );
    const jc14 = imm1.bookings.find((b) => b.code === 'JC-14');
    expect(jc14).toBeTruthy();
    expect(jc14.start).toEqual(NOW);
    expect(jc14.end.getTime()).toBeGreaterThan(NOW.getTime());
  });
});
