import { randomUUID } from 'node:crypto';
import { env } from '../config/env.js';
import { AiMessage } from '../db/models/AiMessage.js';
import { forbidden, gone, notFound } from '../lib/errors.js';
import { getTool } from './tools/registry.js';

/**
 * Writes wait for the user (phase 4 §4): the preview is shown, the model's function call stays
 * unanswered until Confirm (runs the tool, continues the turn), Reject or expiry (answers it with
 * `{ status: 'rejected' | 'not_confirmed' }` so the history stays valid).
 */

export const ttlMs = () => env.PENDING_ACTION_TTL_MIN * 60_000;

const responsePart = (action, response) => ({
  functionResponse: { name: action.tool, ...(action.geminiId ? { id: action.geminiId } : {}), response },
});

/** The user content that answers the step: sibling responses in call order with this call's response slotted in. */
export const stepResponses = (action, response) => {
  const parts = [...(action.siblingResponses ?? [])];
  parts.splice(Math.min(action.callIndex ?? parts.length, parts.length), 0, responsePart(action, response));
  return { role: 'user', parts };
};

/** Stores the pending write on the assistant message and marks the message awaiting confirmation. */
export const createPendingAction = async (
  message,
  { tool, args, callId, geminiId, callIndex, siblingResponses, preview },
) => {
  const action = {
    id: randomUUID(),
    tool,
    args,
    callId,
    geminiId: geminiId ?? null,
    callIndex,
    siblingResponses,
    preview,
    status: 'pending',
    expiresAt: new Date(Date.now() + ttlMs()),
    result: null,
  };
  await AiMessage.updateOne(
    { _id: message._id },
    { $set: { pendingAction: action, status: 'awaiting_confirmation' } },
  );
  return action;
};

const settle = (message, action, status, response, notice) =>
  AiMessage.updateOne(
    { _id: message._id, 'pendingAction.id': action.id, 'pendingAction.status': 'pending' },
    {
      $set: { 'pendingAction.status': status, 'pendingAction.result': response, status: 'complete' },
      $push: { gemini: stepResponses(action, response), parts: { type: 'notice', text: notice } },
    },
  );

const findPending = async (conversation, actionId) => {
  const message = await AiMessage.findOne({
    conversationId: conversation._id,
    'pendingAction.id': actionId,
  }).lean();
  if (!message) throw notFound('That action no longer exists');
  return message;
};

/**
 * Atomically claims a pending action (pending → confirmed) after re-checking expiry and permission.
 * Returns `{ message, action, tool }`; the caller runs the tool and continues the turn.
 */
export const claimPendingAction = async ({ ctx, conversation, actionId }) => {
  const message = await findPending(conversation, actionId);
  const action = message.pendingAction;
  if (action.status !== 'pending') throw gone(`This action was already ${action.status}`);
  if (new Date(action.expiresAt) < new Date()) {
    await settle(
      message,
      action,
      'expired',
      { status: 'not_confirmed', reason: 'expired' },
      'The confirmation expired.',
    );
    throw gone('This action has expired; ask SARA again');
  }
  const tool = getTool(action.tool);
  if (!tool || (tool.permission && !tool.permission(ctx)))
    throw forbidden('You are not allowed to run this action');
  const claimed = await AiMessage.findOneAndUpdate(
    { _id: message._id, 'pendingAction.id': actionId, 'pendingAction.status': 'pending' },
    { $set: { 'pendingAction.status': 'confirmed' } },
    { new: true },
  ).lean();
  if (!claimed) throw gone('This action was already handled');
  return { message: claimed, action: claimed.pendingAction, tool };
};

/** Reject: the model's call is answered with `{ status: 'rejected' }` and the message completes. */
export const rejectPendingAction = async ({ conversation, actionId }) => {
  const message = await findPending(conversation, actionId);
  if (message.pendingAction.status !== 'pending')
    throw gone(`This action was already ${message.pendingAction.status}`);
  await settle(
    message,
    message.pendingAction,
    'rejected',
    { status: 'rejected' },
    'Change rejected; nothing was saved.',
  );
  return message.pendingAction;
};

/** Expires every pending action of a conversation (past TTL or superseded by a new message). */
export const expirePendingActions = async (conversationId) => {
  const messages = await AiMessage.find({ conversationId, 'pendingAction.status': 'pending' }).lean();
  for (const m of messages) {
    await settle(
      m,
      m.pendingAction,
      'expired',
      { status: 'not_confirmed' },
      'The confirmation expired; nothing was saved.',
    );
  }
  return messages.length;
};
