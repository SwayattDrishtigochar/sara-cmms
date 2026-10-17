import { DateTime } from 'luxon';
import { CATEGORY_OF, describeAnomaly, PRIORITY_OF } from '../../ai/anomaly/autoWorkOrder.js';
import { badRequest } from '../../lib/errors.js';
import { humanize } from '../../lib/format.js';
import { OBJECT_ID_PATTERN } from '../../modules/fields.js';
import { scopeFilter } from '../../modules/records.js';
import { getModule, labelOf } from '../../modules/registry.js';
import { CATEGORY_MIN } from '../../planning/maintenance.js';
import { freeFor, loadPeople, pickPerson, skillsForTask } from '../../planning/people.js';
import { asObjectId, fmtDate, zoneOf } from './common.js';
import { resolveTimeRange } from './resolve.js';

/**
 * Smart defaults for agent writes: `completeRecord` turns what the model passed (names, codes, loose
 * field names, text dates, lowercase enums, missing fields) into a record the module schema accepts and
 * lists every decision SARA made (`decided`) so the confirm card can show it before anything is saved.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const DUE_BY_PRIORITY = { High: DAY, Medium: 3 * DAY, Low: 7 * DAY };
const PRIORITY_WORDS = {
  urgent: 'High',
  critical: 'High',
  emergency: 'High',
  asap: 'High',
  normal: 'Medium',
  minor: 'Low',
};
const CATEGORY_WORDS = [
  ['Safety', /\bsafety|guard|hazard|fire|shock\b/i],
  ['Calibration', /\bcalibrat|sensor|gauge|instrument/i],
  ['Electrical', /\belectric|motor|wiring|current|voltage|plc|drive|heater|panel|tripp/i],
  ['Hydraulic', /\bhydraul|pressure|oil leak|cylinder|pump|seal|pneumatic|air leak/i],
  ['Cleaning', /\bclean|wash|dust|housekeep/i],
  ['Inspection', /\binspect|check|audit|root cause|rca|investigat/i],
  ['Preventive', /\bpreventive|pm\b|service|lubricat|greas/i],
  ['Mechanical', /\bmechanic|bearing|belt|gear|vibrat|noise|alignment|wear|jam|stuck/i],
  ['Breakdown', /\bbreak\s?down|stopped|not working|failure|fault|down\b|tripped|band|kharab|bandh/i],
];
const HIGH_WORDS =
  /\bbreakdown|break down|critical|urgent|emergency|asap|immediately|safety|turant|jaldi|abhi\b/i;
const STANDARD_TASKS = {
  Breakdown: [
    'Isolate the machine and record the fault',
    'Find the root cause',
    'Repair or replace the failed part',
    'Trial run and hand back to production',
  ],
  Electrical: [
    'Lock out and test for dead',
    'Check supply, contactors and wiring',
    'Repair or replace the faulty part',
    'Test under load and restore',
  ],
  Mechanical: [
    'Inspect for wear, play and alignment',
    'Repair or replace worn parts',
    'Lubricate and re-align',
    'Trial run and check vibration/noise',
  ],
  Hydraulic: [
    'Check oil level, leaks and pressure',
    'Inspect hoses, seals and valves',
    'Replace failed seals or parts',
    'Pressure test and trial run',
  ],
  Preventive: [
    'Clean and inspect',
    'Lubricate as per schedule',
    'Check wear parts and settings',
    'Record readings and sign off',
  ],
  Calibration: [
    'Compare against the reference',
    'Adjust to specification',
    'Record as-found and as-left values',
    'Apply the calibration label',
  ],
  Inspection: [
    'Record current readings',
    'Compare with the normal range',
    'Note likely causes',
    'Recommend the next action',
  ],
  Cleaning: [
    'Switch off and isolate',
    'Clean the machine and surroundings',
    'Check for leaks and loose parts',
    'Restore and sign off',
  ],
  Safety: [
    'Make the area safe',
    'Check guards, interlocks and emergency stops',
    'Fix or replace the failed safety part',
    'Test and record',
  ],
};
const GENERIC_TASKS = ['Inspect and record the condition', 'Carry out the work', 'Test and hand back'];
const FREQUENCY_WORDS = {
  daily: [1, 'Days'],
  weekly: [1, 'Weeks'],
  fortnightly: [2, 'Weeks'],
  biweekly: [2, 'Weeks'],
  monthly: [1, 'Months'],
  quarterly: [3, 'Months'],
  'half-yearly': [6, 'Months'],
  'half yearly': [6, 'Months'],
  yearly: [1, 'Years'],
  annually: [1, 'Years'],
  annual: [1, 'Years'],
};
const CYCLE_MS = { Hours: HOUR, Days: DAY, Weeks: 7 * DAY, Months: 30 * DAY, Years: 365 * DAY };

/** Loose field names the model uses → the module's own field (null = not stored, dropped with a note). */
const ALIASES = {
  workorders: {
    title: 'name',
    desc: 'description',
    details: 'description',
    notes: 'description',
    tasks: 'taskAndChecklist',
    checklist: 'taskAndChecklist',
    assignee: 'people',
    assignees: 'people',
    technician: 'people',
    technicians: 'people',
    assignedTo: 'people',
    assignTo: 'people',
    due: 'dueDate',
    deadline: 'dueDate',
    machine: 'asset',
    assetId: 'asset',
    anomaly: 'anomalyId',
    duration: 'estimatedDurationMin',
    estimatedDuration: 'estimatedDurationMin',
    status: null,
    workStatus: null,
  },
  preventivemaintenances: {
    title: 'name',
    asset: 'assetAllocation',
    assetId: 'assetAllocation',
    machine: 'assetAllocation',
    nextDue: 'nextGenerationDate',
    nextDate: 'nextGenerationDate',
    startDate: 'nextGenerationDate',
    dueDate: 'nextGenerationDate',
    frequency: '$frequency',
    every: '$frequency',
    interval: '$frequency',
    repeat: '$frequency',
    cycle: '$frequency',
    people: 'selectWorkOrder.people',
    assignee: 'selectWorkOrder.people',
    assignees: 'selectWorkOrder.people',
    technician: 'selectWorkOrder.people',
    technicians: 'selectWorkOrder.people',
    tasks: 'selectWorkOrder.taskAndChecklist',
    checklist: 'selectWorkOrder.taskAndChecklist',
    taskAndChecklist: 'selectWorkOrder.taskAndChecklist',
    priority: 'selectWorkOrder.priority',
    duration: 'estimatedDurationMin',
    estimatedDuration: 'estimatedDurationMin',
    category: null,
  },
  requests: {
    title: 'name',
    category: 'type',
    machine: 'asset',
    assetId: 'asset',
    priority: null,
    people: null,
    dueDate: null,
  },
};
const DROP_NOTES = {
  'requests.priority': 'requests have none; the work order it opens is High priority',
  'workorders.status': 'status moves through update_work_order_status',
  'workorders.workStatus': 'status moves through update_work_order_status',
};

/** people: "auto" / "anyone" / "whoever is free" / "koi bhi" = let SARA pick. */
export const isAutoWord = (v) =>
  typeof v === 'string' &&
  /^(auto|any|anyone|anybody|whoever(\s+is\s+free)?|free|koi\s*bhi|jo\s+free\s+ho)$/i.test(v.trim());

const norm = (s) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
const bigrams = (s) =>
  new Set(Array.from({ length: Math.max(0, s.length - 1) }, (_, i) => s.slice(i, i + 2)));
/** 1 = same, ≥ 0.9 = prefix/contains, else bigram Dice (typos: "Rakesh Kumar" ~ "Ramesh Kumar" = 0.82). */
export const similarity = (a, b) => {
  const [x, y] = [norm(a), norm(b)];
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (y.startsWith(x) || x.startsWith(y)) return 0.95;
  if (y.includes(x)) return 0.9;
  const [A, B] = [bigrams(x), bigrams(y)];
  let hit = 0;
  for (const g of A) if (B.has(g)) hit++;
  return (2 * hit) / (A.size + B.size);
};

const candidatesOf = (mod, doc) =>
  [labelOf(mod, doc), doc[mod.codeField], ...mod.search.map((f) => doc[f])].filter(
    (v) => typeof v === 'string' && v,
  );

/**
 * One record of `module` by id, code or (fuzzy) name within the viewer's scope: `{ id, label, doc, exact }`.
 * 400 with "did you mean" when nothing is close, or when two records are equally close.
 */
export const findRef = async (ctx, module, query, { filter = {} } = {}) => {
  const mod = getModule(module);
  const q = String(query ?? '').trim();
  const what = (mod.singular ?? mod.label).toLowerCase();
  if (!q) throw badRequest(`Give the ${what} name, code or id`);
  if (mod.idType !== 'string' && OBJECT_ID_PATTERN.test(q)) {
    const doc = await mod.Model.findOne({ _id: q, ...scopeFilter(ctx, mod) }).lean();
    if (!doc) throw badRequest(`Unknown ${what} id ${q}`);
    for (const key of mod.secretKeys ?? []) delete doc[key];
    return { id: q, label: labelOf(mod, doc), doc, exact: true };
  }
  const rows = await mod.Model.find({ ...filter, ...scopeFilter(ctx, mod) })
    .limit(500)
    .lean();
  const scored = rows
    .map((doc) => ({ doc, score: Math.max(0, ...candidatesOf(mod, doc).map((c) => similarity(q, c))) }))
    .sort((a, b) => b.score - a.score);
  const [best, second] = scored;
  if (!best || best.score < 0.6) {
    const hint = best && best.score >= 0.4 ? `; did you mean ${labelOf(mod, best.doc)}?` : '';
    throw badRequest(`No ${what} matches "${q}"${hint}`, { module, query: q });
  }
  if (second && second.score === best.score && best.score < 1) {
    throw badRequest(
      `"${q}" could be ${labelOf(mod, best.doc)} or ${labelOf(mod, second.doc)}; say which one`,
      { module, matches: [best, second].map((m) => ({ id: String(m.doc._id), label: labelOf(mod, m.doc) })) },
    );
  }
  for (const key of mod.secretKeys ?? []) delete best.doc[key];
  return { id: String(best.doc._id), label: labelOf(mod, best.doc), doc: best.doc, exact: best.score >= 0.9 };
};

const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
/** Due-date phrases resolve_time_range reads differently or not at all: days from `now`, or null. */
const dueDays = (text) => {
  const t = text.toLowerCase().replace(/\s+/g, ' ');
  if (/^(kal|tomorrow)$/.test(t)) return 1; // "kal" is yesterday in a report, tomorrow for a due date
  if (/^(parso|day after tomorrow)$/.test(t)) return 2;
  const m = /^(?:in|within|after|next)\s+(\d+)\s*(day|week)s?$/.exec(t);
  if (m) return Number(m[1]) * (m[2] === 'week' ? 7 : 1);
  return null;
};

/** Text or ISO → Date: "tomorrow" = end of tomorrow, "tomorrow 2 pm" = that time, ISO as given. */
export const coerceDate = (ctx, value, now = new Date()) => {
  if (value instanceof Date) return value;
  const text = String(value).trim();
  const zone = zoneOf(ctx);
  const iso = DateTime.fromISO(text, { zone });
  if (iso.isValid && /^\d{4}-\d{2}-\d{2}/.test(text)) return iso.toJSDate();
  const today = DateTime.fromJSDate(now, { zone }).startOf('day');
  const days = dueDays(text);
  if (days != null)
    return today
      .plus({ days: days + 1 })
      .minus({ seconds: 1 })
      .toJSDate();
  const weekday = /^(?:next\s+|this\s+|coming\s+)?([a-z]+day)$/i.exec(text)?.[1].toLowerCase();
  if (weekday && WEEKDAYS.includes(weekday)) {
    const ahead = (WEEKDAYS.indexOf(weekday) + 1 - today.weekday + 7) % 7 || 7;
    return today
      .plus({ days: ahead + 1 })
      .minus({ seconds: 1 })
      .toJSDate();
  }
  const range = resolveTimeRange({ text }, ctx, DateTime.fromJSDate(now));
  const [start, stop] = [new Date(range.start), new Date(range.stop)];
  return stop - start >= DAY ? new Date(stop.getTime() - 1000) : start;
};

const setPath = (obj, path, value) => {
  const keys = path.split('.');
  let at = obj;
  for (const k of keys.slice(0, -1)) at = at[k] ??= {};
  at[keys.at(-1)] = value;
};

/** Loose keys → module fields; dropped keys are noted. */
const applyAliases = (module, raw, decided, { filter = false } = {}) => {
  const aliases = ALIASES[module] ?? {};
  const item = {};
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (!(key in aliases)) {
      item[key] = value;
      continue;
    }
    const target = aliases[key];
    if (target === null && filter) {
      item[key] = value;
      continue;
    }
    if (target === null) {
      if (value != null)
        decided.push({
          field: key,
          value: null,
          why: DROP_NOTES[`${module}.${key}`] ?? 'not a field of this record',
        });
      continue;
    }
    setPath(item, target, value);
  }
  return item;
};

/** Checklist in any shape (strings, { task }, { topic, tasks }) → taskAndChecklist rows. */
export const normTasks = (value, topic = 'Checklist') => {
  if (!Array.isArray(value)) return value;
  const rows = value.map((t) => (typeof t === 'string' ? { task: t } : t)).filter(Boolean);
  if (rows.every((r) => Array.isArray(r.tasks)))
    return rows.map((r) => ({ ...r, tasks: r.tasks.map((t) => (typeof t === 'string' ? { task: t } : t)) }));
  return [{ topic, tasks: rows }];
};

const enumValue = (spec, value) => {
  const text = String(value).trim();
  return (
    spec.values.find((v) => v.toLowerCase() === text.toLowerCase()) ??
    (spec.values.includes(PRIORITY_WORDS[text.toLowerCase()]) ? PRIORITY_WORDS[text.toLowerCase()] : null)
  );
};

/** Refs by name/code, enums case-insensitively, dates from text, checklists in any shape; recurses into objects. */
const coerceFields = async (ctx, specs, obj, { decided, now, filter = false, path = '' }) => {
  for (const [key, spec] of Object.entries(specs)) {
    const value = obj[key];
    if (value == null || (spec.readOnly && !filter)) continue;
    const field = path ? `${path}.${key}` : key;
    if (spec.type === 'ref' || spec.type === 'refs') {
      if (spec.idType === 'string') continue;
      const refs = []
        .concat(value)
        .flatMap((v) => (typeof v === 'string' ? v.split(/\s*[,;]\s*|\s+and\s+/) : [v]))
        .filter((v) => v !== '' && v != null);
      if (key === 'people' && refs.some(isAutoWord)) {
        // "auto" / "whoever is free": the filler (create) or the caller (update) picks the technician.
        obj[key] = [];
        obj.$autoPeople = true;
        continue;
      }
      const ids = [];
      for (const ref of refs) {
        if (typeof ref === 'object') {
          ids.push(String(ref._id ?? ref.id ?? ref));
          continue;
        }
        const found = await findRef(ctx, spec.ref, ref);
        if (!found.exact) decided.push({ field, value: found.label, why: `closest match to "${ref}"` });
        ids.push(found.id);
      }
      obj[key] = spec.type === 'refs' ? [...new Set(ids)] : (ids[0] ?? null);
    } else if (spec.type === 'enum' && typeof value === 'string' && !spec.values.includes(value)) {
      const hit = enumValue(spec, value);
      if (!hit) throw badRequest(`${field}: "${value}" is not one of ${spec.values.join(', ')}`);
      obj[key] = hit;
    } else if (spec.type === 'date' && typeof value === 'string' && !/^\d{4}-\d{2}-\d{2}/.test(value)) {
      try {
        obj[key] = coerceDate(ctx, value, now);
      } catch {
        throw badRequest(
          `${field}: I could not read "${value}" as a date; use ISO 8601 or words like "tomorrow"`,
        );
      }
      decided.push({ field, value: fmtDate(ctx, obj[key], { time: true }), why: `from "${value}"` });
    } else if (spec.type === 'array' && key === 'taskAndChecklist') {
      obj[key] = normTasks(value);
    } else if (spec.type === 'object' && typeof value === 'object') {
      await coerceFields(ctx, spec.fields, value, { decided, now, filter, path: field });
    }
  }
  return obj;
};

const textOf = (...parts) => parts.filter((p) => typeof p === 'string').join(' ');
const categoryFromText = (text) => CATEGORY_WORDS.find(([, re]) => re.test(text))?.[0] ?? null;
const assetOf = (ctx, id) =>
  id
    ? getModule('assets')
        .Model.findOne({ _id: asObjectId(id), companyId: ctx.companyId })
        .lean()
    : null;

/**
 * The best free maintenance technician for the next `durationMin` minutes (skills of the category/asset
 * type first), else the least-loaded one; null when the plant has no technician.
 */
export const pickTechnician = async (
  ctx,
  { plantId, assetType, category, now = new Date(), durationMin = 60, exclude = [] },
) => {
  const window = { start: now, end: new Date(now.getTime() + 8 * HOUR) };
  const load = (roles) => loadPeople(ctx, { department: 'Maintenance', plantId, window, roles });
  const skip = new Set(exclude.map(String));
  let people = (await load(['technician'])).filter((p) => !skip.has(p.userId));
  if (!people.length) people = (await load(['technician', 'admin'])).filter((p) => !skip.has(p.userId));
  if (!people.length) return null;
  const skills = skillsForTask({ category, assetType });
  const interval = { start: now, end: new Date(now.getTime() + durationMin * 60_000) };
  const person =
    pickPerson(people, interval, { skills }) ??
    [...people].sort((a, b) => a.loadHours - b.loadHours || a.name.localeCompare(b.name))[0];
  const free = freeFor(person, interval);
  const shiftEnd = person.onShift.find((w) => w.start <= now && now < w.end)?.end ?? null;
  const nextBooking = person.bookings.find((b) => b.start > now)?.start ?? null;
  const freeUntil = free
    ? nextBooking && (!shiftEnd || nextBooking < shiftEnd)
      ? nextBooking
      : shiftEnd
    : null;
  const matched = person.skills.filter((s) => skills.includes(s));
  const why = free
    ? `free${freeUntil ? ` until ${fmtDate(ctx, freeUntil, { time: true }).slice(-5)}` : ' now'}${matched.length ? `, ${matched.join('/')}` : ''}`
    : `least loaded (${person.loadHours} h booked)${matched.length ? `, ${matched.join('/')}` : ''}`;
  return { id: person.userId, name: person.name, free, freeUntil, skills: matched, why };
};

const fillWorkOrder = async (ctx, item, { hints, now, decided }) => {
  const decide = (field, value, why) => {
    item[field] = value;
    decided.push({ field, value, why });
  };
  const anomaly = item.anomalyId
    ? await getModule('anomalies')
        .Model.findOne({ _id: asObjectId(item.anomalyId), companyId: ctx.companyId })
        .lean()
    : null;
  if (!item.asset && anomaly?.assetId) item.asset = String(anomaly.assetId);
  const asset = await assetOf(ctx, item.asset);
  const text = textOf(item.name, item.description, hints);
  if (!item.category) {
    const fromAnomaly = anomaly ? CATEGORY_OF[anomaly.type] : null;
    const fromText = categoryFromText(text);
    decide(
      'category',
      fromAnomaly ?? fromText ?? 'Breakdown',
      fromAnomaly ? `anomaly ${anomaly.type}` : fromText ? 'from the description' : 'default',
    );
  }
  if (!item.priority) {
    const fromAnomaly = anomaly ? PRIORITY_OF[anomaly.severity] : null;
    const high = HIGH_WORDS.test(text) || ['Breakdown', 'Safety'].includes(item.category);
    decide(
      'priority',
      fromAnomaly ?? (high ? 'High' : 'Medium'),
      fromAnomaly ? `anomaly ${anomaly.severity}` : high ? item.category.toLowerCase() : 'default',
    );
  }
  if (!item.name) {
    const name = anomaly
      ? `${humanize(anomaly.type)} on ${asset?.name ?? 'machine'}`
      : `${item.category}${asset ? ` – ${asset.name}` : ''}`;
    decide('name', name, 'from the problem and the asset');
  }
  if (!item.description) {
    if (anomaly) decide('description', describeAnomaly(anomaly), 'from the anomaly');
    else if (hints) decide('description', hints, 'from the conversation');
    else item.description = `${item.name}. Raised via SARA by ${ctx.user?.name ?? 'the user'}.`;
  }
  if (!item.dueDate) {
    const due = new Date(now.getTime() + (DUE_BY_PRIORITY[item.priority] ?? 3 * DAY));
    decide('dueDate', due, `${item.priority} priority`);
  }
  if (item.estimatedDurationMin == null) item.estimatedDurationMin = CATEGORY_MIN[item.category] ?? 60;
  if (!item.taskAndChecklist?.length) {
    item.taskAndChecklist = normTasks(
      STANDARD_TASKS[item.category] ?? GENERIC_TASKS,
      `${item.category} checklist`,
    );
    decided.push({
      field: 'taskAndChecklist',
      value: `${item.taskAndChecklist[0].tasks.length} standard ${item.category.toLowerCase()} tasks`,
      why: 'no checklist given',
    });
  }
  if (!item.people?.length) {
    delete item.$autoPeople;
    const tech = await pickTechnician(ctx, {
      plantId: asset?.plantId ?? ctx.plantId ?? undefined,
      assetType: asset?.typeOfAsset,
      category: item.category,
      now,
      durationMin: item.estimatedDurationMin,
    });
    if (tech) decide('people', [tech.id], tech.why);
    else
      decided.push({
        field: 'people',
        value: [],
        why: 'no maintenance technician in this plant; left unassigned',
      });
  }
};

/** "monthly", "every 2 weeks", "quarterly" → { everyNumber, duration } or null. */
export const parseFrequency = (text) => {
  const t = String(text ?? '').toLowerCase();
  for (const [word, [everyNumber, duration]] of Object.entries(FREQUENCY_WORDS))
    if (t.includes(word)) return { everyNumber, duration };
  const m = /every\s+(\d+|other|second)?\s*(hour|day|week|month|year)s?/.exec(t);
  if (m) {
    const n = m[1] == null ? 1 : /other|second/.test(m[1]) ? 2 : Number(m[1]);
    return { everyNumber: n, duration: `${m[2][0].toUpperCase()}${m[2].slice(1)}s` };
  }
  return null;
};

const fillPreventive = async (ctx, item, { hints, now, decided }) => {
  const asset = await assetOf(ctx, item.assetAllocation);
  const text = textOf(
    item.name,
    item.description,
    hints,
    typeof item.$frequency === 'string' ? item.$frequency : '',
  );
  const given = typeof item.$frequency === 'object' ? item.$frequency : null;
  delete item.$frequency;
  if (!item.trigger?.cycle) {
    const parsed = given ?? parseFrequency(text);
    const cycle = parsed ?? { everyNumber: 1, duration: 'Months' };
    item.trigger = {
      scheduleType: 'Regular',
      ...(item.trigger ?? {}),
      cycle: { ...(item.trigger?.cycle ?? {}), ...cycle },
    };
    const label =
      cycle.everyNumber === 1
        ? `every ${cycle.duration.replace(/s$/, '').toLowerCase()}`
        : `every ${cycle.everyNumber} ${cycle.duration.toLowerCase()}`;
    decided.push({ field: 'trigger', value: label, why: parsed ? 'from the request' : 'default' });
  }
  const category = categoryFromText(text) ?? 'Preventive';
  if (!item.name) {
    const cycle = item.trigger.cycle;
    const every =
      cycle.everyNumber === 1
        ? cycle.duration.replace(/s$/, 'ly').replace(/Dayly/, 'Daily')
        : `Every ${cycle.everyNumber} ${cycle.duration.toLowerCase()}`;
    item.name = `${every} ${category.toLowerCase()}${asset ? ` – ${asset.name}` : ''}`;
    decided.push({ field: 'name', value: item.name, why: 'from the schedule and the asset' });
  }
  if (!item.description && hints) {
    item.description = hints;
    decided.push({ field: 'description', value: hints, why: 'from the conversation' });
  }
  if (!item.nextGenerationDate) {
    const cycle = item.trigger.cycle;
    const next = new Date(now.getTime() + cycle.everyNumber * (CYCLE_MS[cycle.duration] ?? 30 * DAY));
    item.nextGenerationDate = next;
    decided.push({ field: 'nextGenerationDate', value: next, why: 'one cycle from now' });
  }
  if (item.estimatedDurationMin == null) item.estimatedDurationMin = CATEGORY_MIN[category] ?? 60;
  item.selectWorkOrder ??= {};
  const wo = item.selectWorkOrder;
  wo.name ??= item.name;
  wo.priority ??= 'Medium';
  if (!wo.taskAndChecklist?.length)
    wo.taskAndChecklist = normTasks(
      STANDARD_TASKS[category] ?? STANDARD_TASKS.Preventive,
      `${category} checklist`,
    );
  if (!wo.people?.length) {
    delete wo.$autoPeople;
    const tech = await pickTechnician(ctx, {
      plantId: asset?.plantId ?? ctx.plantId ?? undefined,
      assetType: asset?.typeOfAsset,
      category,
      now,
      durationMin: item.estimatedDurationMin,
    });
    if (tech) {
      wo.people = [tech.id];
      decided.push({ field: 'selectWorkOrder.people', value: [tech.id], why: tech.why });
    }
  }
};

const fillRequest = async (ctx, item, { hints, decided }) => {
  const asset = await assetOf(ctx, item.asset);
  const text = textOf(item.name, item.description, hints);
  if (!item.type) {
    item.type = categoryFromText(text) ?? 'Breakdown';
    decided.push({
      field: 'type',
      value: item.type,
      why: categoryFromText(text) ? 'from the description' : 'default',
    });
  }
  if (!item.name) {
    item.name = `${item.type}${asset ? ` – ${asset.name}` : ''}`;
    decided.push({ field: 'name', value: item.name, why: 'from the problem and the asset' });
  }
  if (!item.description && hints) {
    item.description = hints;
    decided.push({ field: 'description', value: hints, why: 'from the conversation' });
  }
};

const FILLERS = { workorders: fillWorkOrder, preventivemaintenances: fillPreventive, requests: fillRequest };

/**
 * `raw` from the model → `{ item, decided }`: aliases mapped, refs/enums/dates coerced and, when `fill`
 * (creates), the missing fields decided from the conversation `hints`, the anomaly, the asset and who is free.
 * `filter` = a list filter, not a record: read-only fields (workStatus) are coerced too and nothing is dropped.
 */
export const completeRecord = async (
  ctx,
  module,
  raw,
  { hints = '', now = new Date(), fill = true, filter = false } = {},
) => {
  const mod = getModule(module);
  const decided = [];
  const item = applyAliases(module, raw, decided, { filter });
  await coerceFields(ctx, mod.fields, item, { decided, now, filter });
  if (fill && FILLERS[module])
    await FILLERS[module](ctx, item, { hints: String(hints ?? '').trim(), now, decided });
  return { item, decided };
};

/** "priority High (breakdown); assigned Ramesh Kumar (free until 22:00, hydraulics); due 18-10 09:00". */
export const decidedText = (ctx, decided, labels = {}) =>
  decided
    .map(({ field, value, why }) => {
      const show = (v) =>
        v instanceof Date
          ? fmtDate(ctx, v, { time: true })
          : Array.isArray(v)
            ? v.map((x) => labels[x] ?? x).join(', ')
            : (labels[v] ?? v);
      if (field === 'people' || field === 'selectWorkOrder.people')
        return value?.length ? `assigned ${show(value)} (${why})` : `unassigned (${why})`;
      if (field === 'dueDate') return `due ${show(value)} (${why})`;
      if (value === null) return `${field} dropped (${why})`;
      return `${field} ${show(value)} (${why})`;
    })
    .join('; ');
