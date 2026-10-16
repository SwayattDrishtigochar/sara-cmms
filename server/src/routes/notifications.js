import { Router } from 'express';
import { notFound } from '../lib/errors.js';
import { isObjectIdString } from '../lib/ids.js';
import { getModule } from '../modules/registry.js';

/** In-app notifications of the signed-in user; mounted at /api. */
export const notificationsRouter = Router();

const PAGE = 30;
const Notification = () => getModule('notifications').Model;

/** Addressed to me or to everyone (no recipients), and inside my plant when I am locked to one. */
const mine = (ctx) => ({
  companyId: ctx.companyId,
  $or: [
    { recipientUsers: ctx.userId },
    { recipientUsers: { $size: 0 } },
    { recipientUsers: { $exists: false } },
  ],
  ...(ctx.plantLock ? { plantId: { $in: [ctx.plantLock, null] } } : {}),
});

notificationsRouter.get('/notifications', async (req, res) => {
  const filter = mine(req.ctx);
  const me = String(req.ctx.userId);
  const [items, unread] = await Promise.all([
    Notification().find(filter).sort({ createdAt: -1, _id: -1 }).limit(PAGE).lean(),
    Notification().countDocuments({ ...filter, readBy: { $ne: req.ctx.userId } }),
  ]);
  res.json({
    items: items.map(({ readBy, ...n }) => ({ ...n, read: (readBy ?? []).some((id) => String(id) === me) })),
    unread,
  });
});

notificationsRouter.post('/notifications/read-all', async (req, res) => {
  await Notification().updateMany(mine(req.ctx), { $addToSet: { readBy: req.ctx.userId } });
  res.json({ ok: true });
});

notificationsRouter.post('/notifications/:id/read', async (req, res) => {
  if (!isObjectIdString(req.params.id)) throw notFound('Notification not found');
  const { matchedCount } = await Notification().updateOne(
    { _id: req.params.id, ...mine(req.ctx) },
    { $addToSet: { readBy: req.ctx.userId } },
  );
  if (!matchedCount) throw notFound('Notification not found');
  res.json({ ok: true });
});
