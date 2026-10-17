import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { normalizeUsage } from '../ai/budget.js';
import { TIERS } from '../ai/settings.js';
import { env } from '../config/env.js';
import { AiConversation } from '../db/models/AiConversation.js';
import { AiMessage } from '../db/models/AiMessage.js';
import { AiToolAudit } from '../db/models/AiToolAudit.js';
import { zodIssues } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { toDeclaration, toJsonSchema } from './declarations.js';
import { buildContents, loadTurns, relaxSignatures, replayContent, summarizeOlderTurns } from './history.js';
import { aiErrorCode, friendlyAiError, getLlm, isAbort, tierInfo } from './llm.js';
import { createPendingAction, expirePendingActions, stepResponses } from './pendingActions.js';
import { route } from './router.js';
import { buildSystemPrompt } from './systemPrompt.js';
import { getTool, groupsFor, toolsFor } from './tools/registry.js';
import { redact } from './validators/redact.js';

/**
 * One chat turn (phase 4 §4): stream a model step, run its tool calls, answer them in one user content,
 * repeat until the model answers in text, a write waits for confirmation, a cap is hit or the user stops.
 */

const TITLE_SCHEMA = toJsonSchema(z.object({ title: z.string().max(60) }));
const STUCK = /\bI could not determine\b/i;
const FALLBACK_TIER = { deep: 'balanced', balanced: 'fast', fast: 'balanced' };

// ponytail: in-memory stop map, single server process; scale-out needs Redis pub/sub for stops.
const active = new Map();

/** Stops a running turn of `userId`; false when that message is not streaming here. */
export const stopTurn = (messageId, userId) => {
  const turn = active.get(String(messageId));
  if (!turn || String(turn.userId) !== String(userId)) return false;
  turn.controller.abort();
  return true;
};

const shortId = () => randomUUID().replaceAll('-', '').slice(0, 10);

const withTimeout = (promise, ms, signal) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'TOOL_TIMEOUT' })), ms);
    const onAbort = () => reject(Object.assign(new Error('stopped'), { name: 'AbortError' }));
    signal?.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    });
  });

/** What the model learns from a failed tool call: the message of a 4xx, never a stack. */
const toolError = (err, name) => {
  if (err?.code === 'TOOL_TIMEOUT')
    return { error: `${name} took too long`, hint: 'Narrow the time range or the filter' };
  if (err?.status && err.status < 500)
    return { error: err.message, ...(err.details ? { details: err.details } : {}) };
  logger.warn({ err, tool: name }, 'agent tool failed');
  return { error: `${name} failed: ${String(err?.message ?? err).slice(0, 200)}` };
};

/** zod check + run (or preview) with a timeout; never throws except on abort. */
export const execute = async ({ tool, args, ctx, io, mode = 'run' }) => {
  const started = Date.now();
  const parsed = tool.schema.safeParse(args ?? {});
  if (!parsed.success) {
    return { ms: 0, args, error: { error: 'Invalid arguments', issues: zodIssues(parsed.error) } };
  }
  try {
    const fn = mode === 'preview' ? tool.preview : tool.run;
    const value = await withTimeout(
      Promise.resolve(fn(ctx, parsed.data, io)),
      env.TOOL_TIMEOUT_MS,
      io.signal,
    );
    return { ms: Date.now() - started, args: parsed.data, value };
  } catch (err) {
    if (isAbort(err)) throw err;
    return { ms: Date.now() - started, args: parsed.data, error: toolError(err, tool.name) };
  }
};

/** Writes one AiToolAudit row for a tool call (args redacted). */
export const audit = (ctx, ids, name, outcome) =>
  AiToolAudit.create({
    companyId: ctx.companyId,
    userId: ctx.userId,
    ...ids,
    tool: name,
    args: redact(outcome.args ?? {}),
    durationMs: outcome.ms,
    rowCount: outcome.value?.rowCount,
    ok: !outcome.error && outcome.value?.ok !== false,
    error: outcome.error?.error,
  }).catch((err) => logger.warn({ err }, 'tool audit not written'));

const responsePart = (call, response) => ({
  functionResponse: { name: call.name, ...(call.id ? { id: call.id } : {}), response },
});

const textOf = (gemini) =>
  gemini
    .filter((c) => c.role === 'model')
    .flatMap((c) => c.parts.filter((p) => p.text && !p.thought).map((p) => p.text))
    .join('')
    .trim();

const addUsage = (total, raw) => {
  const u = normalizeUsage(raw ?? {});
  for (const key of ['prompt', 'thoughts', 'candidates', 'total']) total[key] = (total[key] ?? 0) + u[key];
};

/** The first words of a question: the title when no model can give one. */
const titleFrom = (userText) =>
  userText.trim().split(/\s+/).slice(0, 6).join(' ').slice(0, 60) || 'New conversation';

/** Short title from the router model; the first words of the question when that fails. */
const makeTitle = async (ctx, userText, answer) => {
  try {
    const llm = await getLlm();
    const { json } = await llm.generate({
      tier: 'router',
      purpose: 'title',
      companyId: ctx.companyId,
      system:
        'Give this conversation a short title: at most 6 words, no quotes, no trailing period. Return JSON { "title": string }.',
      contents: `User: ${userText.slice(0, 500)}\nSARA: ${answer.slice(0, 500)}`,
      schema: TITLE_SCHEMA,
      mockInput: { text: userText },
    });
    if (json?.title?.trim()) return json.title.trim().slice(0, 60);
  } catch (err) {
    logger.warn({ err: err.message }, 'title fell back to the question');
  }
  return titleFrom(userText);
};

const flatHistory = (turns) =>
  turns.flatMap((t) => [
    ...(t.user ? [{ role: 'user', text: t.user.text }] : []),
    ...(t.assistant ? [{ role: 'assistant', text: t.assistant.text }] : []),
  ]);

/**
 * Runs one turn and streams it over `sse` (phase 4 §5 events). A new turn saves the user message, routes
 * it and creates the assistant message; `continuation` (from `claimPendingAction`) runs the confirmed
 * write and continues the same assistant message. Resolves when the turn is persisted.
 */
export const runTurn = async ({
  ctx,
  conversation,
  userText,
  tier: pinnedTier,
  context,
  sse,
  signal,
  continuation,
}) => {
  const started = Date.now();
  const send = (event, data) => {
    if (!sse.closed) sse.send(event, data);
  };
  const available = groupsFor(ctx);
  let message;
  let decision;
  let text = userText;
  let gemini = [];
  const parts = [];

  if (continuation) {
    message = continuation.message;
    decision = message.routerDecision ?? { groups: [], confident: true };
    gemini = [...(message.gemini ?? [])];
    parts.push(...(message.parts ?? []));
    const user = await AiMessage.findOne({
      conversationId: conversation._id,
      role: 'user',
      createdAt: { $lte: message.createdAt },
    })
      .sort({ createdAt: -1, _id: -1 })
      .lean();
    text = user?.text ?? '';
  } else {
    await expirePendingActions(conversation._id);
    const turns = await loadTurns(conversation._id);
    await AiMessage.create({
      conversationId: conversation._id,
      companyId: ctx.companyId,
      userId: ctx.userId,
      role: 'user',
      text: userText,
      context: context ?? null,
    });
    const pinned = pinnedTier && pinnedTier !== 'auto' ? pinnedTier : conversation.tierPreference;
    decision = await route({
      ctx,
      conversation: { ...conversation, tierPreference: pinned },
      text: userText,
      history: flatHistory(turns),
    });
  }

  // A voice turn stores tier 'voice' (the Live model); its text continuation runs on a normal tier.
  let tier = continuation ? (TIERS.includes(message.tier) ? message.tier : 'balanced') : decision.tier;
  let info = await tierInfo(tier);
  const loaded = new Set(
    [...(conversation.loadedGroups ?? []), ...(decision.groups ?? [])].filter((g) => available.includes(g)),
  );
  const turnGroups = new Set(decision.confident === false ? available : loaded);
  if (continuation) turnGroups.add('write');

  if (!continuation) {
    message = (
      await AiMessage.create({
        conversationId: conversation._id,
        companyId: ctx.companyId,
        userId: ctx.userId,
        role: 'assistant',
        status: 'streaming',
        tier,
        model: info.model,
        thinkingLevel: info.thinkingLevel,
        routerDecision: decision,
        context: context ?? null,
      })
    ).toObject();
  }
  const ids = { conversationId: conversation._id, messageId: message._id };
  const controller = new AbortController();
  const timeout = AbortSignal.timeout(env.MAX_TURN_MS);
  const turnSignal = AbortSignal.any([controller.signal, timeout, ...(signal ? [signal] : [])]);
  active.set(String(message._id), { controller, userId: ctx.userId });

  const ui = (part) => {
    const prev = parts.at(-1);
    if ((part.type === 'thought' || part.type === 'text') && prev?.type === part.type) prev.text += part.text;
    // A text part that starts after a card or tool call (e.g. the answer after a confirm) needs no leading blank lines.
    else if (part.type !== 'text') parts.push(part);
    else if (part.text.trim()) parts.push({ ...part, text: part.text.trimStart() });
  };
  const emitBlocks = (blocks = []) => {
    for (const block of blocks) {
      const id = `b_${shortId()}`;
      const payload =
        block.type === 'file'
          ? { ...block.payload, url: `/api/export/${message._id}/${id}.csv` }
          : block.payload;
      parts.push({
        type: 'block',
        id,
        blockType: block.type,
        payload,
        ...(block.csv ? { csv: block.csv } : {}),
      });
      send('block', { id, type: block.type, payload });
    }
  };
  const notice = (noticeText) => {
    parts.push({ type: 'notice', text: noticeText });
    send('notice', { text: noticeText });
  };
  const toolResult = (ref, name, outcome) => {
    const ok = !outcome.error && outcome.value?.ok !== false;
    const event = {
      id: ref,
      name,
      ok,
      summary: outcome.error ? outcome.error.error : (outcome.value?.summary ?? ''),
      rowCount: outcome.value?.rowCount ?? null,
      ms: outcome.ms,
      ...(outcome.error ? { error: outcome.error.error } : {}),
    };
    parts.push({ type: 'tool_result', ...event });
    send('tool_result', event);
    if (!outcome.error) emitBlocks(outcome.value.blocks);
    audit(ctx, ids, name, outcome);
    return outcome.error ? { ref, ...outcome.error } : { ref, result: outcome.value.forModel };
  };

  send('meta', {
    conversationId: String(conversation._id),
    messageId: String(message._id),
    tier,
    model: info.model,
    thinkingLevel: info.thinkingLevel,
    routerDecision: decision,
  });

  const usage = { prompt: 0, thoughts: 0, candidates: 0, total: 0 };
  const results = new Map(); // ref → full ToolResult of this turn (render_* / export_csv sourceRef)
  const io = (callId) => ({ emit: send, signal: turnSignal, results, callId });
  let status = 'complete';
  let errorInfo = null;

  try {
    if (continuation) {
      const { action, tool } = continuation;
      // The confirmed write is not tied to the turn signal: a Stop or a dropped stream must not leave a
      // committed write that history and pendingAction report as never run. Only the model step after it stops.
      const outcome = await execute({
        tool,
        args: action.args,
        ctx,
        io: { ...io(action.callId), signal: undefined },
      });
      if (outcome.value) results.set(action.callId, outcome.value);
      const answer = toolResult(action.callId, tool.name, outcome);
      const response = outcome.error ? { status: 'failed', ...answer } : { status: 'confirmed', ...answer };
      gemini.push(stepResponses(action, response));
      await AiMessage.updateOne(
        { _id: message._id },
        {
          $set: {
            'pendingAction.result': {
              ok: !outcome.error,
              summary: outcome.value?.summary ?? outcome.error?.error,
            },
          },
        },
      );
    }

    const history = await buildContents(conversation, { exclude: message._id });
    const system = await buildSystemPrompt({ ctx, conversation, context, groups: [...turnGroups] });
    const llm = await getLlm();
    let iterations = 0;
    let escalated = false;
    let retried = false;
    const turnModel = continuation ? message.model : null;

    for (;;) {
      const final = iterations >= env.MAX_TOOL_ITERATIONS;
      const tools = final ? [] : toolsFor(ctx, [...turnGroups]);
      const allowed = new Set(tools.map((t) => t.name));
      const contents = [...history, ...gemini.map(replayContent)];
      // Signatures of another model (a continuation on a new model, or a mid-turn fallback) fail validation.
      if ((turnModel && turnModel !== info.model) || retried) relaxSignatures(contents);
      const stepParts = [];
      const mark = parts.length;
      const tailText = parts.at(-1)?.text;
      let stepUsage;
      try {
        const stream = llm.generateStream({
          tier,
          purpose: 'chat',
          companyId: ctx.companyId,
          system: final
            ? `${system}\n\nThe tool budget of this answer is used up: answer now with what you have.`
            : system,
          contents,
          tools: tools.length ? [{ functionDeclarations: tools.map(toDeclaration) }] : undefined,
          signal: turnSignal,
          mockInput: { text },
          onAttempt: (attempt) => {
            if (attempt.fallbackFrom)
              notice(`${attempt.fallbackFrom} is busy, so ${attempt.model} answers this one.`);
            info = {
              ...info,
              model: attempt.model,
              thinkingLevel: attempt.thinkingLevel ?? info.thinkingLevel,
            };
          },
        });
        for await (const chunk of stream) {
          if (turnSignal.aborted) break;
          if (chunk.usageMetadata) stepUsage = chunk.usageMetadata;
          for (const part of chunk.candidates?.[0]?.content?.parts ?? []) {
            if (part.functionCall || (typeof part.text !== 'string' && !part.thoughtSignature)) {
              stepParts.push({ ...part });
              continue;
            }
            const piece = part.text ?? '';
            if (piece) {
              ui({ type: part.thought ? 'thought' : 'text', text: piece });
              send(part.thought ? 'thought' : 'delta', { text: piece });
            }
            const prev = stepParts.at(-1);
            const sameKind =
              prev &&
              typeof prev.text === 'string' &&
              !prev.functionCall &&
              Boolean(prev.thought) === Boolean(part.thought);
            if (sameKind && !prev.thoughtSignature) {
              prev.text += piece;
              if (part.thoughtSignature) prev.thoughtSignature = part.thoughtSignature;
            } else stepParts.push({ ...part, text: piece });
          }
        }
        addUsage(usage, stepUsage);
      } catch (err) {
        if (turnSignal.aborted || isAbort(err)) break;
        const code = aiErrorCode(err);
        if (!code || retried) throw err;
        retried = true;
        parts.splice(mark); // drop the half-streamed text of the failed attempt
        if (tailText !== undefined) parts[mark - 1].text = tailText;
        tier = FALLBACK_TIER[tier] ?? 'fast';
        info = await tierInfo(tier);
        notice(
          code === 'AI_QUOTA'
            ? `The AI is busy; trying again on the ${tier} tier.`
            : `The AI stumbled; trying again on the ${tier} tier.`,
        );
        continue;
      }
      if (turnSignal.aborted) {
        if (stepParts.length) gemini.push({ role: 'model', parts: stepParts.filter((p) => !p.functionCall) });
        break;
      }

      let calls = stepParts.filter((p) => p.functionCall);
      const modelParts = final ? stepParts.filter((p) => !p.functionCall) : stepParts;
      if (modelParts.length) gemini.push({ role: 'model', parts: modelParts });
      if (final && calls.length) {
        notice(`I stopped after ${env.MAX_TOOL_ITERATIONS} rounds of lookups for one answer.`);
        calls = [];
      }

      if (!calls.length) {
        const answer = textOf(gemini);
        if (!continuation && !escalated && tier !== 'deep' && STUCK.test(answer)) {
          escalated = true;
          const event = {
            from: tier,
            to: 'deep',
            reason: 'The first answer was not sure, so a deeper model tries again',
          };
          parts.push({ type: 'escalated', ...event });
          send('escalated', event);
          tier = 'deep';
          info = await tierInfo('deep');
          gemini = [];
          iterations = 0;
          continue;
        }
        break;
      }

      const responses = [];
      let pending = null;
      for (const [index, part] of calls.entries()) {
        const call = part.functionCall;
        const ref = call.id ?? `t_${shortId()}`;
        parts.push({ type: 'tool_call', id: ref, name: call.name, args: call.args ?? {} });
        send('tool_call', { id: ref, name: call.name, args: call.args ?? {} });
        const known = getTool(call.name);
        const tool = known && toolsFor(ctx, [known.group]).includes(known) ? known : null;
        if (tool && !allowed.has(tool.name)) {
          // A permitted tool of a group the model did not load: load it now instead of a load_tools round trip.
          turnGroups.add(tool.group);
          loaded.add(tool.group);
        }
        if (!tool) {
          const error = known
            ? {
                error: `${call.name} is not available to ${ctx.user?.name ?? 'this user'} (role ${ctx.role})`,
                hint: 'Explain this to the user and offer to draft the details instead',
              }
            : { error: `Unknown tool "${call.name}"`, hint: 'Use one of the declared tools' };
          responses.push(responsePart(call, toolResult(ref, call.name, { ms: 0, args: call.args, error })));
          continue;
        }
        if (tool.requiresConfirmation) {
          if (pending) {
            const error = {
              error: 'one change at a time',
              hint: 'Ask for this change again after the user confirms the first one',
            };
            responses.push(responsePart(call, toolResult(ref, call.name, { ms: 0, args: call.args, error })));
            continue;
          }
          const outcome = await execute({ tool, args: call.args, ctx, io: io(ref), mode: 'preview' });
          if (outcome.error) {
            responses.push(responsePart(call, toolResult(ref, call.name, outcome)));
            continue;
          }
          pending = { call, ref, index, tool, args: outcome.args, preview: outcome.value };
          continue;
        }
        const outcome = await execute({ tool, args: call.args, ctx, io: io(ref) });
        if (outcome.value) results.set(ref, outcome.value);
        if (tool.name === 'load_tools' && outcome.value) {
          const [ok, refused] = [
            outcome.args.groups.filter((g) => available.includes(g)),
            outcome.args.groups.filter((g) => !available.includes(g)),
          ];
          for (const g of ok) {
            turnGroups.add(g);
            loaded.add(g);
          }
          if (refused.length) {
            outcome.value.forModel = {
              loaded: ok,
              notAvailable: refused,
              note: 'Groups in notAvailable are switched off for this company or not allowed for this user',
            };
          }
        }
        responses.push(responsePart(call, toolResult(ref, call.name, outcome)));
      }

      if (pending) {
        const action = await createPendingAction(message, {
          tool: pending.tool.name,
          args: pending.args,
          callId: pending.ref,
          geminiId: pending.call.id,
          callIndex: pending.index,
          siblingResponses: responses,
          preview: pending.preview.payload,
        });
        emitBlocks([
          {
            type: 'confirm',
            payload: {
              ...pending.preview.payload,
              actionId: action.id,
              expiresAt: action.expiresAt,
              status: 'pending',
            },
          },
        ]);
        message.pendingAction = action;
        status = 'awaiting_confirmation';
        break;
      }
      gemini.push({ role: 'user', parts: responses });
      if (calls.some((p) => p.functionCall.name !== 'load_tools')) iterations++;
    }

    if (turnSignal.aborted) {
      status = 'stopped';
      if (timeout.aborted) notice('That took too long, so I stopped. Try a narrower question.');
    }
  } catch (err) {
    if (turnSignal.aborted || isAbort(err)) status = 'stopped';
    else {
      status = 'error';
      const code = aiErrorCode(err);
      errorInfo = {
        code: code ?? err.code ?? 'AGENT_ERROR',
        message: code
          ? friendlyAiError(err)
          : err.status && err.status < 500
            ? err.message
            : 'Something went wrong while answering. Please try again.',
      };
      if (!code) logger.error({ err }, 'chat turn failed');
    }
  } finally {
    active.delete(String(message._id));
  }

  const answer = textOf(gemini);
  const latencyMs = Date.now() - started;
  const totalUsage = continuation
    ? Object.fromEntries(Object.entries(usage).map(([k, v]) => [k, v + (message.usage?.[k] ?? 0)]))
    : usage;
  await AiMessage.updateOne(
    { _id: message._id },
    {
      $set: {
        text: answer,
        parts,
        gemini,
        usage: totalUsage,
        latencyMs,
        status,
        tier,
        model: info.model,
        thinkingLevel: info.thinkingLevel,
      },
    },
  );
  await AiConversation.updateOne(
    { _id: conversation._id },
    { $set: { lastMessageAt: new Date() }, $addToSet: { loadedGroups: { $each: [...loaded] } } },
  );
  send('usage', { ...totalUsage, latencyMs });

  if (!conversation.title) {
    // A failed turn still gets a title, from the question itself: no model call while the AI is failing.
    const title = status === 'error' ? titleFrom(text) : await makeTitle(ctx, text, answer);
    await AiConversation.updateOne({ _id: conversation._id }, { $set: { title } });
    conversation.title = title;
    send('title', { title });
  }
  if (errorInfo) send('error', errorInfo);
  send('done', {
    messageId: String(message._id),
    status,
    ...(status === 'awaiting_confirmation' ? { pendingAction: publicAction(message.pendingAction) } : {}),
  });
  if (!continuation) summarizeOlderTurns(conversation).catch(() => {});
  return { messageId: String(message._id), status, text: answer };
};

/** A pending action as the client sees it (no sibling responses or Gemini ids). */
export const publicAction = (action) =>
  action && {
    id: action.id,
    tool: action.tool,
    args: action.args,
    callId: action.callId,
    preview: action.preview,
    status: action.status,
    expiresAt: action.expiresAt,
    result: action.result ?? null,
  };
