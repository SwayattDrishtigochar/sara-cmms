import mongoose from 'mongoose';
import { nextSeq } from '../db/models/Counter.js';
import { badRequest, conflict, forbidden, notFound, parseOrThrow } from '../lib/errors.js';
import { plantAudience, publish } from '../lib/events.js';
import { escapeRegex } from '../lib/format.js';
import { isPrimitiveArray, OBJECT_ID_PATTERN, refPaths, valuesAt } from './fields.js';
import { assertCan } from './permissions.js';
import { getModule, labelOf } from './registry.js';

/**
 * The only path to module data, for REST pages, agent writes (after Confirm), planners,
 * generators and the KPI runner. It owns tenancy, the plant rule, ref ownership, counters,
 * permissions, hooks and soft delete.
 *
 * ctx: { userId, companyId, plantLock, role, permissions } (see context/buildUserContext.js).
 * opts.source: 'rest' | 'agent' | 'system'. Agent writes use schemas without secret fields and
 * only reach modules with agentWritable.
 */

const { ObjectId } = mongoose.Types;
const MAX_PAGE = 100;

export { getModule };

const asObjectId = (value) => {
  if (value instanceof ObjectId) return value;
  if (typeof value === 'string' && OBJECT_ID_PATTERN.test(value)) return new ObjectId(value);
  return null;
};

/** Record id → the type stored in `_id` (ObjectId, or string for bins). Unknown shapes → 404. */
const castId = (mod, id) => {
  if (mod.idType === 'string') return String(id);
  const oid = asObjectId(id);
  if (!oid) throw notFound(`${mod.singular ?? mod.label} not found`);
  return oid;
};

/** Tenant + plant + not-deleted filter. Always merged last so callers can't widen it. */
export const scopeFilter = (ctx, mod, { includeDeleted = false } = {}) => {
  const filter = { [mod.tenantField]: ctx.companyId };
  if (mod.softDelete && !includeDeleted) filter.deleted = { $ne: true };
  if (mod.plantScoped && ctx.plantLock) {
    // sharedWhenNoPlant: a record without a plant is company-wide, so plant-locked users see it too
    filter.plantId = mod.sharedWhenNoPlant ? { $in: [ctx.plantLock, null] } : ctx.plantLock;
  }
  return filter;
};

const assertAgentWritable = (mod, opts) => {
  if (opts.source === 'agent' && !mod.agentWritable) {
    throw forbidden(`${mod.label} can't be changed from chat; use the ${mod.label} page`);
  }
};

const stripNulls = (obj) =>
  Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== null && v !== undefined));

const getPath = (doc, path) => path.split('.').reduce((v, k) => (v == null ? v : v[k]), doc);

/** Record events follow the plant rule: plant-scoped records only reach users who can see that plant. */
const announce = (ctx, mod, doc, change) =>
  publish(
    ctx.companyId,
    'record',
    { module: mod.name, id: String(doc._id), change },
    mod.plantScoped ? plantAudience(doc.plantId) : {},
  );

/** Removes secret fields from a plain document. */
const clean = (mod, doc) => {
  if (!doc) return doc;
  for (const key of mod.secretKeys) delete doc[key];
  return doc;
};

/** Plant rule: plant-locked users always write to their plant; others may pick a plant of their company. */
const applyPlant = async (ctx, mod, doc) => {
  if (!mod.plantScoped) return;
  if (ctx.plantLock) {
    doc.plantId = ctx.plantLock;
    return;
  }
  if (!doc.plantId) {
    for (const key of mod.inheritPlantFrom) {
      const assetId = asObjectId(doc[key]);
      if (!assetId) continue;
      const asset = await getModule('assets')
        .Model.findOne({ _id: assetId, companyId: ctx.companyId })
        .select('plantId')
        .lean();
      if (asset?.plantId) {
        doc.plantId = asset.plantId;
        return;
      }
    }
    return;
  }
  const plant = await getModule('plants')
    .Model.findOne({ _id: doc.plantId, companyId: ctx.companyId, deleted: { $ne: true } })
    .select('_id')
    .lean();
  if (!plant) throw badRequest('That plant does not belong to your company');
};

/** Every ref in `doc` must point at a live record of the same company. */
const checkRefs = async (ctx, mod, doc) => {
  const wanted = new Map(); // target module → Set of ids
  for (const { path, spec } of refPaths(mod.fields)) {
    if (path[0] === 'plantId') continue; // checked by applyPlant
    for (const value of valuesAt(doc, path)) {
      if (!wanted.has(spec.ref)) wanted.set(spec.ref, new Set());
      wanted.get(spec.ref).add(String(value));
    }
  }
  for (const [target, ids] of wanted) {
    const targetMod = getModule(target);
    const list = [...ids];
    const castIds = targetMod.idType === 'string' ? list : list.map((id) => asObjectId(id)).filter(Boolean);
    const filter = { _id: { $in: castIds }, [targetMod.tenantField]: ctx.companyId };
    if (targetMod.softDelete) filter.deleted = { $ne: true };
    const found = await targetMod.Model.find(filter).select('_id').lean();
    if (found.length !== list.length) {
      const have = new Set(found.map((d) => String(d._id)));
      const missing = list.filter((id) => !have.has(id));
      throw badRequest(`Unknown ${targetMod.label.toLowerCase()}: ${missing.join(', ')}`, {
        module: target,
        missing,
      });
    }
  }
};

/** Casts REST/agent list filters `{ field: value | [values] }` to Mongo, top-level known fields only. */
const castListFilter = (mod, filter = {}) => {
  const where = {};
  for (const [key, raw] of Object.entries(filter)) {
    const spec = mod.allFields[key];
    if (!spec || spec.secret || key === mod.tenantField || key === 'deleted') {
      throw badRequest(`Can't filter ${mod.label} by "${key}"`);
    }
    const values = (Array.isArray(raw) ? raw : [raw]).map((v) => {
      if (v !== null && typeof v === 'object') throw badRequest(`Filter "${key}" must be a plain value`);
      switch (spec.type) {
        case 'ref':
        case 'refs':
          return spec.idType === 'string' ? String(v) : (asObjectId(v) ?? badRequestValue(key));
        case 'number':
          return Number.isNaN(Number(v)) ? badRequestValue(key) : Number(v);
        case 'boolean':
          return v === true || v === 'true';
        case 'enum':
          if (!spec.values.includes(v)) throw badRequest(`"${v}" is not a valid ${key}`);
          return v;
        case 'array':
          return isPrimitiveArray(spec) ? String(v) : badRequestValue(key);
        default:
          return String(v);
      }
    });
    where[key] = values.length === 1 ? values[0] : { $in: values };
  }
  return where;
};
const badRequestValue = (key) => {
  throw badRequest(`Invalid value for filter "${key}"`);
};

const parseSort = (mod, sort) => {
  const spec = sort || mod.sort;
  const out = {};
  for (const part of String(spec).split(',')) {
    const key = part.replace(/^-/, '').trim();
    if (!key) continue;
    if (!(key in mod.allFields) && !['createdAt', 'updatedAt', '_id'].includes(key)) {
      throw badRequest(`Can't sort ${mod.label} by "${key}"`);
    }
    out[key] = part.startsWith('-') ? -1 : 1;
  }
  out._id ??= 1;
  return out;
};

/** Fields a populated ref carries: enough to label and link it. */
const populateSelect = (target) =>
  target.name === 'users'
    ? 'firstName lastName email role userTitle'
    : [target.codeField, target.titleField.split('.')[0], ...(target.populateExtra ?? [])]
        .filter(Boolean)
        .join(' ');

/** Populate every ref path (except tenant/system ones) with the target's label fields. */
const populateRefs = (query, mod) => {
  for (const { path, spec } of refPaths(mod.allFields)) {
    if (['companyId', 'updatedBy', 'deletedBy'].includes(path[0])) continue;
    query.populate({
      path: path.filter((p) => p !== '*').join('.'),
      select: populateSelect(getModule(spec.ref)),
    });
  }
  return query;
};

// ── Reads ───────────────────────────────────────────────────────────────────

export const list = async (ctx, name, params = {}) => {
  const mod = getModule(name);
  assertCan(ctx, mod, 'read');
  const { q, filter, sort, from, to, populate = true } = params;
  const page = Math.max(1, Number(params.page) || 1);
  const limit = Math.min(MAX_PAGE, Math.max(1, Number(params.limit) || 25));

  const where = castListFilter(mod, filter);
  if (q && mod.search.length) {
    const rx = { $regex: escapeRegex(String(q).slice(0, 100)), $options: 'i' };
    where.$or = mod.search.map((field) => ({ [field]: rx }));
  }
  if (from || to) {
    const range = {};
    if (from) range.$gte = new Date(from);
    if (to) range.$lt = new Date(to);
    if (Object.values(range).some((d) => Number.isNaN(d.getTime())))
      throw badRequest('from/to must be dates');
    where[mod.dateField] = range;
  }
  Object.assign(where, scopeFilter(ctx, mod));

  const query = mod.Model.find(where)
    .sort(parseSort(mod, sort))
    .skip((page - 1) * limit)
    .limit(limit)
    .lean();
  if (populate) populateRefs(query, mod);
  const [items, total] = await Promise.all([query, mod.Model.countDocuments(where)]);
  return { items: items.map((d) => clean(mod, d)), total, page, limit };
};

export const get = async (ctx, name, id, { populate = true } = {}) => {
  const mod = getModule(name);
  assertCan(ctx, mod, 'read');
  const query = mod.Model.findOne({ _id: castId(mod, id), ...scopeFilter(ctx, mod) }).lean();
  if (populate) populateRefs(query, mod);
  const doc = await query;
  if (!doc) throw notFound(`${mod.singular ?? mod.label} not found`);
  return clean(mod, doc);
};

/** Ref ids → labels, for confirm cards and diffs. */
export const refLabels = async (ctx, mod, doc) => {
  const labels = {};
  for (const { path, spec } of refPaths(mod.fields)) {
    const ids = valuesAt(doc, path).map(String);
    if (!ids.length) continue;
    const target = getModule(spec.ref);
    const castIds = target.idType === 'string' ? ids : ids.map(asObjectId).filter(Boolean);
    const rows = await target.Model.find({
      _id: { $in: castIds },
      [target.tenantField]: ctx.companyId,
    }).lean();
    for (const row of rows) labels[String(row._id)] = labelOf(target, row);
  }
  return labels;
};

// ── Writes ──────────────────────────────────────────────────────────────────

const schemaFor = (mod, kind, opts) => {
  if (opts.source === 'agent') return kind === 'create' ? mod.agentCreateSchema : mod.agentUpdateSchema;
  return kind === 'create' ? mod.createSchema : mod.updateSchema;
};

const bumpScheduleVersion = async (ctx, mod) => {
  if (!mod.planned) return;
  await getModule('companies').Model.updateOne({ _id: ctx.companyId }, { $inc: { scheduleVersion: 1 } });
};

export const create = async (ctx, name, input, opts = {}) => {
  const mod = getModule(name);
  assertCan(ctx, mod, 'create');
  assertAgentWritable(mod, opts);
  if (mod.createRoles && !mod.createRoles.includes(ctx.role))
    throw forbidden(`Only a platform admin can create ${mod.label}`);

  const doc = stripNulls(
    parseOrThrow(schemaFor(mod, 'create', opts), input ?? {}, mod.singular ?? mod.label),
  );
  if (mod.tenantField === 'companyId') doc.companyId = ctx.companyId;
  await applyPlant(ctx, mod, doc);
  await checkRefs(ctx, mod, doc);
  doc.createdBy = ctx.userId;
  doc.updatedBy = ctx.userId;
  if (mod.hooks?.beforeCreate) await mod.hooks.beforeCreate({ ctx, doc, opts, svc: service });
  if (opts.dryRun)
    return { dryRun: true, doc: clean(mod, { ...doc }), labels: await refLabels(ctx, mod, doc) };

  if (opts.stamp) {
    const existing = await mod.Model.findOne({
      proposalId: opts.stamp.proposalId,
      proposalSeq: opts.stamp.seq,
    }).lean();
    if (existing) return clean(mod, existing);
    doc.proposalId = opts.stamp.proposalId;
    doc.proposalSeq = opts.stamp.seq;
  }
  if (mod.counter && !doc[mod.counter.field]) {
    const seq = await nextSeq({
      companyId: ctx.companyId,
      plantId: doc.plantId ?? null,
      type: mod.counter.type,
    });
    doc[mod.counter.field] = `${mod.counter.prefix}${seq}`;
  }

  let created;
  try {
    created = (await mod.Model.create(doc)).toObject();
  } catch (err) {
    if (err.code === 11000) {
      if (opts.stamp) {
        const existing = await mod.Model.findOne({
          proposalId: opts.stamp.proposalId,
          proposalSeq: opts.stamp.seq,
        }).lean();
        if (existing) return clean(mod, existing);
      }
      throw conflict(`That ${mod.singular?.toLowerCase() ?? 'record'} already exists`, err.keyValue);
    }
    if (err.name === 'ValidationError') throw badRequest(err.message);
    throw err;
  }
  clean(mod, created);
  if (mod.hooks?.afterCreate) await mod.hooks.afterCreate({ ctx, doc: created, opts, svc: service });
  await bumpScheduleVersion(ctx, mod);
  announce(ctx, mod, created, 'created');
  return created;
};

/** Field-level diff for confirm cards: [{ field, from, to }]. */
const diffFields = (before, patch) =>
  Object.entries(patch)
    .filter(([key, to]) => JSON.stringify(before[key] ?? null) !== JSON.stringify(to ?? null))
    .map(([field, to]) => ({ field, from: before[field] ?? null, to: to ?? null }));

export const update = async (ctx, name, id, input, opts = {}) => {
  const mod = getModule(name);
  assertCan(ctx, mod, 'update');
  assertAgentWritable(mod, opts);
  const patch = parseOrThrow(schemaFor(mod, 'update', opts), input ?? {}, mod.singular ?? mod.label);
  if (!Object.keys(patch).length) throw badRequest('Nothing to update');

  const where = { _id: castId(mod, id), ...scopeFilter(ctx, mod) };
  const existing = await mod.Model.findOne(where).lean();
  if (!existing) throw notFound(`${mod.singular ?? mod.label} not found`);

  if ('plantId' in patch) await applyPlant(ctx, mod, patch);
  await checkRefs(ctx, mod, stripNulls(patch));
  if (mod.hooks?.beforeUpdate) await mod.hooks.beforeUpdate({ ctx, existing, patch, opts, svc: service });
  const changes = diffFields(existing, patch);
  if (opts.dryRun) {
    return {
      dryRun: true,
      before: clean(mod, { ...existing }),
      changes: changes.filter((c) => !mod.secretKeys.includes(c.field)),
      labels: await refLabels(ctx, mod, { ...existing, ...stripNulls(patch) }),
    };
  }

  const $set = { updatedBy: ctx.userId };
  const $unset = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) $unset[key] = '';
    else $set[key] = value;
  }
  const after = await mod.Model.findOneAndUpdate(
    where,
    { $set, ...(Object.keys($unset).length ? { $unset } : {}) },
    { new: true, runValidators: true },
  ).lean();
  if (!after) throw notFound(`${mod.singular ?? mod.label} not found`);
  if (mod.hooks?.afterUpdate)
    await mod.hooks.afterUpdate({ ctx, before: existing, after, opts, svc: service });
  await bumpScheduleVersion(ctx, mod);
  announce(ctx, mod, after, 'updated');
  return {
    before: clean(mod, existing),
    after: clean(mod, after),
    changes: changes.filter((c) => !mod.secretKeys.includes(c.field)),
  };
};

export const remove = async (ctx, name, id, { reason, ...opts } = {}) => {
  const mod = getModule(name);
  assertCan(ctx, mod, 'delete');
  assertAgentWritable(mod, opts);
  if (!mod.softDelete) throw badRequest(`${mod.label} can't be deleted`);
  const where = { _id: castId(mod, id), ...scopeFilter(ctx, mod) };
  const existing = await mod.Model.findOne(where).lean();
  if (!existing) throw notFound(`${mod.singular ?? mod.label} not found`);
  const label = labelOf(mod, existing);
  if (opts.dryRun) return { dryRun: true, doc: clean(mod, existing), label };
  await mod.Model.updateOne(where, {
    $set: { deleted: true, deletedAt: new Date(), deletedBy: ctx.userId, deleteReason: reason ?? undefined },
  });
  await bumpScheduleVersion(ctx, mod);
  announce(ctx, mod, existing, 'deleted');
  return { deleted: true, id: String(existing._id), label };
};

/** Runs a module action (e.g. work order status) on a hydrated document. */
export const runAction = async (ctx, name, id, actionName, input, opts = {}) => {
  const mod = getModule(name);
  const action = mod.actions?.[actionName];
  if (!action) throw notFound(`${mod.label} has no action "${actionName}"`);
  assertCan(ctx, mod, action.permission ?? 'update');
  const args = parseOrThrow(action.schema, input ?? {}, action.label);
  const record = await mod.Model.findOne({ _id: castId(mod, id), ...scopeFilter(ctx, mod) });
  if (!record) throw notFound(`${mod.singular ?? mod.label} not found`);
  if (opts.dryRun) return { dryRun: true, doc: clean(mod, record.toObject()), input: args };
  const result = await action.run({ ctx, record, input: args, opts, svc: service });
  return clean(mod, result);
};

/** Finds a record by its human code (WO-42) within scope; several plants can share a code. */
export const findByCode = async (ctx, name, code) => {
  const mod = getModule(name);
  assertCan(ctx, mod, 'read');
  if (!mod.codeField) throw badRequest(`${mod.label} have no code`);
  const rx = { $regex: `^${escapeRegex(String(code).trim())}$`, $options: 'i' };
  return mod.Model.find({ [mod.codeField]: rx, ...scopeFilter(ctx, mod) })
    .limit(5)
    .lean();
};

export const getLabel = (name, doc) => labelOf(getModule(name), doc);
export const getField = getPath;

const service = {
  getModule,
  list,
  get,
  create,
  update,
  remove,
  runAction,
  findByCode,
  scopeFilter,
  refLabels,
};
export const records = service;
