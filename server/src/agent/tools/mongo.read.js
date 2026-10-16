import { z } from 'zod';
import { badRequest } from '../../lib/errors.js';
import { humanize } from '../../lib/format.js';
import { toMeta } from '../../modules/fields.js';
import { scopeFilter } from '../../modules/records.js';
import { fieldSpec, sanitizeFilter } from '../validators/mongoFilter.js';
import { sanitizePipeline } from '../validators/mongoPipeline.js';
import { REDACTED_KEYS, redact } from '../validators/redact.js';
import { compact, labelsFor, MAX_ROWS, readableModule, rowsResult } from './common.js';

/** Generic MongoDB read tools (phase 4 §2): every call is scoped, validated, capped and redacted. */

const DEFAULT_LIMIT = 50;
const MAX_TIME_MS = 15_000;
const SORTABLE_EXTRA = new Set(['createdAt', 'updatedAt', '_id']);
const freeForm = () => z.record(z.string(), z.any());

const parseSort = (mod, sort) => {
  const out = {};
  for (const part of String(sort ?? mod.sort).split(',')) {
    const key = part.replace(/^-/, '').trim();
    if (!key) continue;
    if (!(key in mod.allFields) && !SORTABLE_EXTRA.has(key))
      throw badRequest(`Can't sort ${mod.label} by "${key}"`);
    out[key] = part.trim().startsWith('-') ? -1 : 1;
  }
  out._id ??= 1;
  return out;
};

/** Projection without secrets or hidden system fields; dotted paths allowed. */
const safeProjection = (mod, projection) =>
  projection
    .map((p) => String(p).trim())
    .filter((p) => p && !mod.secretKeys.includes(p.split('.')[0]) && !REDACTED_KEYS.has(p.split('.')[0]))
    .join(' ');

/** Replaces ref ids in `rows` with `{ id, label }` for the requested top-level ref fields. */
const populateLabels = async (ctx, mod, rows, names) => {
  const notes = [];
  for (const name of names) {
    const spec = mod.allFields[name];
    if (!spec || (spec.type !== 'ref' && spec.type !== 'refs')) {
      notes.push(`"${name}" is not a reference field of ${mod.name}`);
      continue;
    }
    const ids = rows.flatMap((row) => (Array.isArray(row[name]) ? row[name] : [row[name]])).filter(Boolean);
    const labels = await labelsFor(ctx, spec.ref, ids);
    const pick = (id) => ({ id: String(id), label: labels.get(String(id)) ?? String(id) });
    for (const row of rows) {
      if (row[name] == null) continue;
      row[name] = Array.isArray(row[name]) ? row[name].map(pick) : pick(row[name]);
    }
  }
  return notes;
};

/** Columns for render_table: the module's list view first, then whatever else the rows carry. */
const columnsFor = (mod, rows) => {
  const keys = new Set(rows.flatMap((r) => Object.keys(r)));
  const ordered = [...mod.list.filter((k) => keys.has(k)), ...[...keys].filter((k) => !mod.list.includes(k))];
  return ordered
    .filter((k) => k !== '_id' && k !== 'companyId' && k !== 'deleted')
    .map((key) => ({
      key,
      label: mod.allFields[key]?.label ?? humanize(key),
      unit: mod.allFields[key]?.unit,
    }));
};

const describeField = (meta) => {
  const out = { key: meta.key, type: meta.type, label: meta.label };
  if (meta.required) out.required = true;
  if (meta.readOnly) out.readOnly = true;
  if (meta.values) out.values = meta.values;
  if (meta.ref) out.ref = meta.ref;
  if (meta.unit) out.unit = meta.unit;
  if (meta.help) out.help = meta.help;
  if (meta.fields) out.fields = meta.fields.filter((f) => !f.hidden && !f.secret).map(describeField);
  if (meta.of) out.of = meta.of.type;
  return out;
};

const exampleFilters = (mod) => {
  const examples = [];
  const entries = Object.entries(mod.fields).filter(([, s]) => !s.hidden && !s.secret);
  const enumField = entries.find(([, s]) => s.type === 'enum');
  if (enumField) examples.push({ [enumField[0]]: enumField[1].values[0] });
  const dateField = entries.find(([, s]) => s.type === 'date') ?? ['createdAt'];
  examples.push({ [dateField[0]]: { $gte: '2026-10-01T00:00:00Z', $lt: '2026-11-01T00:00:00Z' } });
  const refField = entries.find(([, s]) => s.type === 'ref');
  if (refField) examples.push({ [refField[0]]: '<id from resolve>' });
  if (mod.search.length) examples.push({ [mod.search[0]]: { $regex: 'bearing', $options: 'i' } });
  return examples;
};

export const mongoReadTools = [
  {
    name: 'module_schema',
    group: 'core',
    description:
      'Fields, enums, references and date fields of one module, with example filters. Call it before the first mongo_* query on a module in this conversation. Example: { module: "workorders" }.',
    schema: z.object({ module: z.string().min(1).max(60) }),
    run: async (ctx, { module }) => {
      const mod = readableModule(ctx, module);
      const fields = toMeta(mod.fields)
        .filter((f) => !f.hidden && !f.secret)
        .map(describeField);
      fields.push(
        { key: 'createdAt', type: 'date', label: 'Created' },
        { key: 'updatedAt', type: 'date', label: 'Updated' },
      );
      const schema = {
        module: mod.name,
        label: mod.label,
        description: mod.description,
        notes: mod.agentNotes,
        codeField: mod.codeField,
        titleField: mod.titleField,
        dateField: mod.dateField,
        plantScoped: mod.plantScoped,
        agentWritable: mod.agentWritable,
        fields,
        exampleFilters: exampleFilters(mod),
      };
      return { forModel: schema, summary: `${mod.label}: ${fields.length} fields`, data: schema };
    },
  },
  {
    name: 'mongo_find',
    group: 'core',
    description:
      'Reads records of a module with a Mongo filter (already scoped to the company and the user plant; never add companyId). Ids are 24-hex strings, dates ISO strings. populate replaces reference fields with { id, label }. Prefer a summary tool when one fits. Example: { module: "workorders", filter: { workStatus: { $nin: ["Completed", "Closed"] }, priority: "High" }, sort: "-dueDate", populate: ["asset", "people"], limit: 50 }.',
    schema: z.object({
      module: z.string().min(1).max(60),
      filter: freeForm().optional(),
      projection: z.array(z.string().max(80)).max(40).optional().describe('Fields to return'),
      sort: z.string().max(120).optional().describe('e.g. "-dueDate" or "priority,-createdAt"'),
      limit: z.int().min(1).max(MAX_ROWS).optional(),
      populate: z.array(z.string().max(60)).max(10).optional().describe('Reference fields to label'),
    }),
    run: async (ctx, { module, filter, projection, sort, limit, populate }) => {
      const mod = readableModule(ctx, module);
      const where = { $and: [sanitizeFilter(filter ?? {}, { mod, ctx }), scopeFilter(ctx, mod)] };
      const query = mod.Model.find(where)
        .sort(parseSort(mod, sort))
        .limit(Math.min(limit ?? DEFAULT_LIMIT, MAX_ROWS))
        .lean()
        .maxTimeMS(MAX_TIME_MS);
      const select = projection?.length ? safeProjection(mod, projection) : '';
      if (select) query.select(select);
      const rows = (await query).map((row) => {
        for (const key of mod.secretKeys) delete row[key];
        return row;
      });
      const notes = populate?.length ? await populateLabels(ctx, mod, rows, populate) : [];
      return rowsResult({
        rows,
        what: mod.label.toLowerCase(),
        columns: columnsFor(mod, rows),
        extra: { module: mod.name, ...(notes.length ? { notes } : {}) },
      });
    },
  },
  {
    name: 'mongo_count',
    group: 'core',
    description:
      'Counts records of a module matching a filter (same filter rules as mongo_find). Example: { module: "workorders", filter: { workStatus: "Open" } }.',
    schema: z.object({ module: z.string().min(1).max(60), filter: freeForm().optional() }),
    run: async (ctx, { module, filter }) => {
      const mod = readableModule(ctx, module);
      const where = { $and: [sanitizeFilter(filter ?? {}, { mod, ctx }), scopeFilter(ctx, mod)] };
      const count = await mod.Model.countDocuments(where).maxTimeMS(MAX_TIME_MS);
      return {
        forModel: { module: mod.name, count },
        summary: `${count} ${mod.label.toLowerCase()}`,
        rowCount: count,
      };
    },
  },
  {
    name: 'mongo_distinct',
    group: 'core',
    description:
      'Distinct values of one field of a module, optionally filtered. Good for "which categories / reasons / statuses exist". Example: { module: "downtimes", field: "reason" }.',
    schema: z.object({
      module: z.string().min(1).max(60),
      field: z.string().min(1).max(80),
      filter: freeForm().optional(),
    }),
    run: async (ctx, { module, field, filter }) => {
      const mod = readableModule(ctx, module);
      const spec = fieldSpec(mod, field);
      if (!spec || spec.secret || REDACTED_KEYS.has(field.split('.')[0])) {
        throw badRequest(`"${field}" is not a field of ${mod.name}`);
      }
      const where = { $and: [sanitizeFilter(filter ?? {}, { mod, ctx }), scopeFilter(ctx, mod)] };
      const values = redact(await mod.Model.distinct(field, where).maxTimeMS(MAX_TIME_MS)).slice(0, MAX_ROWS);
      return {
        forModel: { module: mod.name, field, values: compact(values) },
        summary: `${values.length} distinct ${field}`,
        rowCount: values.length,
        data: { rows: values.map((value) => ({ [field]: value })) },
      };
    },
  },
  {
    name: 'mongo_aggregate',
    group: 'core',
    description:
      'Runs an aggregation pipeline on a module. Allowed stages: $match $project $group $sort $limit $skip $unwind $lookup (from/localField/foreignField/as only) $addFields $set $count $facet $sortByCount $bucket $replaceRoot. The company scope is added for you; do not add companyId. Example: { module: "workorders", pipeline: [{ $match: { workStatus: "Open" } }, { $group: { _id: "$priority", count: { $sum: 1 } } }, { $sort: { count: -1 } }] }.',
    schema: z.object({
      module: z.string().min(1).max(60),
      pipeline: z.array(freeForm()).min(1).max(20),
    }),
    run: async (ctx, { module, pipeline }) => {
      const mod = readableModule(ctx, module);
      const safe = sanitizePipeline(pipeline, { mod, ctx });
      const rows = redact(await mod.Model.aggregate(safe.pipeline).option(safe.options).exec());
      return rowsResult({ rows, what: 'rows', extra: { module: mod.name } });
    },
  },
];
