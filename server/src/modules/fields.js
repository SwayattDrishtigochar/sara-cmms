import mongoose from 'mongoose';
import { z } from 'zod';
import { humanize } from '../lib/format.js';

/**
 * Field DSL shared by every module. One spec produces:
 *   - the Mongoose schema         (toMongooseFields)
 *   - strict zod create/update    (toZodObject)
 *   - UI metadata for the pages   (toMeta)
 *   - a digest line for the agent (digestFields)
 *
 * Types: string | text | number | boolean | date | enum | ref | refs | tags | object | array | mixed
 *   enum   { values: [...] }
 *   ref    { ref: '<module name>', idType?: 'string' }      refs { ref }
 *   object { fields: { ... } }
 *   array  { of: { type: 'string' } }  (primitive rows)  or  { of: { field: spec, ... } } (object rows)
 * Options: required, default, readOnly (server-managed), hidden, secret, unit, label, help, min, max,
 *          pattern, suggestions, index, unique, lowercase.
 */

const { Schema } = mongoose;
export const OBJECT_ID_PATTERN = /^[a-f0-9]{24}$/i;

/** `of` is a primitive spec when it has a string `type`; otherwise it is a map of row fields. */
export const isPrimitiveArray = (spec) => typeof spec.of?.type === 'string';

const blankToUndefined = (v) => (v === '' ? undefined : v);
const toNumber = (v) =>
  typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v)) ? Number(v) : v;
const toBoolean = (v) => (v === 'true' ? true : v === 'false' ? false : v);

// ── Mongoose ────────────────────────────────────────────────────────────────

const mongoosePath = (spec, modelOf) => {
  const path = {};
  switch (spec.type) {
    case 'string':
    case 'text':
      path.type = String;
      path.trim = true;
      break;
    case 'number':
      path.type = Number;
      break;
    case 'boolean':
      path.type = Boolean;
      break;
    case 'date':
      path.type = Date;
      break;
    case 'enum':
      path.type = String;
      path.enum = [...spec.values, null];
      break;
    case 'ref':
      path.type = spec.idType === 'string' ? String : Schema.Types.ObjectId;
      path.ref = modelOf(spec.ref);
      path.default = null;
      break;
    case 'refs':
      return {
        type: [{ type: spec.idType === 'string' ? String : Schema.Types.ObjectId, ref: modelOf(spec.ref) }],
      };
    case 'tags':
      return { type: [String] };
    case 'object':
      return {
        type: new Schema(toMongooseFields(spec.fields, modelOf), { _id: false }),
        default: () => ({}),
      };
    case 'array':
      if (isPrimitiveArray(spec)) return { type: [mongoosePath(spec.of, modelOf)] };
      return { type: [new Schema(toMongooseFields(spec.of, modelOf), { _id: spec.rowIds !== false })] };
    case 'mixed':
      path.type = Schema.Types.Mixed;
      break;
    default:
      throw new Error(`Unknown field type "${spec.type}"`);
  }
  if (spec.required) path.required = true;
  if (spec.default !== undefined) path.default = spec.default;
  if (spec.secret) path.select = false;
  if (spec.index) path.index = true;
  if (spec.unique) path.unique = true;
  if (spec.lowercase) path.lowercase = true;
  // Raw writers (the simulator) bypass zod, so the format is a schema rule too (validate-db checks it).
  if (spec.pattern && spec.type === 'string') path.match = [new RegExp(spec.pattern), spec.patternMessage];
  if (spec.min !== undefined && spec.type === 'number') path.min = spec.min;
  if (spec.max !== undefined && spec.type === 'number') path.max = spec.max;
  return path;
};

export const toMongooseFields = (fields, modelOf) =>
  Object.fromEntries(Object.entries(fields).map(([key, spec]) => [key, mongoosePath(spec, modelOf)]));

// ── zod ─────────────────────────────────────────────────────────────────────

const objectIdString = z.string().regex(OBJECT_ID_PATTERN, 'must be a 24-character id');

const zodFor = (spec, opts) => {
  switch (spec.type) {
    case 'string': {
      let s = z
        .string()
        .trim()
        .max(spec.max ?? 500);
      if (spec.pattern)
        s = s.regex(new RegExp(spec.pattern), spec.patternMessage ?? `must match ${spec.pattern}`);
      if (spec.email) s = s.email();
      return s;
    }
    case 'text':
      return z
        .string()
        .trim()
        .max(spec.max ?? 20000);
    case 'number': {
      let s = z.number({ error: 'must be a number' });
      if (spec.min !== undefined) s = s.min(spec.min);
      if (spec.max !== undefined) s = s.max(spec.max);
      if (spec.int) s = s.int();
      return z.preprocess(toNumber, s);
    }
    case 'boolean':
      return z.preprocess(toBoolean, z.boolean());
    case 'date':
      return z.preprocess(blankToUndefined, z.coerce.date({ error: 'must be a date (ISO 8601)' }));
    case 'enum':
      return z.enum(spec.values);
    case 'ref':
      return spec.idType === 'string' ? z.string().min(1).max(200) : objectIdString;
    case 'refs':
      return z
        .array(spec.idType === 'string' ? z.string().min(1).max(200) : objectIdString)
        .max(spec.maxItems ?? 500);
    case 'tags':
      return z.array(z.string().trim().min(1).max(120)).max(spec.maxItems ?? 100);
    case 'object':
      return toZodObject(spec.fields, { ...opts, partial: false });
    case 'array': {
      if (isPrimitiveArray(spec)) return z.array(zodFor(spec.of, opts)).max(spec.maxItems ?? 500);
      // Existing rows keep their _id (e.g. plant shifts that users reference) when edited.
      let row = toZodObject(spec.of, { ...opts, partial: false });
      if (spec.rowIds !== false) row = row.extend({ _id: objectIdString.optional() });
      return z.array(row).max(spec.maxItems ?? 500);
    }
    case 'mixed':
      return z.any();
    default:
      throw new Error(`Unknown field type "${spec.type}"`);
  }
};

/**
 * Strict object schema for writes. Read-only fields are left out (the server sets them),
 * secret fields only when `allowSecret`. `partial` makes every field optional (updates).
 * Optional fields without a default accept `null`, which means "clear this field".
 */
export const toZodObject = (fields, { partial = false, allowSecret = true } = {}) => {
  const shape = {};
  for (const [key, spec] of Object.entries(fields)) {
    if (spec.readOnly) continue;
    if (spec.secret && !allowSecret) continue;
    let s = zodFor(spec, { allowSecret });
    if (!spec.required && spec.default === undefined) s = s.nullable();
    if (partial || !spec.required || spec.default !== undefined) s = s.optional();
    shape[key] = s;
  }
  return z.object(shape).strict();
};

// ── UI metadata ─────────────────────────────────────────────────────────────

const metaFor = (key, spec) => {
  const meta = {
    key,
    type: spec.type,
    label: spec.label ?? humanize(key),
  };
  for (const opt of [
    'required',
    'readOnly',
    'hidden',
    'secret',
    'unit',
    'help',
    'ref',
    'idType',
    'suggestions',
  ]) {
    if (spec[opt] !== undefined && spec[opt] !== false) meta[opt] = spec[opt];
  }
  if (spec.values) meta.values = spec.values;
  if (spec.default !== undefined && typeof spec.default !== 'function') meta.default = spec.default;
  if (spec.type === 'object') meta.fields = toMeta(spec.fields);
  if (spec.type === 'array') {
    if (isPrimitiveArray(spec)) meta.of = metaFor('item', spec.of);
    else meta.fields = toMeta(spec.of);
  }
  return meta;
};

export const toMeta = (fields) => Object.entries(fields).map(([key, spec]) => metaFor(key, spec));

// ── Agent digest ────────────────────────────────────────────────────────────

const digestField = (key, spec) => {
  if (spec.hidden || spec.secret) return null;
  const mark = spec.required && !spec.readOnly ? '!' : '';
  const ro = spec.readOnly ? '(ro)' : '';
  switch (spec.type) {
    case 'enum':
      return `${key}${mark}[${spec.values.join('|')}]${ro}`;
    case 'ref':
      return `${key}${mark}→${spec.ref}${ro}`;
    case 'refs':
      return `${key}${mark}→${spec.ref}[]${ro}`;
    case 'date':
      return `${key}${mark}(date)${ro}`;
    case 'number':
      return `${key}${mark}(num${spec.unit ? ` ${spec.unit}` : ''})${ro}`;
    case 'boolean':
      return `${key}${mark}(bool)${ro}`;
    case 'tags':
      return `${key}${mark}[str]${ro}`;
    case 'object':
      return `${key}{${digestFields(spec.fields, 8)}}${ro}`;
    case 'array':
      return isPrimitiveArray(spec)
        ? `${key}${mark}[${spec.of.values ? spec.of.values.join('|') : spec.of.type}]${ro}`
        : `${key}[{${digestFields(spec.of, 8)}}]${ro}`;
    default:
      return `${key}${mark}${ro}`;
  }
};

/** Compact field list, e.g. `name!, asset→assets, priority[Low|Medium|High], dueDate(date)`. */
export const digestFields = (fields, limit = 40) =>
  Object.entries(fields)
    .map(([key, spec]) => digestField(key, spec))
    .filter(Boolean)
    .slice(0, limit)
    .join(', ');

/** Walks a spec and yields every ref path: { path: ['spareParts', '*', 'sparePart'], spec }. */
export function* refPaths(fields, prefix = []) {
  for (const [key, spec] of Object.entries(fields)) {
    if (spec.type === 'ref' || spec.type === 'refs') yield { path: [...prefix, key], spec };
    else if (spec.type === 'object') yield* refPaths(spec.fields, [...prefix, key]);
    else if (spec.type === 'array' && !isPrimitiveArray(spec))
      yield* refPaths(spec.of, [...prefix, key, '*']);
  }
}

/** Reads every value at a ref path ('*' fans out over arrays). */
export const valuesAt = (doc, path) => {
  let level = [doc];
  for (const key of path) {
    const next = [];
    for (const v of level) {
      if (v == null) continue;
      if (key === '*') {
        if (Array.isArray(v)) next.push(...v);
      } else next.push(v[key]);
    }
    level = next;
  }
  return level.flat().filter((v) => v != null && v !== '');
};
