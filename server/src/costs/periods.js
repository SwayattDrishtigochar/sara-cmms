import { DateTime } from 'luxon';
import { badRequest } from '../lib/errors.js';

export const PERIODS = ['day', 'week', 'month'];

const KEY = {
  day: (d) => `day:${d.toISODate()}`,
  week: (d) => `week:${d.toFormat("kkkk-'W'WW")}`,
  month: (d) => `month:${d.toFormat('yyyy-LL')}`,
};
const LABEL = {
  day: (d) => d.toFormat('d LLL yyyy'),
  week: (d) => `week of ${d.toFormat('d LLL yyyy')}`,
  month: (d) => d.toFormat('LLLL yyyy'),
};

/**
 * The current period up to `now` (period-to-date), or with `previous` the last complete one.
 * Keys: 'day:2026-10-16', 'week:2026-W42' (ISO week, Monday start), 'month:2026-10'. The stop is at least
 * 1 ms after the start, so a period that has just begun is still a valid range.
 */
export const periodRange = (period, zone, now = new Date(), { previous = false } = {}) => {
  if (!PERIODS.includes(period)) throw badRequest(`Period must be one of ${PERIODS.join(', ')}`);
  const current = DateTime.fromJSDate(new Date(now), { zone }).startOf(period);
  const start = previous ? current.minus({ [period]: 1 }) : current;
  return {
    start: start.toJSDate(),
    stop: previous ? current.toJSDate() : new Date(Math.max(new Date(now).getTime(), start.toMillis() + 1)),
    key: KEY[period](start),
    label: LABEL[period](start),
  };
};
