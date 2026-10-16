import { DateTime } from 'luxon';
import mongoose from 'mongoose';
import { env } from '../../config/env.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { humanize } from '../../lib/format.js';
import { OBJECT_ID_PATTERN } from '../../modules/fields.js';
import { assertCan } from '../../modules/permissions.js';
import { records } from '../../modules/records.js';
import { getModule, hasModule, labelOf } from '../../modules/registry.js';
import { redact } from '../validators/redact.js';

/** Helpers every tool module shares: module access, payload trimming, labels, dates, money. */

const { ObjectId } = mongoose.Types;
export const MAX_ROWS = env.MAX_ROWS;
/** Rows and characters the model sees per tool result (the UI gets the full payload). */
export const MODEL_ROWS = 50;
export const MODEL_TEXT = 300;
export const DATE_TOKENS = {
  'DD-MM-YYYY': 'dd-MM-yyyy',
  'MM-DD-YYYY': 'MM-dd-yyyy',
  'YYYY-MM-DD': 'yyyy-MM-dd',
};
const DAY_MS = 86_400_000;

/** A module the user may read from chat: switched on for the company and readable by the role. */
export const readableModule = (ctx, name) => {
  if (!hasModule(name) || !ctx.modules.includes(name)) {
    throw badRequest(`Unknown module "${name}"`, { hint: `Modules: ${ctx.modules.join(', ')}` });
  }
  const mod = getModule(name);
  assertCan(ctx, mod, 'read');
  return mod;
};

export const asObjectId = (value) => {
  if (value instanceof ObjectId) return value;
  return typeof value === 'string' && OBJECT_ID_PATTERN.test(value) ? new ObjectId(value) : null;
};

export const zoneOf = (ctx) => ctx.company?.timeZone ?? env.DEFAULT_TIMEZONE;

/** Trims a payload for the model: at most `rows` items per array (with a closing note), strings cut at `text`. */
export const compact = (value, { rows = MODEL_ROWS, text = MODEL_TEXT } = {}) => {
  const walk = (v) => {
    if (typeof v === 'string') return v.length > text ? `${v.slice(0, text)}…` : v;
    if (Array.isArray(v)) {
      const head = v.slice(0, rows).map(walk);
      if (v.length > rows) head.push(`… ${v.length - rows} more rows (the full table is shown to the user)`);
      return head;
    }
    if (v && typeof v === 'object')
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(redact(value));
};

/** One record by id or human code (WO-42); 404 when missing, 400 when a code exists in several plants. */
export const findByIdOrCode = async (ctx, module, ref) => {
  const mod = readableModule(ctx, module);
  const value = String(ref ?? '').trim();
  if (!value) throw badRequest(`Give a ${mod.singular.toLowerCase()} id or code`);
  if (mod.idType !== 'string' && OBJECT_ID_PATTERN.test(value)) {
    return records.get(ctx, module, value, { populate: false });
  }
  if (!mod.codeField) throw notFound(`${mod.singular} "${value}" not found`);
  const matches = await records.findByCode(ctx, module, value);
  if (!matches.length) throw notFound(`${mod.singular} ${value} not found`);
  if (matches.length > 1) {
    throw badRequest(`${value} exists in ${matches.length} plants; pass the record id instead`, {
      matches: matches.map((m) => ({ id: String(m._id), plantId: m.plantId ? String(m.plantId) : null })),
    });
  }
  for (const key of mod.secretKeys) delete matches[0][key];
  return matches[0];
};

/** Labels of records of one module by id (same company only): Map<id, label>. */
export const labelsFor = async (ctx, module, ids) => {
  const mod = getModule(module);
  const wanted = [...new Set(ids.filter(Boolean).map(String))];
  if (!wanted.length) return new Map();
  const castIds = mod.idType === 'string' ? wanted : wanted.map(asObjectId).filter(Boolean);
  const rows = await mod.Model.find({ _id: { $in: castIds }, [mod.tenantField]: ctx.companyId }).lean();
  return new Map(rows.map((row) => [String(row._id), labelOf(mod, row)]));
};

export const plantOf = (ctx, plantId) =>
  ctx.plants.find((p) => String(p._id) === String(plantId)) ??
  ctx.plants.find((p) => String(p._id) === String(ctx.plantId)) ??
  ctx.plants[0] ??
  null;

export const plantName = (ctx, plantId) =>
  ctx.plants.find((p) => String(p._id) === String(plantId))?.name ?? null;

/** `{ start, stop }` Dates from tool args (ISO or epoch); start defaults to stop − defaultDays. */
export const timeWindow = ({ start, stop } = {}, { defaultDays = 30 } = {}) => {
  const toDate = (v, what) => {
    const date = new Date(/^\d+$/.test(String(v)) ? Number(v) : v);
    if (Number.isNaN(date.getTime())) {
      throw badRequest(
        `"${what}" is not a valid date; call resolve_time_range first and pass its start/stop`,
      );
    }
    return date;
  };
  const stopDate = stop ? toDate(stop, 'stop') : new Date();
  const startDate = start ? toDate(start, 'start') : new Date(stopDate.getTime() - defaultDays * DAY_MS);
  if (startDate >= stopDate) throw badRequest('The start must be before the stop');
  return { start: startDate, stop: stopDate };
};

/** A date in the company format (plus time when asked), in the company zone. */
export const fmtDate = (ctx, date, { time = false } = {}) => {
  if (!date) return null;
  const dt = DateTime.fromJSDate(new Date(date), { zone: zoneOf(ctx) });
  if (!dt.isValid) return null;
  const token = DATE_TOKENS[ctx.company?.dateFormat] ?? 'dd-MM-yyyy';
  return dt.toFormat(time ? `${token} HH:mm` : token);
};

export const money = (ctx, amount) =>
  amount == null
    ? null
    : `${ctx.company?.currency?.symbol ?? '₹'}${Math.round(amount).toLocaleString('en-IN')}`;

export const round = (n, dp = 1) => (n == null || Number.isNaN(n) ? null : Number(Number(n).toFixed(dp)));

/** Table columns from the first row (render_table uses them when the model gives none). */
export const columnsOf = (rows, labels = {}) =>
  Object.keys(rows[0] ?? {}).map((key) => ({ key, label: labels[key] ?? humanize(key) }));

/** Standard result of a row-producing tool: compact rows for the model, full rows for render_* / export. */
export const rowsResult = ({ rows, what, columns, forModel, blocks, extra = {} }) => ({
  forModel: forModel ?? { count: rows.length, ...extra, rows: compact(rows) },
  summary: `${rows.length} ${what}`,
  rowCount: rows.length,
  data: { rows: redact(rows), columns: columns ?? columnsOf(rows) },
  ...(blocks ? { blocks } : {}),
});

/** Deep link to a record in the web app. */
export const linkTo = (module, id) => (module === 'assets' ? `/machines/${id}` : `/m/${module}/${id}`);
