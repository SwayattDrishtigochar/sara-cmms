import { DateTime } from 'luxon';

/**
 * Shift calendar maths shared by the simulator config, the downtime tracker and the planners.
 *
 * Rules (ported from CMMS plantModel/oeeService, with its overnight-break bug fixed):
 *  - shift times are "HH:mm" in the plant's time zone; end ≤ start means the shift ends next day;
 *  - a break whose start is earlier than the shift start belongs to the next day (02:00 in a 22:00 shift);
 *  - the shift's START date decides whether it is a running day and whether it is a holiday.
 */

const WEEKDAY = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const toMinutes = (hhmm) => {
  const [h, m] = String(hhmm ?? '')
    .split(':')
    .map(Number);
  return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null;
};

/**
 * Wall-clock time `minutes` after the start of `day` (may spill into the next day). Uses set() rather
 * than adding a duration, so shifts keep their local clock times on DST change days.
 */
const atMinutes = (day, minutes) =>
  day
    .plus({ days: Math.floor(minutes / 1440) })
    .set({ hour: Math.floor((minutes % 1440) / 60), minute: minutes % 60 });

/** All shift windows that overlap [from, to): [{ shiftName, shiftId, start, end, breaks: [{start,end,breakType}] }]. */
export const shiftWindows = (plant, from, to, zone) => {
  const out = [];
  const running = new Set(
    (plant.runningSchedule?.length ? plant.runningSchedule : WEEKDAY).map((d) => d.toLowerCase()),
  );
  const holidays = new Set(
    (plant.holidays ?? []).map((h) => DateTime.fromJSDate(new Date(h.date), { zone }).toISODate()),
  );
  const fromMs = new Date(from).getTime();
  const toMs = new Date(to).getTime();
  // Start one day early so an overnight shift that began yesterday is included.
  let day = DateTime.fromMillis(fromMs, { zone }).startOf('day').minus({ days: 1 });
  const lastDay = DateTime.fromMillis(toMs, { zone }).startOf('day');

  while (day <= lastDay) {
    const weekday = WEEKDAY[day.weekday - 1];
    if (running.has(weekday) && !holidays.has(day.toISODate())) {
      for (const shift of plant.shifts ?? []) {
        const s = toMinutes(shift.shiftStartTime);
        const e = toMinutes(shift.shiftEndTime);
        if (s == null || e == null) continue;
        const start = atMinutes(day, s);
        const end = atMinutes(day, e <= s ? e + 1440 : e);
        if (end.toMillis() <= fromMs || start.toMillis() >= toMs) continue;
        const breaks = (shift.breaks ?? [])
          .map((b) => {
            const bs = toMinutes(b.breakStartTime);
            const be = toMinutes(b.breakEndTime);
            if (bs == null || be == null) return null;
            const offset = bs < s ? 1440 : 0; // after midnight in an overnight shift
            const bStart = atMinutes(day, bs + offset);
            const bEnd = atMinutes(day, (be <= bs ? be + 1440 : be) + offset);
            return { breakType: b.breakType, start: bStart.toJSDate(), end: bEnd.toJSDate() };
          })
          .filter(Boolean)
          .filter((b) => b.start >= start.toJSDate() && b.end <= end.toJSDate());
        out.push({
          shiftName: shift.shiftName,
          shiftId: shift._id ? String(shift._id) : undefined,
          start: start.toJSDate(),
          end: end.toJSDate(),
          breaks,
        });
      }
    }
    day = day.plus({ days: 1 });
  }
  return out.sort((a, b) => a.start - b.start);
};

/** The shift containing `at` (or null). */
export const shiftAt = (plant, at, zone) => {
  const t = new Date(at);
  return (
    shiftWindows(plant, new Date(t.getTime() - 86_400_000), new Date(t.getTime() + 1), zone).find(
      (w) => w.start <= t && t < w.end,
    ) ?? null
  );
};

/** Is `at` inside a shift and outside its breaks? */
export const isWorkingTime = (plant, at, zone) => {
  const w = shiftAt(plant, at, zone);
  if (!w) return false;
  const t = new Date(at);
  return !w.breaks.some((b) => b.start <= t && t < b.end);
};

/** Working intervals (shifts minus breaks) overlapping [from, to), clipped to the range. */
export const workingIntervals = (plant, from, to, zone) => {
  const lo = new Date(from).getTime();
  const hi = new Date(to).getTime();
  const out = [];
  for (const w of shiftWindows(plant, from, to, zone)) {
    let cursor = w.start.getTime();
    for (const b of [...w.breaks].sort((x, y) => x.start - y.start)) {
      if (b.start.getTime() > cursor) out.push([cursor, b.start.getTime()]);
      cursor = Math.max(cursor, b.end.getTime());
    }
    if (w.end.getTime() > cursor) out.push([cursor, w.end.getTime()]);
  }
  return out
    .map(([s, e]) => [Math.max(s, lo), Math.min(e, hi)])
    .filter(([s, e]) => e > s)
    .map(([s, e]) => ({ start: new Date(s), end: new Date(e) }));
};

/** Total scheduled working seconds in [from, to). */
export const scheduledSeconds = (plant, from, to, zone) =>
  workingIntervals(plant, from, to, zone).reduce((sum, i) => sum + (i.end - i.start) / 1000, 0);
