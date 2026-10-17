import { notFound } from '../lib/errors.js';
import { can } from './permissions.js';
import { records } from './records.js';
import { getModule } from './registry.js';

/** Declared children the caller may see: feature-enabled modules they can read. */
const childrenOf = (ctx, mod) =>
  mod.children.filter((c) => ctx.modules.includes(c.module) && can(ctx, getModule(c.module), 'read'));

const canCreate = (ctx, child) =>
  can(ctx, child, 'create') && (!child.createRoles || child.createRoles.includes(ctx.role));

/** Child relations of a record with their counts; 404/403 come from reading the parent. */
export const relatedCounts = async (ctx, module, id) => {
  const mod = getModule(module);
  const parent = await records.get(ctx, module, id, { populate: false });
  const children = await Promise.all(
    childrenOf(ctx, mod).map(async ({ module: name, field, label, order }) => {
      const child = getModule(name);
      const count = await child.Model.countDocuments({
        [field]: parent._id,
        ...records.scopeFilter(ctx, child),
      });
      return { module: name, field, label, order, count, can: { read: true, create: canCreate(ctx, child) } };
    }),
  );
  return { parent: { module, id: String(parent._id) }, children };
};

/** One page of a child relation, through records.list (tenancy, plant lock, populated refs). */
export const relatedList = async (ctx, module, id, childName, { page, limit = 25, sort, q } = {}) => {
  const mod = getModule(module);
  const child = childrenOf(ctx, mod).find((c) => c.module === childName);
  if (!child) throw notFound(`${mod.singular ?? mod.label} has no related "${childName}"`);
  const parent = await records.get(ctx, module, id, { populate: false });
  const result = await records.list(ctx, childName, {
    filter: { [child.field]: String(parent._id) },
    page,
    limit,
    sort,
    q,
  });
  return { child: { module: child.module, field: child.field, label: child.label }, ...result };
};
