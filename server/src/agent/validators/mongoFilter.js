import mongoose from 'mongoose';
import { badRequest } from '../../lib/errors.js';
import { isPrimitiveArray, OBJECT_ID_PATTERN } from '../../modules/fields.js';

const { ObjectId } = mongoose.Types;

/**
 * The model writes Mongo filters; this is the boundary that makes them safe (phase 4 §3).
 * Allow-listed operators only, no code execution, tenant keys dropped at any depth, regexes bounded,
 * values cast from the registry metadata of the module.
 */
export const ALLOWED_OPERATORS = new Set([
  '$eq',
  '$ne',
  '$gt',
  '$gte',
  '$lt',
  '$lte',
  '$in',
  '$nin',
  '$exists',
  '$regex',
  '$options',
  '$and',
  '$or',
  '$nor',
  '$not',
  '$elemMatch',
  '$size',
  '$all',
  '$type',
]);
const BANNED = /^\$(where|function|accumulator|expr|jsonSchema|text|near)/;
export const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const TENANT_KEYS = new Set(['companyId', 'company']);
export const MAX_DEPTH = 6;
const MAX_REGEX = 200;
/** A quantified group that is quantified again ((a+)+, (\d*){2,}) or stacked quantifiers (a++): exponential backtracking. */
const NESTED_QUANTIFIER =
  /\((?:[^()\\]|\\.)*(?:[+*]|\{\d*,?\d*\})(?:[^()\\]|\\.)*\)\??(?:[+*]|\{\d*,?\d*\})|[+*}][+*]/;
const ISO_LIKE = /^\d{4}-\d{2}-\d{2}/;
const SYSTEM_DATES = new Set(['createdAt', 'updatedAt', 'deletedAt']);

export const isPlainObject = (v) =>
  v !== null &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);

export const checkKey = (key) => {
  if (DANGEROUS_KEYS.has(key)) throw badRequest(`"${key}" is not allowed in a query`);
  if (key.includes('\0')) throw badRequest('Keys may not contain NUL characters');
};

/** Field spec of a (dotted) path from the module registry, or null when unknown. */
export const fieldSpec = (mod, path) => {
  const segments = String(path).split('.');
  if (segments.length === 1 && segments[0] === '_id')
    return { type: 'ref', idType: mod.idType ?? 'objectId' };
  if (segments.length === 1 && SYSTEM_DATES.has(segments[0])) return { type: 'date' };
  let fields = mod.allFields;
  let spec = null;
  for (const segment of segments) {
    if (/^\d+$/.test(segment) || segment === '$' || segment === '$[]') continue; // array index
    if (!fields) return null;
    spec = fields[segment];
    if (!spec) return null;
    fields =
      spec.type === 'object'
        ? spec.fields
        : spec.type === 'array' && !isPrimitiveArray(spec)
          ? spec.of
          : null;
  }
  return spec;
};

/** Casts a primitive from the model to what the field stores (ids, dates, numbers, booleans). */
export const castValue = (spec, value) => {
  if (value == null || !spec || typeof value === 'object') return value;
  const type = spec.type === 'array' && isPrimitiveArray(spec) ? spec.of.type : spec.type;
  if ((type === 'ref' || type === 'refs') && spec.idType !== 'string') {
    return typeof value === 'string' && OBJECT_ID_PATTERN.test(value) ? new ObjectId(value) : value;
  }
  if (type === 'date' && typeof value === 'string' && ISO_LIKE.test(value)) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date;
  }
  if (type === 'number' && typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value))) {
    return Number(value);
  }
  if (type === 'boolean' && (value === 'true' || value === 'false')) return value === 'true';
  return value;
};

const primitive = (value, spec, path) => {
  if (value !== null && typeof value === 'object') {
    throw badRequest(`"${path}" expects a plain value here, not an object`);
  }
  return castValue(spec, value);
};

/** Bounds a regex the model wrote: length, no nested quantifiers, imsx options only, compiles. */
export const checkRegex = (pattern, options) => {
  if (typeof pattern !== 'string') throw badRequest('$regex must be a string');
  if (pattern.length > MAX_REGEX) throw badRequest(`$regex must be ${MAX_REGEX} characters or less`);
  if (NESTED_QUANTIFIER.test(pattern))
    throw badRequest('$regex uses nested quantifiers, which are not allowed');
  if (typeof options !== 'string' || /[^imsx]/.test(options))
    throw badRequest('$options may only use i, m, s, x');
  try {
    new RegExp(pattern, options); // compiled once here; the database compiles it again
  } catch {
    throw badRequest('$regex is not a valid regular expression');
  }
};

const isTenantKey = (mod, key) =>
  TENANT_KEYS.has(key) || (mod.tenantField !== '_id' && key === mod.tenantField);

/** The spec an array element is matched against ($elemMatch, $all, $in on arrays). */
const elementOf = (spec) =>
  spec?.type === 'array' ? (isPrimitiveArray(spec) ? spec.of : { type: 'object', fields: spec.of }) : spec;

const sanitizeOperators = (obj, spec, s) => {
  if (s.depth > MAX_DEPTH) throw badRequest(`The filter is nested too deeply (max ${MAX_DEPTH} levels)`);
  const out = {};
  for (const [op, value] of Object.entries(obj)) {
    checkKey(op);
    if (!op.startsWith('$')) throw badRequest(`Can't mix fields and operators under "${s.path}"`);
    if (!ALLOWED_OPERATORS.has(op)) {
      throw badRequest(
        BANNED.test(op) ? `"${op}" is not allowed` : `Unknown operator "${op}" on "${s.path}"`,
      );
    }
    switch (op) {
      case '$and':
      case '$or':
      case '$nor':
        throw badRequest(`"${op}" belongs at the top level of a filter, not under "${s.path}"`);
      case '$in':
      case '$nin':
      case '$all': {
        if (!Array.isArray(value)) throw badRequest(`${op} on "${s.path}" needs an array`);
        out[op] = value.map((v) => primitive(v, elementOf(spec), s.path));
        break;
      }
      case '$exists':
        out[op] = value === true || value === 'true';
        break;
      case '$size':
        if (!Number.isInteger(value) || value < 0) throw badRequest('$size needs a non-negative integer');
        out[op] = value;
        break;
      case '$type':
        if (typeof value !== 'string' && typeof value !== 'number') throw badRequest('$type needs a string');
        out[op] = value;
        break;
      case '$regex':
      case '$options':
        out[op] = value;
        break;
      case '$not':
        if (!isPlainObject(value)) throw badRequest('$not needs an object of operators');
        out[op] = sanitizeOperators(value, spec, { ...s, depth: s.depth + 1 });
        break;
      case '$elemMatch': {
        if (!isPlainObject(value)) throw badRequest('$elemMatch needs an object');
        const element = elementOf(spec);
        const operatorForm = Object.keys(value).some((k) => k.startsWith('$'));
        out[op] = operatorForm
          ? sanitizeOperators(value, element, { ...s, depth: s.depth + 1 })
          : sanitizeObject(value, {
              ...s,
              depth: s.depth + 1,
              path: '',
              mod: { ...s.mod, allFields: element?.fields ?? {} },
            });
        break;
      }
      default:
        out[op] = primitive(value, spec, s.path);
    }
  }
  if ('$regex' in out) {
    out.$options ??= 'i';
    checkRegex(out.$regex, out.$options);
  } else if ('$options' in out) throw badRequest('$options needs a $regex');
  return out;
};

const sanitizeValue = (value, spec, s) => {
  if (Array.isArray(value)) return value.map((v) => primitive(v, elementOf(spec), s.path));
  if (isPlainObject(value)) {
    if (Object.keys(value).some((k) => k.startsWith('$'))) return sanitizeOperators(value, spec, s);
    return sanitizeObject(value, s); // nested document equality, e.g. { trackProcess: { openedAt } }
  }
  return primitive(value, spec, s.path);
};

const sanitizeObject = (filter, s) => {
  if (!isPlainObject(filter)) throw badRequest('A filter must be a plain object');
  if (s.depth > MAX_DEPTH) throw badRequest(`The filter is nested too deeply (max ${MAX_DEPTH} levels)`);
  const out = {};
  for (const [key, value] of Object.entries(filter)) {
    checkKey(key);
    if (key.startsWith('$')) {
      if (key === '$and' || key === '$or' || key === '$nor') {
        if (!Array.isArray(value) || !value.length)
          throw badRequest(`${key} needs a non-empty array of filters`);
        out[key] = value.map((f) => sanitizeObject(f, { ...s, depth: s.depth + 1 }));
        continue;
      }
      throw badRequest(
        ALLOWED_OPERATORS.has(key) ? `"${key}" must sit under a field name` : `"${key}" is not allowed`,
      );
    }
    if (isTenantKey(s.mod, key)) continue; // the tenant comes from the session, never from the model
    const path = s.path ? `${s.path}.${key}` : key;
    const spec = fieldSpec(s.mod, path);
    if (spec?.secret) throw badRequest(`Can't filter by "${path}"`);
    out[key] = sanitizeValue(value, spec, { ...s, path, depth: s.depth + 1 });
  }
  return out;
};

/**
 * Returns a safe copy of a model-written filter for `mod`. Never mutates the input; the caller still
 * ANDs `records.scopeFilter` onto the result.
 */
export const sanitizeFilter = (filter, { mod, ctx }) =>
  sanitizeObject(filter ?? {}, { mod, ctx, depth: 0, path: '' });
