import { DateTime } from 'luxon';
import { getTool, groupEnabled } from '../agent/tools/registry.js';
import { resolveTimeRange } from '../agent/tools/resolve.js';
import { badRequest } from '../lib/errors.js';
import { identifiersOf, KEY_PATTERN, parseExpr } from './expr.js';
import { normalize } from './normalize.js';

/**
 * KPI runner (docs/phase5-contracts.md §3.7): 1–4 read-tool sources run in the viewer's ctx, the time range
 * re-resolved from its text on every run, zod re-validation of the stored args, then `normalize`.
 * `getTool` is called at run time only: the agent registry imports kpis/tools.js, which imports this file
 * (tools.js reads nothing from here at load time, so either module may be imported first).
 */

export const KPI_SOURCE_TOOLS = new Set([
  'work_orders_summary',
  'spare_parts_below_minimum',
  'upcoming_maintenance',
  'job_card_progress',
  'rejection_summary',
  'downtime_summary',
  'attendance_summary',
  'telemetry_latest',
  'telemetry_series',
  'telemetry_status_timeline',
  'telemetry_shot_counts',
  'energy_consumption',
  'machine_health',
  'list_anomalies',
  'mongo_find',
  'mongo_count',
  'mongo_aggregate',
  'cost_summary',
]);
const SOURCE_TIMEOUT_MS = 15_000;
const DEFAULT_RANGE = 'last 7 days';

const toDateTime = (now) =>
  now == null ? DateTime.now() : DateTime.isDateTime(now) ? now : DateTime.fromJSDate(new Date(now));

/** Stored args never hold the window: top-level start/stop come from the time range on each run. */
export const stripWindow = (args = {}) => {
  const { start, stop, ...rest } = args ?? {};
  return rest;
};

/** `"$start"` / `"$stop"` at any depth → the run's window; top-level start/stop injected when the tool takes them. */
export const argsFor = (tool, args, range) => {
  const swap = (v) => {
    if (v === '$start') return range.start;
    if (v === '$stop') return range.stop;
    if (Array.isArray(v)) return v.map(swap);
    if (v && typeof v === 'object')
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, swap(x)]));
    return v;
  };
  const out = swap(stripWindow(args));
  const shape = tool.schema?.shape ?? {};
  if ('start' in shape) out.start = range.start;
  if ('stop' in shape) out.stop = range.stop;
  return out;
};

/** The tool a source may use in this ctx, or the reason it can't. */
const sourceTool = (ctx, name) => {
  if (!KPI_SOURCE_TOOLS.has(name)) return { error: `"${name}" can't feed a KPI` };
  const tool = getTool(name);
  if (!tool) return { error: `"${name}" is not available` };
  if (!groupEnabled(ctx, tool.group) || (tool.permission && !tool.permission(ctx)))
    return { error: `"${name}" is not available to your role or company` };
  return { tool };
};

const rangeOf = (ctx, def, now) =>
  resolveTimeRange({ text: def.timeRange?.text || DEFAULT_RANGE }, ctx, toDateTime(now));

/**
 * Checks a KPI definition; 400 with `details.issues` ([{ path, message }]) when anything is off.
 * Returns the definition with start/stop removed from every source's args.
 */
export const validateKpi = (ctx, def, { now } = {}) => {
  const issues = [];
  const add = (path, message) => issues.push({ path, message });
  const sources = def.sources ?? [];
  if (sources.length < 1 || sources.length > 4) add('sources', 'A KPI needs 1 to 4 sources');
  let range = null;
  try {
    range = rangeOf(ctx, def, now);
  } catch (err) {
    add('timeRange.text', err.message);
  }
  const keys = new Set();
  const cleaned = sources.map((s, i) => {
    if (!KEY_PATTERN.test(s.key ?? ''))
      add(`sources.${i}.key`, 'Keys are short camelCase names, e.g. energy');
    if (keys.has(s.key)) add(`sources.${i}.key`, `The key "${s.key}" is used twice`);
    keys.add(s.key);
    const { tool, error } = sourceTool(ctx, s.tool);
    if (error) add(`sources.${i}.tool`, `${error}. Allowed: ${[...KPI_SOURCE_TOOLS].join(', ')}`);
    else if (range) {
      const parsed = tool.schema.safeParse(argsFor(tool, s.args, range));
      if (!parsed.success)
        for (const issue of parsed.error.issues)
          add(`sources.${i}.args.${issue.path.join('.')}`.replace(/\.$/, ''), issue.message);
    }
    return { ...s, args: stripWindow(s.args) };
  });
  if (def.formula) {
    try {
      const unknown = identifiersOf(parseExpr(def.formula)).filter((k) => !keys.has(k));
      if (unknown.length) add('formula', `Unknown source key(s): ${unknown.join(', ')}`);
    } catch (err) {
      add('formula', err.message);
    }
  }
  if (def.encoding?.source && !keys.has(def.encoding.source))
    add('encoding.source', `"${def.encoding.source}" is not one of the source keys`);
  if (issues.length)
    throw badRequest(`This KPI is not valid: ${issues.map((x) => `${x.path}: ${x.message}`).join('; ')}`, {
      issues,
    });
  return { ...def, sources: cleaned };
};

const withTimeout = (promise, ms, label) => {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} took too long`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
};

const readPath = (obj, path) =>
  String(path)
    .split('.')
    .reduce((v, k) => (v == null || !Object.hasOwn(Object(v), k) ? undefined : v[k]), obj);

/** One source → { value, columns } or { error }. */
const runSource = async (ctx, source, range, signal) => {
  const { tool, error } = sourceTool(ctx, source.tool);
  if (error) return { error };
  const parsed = tool.schema.safeParse(argsFor(tool, source.args, range));
  if (!parsed.success)
    return { error: `invalid arguments (${parsed.error.issues.map((i) => i.message).join('; ')})` };
  try {
    const io = { emit: () => {}, signal, results: new Map(), callId: `kpi_${source.key}` };
    const out = await withTimeout(
      Promise.resolve(tool.run(ctx, parsed.data, io)),
      SOURCE_TIMEOUT_MS,
      source.tool,
    );
    const picked = readPath({ forModel: out?.forModel, data: out?.data }, source.pick || 'data.rows');
    const value = picked ?? out?.forModel?.rows ?? out?.forModel?.count ?? null;
    return { value, columns: out?.data?.columns };
  } catch (err) {
    return { error: err?.message ?? String(err) };
  }
};

/** Runs a KPI in `ctx` (the viewer's); a failing source never throws, it sets `result.error`. */
export const runKpi = async (ctx, def, { now, signal } = {}) => {
  const id = def._id ? String(def._id) : def.id;
  const base = { ...(id ? { id } : {}), viz: def.viz, title: def.title, unit: def.unit ?? null };
  let range;
  try {
    range = rangeOf(ctx, def, now);
  } catch (err) {
    return {
      ...base,
      ranAt: new Date().toISOString(),
      warnings: [],
      stats: { count: 0 },
      error: err.message,
    };
  }
  const sources = def.sources ?? [];
  const outs = await Promise.all(sources.map((s) => runSource(ctx, s, range, signal)));
  const failed = outs.findIndex((o) => o.error);
  if (failed >= 0) {
    return {
      ...base,
      timeRange: range,
      ranAt: new Date().toISOString(),
      warnings: [],
      stats: { count: 0 },
      error: `${sources[failed].key} (${sources[failed].tool}): ${outs[failed].error}`,
    };
  }
  const values = Object.fromEntries(sources.map((s, i) => [s.key, outs[i].value]));
  const columns = Object.fromEntries(sources.map((s, i) => [s.key, outs[i].columns]));
  try {
    return { ...(id ? { id } : {}), ...normalize(def, values, range, columns) };
  } catch (err) {
    return {
      ...base,
      timeRange: range,
      ranAt: new Date().toISOString(),
      warnings: [],
      stats: { count: 0 },
      error: err.message,
    };
  }
};
