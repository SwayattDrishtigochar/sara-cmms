import { Counter } from '../db/models/Counter.js';
import { allModules } from './registry.js';

/**
 * Plant-scoped modules whose records may span the company (a plant-less user sees every plant): a KPI made
 * without a plant lock and a company-scope cost alert have no plant (phase5-contracts §2).
 */
const COMPANY_WIDE = new Set(['users', 'notifications', 'kpis', 'costalerts']);
/** Detail rows kept per kind; the per-module counts stay exact. */
const MAX_DETAILS = 1000;

/**
 * Checks every document of a company the way SARA reads it — what raw writers such as the simulator
 * must get right: registry schema validation (`new Model(doc).validateSync()`), a plantId on
 * plant-scoped records, documents that belong to no company, and counters behind the highest code
 * in use (the next record would repeat a number). Fields SARA does not know are warnings.
 * Returns { modules: [{ module, docs, errors, warnings }], errors: [detail], warnings: [detail] },
 * detail = { module, id, path, message }.
 */
export const validateCompany = async (companyId) => {
  const modules = [];
  const errors = [];
  const warnings = [];
  const seqs = new Map(
    (await Counter.find({ companyId }).lean()).map((c) => [`${c.plantId ?? null}:${c.type}`, c.seq]),
  );

  for (const mod of allModules()) {
    const { Model, counter } = mod;
    const row = { module: mod.name, docs: 0, errors: 0, warnings: 0 };
    const note = (list, kind) => (id, path, message) => {
      row[kind] += 1;
      if (list.length < MAX_DETAILS)
        list.push({ module: mod.name, id: id ? String(id) : null, path, message });
    };
    const fail = note(errors, 'errors');
    const warn = note(warnings, 'warnings');
    const known = new Set(Object.keys(Model.schema.paths).map((path) => path.split('.')[0]));
    const highest = new Map(); // `${plantId}:${type}` → highest code number in use

    for await (const doc of Model.find({ [mod.tenantField]: companyId })
      .lean()
      .cursor()) {
      row.docs += 1;
      const invalid = new Model(doc).validateSync();
      for (const [path, err] of Object.entries(invalid?.errors ?? {})) fail(doc._id, path, err.message);
      for (const key of Object.keys(doc)) {
        if (!known.has(key)) warn(doc._id, key, 'not a field of this module, so SARA ignores it');
      }
      if (mod.plantScoped && !doc.plantId && !COMPANY_WIDE.has(mod.name)) {
        fail(doc._id, 'plantId', 'missing: a plant-scoped record needs its plant');
      }
      const number = counter && Number(/(\d+)$/.exec(doc[counter.field] ?? '')?.[1]);
      if (number) {
        const key = `${doc.plantId ?? null}:${counter.type}`;
        highest.set(key, Math.max(highest.get(key) ?? 0, number));
      }
    }

    for (const [key, number] of highest) {
      const seq = seqs.get(key) ?? 0;
      if (seq >= number) continue;
      const plant = key.split(':')[0];
      fail(
        null,
        counter.field,
        `counter ${counter.type}${plant === 'null' ? '' : ` (plant ${plant})`} is at ${seq} but ${counter.prefix}${number} exists`,
      );
    }
    if (mod.tenantField === 'companyId') {
      const orphans = await Model.countDocuments({ companyId: null });
      if (orphans) fail(null, 'companyId', `${orphans} document(s) belong to no company (companyId missing)`);
    }
    modules.push(row);
  }
  return { modules, errors, warnings };
};
