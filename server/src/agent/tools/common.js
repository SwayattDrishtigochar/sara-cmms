import { DateTime } from 'luxon';
import mongoose from 'mongoose';
import { env } from '../../config/env.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { humanize } from '../../lib/format.js';
import { OBJECT_ID_PATTERN } from '../../modules/fields.js';
import { assertCan } from '../../modules/permissions.js';
import { records, scopeFilter } from '../../modules/records.js';
import { getModule, hasModule, labelOf } from '../../modules/registry.js';
import { redact } from '../validators/redact.js';
import { lenientTimeRange, parseDate } from './resolve.js';

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
  // The same code in several plants: the user's own plant wins; otherwise ask for the id.
  const own = matches.length > 1 ? matches.filter((m) => String(m.plantId) === String(ctx.plantId)) : [];
  if (own.length === 1) matches.splice(0, matches.length, own[0]);
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

// ── Time windows ────────────────────────────────────────────────────────────

const PLACEHOLDER = /^\$\{?(start|stop|end|now)\}?$/i;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** The latest resolve_time_range result of this turn (`io.results`), or null. */
export const latestRange = (io) => {
  for (const value of [...(io?.results?.values() ?? [])].reverse()) {
    const d = value?.data;
    if (d?.start && d?.stop && d?.label && d?.timeZone) return d;
  }
  return null;
};

/** What a "$start" / "$stop" placeholder means: the latest resolved range of the turn, else today. */
const placeholderIso = (key, io, zone) => {
  if (key === 'now') return new Date().toISOString();
  const latest = latestRange(io);
  if (latest) return key === 'start' ? latest.start : latest.stop;
  const now = DateTime.now().setZone(zone);
  return (key === 'start' ? now.startOf('day') : now).toUTC().toISO();
};
const placeholderKey = (text) => {
  const m = PLACEHOLDER.exec(String(text).trim());
  if (!m) return null;
  const key = m[1].toLowerCase();
  return key === 'end' ? 'stop' : key;
};

/** Replaces "$start"/"$stop" strings anywhere in model args (the KPI syntax leaks into other tools). */
export const fillPlaceholders = (args, { ctx, io } = {}) => {
  const zone = ctx ? zoneOf(ctx) : env.DEFAULT_TIMEZONE;
  const walk = (v) => {
    if (typeof v === 'string') {
      const key = placeholderKey(v);
      return key ? placeholderIso(key, io, zone) : v;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype)
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(args);
};

/** An exact instant from a tool arg (ISO, date in the company format, epoch, "now", placeholder), else null. */
const instantOf = (value, { end, zone, io, ctx }) => {
  if (value instanceof Date) return value;
  const text = String(value ?? '').trim();
  if (!text) return null;
  if (/^\d{12,}$/.test(text)) return new Date(Number(text));
  if (/^\d{9,11}$/.test(text)) return new Date(Number(text) * 1000);
  if (/^(now|abhi)$/i.test(text)) return new Date();
  const key = placeholderKey(text);
  if (key) return new Date(placeholderIso(key, io, zone));
  const iso = DateTime.fromISO(text, { zone, setZone: !/[zZ]|[+-]\d\d:\d\d$/.test(text) });
  if (iso.isValid) return (end && DATE_ONLY.test(text) ? iso.plus({ days: 1 }) : iso).toJSDate();
  const day = parseDate(text, {
    zone,
    year: DateTime.now().setZone(zone).year,
    dateFormat: ctx?.company?.dateFormat,
  });
  if (day) return (end ? day.plus({ days: 1 }) : day).toJSDate();
  return null;
};

/**
 * `{ start, stop, label? }` Dates from tool args. Accepts ISO, dates in the company format, epochs, natural
 * text ("today", "last 3 days"), "$start"/"$stop" placeholders (the latest resolve_time_range result of
 * the turn, else today) and a missing stop (= now). `label` names a phrase that was interpreted.
 */
export const timeWindow = ({ start, stop } = {}, { defaultDays = 30, ctx, io } = {}) => {
  const zone = ctx ? zoneOf(ctx) : env.DEFAULT_TIMEZONE;
  const tctx = ctx ?? { plants: [] };
  const opts = { zone, io, ctx };
  let s = instantOf(start, { ...opts, end: false });
  let e = instantOf(stop, { ...opts, end: true });
  const labels = [];
  if (start && !s) {
    const r = lenientTimeRange({ text: String(start) }, tctx);
    s = new Date(r.start);
    if (!stop) e = new Date(r.stop);
    labels.push(r.label);
  }
  if (stop && !e) {
    const r = lenientTimeRange({ text: String(stop) }, tctx);
    e = new Date(r.stop);
    if (!start) s = new Date(r.start);
    labels.push(r.label);
  }
  e ??= new Date();
  s ??= new Date(e.getTime() - defaultDays * DAY_MS);
  if (s.getTime() === e.getTime()) e = new Date(s.getTime() + DAY_MS);
  if (s > e) [s, e] = [e, s];
  return { start: s, stop: e, ...(labels.length ? { label: labels.join(' – ') } : {}) };
};

// ── Asset references ────────────────────────────────────────────────────────

const ASSET_CAP = 20;
const ALL_WORDS = new Set(['all', '*', 'every', 'everything', 'all assets', 'all machines', 'sab', 'sabhi']);

/** "IMM-01" / "imm 1" / "Imm01" → "imm1": case, spaces, hyphens and leading zeros do not matter. */
export const refKey = (text) =>
  (
    String(text ?? '')
      .toLowerCase()
      .match(/[a-z]+|\d+/g) ?? []
  )
    .map((t) => (/^\d+$/.test(t) ? String(Number(t)) : t))
    .join('');

/** Levenshtein distance (small strings only). */
export const editDistance = (a, b) => {
  if (a === b) return 0;
  if (!a.length || !b.length) return a.length || b.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
};

const tokens = (text) =>
  String(text ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

/** 0–1: share of query words with a near match (prefix or ≤ 1 typo per 4 letters) in the candidate. */
export const fuzzyScore = (query, candidate) => {
  const q = tokens(query);
  if (!q.length) return 0;
  const c = tokens(candidate);
  // Short tokens (a number, "A") must match exactly: "9" is not a typo of "1".
  const hit = q.filter((w) =>
    c.some(
      (x) =>
        x === w ||
        (w.length > 2 && (x.startsWith(w) || editDistance(w, x) <= Math.max(1, Math.floor(w.length / 4)))),
    ),
  );
  return hit.length / q.length;
};

/** Up to `n` candidate labels closest to `query` (fuzzy score, then edit distance). */
export const closest = (query, labels, n = 3) =>
  labels
    .map((label) => ({
      label,
      score: fuzzyScore(query, label),
      d: editDistance(refKey(query), refKey(label)),
    }))
    .filter((x) => x.score >= 0.5 || x.d <= 2)
    .sort((a, b) => b.score - a.score || a.d - b.d)
    .slice(0, n)
    .map((x) => x.label);

/** Every asset the user may read (lean, capped at 500). */
export const readableAssets = async (ctx) => {
  const mod = readableModule(ctx, 'assets');
  return mod.Model.find(scopeFilter(ctx, mod))
    .select('name assetTag typeOfAsset assetStatus plantId isEnergyAsset isProductionAsset')
    .sort({ name: 1 })
    .limit(500)
    .lean();
};

/** The asset a record of another module points at (anomaly, work order, job card), by that record's id. */
const assetViaRecord = async (ctx, id) => {
  const links = [
    ['anomalies', 'assetId'],
    ['workorders', 'asset'],
    ['jobcards', 'asset'],
  ];
  for (const [module, field] of links) {
    if (!ctx.modules.includes(module)) continue;
    const mod = getModule(module);
    const doc = await mod.Model.findOne({ _id: id, ...scopeFilter(ctx, mod) })
      .select(field)
      .lean()
      .catch(() => null);
    if (doc?.[field]) return String(doc[field]);
  }
  return null;
};

const someNames = (all) =>
  all
    .slice(0, 12)
    .map((a) => a.name)
    .join(', ');

/**
 * Assets from whatever the model sends as assetId/assetIds: an id, a code (IMM-01), a name (imm 1,
 * "furnace 2"), a type ("compressors"), "all" or nothing (= every readable asset, capped), or a list
 * mixing them. Unknown references fail with the closest names ("did you mean IMM 1, IMM 2?").
 */
export const assetRefs = async (ctx, refs, { max = ASSET_CAP } = {}) => {
  const all = await readableAssets(ctx);
  const list = (Array.isArray(refs) ? refs : [refs]).map((r) => String(r ?? '').trim()).filter(Boolean);
  if (!list.length || list.some((r) => ALL_WORDS.has(r.toLowerCase()))) return all.slice(0, max);
  const byId = new Map(all.map((a) => [String(a._id), a]));
  const out = new Map();
  const add = (assets) => {
    for (const a of assets) out.set(String(a._id), a);
  };
  for (const ref of list) {
    if (OBJECT_ID_PATTERN.test(ref)) {
      const linked = byId.get(ref) ? null : await assetViaRecord(ctx, ref);
      const asset = byId.get(ref) ?? (linked && byId.get(linked));
      if (!asset) {
        throw notFound(`Asset not found for id ${ref}`, {
          hint: `That id is not one of your assets; pass the machine name instead. Assets: ${someNames(all)}`,
        });
      }
      add([asset]);
      continue;
    }
    const key = refKey(ref);
    const exact = all.filter((a) => refKey(a.name) === key || refKey(a.assetTag) === key);
    if (exact.length) {
      add(exact.slice(0, 1));
      continue;
    }
    const typeKey = key.replace(/^all/, '').replace(/s$/, '');
    const ofType =
      typeKey.length >= 3
        ? all.filter((a) => {
            const t = refKey(a.typeOfAsset);
            return t && (t.replace(/s$/, '') === typeKey || t.includes(typeKey));
          })
        : [];
    const partial = ofType.length
      ? ofType
      : all.filter((a) => refKey(a.name).startsWith(key) || refKey(a.assetTag).startsWith(key));
    if (partial.length > 1 && max === 1) {
      // One asset wanted, several share the type or start with the text: name them instead of guessing.
      throw badRequest(
        `Several assets match "${ref}": ${partial.map((a) => a.name).join(', ')}; pick one or ask the user which one`,
        { matches: partial.map((a) => ({ id: String(a._id), label: a.name })) },
      );
    }
    if (ofType.length || partial.length === 1 || (partial.length > 1 && key.length >= 3)) {
      add(partial);
      continue;
    }
    const near = closest(
      ref,
      all.map((a) => a.name),
    );
    throw notFound(
      near.length
        ? `Asset not found: "${ref}"; did you mean ${near.join(', ')}?`
        : `Asset not found: "${ref}". Assets: ${someNames(all)}`,
      near.length ? { suggestions: near } : undefined,
    );
  }
  return [...out.values()].slice(0, max);
};

/** One asset from an id, code or name (the first match of `assetRefs`). */
export const assetRef = async (ctx, ref) => {
  const [asset] = await assetRefs(ctx, ref, { max: 1 });
  if (!asset) throw notFound('Asset not found');
  return asset;
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
