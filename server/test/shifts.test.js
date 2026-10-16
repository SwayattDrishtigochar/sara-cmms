import { describe, expect, it } from 'vitest';
import {
  isWorkingTime,
  scheduledSeconds,
  shiftAt,
  shiftWindows,
  workingIntervals,
} from '../src/lib/shifts.js';

const ZONE = 'Asia/Kolkata';
const plant = {
  runningSchedule: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'],
  holidays: [{ date: new Date('2026-11-08T00:00:00+05:30'), description: 'Diwali' }],
  shifts: [
    {
      shiftName: 'A',
      shiftStartTime: '06:00',
      shiftEndTime: '14:00',
      breaks: [{ breakStartTime: '11:30', breakEndTime: '12:00' }],
    },
    {
      shiftName: 'C',
      shiftStartTime: '22:00',
      shiftEndTime: '06:00',
      breaks: [{ breakStartTime: '02:00', breakEndTime: '02:30' }],
    },
  ],
};
const ist = (s) => new Date(`${s}+05:30`);

describe('shift calendar', () => {
  it('ends overnight shifts the next day', () => {
    const c = shiftWindows(plant, ist('2026-10-15T00:00:00'), ist('2026-10-16T00:00:00'), ZONE).find(
      (w) => w.shiftName === 'C' && w.start.getTime() === ist('2026-10-15T22:00:00').getTime(),
    );
    expect(c.end).toEqual(ist('2026-10-16T06:00:00'));
  });

  it('puts a 02:00 break of the night shift on the next day (CMMS bug fixed)', () => {
    const c = shiftAt(plant, ist('2026-10-16T01:00:00'), ZONE);
    expect(c.shiftName).toBe('C');
    expect(c.breaks[0].start).toEqual(ist('2026-10-16T02:00:00'));
    expect(isWorkingTime(plant, ist('2026-10-16T02:10:00'), ZONE)).toBe(false);
    expect(isWorkingTime(plant, ist('2026-10-16T02:40:00'), ZONE)).toBe(true);
  });

  it('skips non-running days and holidays, judged by the shift start date', () => {
    // Sunday 2026-10-18: no A shift; the Saturday-night C shift still runs into Sunday morning.
    expect(shiftAt(plant, ist('2026-10-18T09:00:00'), ZONE)).toBeNull();
    expect(shiftAt(plant, ist('2026-10-18T03:00:00'), ZONE)?.shiftName).toBe('C');
    // Diwali (Sunday 2026-11-08 is a holiday anyway); Monday 2026-11-09 normal.
    expect(shiftAt(plant, ist('2026-11-09T07:00:00'), ZONE)?.shiftName).toBe('A');
  });

  it('subtracts breaks from scheduled time', () => {
    // Thursday 06:00–14:00 minus 30 min = 7.5 h
    const seconds = scheduledSeconds(plant, ist('2026-10-15T06:00:00'), ist('2026-10-15T14:00:00'), ZONE);
    expect(seconds).toBe(7.5 * 3600);
    const parts = workingIntervals(plant, ist('2026-10-15T06:00:00'), ist('2026-10-15T14:00:00'), ZONE);
    expect(parts).toHaveLength(2);
  });
});
