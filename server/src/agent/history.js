import { env } from '../config/env.js';
import { AiConversation } from '../db/models/AiConversation.js';
import { AiMessage } from '../db/models/AiMessage.js';
import { logger } from '../lib/logger.js';
import { getLlm } from './llm.js';

/** History replay for the model (phase 4 §4 `buildContents`) and the rolling conversation summary. */

const NOT_CONFIRMED = { status: 'not_confirmed' };
const SUMMARY_SCHEMA = { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] };

/** Messages of a conversation grouped into turns `[{ user, assistant }]`, oldest first. */
export const loadTurns = async (conversationId, { exclude } = {}) => {
  const messages = await AiMessage.find({ conversationId }).sort({ createdAt: 1, _id: 1 }).lean();
  const turns = [];
  for (const m of messages) {
    if (exclude && String(m._id) === String(exclude)) continue;
    if (m.role === 'user') turns.push({ user: m, assistant: null });
    else if (turns.length && !turns.at(-1).assistant) turns.at(-1).assistant = m;
    else turns.push({ user: null, assistant: m });
  }
  return turns;
};

const responsePart = (call, response) => ({
  functionResponse: { name: call.name, ...(call.id ? { id: call.id } : {}), response },
});

/** Answers every call of a model content with the parts of the next user content, in call order. */
const answersFor = (calls, next) => {
  const pool = (next?.parts ?? []).filter((p) => p.functionResponse);
  const others = (next?.parts ?? []).filter((p) => !p.functionResponse);
  const used = new Set();
  const parts = calls.map((call) => {
    const index = pool.findIndex(
      (p, i) =>
        !used.has(i) && (call.id ? p.functionResponse.id === call.id : p.functionResponse.name === call.name),
    );
    if (index === -1) return responsePart(call, NOT_CONFIRMED);
    used.add(index);
    return pool[index];
  });
  return { parts: [...parts, ...others], missing: parts.length - used.size };
};

/** A stored content as the API should get it back: thought text dropped, its signature kept. */
export const replayContent = (c) => ({
  role: c.role,
  parts: (c.parts ?? [])
    .filter((p) => !p.thought || p.thoughtSignature)
    .map((p) => (p.thought ? { thoughtSignature: p.thoughtSignature, text: '' } : { ...p })),
});

/** An old function response reduced to `{ ref, summary, rowCount }` (the loop puts the call id in `ref`). */
const shrunk = (summaries, response) => {
  const ref = response?.ref;
  if (response?.status && !response.result) return response; // not_confirmed / rejected answers are tiny already
  return { ...(ref ? { ref } : {}), ...(summaries.get(ref) ?? { summary: 'result omitted from history' }) };
};

/**
 * Model/user contents of one assistant message as the API should see them: thought text dropped
 * (signatures kept), every function call answered, responses of old turns shrunk to `{ summary, rowCount }`.
 * `open` leaves a trailing user content in place (the model continues from it after a Confirm).
 */
export const assistantContents = (message, { full = true, open = false } = {}) => {
  const summaries = new Map();
  for (const part of message.parts ?? []) {
    if (part.type === 'tool_result') {
      summaries.set(part.id, {
        summary: part.summary ?? '',
        rowCount: part.rowCount ?? null,
        ...(part.error ? { error: part.error } : {}),
      });
    }
  }
  const contents = (message.gemini ?? []).map(replayContent).filter((c) => c.parts.length);

  const out = [];
  for (let i = 0; i < contents.length; i++) {
    const content = contents[i];
    if (content.role !== 'model') {
      out.push(content);
      continue;
    }
    out.push(content);
    const calls = content.parts.filter((p) => p.functionCall).map((p) => p.functionCall);
    if (!calls.length) continue;
    const next = contents[i + 1]?.role === 'user' ? contents[i + 1] : null;
    const answered = answersFor(calls, next);
    if (next) {
      next.parts = answered.parts;
    } else {
      contents.splice(i + 1, 0, { role: 'user', parts: answered.parts });
    }
  }
  if (!full) {
    for (const content of out) {
      if (content.role !== 'user') continue;
      content.parts = content.parts.map((p) =>
        p.functionResponse
          ? {
              functionResponse: {
                ...p.functionResponse,
                response: shrunk(summaries, p.functionResponse.response),
              },
            }
          : p,
      );
    }
  }
  if (!out.length) return [{ role: 'model', parts: [{ text: message.text || '(no answer)' }] }];
  if (!open && out.at(-1).role !== 'model') {
    out.push({ role: 'model', parts: [{ text: message.text || '(stopped before answering)' }] });
  }
  return out;
};

/**
 * Contents for the next model call: the last `turns` turns of the conversation. The most recent
 * `keepFull` turns keep full tool results; older ones are shrunk. `exclude` skips the assistant message
 * being generated; `open` names the message a Confirm continues.
 */
export const buildContents = async (
  conversation,
  { exclude, open, turns = env.HISTORY_TURNS, keepFull = 2 } = {},
) => {
  const all = await loadTurns(conversation._id, { exclude });
  const window = all.slice(-turns);
  const contents = [];
  window.forEach((turn, i) => {
    const full = i >= window.length - keepFull;
    if (turn.user) contents.push({ role: 'user', parts: [{ text: turn.user.text || '(empty message)' }] });
    if (turn.assistant) {
      const isOpen = Boolean(open) && String(turn.assistant._id) === String(open);
      contents.push(...assistantContents(turn.assistant, { full, open: isOpen }));
    }
  });
  return contents;
};

/** Marks every signature as skippable: a continuation on another model can't validate them. */
export const relaxSignatures = (contents) => {
  for (const content of contents) {
    for (const part of content.parts ?? [])
      if (part.thoughtSignature) part.thoughtSignature = 'skip_thought_signature_validator';
  }
  return contents;
};

/** Folds turns that fell out of the history window into `conversation.summary` (router model, best effort). */
export const summarizeOlderTurns = async (conversation, { turns = env.HISTORY_TURNS } = {}) => {
  const all = await loadTurns(conversation._id);
  const dropped = all.length - turns;
  const done = conversation.summarizedUpTo ?? 0;
  if (dropped <= 0 || dropped <= done) return conversation.summary ?? '';
  const transcript = all
    .slice(done, dropped)
    .map(
      (t) =>
        `${t.user ? `User: ${t.user.text}\n` : ''}${t.assistant ? `SARA: ${(t.assistant.text || '').slice(0, 600)}` : ''}`,
    )
    .join('\n');
  try {
    const llm = await getLlm();
    const { json, text } = await llm.generate({
      tier: 'router',
      purpose: 'summary',
      companyId: conversation.companyId,
      system:
        'Summarise the conversation so far in at most 120 words: the entities (assets, people, codes), time ranges, filters and decisions that later questions may refer to. Return JSON { "summary": string }.',
      contents: `Previous summary: ${conversation.summary || '(none)'}\n\nTranscript:\n${transcript}`,
      schema: SUMMARY_SCHEMA,
      mockInput: { transcript },
    });
    const summary = String(json?.summary ?? text ?? '')
      .trim()
      .slice(0, 2000);
    if (summary) {
      await AiConversation.updateOne(
        { _id: conversation._id },
        { $set: { summary, summarizedUpTo: dropped } },
      );
      conversation.summary = summary;
      conversation.summarizedUpTo = dropped;
    }
  } catch (err) {
    logger.warn({ err: err.message }, 'conversation summary skipped');
  }
  return conversation.summary ?? '';
};
