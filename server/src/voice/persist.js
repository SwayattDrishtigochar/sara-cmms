import { AiConversation } from '../db/models/AiConversation.js';
import { AiMessage } from '../db/models/AiMessage.js';

/**
 * Voice turns in Mongo (phase 8 §3.5): one user + one assistant ai_messages doc per turn, chat-shaped.
 * Only atomic $set / $push after the inserts, so a confirm landing mid-turn interleaves safely.
 */

/** The session's conversation, created at its first turn with the id the session already announced. */
export const ensureConversation = async (ctx, { conversationId }) =>
  AiConversation.findOneAndUpdate(
    { _id: conversationId },
    {
      $setOnInsert: {
        companyId: ctx.companyId,
        userId: ctx.userId,
        plantId: ctx.plantId ?? null,
        title: '',
        voice: true,
      },
    },
    { upsert: true, new: true },
  ).lean();

/** Inserts the turn's user message, then its streaming assistant message (ids may be chosen up front). */
export const openTurn = async (ctx, conversation, { userText, context, model, userMessageId, messageId }) => {
  const base = {
    conversationId: conversation._id,
    companyId: ctx.companyId,
    userId: ctx.userId,
    context: context ?? null,
    channel: 'voice',
  };
  const user = await AiMessage.create({
    ...(userMessageId ? { _id: userMessageId } : {}),
    ...base,
    role: 'user',
    text: userText || '(voice message)',
  });
  const assistant = await AiMessage.create({
    ...(messageId ? { _id: messageId } : {}),
    ...base,
    role: 'assistant',
    status: 'streaming',
    tier: 'voice',
    model,
    thinkingLevel: null,
    routerDecision: null,
  });
  return { userMessageId: user._id, messageId: assistant._id };
};

/** Appends one tool round: UI parts and Gemini contents. */
export const flushRound = async (messageId, { parts = [], gemini = [] }) => {
  if (!parts.length && !gemini.length) return;
  await AiMessage.updateOne(
    { _id: messageId },
    { $push: { parts: { $each: parts }, gemini: { $each: gemini } } },
  );
};

const titleFrom = (text) =>
  String(text ?? '')
    .trim()
    .split(/\s+/)
    .slice(0, 6)
    .join(' ')
    .slice(0, 60) || 'Voice conversation';

/**
 * Finishes a turn: user text, assistant text/usage/latency, the remaining parts, the model's spoken answer in
 * `gemini` (not when a pending action keeps the write call open), the status unless §3.4 already set one,
 * and the conversation's lastMessageAt / voice flag / title.
 */
export const closeTurn = async (
  { conversationId, userMessageId, messageId },
  { userText, text, parts = [], usage, latencyMs, status, pending },
) => {
  await AiMessage.updateOne({ _id: userMessageId }, { $set: { text: userText || '(voice message)' } });
  await AiMessage.updateOne(
    { _id: messageId },
    {
      $set: { text: text ?? '', usage, latencyMs: latencyMs ?? null },
      $push: {
        parts: { $each: parts },
        gemini: { $each: pending ? [] : [{ role: 'model', parts: [{ text: text || '(no answer)' }] }] },
      },
    },
  );
  await AiMessage.updateOne({ _id: messageId, status: 'streaming' }, { $set: { status } });
  await AiConversation.updateOne(
    { _id: conversationId },
    { $set: { lastMessageAt: new Date(), voice: true } },
  );
  await AiConversation.updateOne(
    { _id: conversationId, title: '' },
    { $set: { title: titleFrom(userText) } },
  );
};
