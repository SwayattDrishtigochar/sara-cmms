import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import mongoose from 'mongoose';
import { z } from 'zod';
import { publicAction, runTurn, stopTurn } from '../agent/loop.js';
import { claimPendingAction, rejectPendingAction } from '../agent/pendingActions.js';
import { env } from '../config/env.js';
import { AiConversation, TIER_PREFERENCES } from '../db/models/AiConversation.js';
import { AiMessage } from '../db/models/AiMessage.js';
import { badRequest, notFound, parseOrThrow } from '../lib/errors.js';
import { openSse } from '../lib/sse.js';

/** Chat conversations and their streaming turns (phase 4 §5); mounted at /api. */
export const conversationsRouter = Router();

const PAGE = 30;
const isId = (v) => mongoose.isValidObjectId(v) && String(v).length === 24;

const messageLimit = rateLimit({
  windowMs: 60_000,
  limit: () => env.RATE_LIMIT_MESSAGES_PER_MIN,
  keyGenerator: (req) => String(req.ctx.userId),
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: {
    error: {
      code: 'RATE_LIMITED',
      message: 'You are sending messages very fast. Wait a minute and try again.',
    },
  },
});

const createSchema = z.strictObject({ title: z.string().trim().max(120).optional() });
const patchSchema = z.strictObject({
  title: z.string().trim().min(1).max(120).optional(),
  tierPreference: z.enum(TIER_PREFERENCES).optional(),
});
const messageSchema = z.strictObject({
  text: z.string().trim().min(1).max(8000),
  tier: z.enum(TIER_PREFERENCES).optional(),
  context: z
    .object({
      page: z.string().max(60).optional(),
      recordRef: z
        .object({ module: z.string().max(60), id: z.string().max(60), label: z.string().max(120).optional() })
        .optional(),
    })
    .optional(),
});

const publicConversation = (c) => ({
  id: String(c._id),
  title: c.title,
  tierPreference: c.tierPreference,
  loadedGroups: c.loadedGroups,
  plantId: c.plantId ? String(c.plantId) : null,
  lastMessageAt: c.lastMessageAt,
  createdAt: c.createdAt,
  voice: Boolean(c.voice),
});

/** A stored message for the UI: parts and blocks, no raw Gemini contents or CSV payloads. */
const publicMessage = (m) => ({
  id: String(m._id),
  role: m.role,
  channel: m.channel ?? 'text',
  text: m.text,
  context: m.context,
  parts: (m.parts ?? []).map(({ csv: _csv, ...part }) => part),
  model: m.model ?? null,
  tier: m.tier ?? null,
  thinkingLevel: m.thinkingLevel ?? null,
  routerDecision: m.routerDecision ?? null,
  usage: m.usage ?? null,
  latencyMs: m.latencyMs ?? null,
  status: m.status,
  pendingAction: publicAction(m.pendingAction),
  createdAt: m.createdAt,
});

/** The caller's own, not deleted conversation, or 404. */
const owned = async (req) => {
  const { id } = req.params;
  const conversation = isId(id)
    ? await AiConversation.findOne({
        _id: id,
        companyId: req.ctx.companyId,
        userId: req.ctx.userId,
        deleted: false,
      }).lean()
    : null;
  if (!conversation) throw notFound('Conversation not found');
  return conversation;
};

/** Opens SSE and runs a turn; a client that goes away aborts it. */
const streamTurn = async (req, res, args) => {
  const controller = new AbortController();
  // Registered before openSse's own close handler, which ends the response.
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });
  const sse = openSse(res);
  try {
    await runTurn({ ctx: req.ctx, sse, signal: controller.signal, ...args });
  } catch (err) {
    req.log?.error({ err }, 'chat turn failed before streaming');
    sse.send('error', {
      code: 'AGENT_ERROR',
      message: 'Something went wrong while answering. Please try again.',
    });
  } finally {
    sse.close();
  }
};

conversationsRouter.get('/conversations', async (req, res) => {
  const filter = { companyId: req.ctx.companyId, userId: req.ctx.userId, deleted: false };
  const cursor = req.query.cursor ? String(req.query.cursor) : null;
  if (cursor) {
    const [ms, id] = cursor.split('_');
    if (!/^\d+$/.test(ms ?? '') || !isId(id)) throw badRequest('Invalid cursor');
    const at = new Date(Number(ms));
    filter.$or = [
      { lastMessageAt: { $lt: at } },
      { lastMessageAt: at, _id: { $lt: new mongoose.Types.ObjectId(id) } },
    ];
  }
  const rows = await AiConversation.find(filter)
    .sort({ lastMessageAt: -1, _id: -1 })
    .limit(PAGE + 1)
    .lean();
  const items = rows.slice(0, PAGE).map(publicConversation);
  const last = rows.length > PAGE ? rows[PAGE - 1] : null;
  res.json({ items, nextCursor: last ? `${new Date(last.lastMessageAt).getTime()}_${last._id}` : null });
});

conversationsRouter.post('/conversations', async (req, res) => {
  const { title } = parseOrThrow(createSchema, req.body ?? {}, 'conversation');
  const conversation = await AiConversation.create({
    companyId: req.ctx.companyId,
    userId: req.ctx.userId,
    plantId: req.ctx.plantId ?? null,
    title: title ?? '',
  });
  res.status(201).json({ conversation: publicConversation(conversation.toObject()) });
});

conversationsRouter.get('/conversations/:id', async (req, res) => {
  const conversation = await owned(req);
  // No turn outlives MAX_TURN_MS, so an older 'streaming' answer was cut off (a restart mid-turn).
  await AiMessage.updateMany(
    {
      conversationId: conversation._id,
      status: 'streaming',
      updatedAt: { $lt: new Date(Date.now() - env.MAX_TURN_MS - 60_000) },
    },
    { $set: { status: 'error' } },
  );
  const messages = await AiMessage.find({ conversationId: conversation._id })
    .select('-gemini')
    .sort({ createdAt: 1, _id: 1 })
    .lean();
  res.json({ conversation: publicConversation(conversation), messages: messages.map(publicMessage) });
});

conversationsRouter.patch('/conversations/:id', async (req, res) => {
  const patch = parseOrThrow(patchSchema, req.body ?? {}, 'conversation');
  const conversation = await owned(req);
  const updated = await AiConversation.findByIdAndUpdate(
    conversation._id,
    { $set: patch },
    { new: true },
  ).lean();
  res.json({ conversation: publicConversation(updated) });
});

conversationsRouter.delete('/conversations/:id', async (req, res) => {
  const conversation = await owned(req);
  await AiConversation.updateOne({ _id: conversation._id }, { $set: { deleted: true } });
  res.status(204).end();
});

conversationsRouter.post('/conversations/:id/messages', messageLimit, async (req, res) => {
  const { text, tier, context } = parseOrThrow(messageSchema, req.body ?? {}, 'message');
  const conversation = await owned(req);
  await streamTurn(req, res, { conversation, userText: text, tier, context });
});

conversationsRouter.post('/conversations/:id/messages/:messageId/stop', async (req, res) => {
  await owned(req);
  res.json({ ok: stopTurn(req.params.messageId, req.ctx.userId) });
});

conversationsRouter.post('/conversations/:id/actions/:actionId/confirm', messageLimit, async (req, res) => {
  const conversation = await owned(req);
  const continuation = await claimPendingAction({
    ctx: req.ctx,
    conversation,
    actionId: req.params.actionId,
  });
  await streamTurn(req, res, { conversation, context: continuation.message.context, continuation });
});

conversationsRouter.post('/conversations/:id/actions/:actionId/reject', async (req, res) => {
  const conversation = await owned(req);
  await rejectPendingAction({ conversation, actionId: req.params.actionId });
  res.json({ ok: true });
});
