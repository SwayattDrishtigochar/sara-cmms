import { plantOf, zoneOf } from '../agent/tools/common.js';
import { shiftWindows, workingIntervals } from '../lib/shifts.js';
import { scopeFilter } from '../modules/records.js';
import { getModule } from '../modules/registry.js';
import { assertPlanSpan } from './capacity.js';
import { intersectIntervals, mergeIntervals, totalSeconds } from './intervals.js';

/**
 * People availability for the planners (phase 7 §3.1): who of a department is on shift inside a window,
 * what they are already booked on (job cards, work orders), and pure helpers to rank, pick and book them.
 */

const HOUR = 3_600_000;
const OPEN_JOBS = ['Open', 'In Progress', 'On Hold'];
const DONE_WORK = ['Completed', 'Closed'];
const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const ms = (d) => new Date(d).getTime();
const hoursOf = (start, end) => Math.round((Math.max(0, ms(end) - ms(start)) / HOUR) * 100) / 100;
const overlaps = (a, b) => ms(a.start) < ms(b.end) && ms(b.start) < ms(a.end);

export const OPERATOR_SKILL = {
  'Injection Moulding Machine': 'moulding',
  'Power Press': 'press',
  'CNC Machine': 'cnc',
};
export const CATEGORY_SKILLS = {
  Electrical: ['electrical', 'plc', 'drives'],
  Hydraulic: ['hydraulics', 'pneumatics'],
  Mechanical: ['mechanical'],
  Preventive: ['mechanical', 'lubrication'],
  Calibration: ['calibration', 'instrumentation'],
  Breakdown: ['mechanical', 'electrical'],
  Safety: ['electrical', 'mechanical'],
  Inspection: [],
  Cleaning: [],
  Alert: [],
  'Project Based': [],
};
export const ASSET_SKILLS = {
  Compressor: ['utilities', 'pneumatics'],
  Chiller: ['utilities', 'refrigeration'],
  Furnace: ['utilities', 'electrical'],
  'Energy Meter': ['electrical', 'instrumentation'],
};

/** The trade of each department: plans staff tasks with people who have one of these skills. */
const TRADE_SKILLS = {
  Production: new Set(Object.values(OPERATOR_SKILL)),
  Maintenance: new Set([...Object.values(CATEGORY_SKILLS), ...Object.values(ASSET_SKILLS)].flat()),
};

/** CATEGORY_SKILLS[category] ∪ ASSET_SKILLS[assetType], lowercase, unique. */
export const skillsForTask = ({ category, assetType } = {}) => [
  ...new Set(
    [...(CATEGORY_SKILLS[category] ?? []), ...(ASSET_SKILLS[assetType] ?? [])].map((s) => s.toLowerCase()),
  ),
];

/** Shift windows of the plant clipped to `interval`, in order (breaks stay inside a segment). */
export const shiftSegments = (plant, interval, zone) =>
  shiftWindows(plant, interval.start, interval.end, zone)
    .map((w) => ({
      shiftId: w.shiftId ?? null,
      shiftName: w.shiftName,
      start: new Date(Math.max(ms(w.start), ms(interval.start))),
      end: new Date(Math.min(ms(w.end), ms(interval.end))),
    }))
    .filter((s) => s.end > s.start);

const nameOf = (u) => [u.firstName, u.lastName].filter(Boolean).join(' ').trim();

/**
 * People of a department with their shift time, bookings and load inside `window` (records scope: tenant + plant lock).
 * @param {{ department: 'Maintenance'|'Production', plantId?, window: { start, end }, roles?: string[],
 *   excludeBookings?: [{ module: 'jobcards'|'workorders', id }], includeNonRunningDays?: boolean }} opts
 *   excludeBookings = the plan being edited; includeNonRunningDays = shifts on Sundays/holidays count too
 */
export const loadPeople = async (ctx, opts) => {
  const { department, plantId, window, roles = ['technician', 'admin'], excludeBookings = [] } = opts;
  assertPlanSpan(window.start, window.end);
  const zone = zoneOf(ctx);
  const users = getModule('users');
  const all = await users.Model.find({
    department,
    role: { $in: roles },
    ...(plantId ? { plantId } : {}),
    // Last, so a caller's plantId never overrides the viewer's plant lock.
    ...scopeFilter(ctx, users),
  })
    .select('firstName lastName userTitle role department skills shiftId plantId')
    .collation({ locale: 'en' })
    .sort({ firstName: 1, lastName: 1 })
    .lean();
  // Machine operators and technicians, not managers, inspectors or store keepers; when nobody has a skill
  // of the trade recorded, everyone of the department.
  const trade = TRADE_SKILLS[department];
  const skilled = all.filter((u) => (u.skills ?? []).some((s) => trade?.has(String(s).toLowerCase())));
  const rows = skilled.length ? skilled : all;
  if (!rows.length) return [];
  const ids = rows.map((u) => u._id);
  const skip = new Set(excludeBookings.map((b) => `${b.module}:${b.id}`));
  const span = { startDate: { $lt: window.end }, endDate: { $gt: window.start } };
  const [cards, wos] = await Promise.all([
    ctx.modules.includes('jobcards')
      ? getModule('jobcards')
          .Model.find({
            ...scopeFilter(ctx, getModule('jobcards')),
            jobStatus: { $in: OPEN_JOBS },
            assignedTo: { $in: ids },
            ...span,
          })
          .select('jobCardId assignedTo operatorPlan startDate endDate')
          .lean()
      : [],
    getModule('workorders')
      .Model.find({
        ...scopeFilter(ctx, getModule('workorders')),
        workStatus: { $nin: DONE_WORK },
        people: { $in: ids },
        plannedStart: { $ne: null, $lt: window.end },
        plannedEnd: { $gt: window.start },
      })
      .select('workOrderId people plannedStart plannedEnd')
      .lean(),
  ]);

  return rows.map((u) => {
    const userId = String(u._id);
    const plant = plantOf(ctx, u.plantId ?? plantId);
    const shift = (plant?.shifts ?? []).find((s) => String(s._id) === String(u.shiftId));
    const roster = plant
      ? {
          ...plant,
          ...(shift ? { shifts: [shift] } : {}),
          ...(opts.includeNonRunningDays ? { runningSchedule: WEEKDAYS, holidays: [] } : {}),
        }
      : null;
    // Whole shift windows: a break inside a shift does not take anyone off shift (freeFor). `working` (breaks
    // out) is the time work can actually run (the maintenance planner's staffed time).
    const onShift = roster ? mergeIntervals(shiftSegments(roster, window, zone)) : [];
    const working = roster ? mergeIntervals(workingIntervals(roster, window.start, window.end, zone)) : [];
    const bookings = [
      ...cards
        .filter((c) => (c.assignedTo ?? []).some((id) => String(id) === userId))
        .flatMap((c) => {
          const rows = (c.operatorPlan ?? []).filter((r) => String(r.user) === userId && r.start && r.end);
          const spans = rows.length ? rows : [{ start: c.startDate, end: c.endDate }];
          return spans.map((s) => ({
            kind: 'jobcard',
            id: String(c._id),
            code: c.jobCardId,
            start: new Date(s.start),
            end: new Date(s.end),
          }));
        }),
      ...wos
        .filter((w) => (w.people ?? []).some((id) => String(id) === userId))
        .map((w) => ({
          kind: 'workorder',
          id: String(w._id),
          code: w.workOrderId,
          start: new Date(w.plannedStart),
          end: new Date(w.plannedEnd),
        })),
    ]
      .filter(
        (b) =>
          overlaps(b, window) && !skip.has(`${b.kind === 'jobcard' ? 'jobcards' : 'workorders'}:${b.id}`),
      )
      .sort((a, b) => ms(a.start) - ms(b.start));
    return {
      userId,
      name: nameOf(u),
      title: u.userTitle ?? null,
      role: u.role,
      department: u.department,
      skills: (u.skills ?? []).map((s) => String(s).toLowerCase()),
      shiftId: shift ? String(shift._id) : null,
      shiftName: shift?.shiftName ?? null,
      plantId: u.plantId ? String(u.plantId) : null,
      onShift,
      working,
      bookings,
      loadHours: Math.round(bookings.reduce((sum, b) => sum + hoursOf(b.start, b.end), 0) * 100) / 100,
    };
  });
};

/** Pure: `interval` sits inside one of the person's shift windows and overlaps none of their bookings. */
export const freeFor = (person, interval) =>
  mergeIntervals(person.onShift).some(
    (w) => ms(w.start) <= ms(interval.start) && ms(interval.end) <= ms(w.end),
  ) && !person.bookings.some((b) => overlaps(b, interval));

/** Pure: free people, skill matches first, then the lightest load, then name. Marks `skillMatch` on the person. */
export const rank = (people, interval, { skills = [] } = {}) => {
  const wanted = skills.map((s) => s.toLowerCase());
  return people
    .filter((p) => freeFor(p, interval))
    .map((p) => Object.assign(p, { skillMatch: p.skills.some((s) => wanted.includes(s)) }))
    .sort(
      (a, b) =>
        Number(b.skillMatch) - Number(a.skillMatch) ||
        a.loadHours - b.loadHours ||
        a.name.localeCompare(b.name),
    );
};

/** Pure: the best free person for `interval` whose userId is not in `exclude`, else null. */
export const pickPerson = (people, interval, { skills = [], exclude = new Set() } = {}) =>
  rank(people, interval, { skills }).find((p) => !exclude.has(p.userId)) ?? null;

/** Pure mutate: adds the booking and its hours to the person's load. */
export const bookPerson = (person, { kind, id, code, start, end }) => {
  person.bookings.push({ kind, id, code, start: new Date(start), end: new Date(end) });
  person.loadHours = Math.round((person.loadHours + hoursOf(start, end)) * 100) / 100;
};

/** GET /api/planning/people: everyone of the department with `free` for the whole window. */
export const availableUsers = async (ctx, { department, skills = [], window, plantId }) => {
  const people = await loadPeople(ctx, { department, plantId, window });
  const wanted = skills.map((s) => s.toLowerCase());
  return people
    .map((p) => ({
      userId: p.userId,
      name: p.name,
      title: p.title,
      role: p.role,
      shiftId: p.shiftId,
      shift: p.shiftName,
      skills: p.skills,
      skillMatch: p.skills.some((s) => wanted.includes(s)),
      free: freeFor(p, window),
      onShift: totalSeconds(intersectIntervals(p.onShift, [window])) > 0,
      loadHours: p.loadHours,
      busy: p.bookings.slice(0, 5).map(({ kind, code, start, end }) => ({ kind, code, start, end })),
    }))
    .sort(
      (a, b) =>
        Number(b.free) - Number(a.free) ||
        Number(b.onShift) - Number(a.onShift) ||
        Number(b.skillMatch) - Number(a.skillMatch) ||
        a.loadHours - b.loadHours ||
        a.name.localeCompare(b.name),
    );
};
