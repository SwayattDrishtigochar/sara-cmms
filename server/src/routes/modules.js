import { Router } from 'express';
import { z } from 'zod';
import { notFound, parseOrThrow } from '../lib/errors.js';
import { can } from '../modules/permissions.js';
import { records } from '../modules/records.js';
import { getModule, moduleMeta, modulesFor } from '../modules/registry.js';

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

modulesRouter.get('/modules', (req, res) => {
  res.json({ modules: modulesFor(req.ctx).map((mod) => moduleMeta(mod, canMap(req.ctx, mod))) });
});

modulesRouter.get('/modules/:module', (req, res) => {
  const mod = getModule(visibleModule(req));
  res.json({ module: moduleMeta(mod, canMap(req.ctx, mod)) });
});

modulesRouter.get('/m/:module', async (req, res) => {
  const { q, filter, sort, page, limit, from, to } = req.query;
  res.json(await records.list(req.ctx, visibleModule(req), { q, filter, sort, page, limit, from, to }));
});

modulesRouter.get('/m/:module/:id', async (req, res) => {
  res.json({ item: await records.get(req.ctx, visibleModule(req), req.params.id) });
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
