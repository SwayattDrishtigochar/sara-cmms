import { env } from '../../config/env.js';
import { badRequest } from '../../lib/errors.js';
import { scopeFilter } from '../../modules/records.js';
import { getModule, hasModule } from '../../modules/registry.js';
import { checkKey, checkRegex, isPlainObject, sanitizeFilter } from './mongoFilter.js';

/** Aggregation guard (phase 4 §3): stage allow-list, scoped first stage, safe joins, bounded output. */
export const ALLOWED_STAGES = new Set([
  '$match',
  '$project',
  '$group',
  '$sort',
  '$limit',
  '$skip',
  '$unwind',
  '$lookup',
  '$addFields',
  '$set',
  '$count',
  '$facet',
  '$sortByCount',
  '$bucket',
  '$replaceRoot',
]);
export const BANNED_OPERATORS = new Set([
  '$out',
  '$merge',
  '$function',
  '$accumulator',
  '$where',
  '$unionWith',
  '$graphLookup',
  '$collStats',
  '$indexStats',
  '$currentOp',
  '$planCacheStats',
]);
const GROUPING = new Set(['$group', '$bucket', '$sortByCount', '$facet']);
export const MAX_GROUPED = 1000;
const MAX_EXPR_DEPTH = 16;
const LOOKUP_KEYS = ['from', 'localField', 'foreignField', 'as'];
const REGEX_OPERATORS = new Set(['$regexMatch', '$regexFind', '$regexFindAll']);

/** Rejects banned operators and prototype keys anywhere inside an expression. */
const assertSafeExpression = (value, depth = 0) => {
  if (depth > MAX_EXPR_DEPTH) throw badRequest('The pipeline is nested too deeply');
  if (Array.isArray(value)) {
    for (const v of value) assertSafeExpression(v, depth + 1);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  if (!isPlainObject(value)) throw badRequest('Pipeline stages must be plain JSON');
  for (const [key, v] of Object.entries(value)) {
    checkKey(key);
    if (BANNED_OPERATORS.has(key)) throw badRequest(`"${key}" is not allowed`);
    if (REGEX_OPERATORS.has(key)) checkRegex(v?.regex, v?.options ?? '');
    assertSafeExpression(v, depth + 1);
  }
};

const clampInt = (value, min, max, what) => {
  if (!Number.isInteger(value) || value < min)
    throw badRequest(`${what} must be an integer of at least ${min}`);
  return Math.min(value, max);
};

/** Only the localField/foreignField form; joins keep the tenant/plant/deleted scope and never carry secrets. */
const sanitizeLookup = (value, { ctx }) => {
  if (!isPlainObject(value)) throw badRequest('$lookup needs an object');
  const extra = Object.keys(value).filter((k) => !LOOKUP_KEYS.includes(k));
  if (extra.length) {
    throw badRequest(`$lookup only supports from, localField, foreignField, as (not ${extra.join(', ')})`);
  }
  for (const key of LOOKUP_KEYS) {
    if (typeof value[key] !== 'string' || !value[key]) throw badRequest(`$lookup needs a string "${key}"`);
    checkKey(value[key]);
  }
  if (!hasModule(value.from) || !ctx.modules.includes(value.from)) {
    throw badRequest(`Can't join "${value.from}": not a module of this company`);
  }
  const target = getModule(value.from);
  const pipeline = [{ $match: scopeFilter(ctx, target) }];
  if (target.secretKeys.length) {
    pipeline.push({ $project: Object.fromEntries(target.secretKeys.map((k) => [k, 0])) });
  }
  return { ...value, pipeline };
};

const sanitizeStages = (stages, s) =>
  stages.map((stage, i) => {
    if (!isPlainObject(stage) || Object.keys(stage).length !== 1) {
      throw badRequest(`Stage ${i + 1} must be an object with exactly one $stage key`);
    }
    const [key, value] = Object.entries(stage)[0];
    checkKey(key);
    if (BANNED_OPERATORS.has(key)) throw badRequest(`"${key}" is not allowed`);
    if (!ALLOWED_STAGES.has(key)) throw badRequest(`Unsupported stage "${key}"`);
    switch (key) {
      case '$match':
        return { $match: sanitizeFilter(value, s) };
      case '$facet': {
        if (!isPlainObject(value) || !Object.keys(value).length) {
          throw badRequest('$facet needs named sub-pipelines');
        }
        return {
          $facet: Object.fromEntries(
            Object.entries(value).map(([name, sub]) => {
              checkKey(name);
              if (!Array.isArray(sub)) throw badRequest(`$facet "${name}" must be an array of stages`);
              return [name, sanitizeStages(sub, { ...s, depth: s.depth + 1 })];
            }),
          ),
        };
      }
      case '$lookup':
        return { $lookup: sanitizeLookup(value, s) };
      case '$limit':
        return { $limit: clampInt(value, 1, MAX_GROUPED, '$limit') };
      case '$skip':
        return { $skip: clampInt(value, 0, 1_000_000, '$skip') };
      default:
        assertSafeExpression(value);
        return { [key]: value };
    }
  });

/**
 * Safe copy of a model-written pipeline for `mod`, with the tenant/plant scope forced first,
 * secrets projected away, joins rewritten and the output capped. Returns `{ pipeline, options }`.
 */
export const sanitizePipeline = (pipeline, { mod, ctx }) => {
  if (!Array.isArray(pipeline)) throw badRequest('pipeline must be an array of stages');
  const stages = sanitizeStages(pipeline, { mod, ctx, depth: 0 });
  const out = [{ $match: scopeFilter(ctx, mod) }];
  if (mod.secretKeys.length) out.push({ $project: Object.fromEntries(mod.secretKeys.map((k) => [k, 0])) });
  out.push(...stages);
  const lastKey = stages.length ? Object.keys(stages.at(-1))[0] : null;
  if (lastKey !== '$count' && lastKey !== '$limit') {
    const grouped = stages.some((stage) => GROUPING.has(Object.keys(stage)[0]));
    out.push({ $limit: grouped ? MAX_GROUPED : env.MAX_ROWS });
  }
  return { pipeline: out, options: { allowDiskUse: false, maxTimeMS: 15_000 } };
};
