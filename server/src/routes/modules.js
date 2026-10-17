import { Router } from 'express';
import { z } from 'zod';
import { notFound, parseOrThrow } from '../lib/errors.js';
import { can } from '../modules/permissions.js';
import { records } from '../modules/records.js';
import { getModule, moduleMeta, modulesFor } from '../modules/registry.js';
import { relatedCounts, relatedList } from '../modules/related.js';

export const modulesRouter = Router();

/** 404 for modules the company has not switched on (feature flags). */
const visibleModule = (req) => {
  const { module: name } = req.params;
  if (!req.ctx.modules.includes(name)) throw notFound(`Unknown module "${name}"`);
  return name;
};

const canMap = (ctx, mod) => ({
  read: can(ctx, mod, 'read'),
  create: can(ctx, mod, 'create') && (!mod.createRoles || mod.createRoles.includes(ctx.role)),
  update: can(ctx, mod, 'update'),
  delete: can(ctx, mod, 'delete') && mod.softDelete,
});

/** Module meta for this caller; related children are limited to modules the company has on. */
const metaFor = (ctx, mod) => {
  const meta = moduleMeta(mod, canMap(ctx, mod));
  meta.children = meta.children.filter((c) => ctx.modules.includes(c.module));
  return meta;
};

modulesRouter.get('/modules', (req, res) => {
  res.json({ modules: modulesFor(req.ctx).map((mod) => metaFor(req.ctx, mod)) });
});

modulesRouter.get('/modules/:module', (req, res) => {
  res.json({ module: metaFor(req.ctx, getModule(visibleModule(req))) });
});

modulesRouter.get('/m/:module', async (req, res) => {
  const { q, filter, sort, page, limit, from, to } = req.query;
  res.json(await records.list(req.ctx, visibleModule(req), { q, filter, sort, page, limit, from, to }));
});

modulesRouter.get('/m/:module/:id', async (req, res) => {
  res.json({ item: await records.get(req.ctx, visibleModule(req), req.params.id) });
});

modulesRouter.get('/m/:module/:id/related', async (req, res) => {
  res.json(await relatedCounts(req.ctx, visibleModule(req), req.params.id));
});

modulesRouter.get('/m/:module/:id/related/:child', async (req, res) => {
  const { page, limit, sort, q } = req.query;
  res.json(
    await relatedList(req.ctx, visibleModule(req), req.params.id, req.params.child, { page, limit, sort, q }),
  );
});

modulesRouter.post('/m/:module', async (req, res) => {
  const item = await records.create(req.ctx, visibleModule(req), req.body, { source: 'rest' });
  res.status(201).json({ item });
});

modulesRouter.patch('/m/:module/:id', async (req, res) => {
  const result = await records.update(req.ctx, visibleModule(req), req.params.id, req.body, {
    source: 'rest',
  });
  res.json({ item: result.after, changes: result.changes });
});

const deleteSchema = z.object({ reason: z.string().max(500).optional() }).optional();

modulesRouter.delete('/m/:module/:id', async (req, res) => {
  const body = parseOrThrow(deleteSchema, req.body);
  res.json(
    await records.remove(req.ctx, visibleModule(req), req.params.id, {
      reason: body?.reason,
      source: 'rest',
    }),
  );
});

modulesRouter.post('/m/:module/:id/actions/:action', async (req, res) => {
  const item = await records.runAction(
    req.ctx,
    visibleModule(req),
    req.params.id,
    req.params.action,
    req.body,
    {
      source: 'rest',
    },
  );
  res.json({ item });
});
