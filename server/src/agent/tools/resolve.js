import { DateTime } from 'luxon';
import { z } from 'zod';
import { badRequest } from '../../lib/errors.js';
import { shiftAt, shiftWindows } from '../../lib/shifts.js';
import { records } from '../../modules/records.js';
import { getModule, labelOf } from '../../modules/registry.js';
import { DATE_TOKENS, plantName, plantOf, readableModule, zoneOf } from './common.js';

/** Name → record and text → time range resolution (phase 4 §2 `resolve`, `resolve_time_range`). */

export const KINDS = {
  asset: 'assets',
  user: 'users',
  tool: 'tools',
  plant: 'plants',
  job_card: 'jobcards',
  spare_part: 'spareparts',
  work_order: 'workorders',
  production_plan: 'productionplans',
  anomaly: 'anomalies',
  supplier: 'suppliers',
  vendor: 'vendors',
  customer: 'customers',
};
const EXTRA_FIELDS = {
  assets: [
    'typeOfAsset',
    'assetStatus',
    'isEnergyAsset',
    'isProductionAsset',
    'isSensorIntegration',
    'location',
  ],
  users: ['role', 'department', 'userTitle', 'email'],
  tools: ['status', 'toolNumber'],
  jobcards: ['jobStatus', 'target', 'partName'],
  workorders: ['workStatus', 'priority', 'dueDate'],
  spareparts: ['partNumber', 'minimumQuantity', 'criticality'],
  productionplans: ['status', 'quantity', 'dueDate'],
  anomalies: ['type', 'severity', 'state'],
  plants: ['plantCode', 'location'],
};
const MAX_MATCHES = 5;

const norm = (s) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** 3 = exact, 2 = starts with, 1 = contains, 0.5 = every word appears, 0 = no match. */
const scoreOf = (mod, doc, query) => {
  const q = norm(query);
  const words = q.split(' ').filter(Boolean);
  const candidates = [doc[mod.codeField], ...mod.search.map((f) => doc[f]), labelOf(mod, doc)]
    .filter(Boolean)
    .map(norm);
  let best = 0;
  for (const c of candidates) {
    if (c === q) best = Math.max(best, 3);
    else if (c.startsWith(q)) best = Math.max(best, 2);
    else if (c.includes(q)) best = Math.max(best, 1);
    else if (words.length > 1 && words.every((w) => c.includes(w))) best = Math.max(best, 0.5);
  }
  return best;
};

const match = (ctx, mod, doc) => {
  const out = { id: String(doc._id), label: labelOf(mod, doc) };
  if (mod.plantScoped) out.plantName = plantName(ctx, doc.plantId);
  for (const key of EXTRA_FIELDS[mod.name] ?? [])
    if (doc[key] != null && doc[key] !== '') out[key] = doc[key];
  return out;
};

/** Finds up to 5 records by name/code; several equally strong hits set `needsDisambiguation`. */
export const resolveRecords = async (ctx, { kind, query, plantId }) => {
  const module = KINDS[kind];
  const mod = readableModule(ctx, module);
  const filter = plantId && mod.plantScoped ? { plantId } : undefined;
  const search = (q) => records.list(ctx, module, { q, limit: 25, populate: false, filter });
  let { items } = await search(query);
  const words = String(query).trim().split(/\s+/);
  if (!items.length && words.length > 1) ({ items } = await search(words[0]));
  const scored = items
    .map((doc) => ({ doc, score: scoreOf(mod, doc, query) }))
    .filter((m) => m.score > 0)
    .sort((a, b) => b.score - a.score || labelOf(mod, a.doc).localeCompare(labelOf(mod, b.doc)));
  const matches = scored.slice(0, MAX_MATCHES).map((m) => match(ctx, mod, m.doc));
  const needsDisambiguation = scored.length > 1 && scored[0].score === scored[1].score;
  return {
    kind,
    module,
    matches,
    needsDisambiguation,
    ...(matches.length ? {} : { hint: `No ${mod.label.toLowerCase()} match "${query}"; try a shorter name` }),
  };
};

// ── Time ranges ─────────────────────────────────────────────────────────────

const WORD_NUM = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  twelve: 12,
  twenty: 20,
  thirty: 30,
  sixty: 60,
};
const UNITS = {
  minute: 'minutes',
  minutes: 'minutes',
  min: 'minutes',
  mins: 'minutes',
  hour: 'hours',
  hours: 'hours',
  hr: 'hours',
  hrs: 'hours',
  h: 'hours',
  day: 'days',
  days: 'days',
  d: 'days',
  week: 'weeks',
  weeks: 'weeks',
  wk: 'weeks',
  wks: 'weeks',
  month: 'months',
  months: 'months',
  mo: 'months',
  quarter: 'quarters',
  quarters: 'quarters',
  year: 'years',
  years: 'years',
  yr: 'years',
  yrs: 'years',
};
const MONTHS = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};
const DAY_WORDS = /\b(today|yesterday|tomorrow)\b/;
const RANGE_SPLIT = /^(?:between|from)?\s*(.+?)\s+(?:and|to|until|till|-|–)\s+(.+)$/;

const num = (word) => (word in WORD_NUM ? WORD_NUM[word] : Number(word));

/** "15-10-2026", "2026-10-15", "15 oct 2026", "oct 15" → start of that day in `zone`, or null. */
export const parseDate = (text, { zone, year: fallbackYear, dateFormat }) => {
  const t = text.trim().toLowerCase();
  let m;
  const make = (year, month, day) => {
    const dt = DateTime.fromObject({ year, month, day }, { zone });
    return dt.isValid ? dt : null;
  };
  m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);
  if (m) return make(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/.exec(t);
  if (m) {
    const year = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    const [a, b] = [+m[1], +m[2]];
    const [day, month] = dateFormat === 'MM-DD-YYYY' ? [b, a] : [a, b];
    return make(year, month, day) ?? make(year, day, month);
  }
  m = /^(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+)\.?\s*(\d{4})?$/.exec(t);
  if (m && MONTHS[m[2]]) {
    return make(m[3] ? +m[3] : fallbackYear, MONTHS[m[2]], +m[1]);
  }
  m = /^([a-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?\s*(\d{4})?$/.exec(t);
  if (m && MONTHS[m[1]]) {
    return make(m[3] ? +m[3] : fallbackYear, MONTHS[m[1]], +m[2]);
  }
  return null;
};

/** "2 pm", "14:30", "2:30pm", "9" → { hour, minute, meridiem }, or null. */
const parseTime = (text) => {
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(text.trim().toLowerCase());
  if (!m) return null;
  const hour = +m[1];
  const minute = +(m[2] ?? 0);
  if (hour > 24 || minute > 59) return null;
  return { hour, minute, meridiem: m[3] ?? null };
};
const clockOf = (time, meridiem) => {
  let hour = time.hour;
  const mer = time.meridiem ?? meridiem;
  if (mer === 'pm' && hour < 12) hour += 12;
  if (mer === 'am' && hour === 12) hour = 0;
  return { hour, minute: time.minute };
};

const fmt = (ctx) => {
  const token = DATE_TOKENS[ctx.company?.dateFormat] ?? 'dd-MM-yyyy';
  const day = (dt) => dt.toFormat(token);
  return {
    day,
    span: (start, stop) => {
      const last = stop.minus({ milliseconds: 1 });
      if (start.hasSame(last, 'day')) {
        const whole =
          start.equals(start.startOf('day')) && stop.equals(start.startOf('day').plus({ days: 1 }));
        return whole ? day(start) : `${day(start)} ${start.toFormat('HH:mm')}–${stop.toFormat('HH:mm')}`;
      }
      return `${day(start)} – ${day(last)}`;
    },
  };
};

const unitRange = (now, unit, offset) => {
  const unitName = unit.replace(/s$/, '');
  const start = now.startOf(unitName).plus({ [unit]: offset });
  return { start, stop: start.plus({ [unit]: 1 }) };
};

const shiftRange = (w, zone) => ({
  start: DateTime.fromJSDate(w.start, { zone }),
  stop: DateTime.fromJSDate(w.end, { zone }),
});

const currentOrLastShift = (plant, now, zone, { previous = false } = {}) => {
  if (!plant?.shifts?.length) throw badRequest('This plant has no shifts configured');
  const current = shiftAt(plant, now.toJSDate(), zone);
  if (!previous && current) {
    return {
      ...shiftRange(current, zone),
      label: `Current shift ${current.shiftName}`,
      shift: current.shiftName,
    };
  }
  const before = (current ? current.start : now.toJSDate()).getTime();
  const windows = shiftWindows(plant, now.minus({ days: 2 }).toJSDate(), now.toJSDate(), zone).filter(
    (w) => w.start.getTime() < before,
  );
  const w = windows.at(-1);
  if (!w) throw badRequest('No earlier shift found in the last two days');
  return { ...shiftRange(w, zone), label: `Last shift ${w.shiftName}`, shift: w.shiftName };
};

/** Narrows a day (or several) to one shift letter: the shift(s) that START inside the range. */
const applyShift = (range, letter, plant, zone, f) => {
  if (!plant?.shifts?.length) throw badRequest('This plant has no shifts configured');
  const name = letter.toUpperCase();
  const all = shiftWindows(plant, range.start.toJSDate(), range.stop.toJSDate(), zone).filter(
    (w) => w.shiftName.toUpperCase() === name,
  );
  const starting = all.filter((w) => w.start >= range.start.toJSDate() && w.start < range.stop.toJSDate());
  const windows = starting.length ? starting : all;
  if (!windows.length) throw badRequest(`No shift ${name} between ${f.span(range.start, range.stop)}`);
  return {
    start: DateTime.fromJSDate(windows[0].start, { zone }),
    stop: DateTime.fromJSDate(windows.at(-1).end, { zone }),
    label: `${range.label} · Shift ${name}`,
    shift: name,
  };
};

const parseText = (raw, now, ctx, plant) => {
  const zone = now.zone;
  const f = fmt(ctx);
  const opts = { zone, year: now.year, dateFormat: ctx.company?.dateFormat };
  let t = raw.toLowerCase().replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
  let m;
  let shiftLetter = null;
  m = /\b(?:shift\s*([abc])|([abc])[\s-]*shift)\b/.exec(t);
  if (m) {
    shiftLetter = m[1] ?? m[2];
    t = t.replace(m[0], ' ').replace(/\s+/g, ' ').trim();
  }
  t = t.replace(/^(?:the|in|on|for|during)\s+/, '').trim();
  const withShift = (range) => (shiftLetter ? applyShift(range, shiftLetter, plant, zone, f) : range);

  if (/^(?:current|this|present|ongoing)\s+shift$/.test(t)) return currentOrLastShift(plant, now, zone);
  if (/^(?:last|previous)\s+shift$/.test(t)) return currentOrLastShift(plant, now, zone, { previous: true });
  if (t === '' && shiftLetter) t = 'today';
  if (t === 'now' || t === 'right now' || t === 'last hour' || t === 'past hour') {
    return { start: now.minus({ hours: 1 }), stop: now, label: 'Last hour' };
  }

  // A day word, optionally with a time span: "yesterday between 2 and 4 pm", "today 06:00 to 14:00".
  m = DAY_WORDS.exec(t);
  if (m) {
    const day = {
      today: now.startOf('day'),
      yesterday: now.startOf('day').minus({ days: 1 }),
      tomorrow: now.startOf('day').plus({ days: 1 }),
    }[m[1]];
    const rest = t.replace(m[0], ' ').replace(/\s+/g, ' ').trim();
    const label = `${m[1][0].toUpperCase()}${m[1].slice(1)} (${f.day(day)})`;
    if (!rest) return withShift({ start: day, stop: day.plus({ days: 1 }), label });
    const parts = RANGE_SPLIT.exec(rest);
    if (parts) {
      const a = parseTime(parts[1]);
      const b = parseTime(parts[2]);
      if (a && b) {
        const end = clockOf(b, a.meridiem);
        const begin = clockOf(a, b.meridiem);
        const start = day.set(begin);
        let stop = day.set(end);
        if (stop <= start) stop = stop.plus({ days: 1 });
        return { start, stop, label: `${label} ${start.toFormat('HH:mm')}–${stop.toFormat('HH:mm')}` };
      }
    }
    const single = parseTime(rest.replace(/^(?:at|since|from)\s+/, ''));
    if (single) {
      const start = day.set(clockOf(single, null));
      return {
        start,
        stop: start.plus({ hours: 1 }),
        label: `${label} ${start.toFormat('HH:mm')}–${start.plus({ hours: 1 }).toFormat('HH:mm')}`,
      };
    }
  }

  m = /^(this|last|previous|past|next)\s+(week|month|quarter|year)$/.exec(t);
  if (m) {
    const offset = { this: 0, last: -1, previous: -1, past: -1, next: 1 }[m[1]];
    const range = unitRange(now, UNITS[m[2]], offset);
    const label = `${m[1] === 'previous' || m[1] === 'past' ? 'Last' : m[1][0].toUpperCase() + m[1].slice(1)} ${m[2]} (${f.span(range.start, range.stop)})`;
    return withShift({ ...range, label });
  }
  m = /^(?:last|past|previous)\s+(\d+|[a-z]+)?\s*([a-z]+)$/.exec(t);
  if (m && UNITS[m[2]]) {
    const n = m[1] ? num(m[1]) : 1;
    if (!Number.isFinite(n) || n <= 0 || n > 1000)
      throw badRequest(`I could not read the number in "${raw}"`);
    const unit = UNITS[m[2]];
    if (unit === 'quarters') {
      const range = { start: now.startOf('quarter').minus({ quarters: n }), stop: now.startOf('quarter') };
      return { ...range, label: `Last ${n} quarter${n > 1 ? 's' : ''} (${f.span(range.start, range.stop)})` };
    }
    const start = now.minus({ [unit]: n });
    const label = `Last ${n} ${n === 1 ? unit.replace(/s$/, '') : unit} (${f.span(start, now)})`;
    return withShift({ start, stop: now, label });
  }
  m = /^q([1-4])\s*(\d{4})?$/.exec(t);
  if (m) {
    const year = m[2] ? +m[2] : now.year;
    const start = DateTime.fromObject({ year, month: (+m[1] - 1) * 3 + 1, day: 1 }, { zone });
    return { start, stop: start.plus({ months: 3 }), label: `Q${m[1]} ${year}` };
  }
  m = /^([a-z]+)\s*(\d{4})?$/.exec(t);
  if (m && MONTHS[m[1]]) {
    const year = m[2] ? +m[2] : now.year;
    const start = DateTime.fromObject({ year, month: MONTHS[m[1]], day: 1 }, { zone });
    return withShift({ start, stop: start.plus({ months: 1 }), label: start.toFormat('LLLL yyyy') });
  }
  m = /^(?:year\s+)?(\d{4})$/.exec(t);
  if (m) {
    const start = DateTime.fromObject({ year: +m[1], month: 1, day: 1 }, { zone });
    return { start, stop: start.plus({ years: 1 }), label: m[1] };
  }
  m = /^(?:since|from|after)\s+(.+)$/.exec(t);
  if (m) {
    const start = parseDate(m[1], opts);
    if (start) return withShift({ start, stop: now, label: `Since ${f.day(start)}` });
  }
  m = /^(?:until|till|before|up to)\s+(.+)$/.exec(t);
  if (m) {
    const stop = parseDate(m[1], opts)?.plus({ days: 1 });
    if (stop)
      return { start: stop.minus({ days: 31 }), stop, label: `Until ${f.day(stop.minus({ days: 1 }))}` };
  }
  m = RANGE_SPLIT.exec(t);
  if (m) {
    const a = parseDate(m[1], opts);
    const b = parseDate(m[2], opts);
    if (a && b) {
      const [start, stop] = a <= b ? [a, b.plus({ days: 1 })] : [b, a.plus({ days: 1 })];
      return withShift({ start, stop, label: f.span(start, stop) });
    }
    const ta = parseTime(m[1]);
    const tb = parseTime(m[2]);
    if (ta && tb) {
      const day = now.startOf('day');
      const start = day.set(clockOf(ta, tb.meridiem));
      let stop = day.set(clockOf(tb, ta.meridiem));
      if (stop <= start) stop = stop.plus({ days: 1 });
      return { start, stop, label: `Today ${start.toFormat('HH:mm')}–${stop.toFormat('HH:mm')}` };
    }
  }
  const single = parseDate(t, opts);
  if (single) return withShift({ start: single, stop: single.plus({ days: 1 }), label: f.day(single) });
  throw badRequest(`I could not understand the time range "${raw}"; ask the user for dates`);
};

const parseInput = (value, { zone, now, ctx, end = false }) => {
  const text = String(value).trim();
  const iso = DateTime.fromISO(text, { zone, setZone: !/[zZ]|[+-]\d\d:\d\d$/.test(text) });
  if (iso.isValid) return /^\d{4}-\d{2}-\d{2}$/.test(text) && end ? iso.plus({ days: 1 }) : iso;
  const day = parseDate(text, { zone, year: now.year, dateFormat: ctx.company?.dateFormat });
  if (day) return end ? day.plus({ days: 1 }) : day;
  const epoch = /^\d{12,}$/.test(text) ? DateTime.fromMillis(Number(text), { zone }) : null;
  if (epoch?.isValid) return epoch;
  throw badRequest(
    `"${text}" is not a date I understand (use ISO 8601 or ${ctx.company?.dateFormat ?? 'DD-MM-YYYY'})`,
  );
};

/**
 * `{ text?, start?, stop?, shift?, plantId? }` → `{ start, stop, label, timeZone, shift? }` in the
 * company zone. Understands today/yesterday, this/last week|month|quarter|year, last N units, Qn YYYY,
 * month names, dates in the company format, "between … and …", "shift A yesterday", "current/last shift".
 */
export const resolveTimeRange = ({ text, start, stop, shift, plantId } = {}, ctx, now = DateTime.now()) => {
  const zone = zoneOf(ctx);
  const current = now.setZone(zone);
  const plant = plantOf(ctx, plantId);
  const f = fmt(ctx);
  let range;
  if (start || stop) {
    const s = start ? parseInput(start, { zone, now: current, ctx }) : null;
    const e = stop ? parseInput(stop, { zone, now: current, ctx, end: true }) : null;
    const startDt = s ?? e.minus({ days: 1 });
    const stopDt = e ?? (s < current ? current : s.plus({ days: 1 }));
    if (stopDt <= startDt) throw badRequest('The start must be before the stop');
    range = { start: startDt, stop: stopDt, label: f.span(startDt, stopDt) };
    if (shift) range = applyShift(range, shift, plant, zone, f);
  } else if (text?.trim()) {
    range = parseText(shift ? `${text} shift ${shift}` : text, current, ctx, plant);
  } else if (shift) {
    range = applyShift(
      {
        start: current.startOf('day'),
        stop: current.startOf('day').plus({ days: 1 }),
        label: `Today (${f.day(current)})`,
      },
      shift,
      plant,
      zone,
      f,
    );
  } else throw badRequest('Give a time range: text (e.g. "last week"), start/stop or a shift');
  return {
    start: range.start.toUTC().toISO(),
    stop: range.stop.toUTC().toISO(),
    label: range.label,
    timeZone: zone,
    ...(range.shift ? { shift: range.shift } : {}),
  };
};

const timeRangeSchema = z
  .object({
    text: z
      .string()
      .max(120)
      .optional()
      .describe('e.g. "yesterday", "last 2 hours", "Q3 2026", "shift A yesterday"'),
    start: z.string().max(40).optional().describe('ISO date/time or a date in the company format'),
    stop: z.string().max(40).optional(),
    shift: z.string().max(10).optional().describe('Shift name (A, B, C) to narrow the day to'),
    plantId: z.string().optional().describe('Plant whose shifts apply (default: the user plant)'),
  })
  .superRefine((v, ctx) => {
    if (!v.text?.trim() && !v.start && !v.stop && !v.shift) {
      ctx.addIssue({ code: 'custom', message: 'Give text, start/stop or a shift' });
    }
  });

export const resolveTools = [
  {
    name: 'resolve',
    group: 'core',
    description:
      'Finds records by name or code: asset, user, tool, plant, job_card, spare_part, work_order, production_plan, anomaly, supplier, vendor, customer. Call it before querying by name and use the returned id. Example: { kind: "asset", query: "Compressor 2" }. needsDisambiguation=true means several equally good matches: ask the user which one.',
    schema: z.object({
      kind: z.enum(Object.keys(KINDS)),
      query: z.string().min(1).max(120),
      plantId: z.string().optional(),
    }),
    run: async (ctx, args) => {
      const result = await resolveRecords(ctx, args);
      return {
        forModel: result,
        summary:
          result.matches.length === 1
            ? `Found ${result.matches[0].label}`
            : result.matches.length
              ? `${result.matches.length} matches for "${args.query}"`
              : `No match for "${args.query}"`,
        rowCount: result.matches.length,
        data: { rows: result.matches },
      };
    },
  },
  {
    name: 'resolve_time_range',
    group: 'core',
    description:
      'Turns a phrase into a concrete start/stop in the company time zone, shift-aware. Understands today, yesterday, this/last week|month|quarter|year, last N hours|days, Q3 2026, dates in the company format, "yesterday between 2 and 4 pm", "shift A yesterday", "current shift", "last shift". Always call it before a tool that needs start/stop. Example: { text: "last 2 hours" }.',
    schema: timeRangeSchema,
    run: async (ctx, args) => {
      const range = resolveTimeRange(args, ctx);
      return { forModel: range, summary: range.label, data: range };
    },
  },
];

/** Module name of a resolve kind (used by tests and the prompt). */
export const moduleOfKind = (kind) => getModule(KINDS[kind]).name;
