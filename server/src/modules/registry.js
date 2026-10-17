import mongoose from 'mongoose';
import { notFound } from '../lib/errors.js';
import { defs } from './defs/index.js';
import { digestFields, toMeta, toMongooseFields, toZodObject } from './fields.js';

const DEFAULTS = {
  tenantField: 'companyId',
  plantScoped: false,
  softDelete: true,
  timestamps: true,
  agentWritable: true,
  permissionKey: null,
  feature: null,
  titleField: 'name',
  codeField: null,
  search: ['name'],
  sort: '-createdAt',
  dateField: 'createdAt',
  icon: 'Database',
  inheritPlantFrom: [],
  // Related records shown on the record page: [{ module, field, label, order? }] where `field` is a
  // ref/refs field of the child module that points back at this module (phase 7 §2).
  children: [],
};

/** Fields every module gets: tenant, plant, soft delete, authorship, plan-apply stamps. */
const systemFields = (mod) => {
  const f = {};
  if (mod.tenantField === 'companyId') {
    f.companyId = {
      type: 'ref',
      ref: 'companies',
      required: true,
      readOnly: true,
      hidden: true,
      index: !mod.singleton,
    };
  }
  if (mod.softDelete) {
    f.deleted = { type: 'boolean', default: false, readOnly: true, hidden: true, index: true };
    f.deletedAt = { type: 'date', readOnly: true, hidden: true };
    f.deletedBy = { type: 'ref', ref: 'users', readOnly: true, hidden: true };
    f.deleteReason = { type: 'string', readOnly: true, hidden: true };
  }
  f.createdBy = { type: 'ref', ref: 'users', readOnly: true, label: 'Created by' };
  f.updatedBy = { type: 'ref', ref: 'users', readOnly: true, hidden: true };
  if (mod.planned) {
    f.proposalId = { type: 'string', readOnly: true, hidden: true };
    f.proposalSeq = { type: 'number', readOnly: true, hidden: true };
  }
  return f;
};

const modules = new Map();

const build = () => {
  for (const def of defs) {
    if (modules.has(def.name)) throw new Error(`Module "${def.name}" is defined twice`);
    modules.set(def.name, { ...DEFAULTS, singular: def.label.replace(/s$/, ''), ...def });
  }
  const modelOf = (name) => {
    const target = modules.get(name);
    if (!target) throw new Error(`Unknown ref target module "${name}"`);
    return target.model;
  };

  for (const mod of modules.values()) {
    const plantField = mod.plantScoped
      ? { plantId: { type: 'ref', ref: 'plants', label: 'Plant', index: true } }
      : {};
    mod.fields = { ...plantField, ...mod.fields };
    mod.allFields = { ...mod.fields, ...systemFields(mod) };

    const paths = toMongooseFields(mod.allFields, modelOf);
    if (mod.idType === 'string') paths._id = { type: String };
    const schema = new mongoose.Schema(paths, {
      collection: mod.name,
      timestamps: mod.timestamps,
      minimize: false,
      versionKey: false,
    });
    if (mod.tenantField === 'companyId' && mod.codeField) schema.index({ companyId: 1, [mod.codeField]: 1 });
    if (mod.planned) {
      schema.index(
        { proposalId: 1, proposalSeq: 1 },
        { unique: true, partialFilterExpression: { proposalId: { $type: 'string' } } },
      );
    }
    if (mod.singleton) schema.index({ companyId: 1 }, { unique: true });
    for (const [keys, options] of mod.indexes ?? []) schema.index(keys, options);
    mod.Model = mongoose.models[mod.model] ?? mongoose.model(mod.model, schema);

    mod.secretKeys = Object.entries(mod.allFields)
      .filter(([, spec]) => spec.secret)
      .map(([key]) => key);
    mod.createSchema = toZodObject(mod.fields, { allowSecret: true });
    mod.updateSchema = toZodObject(mod.fields, { partial: true, allowSecret: true });
    mod.agentCreateSchema = toZodObject(mod.fields, { allowSecret: false });
    mod.agentUpdateSchema = toZodObject(mod.fields, { partial: true, allowSecret: false });

    for (const action of Object.values(mod.actions ?? {})) action.schema = toZodObject(action.fields ?? {});
  }

  // Children must point back at their parent through a real ref field (a typo here is a startup error).
  for (const mod of modules.values()) {
    mod.children = [...(mod.children ?? [])]
      .map((child, i) => {
        const target = modules.get(child.module);
        if (!target) throw new Error(`Module "${mod.name}": child module "${child.module}" does not exist`);
        const spec = target.fields[child.field];
        if (!spec || !['ref', 'refs'].includes(spec.type) || spec.ref !== mod.name) {
          throw new Error(
            `Module "${mod.name}": "${child.module}.${child.field}" is not a ref to ${mod.name}`,
          );
        }
        return { label: target.label, order: i, ...child };
      })
      .sort((a, b) => a.order - b.order);
  }
};

build();

export const getModule = (name) => {
  const mod = modules.get(name);
  if (!mod) throw notFound(`Unknown module "${name}"`);
  return mod;
};

export const hasModule = (name) => modules.has(name);
export const allModules = () => [...modules.values()];

/** Modules visible to a user: company feature flags decide production/bin modules. */
export const modulesFor = (ctx) =>
  allModules().filter((m) => !m.feature || ctx.company?.features?.[m.feature] === true);

const getPath = (doc, path) => path.split('.').reduce((v, k) => (v == null ? v : v[k]), doc);

export const labelOf = (mod, doc) => {
  if (!doc) return '';
  if (mod.name === 'users') return [doc.firstName, doc.lastName].filter(Boolean).join(' ') || doc.email;
  const parts = [mod.codeField && doc[mod.codeField], getPath(doc, mod.titleField)].filter(Boolean);
  return parts.join(' · ') || String(doc._id);
};

/** Metadata the generic UI pages render from. */
export const moduleMeta = (mod, can) => ({
  name: mod.name,
  label: mod.label,
  singular: mod.singular,
  group: mod.group,
  icon: mod.icon,
  description: mod.description,
  codeField: mod.codeField,
  titleField: mod.titleField,
  list: mod.list,
  search: mod.search,
  dateField: mod.dateField,
  plantScoped: mod.plantScoped,
  softDelete: mod.softDelete,
  idType: mod.idType ?? 'objectId',
  children: mod.children.map(({ module, field, label, order }) => ({ module, field, label, order })),
  fields: toMeta(mod.fields),
  actions: Object.entries(mod.actions ?? {}).map(([key, a]) => ({
    key,
    label: a.label,
    icon: a.icon,
    fields: toMeta(a.fields ?? {}),
  })),
  can,
});

/** One line per module for the agent's system prompt. */
export const moduleDigest = (mod) =>
  `${mod.name} (${mod.label}): ${mod.description ?? ''} ${mod.agentNotes ?? ''} Fields: ${digestFields(mod.fields)}`
    .replace(/\s+/g, ' ')
    .trim();
