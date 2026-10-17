import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { friendlyAiError, isAbort } from '../agent/llm.js';
import { audit, callKey, execute, publicAction, storedRows, TOOL_BUDGET_MESSAGE } from '../agent/loop.js';
import {
  claimPendingAction,
  createPendingAction,
  expirePendingActions,
  rejectPendingAction,
  stepResponses,
} from '../agent/pendingActions.js';
import { columnsOf } from '../agent/tools/common.js';
import { getTool, unknownToolError } from '../agent/tools/registry.js';
import { recordUsage } from '../ai/budget.js';
import { getAiSettings } from '../ai/settings.js';
import { stillSignedIn } from '../auth/middleware.js';
import { env } from '../config/env.js';
import { AiConversation } from '../db/models/AiConversation.js';
import { AiMessage } from '../db/models/AiMessage.js';
import { logger } from '../lib/logger.js';
import { getModule } from '../modules/registry.js';
import { addLiveUsage, buildLiveConfig, clean, openLive } from './liveClient.js';
import { closeTurn, ensureConversation, flushRound, openTurn } from './persist.js';
import { buildVoicePrompt } from './prompt.js';
import {
  AUDIO_IN_BURST,
  AUDIO_IN_RATE,
  AUDIO_OVERRUN_MS,
  CLOSE_CODES,
  IDLE_SEC,
  INPUT_RATE,
  LATE_TRANSCRIPT_MS,
  MAX_CLIENT_BUFFER,
  MAX_TEXT_CHARS,
  OUTPUT_RATE,
  parseClientMessage,
  RECONNECT_WINDOW_MS,
  RESUME_BUFFER_MS,
  REVALIDATE_MS,
  stripAppNote,
  VoiceError,
} from './protocol.js';
import { CONTROL_NAMES, resolveVoiceTool, VOICE_ERRORS, voiceDeclarations } from './tools.js';

/**
 * One voice session (phase 8 §3.4–3.5): a browser socket, an authenticated user and one Gemini Live connection
 * (replaced on resumption). Turn bookkeeping is synchronous; Mongo writes and tool runs go through one queue,
 * so they land in order. Audio is relayed, counted and never stored.
 */

const OPEN = 1; // ws readyState
const IN_BYTES_PER_SEC = INPUT_RATE * 2;
const OUT_BYTES_PER_SEC = OUTPUT_RATE * 2;
const SKIP_SIGNATURE = 'skip_thought_signature_validator';
const MAX_TIMER_MS = 2 ** 31 - 1;

const zeroUsage = () => ({ prompt: 0, thoughts: 0, candidates: 0, total: 0 });
const shortId = () => randomUUID().replaceAll('-', '').slice(0, 10);
const newId = () => new mongoose.Types.ObjectId();
const round1 = (n) => Math.round(n * 10) / 10;
const responsePart = (call, response) => ({
  functionResponse: { name: call.name, ...(call.id ? { id: call.id } : {}), response },
});

// ponytail: per-process typed-text counter (like the chat's in-memory rate limit); Redis if SARA scales out.
const textStamps = new Map();
const textAllowed = (userId) => {
  const now = Date.now();
  const stamps = (textStamps.get(userId) ?? []).filter((t) => now - t < 60_000);
  textStamps.set(userId, stamps);
  if (stamps.length >= env.RATE_LIMIT_MESSAGES_PER_MIN) return false;
  stamps.push(now);
  return true;
};

/** Chat-shaped block parts and their browser payloads (same ids and export urls as the chat loop). */
const blockParts = (messageId, blocks = []) =>
  blocks.map((block) => {
    const id = `b_${shortId()}`;
    const payload =
      block.type === 'file' ? { ...block.payload, url: `/api/export/${messageId}/${id}.csv` } : block.payload;
    return {
      part: { type: 'block', id, blockType: block.type, payload, ...(block.csv ? { csv: block.csv } : {}) },
      event: { id, type: block.type, payload },
    };
  });

/** The spoken answer claims something is on the screen (English, Hindi, Hinglish). */
const CLAIMS_SCREEN = /\b(screen|showing|shown|here are|listed|opened)\b|स्क्रीन|दिखा|दिख रह/i;
const MAX_NET_ROWS = 1000;

/**
 * Safety net (phase 8 §3.4): the last tool result of the turn that carried rows, as a table block, for a turn
 * that said "on your screen" without calling render_*; null when nothing was looked up.
 */
export const fallbackTable = (turn) => {
  if (turn.blocks || !CLAIMS_SCREEN.test(turn.text)) return null;
  for (const value of [...turn.results.values()].reverse()) {
    const data = value?.data;
    const rows = data?.rows ?? (Array.isArray(data) ? data : null);
    if (!rows?.length) continue;
    return {
      type: 'table',
      payload: {
        title: value.summary || 'Details',
        columns: data.columns ?? columnsOf(rows),
        rows: rows.slice(0, MAX_NET_ROWS),
      },
    };
  }
  return null;
};

/** The tool_result event of an outcome (as the chat loop sends it). */
const resultEvent = (ref, name, outcome) => ({
  id: ref,
  name,
  ok: !outcome.error && outcome.value?.ok !== false,
  summary: outcome.error ? outcome.error.error : (outcome.value?.summary ?? ''),
  rowCount: outcome.value?.rowCount ?? null,
  ms: outcome.ms,
  ...(outcome.error ? { error: outcome.error.error } : {}),
});

/** One voice session: a browser socket, an authenticated user and one Live connection (replaced on resumption). */
export const createVoiceSession = ({ socket, auth, start, settings, onClose }) => {
  const ctx = auth.ctx;
  const id = randomUUID();
  const userId = String(ctx.userId);
  const voice = settings.voice;
  const language = start.language ?? voice.languageCode;
  const voiceName = start.voice ?? voice.voiceName;
  const context = start.context ?? null;
  const startedAt = Date.now();
  const maxMs = voice.maxSessionMin * 60_000;

  let conversationId = null; // announced in turn_start before the conversation is written
  let conversation = null;
  let system = '';
  let declarations = [];
  let live = null; // { session, model, connectMs, mock, usage, audioSec, retired, recorded }
  const connections = [];
  let handle = null;
  let resuming = null;
  let resumeWanted = false;
  let resumeAudio = [];
  let isReady = false;
  let muted = false;
  let closed = false;
  let ending = null;
  let current = null; // the open turn
  let lastClosed = null;
  let outputSinceClose = false;
  let nextInput = null; // user input that belongs to the turn after the open one
  let seq = 0;
  let toolCalls = 0;
  let latestAction = null; // { id, messageId, turnId, turnSeq, label }
  let lastUserAt = null;
  let lastDropAt = -Infinity; // last unexpected Gemini close that was reconnected
  let audioBudget = AUDIO_IN_BURST; // token bucket for browser audio bytes
  let audioAt = Date.now();
  let overrun = null; // { since, last } while audio arrives faster than AUDIO_IN_RATE
  const cancelled = new Set();
  const turns = new Map();
  const timers = [];
  let idleTimer = null;
  let chain = Promise.resolve();

  const send = (type, payload = {}) => {
    if (socket.readyState === OPEN) socket.send(JSON.stringify({ type, ...payload }));
  };
  const enqueue = (fn) => {
    chain = chain.then(fn).catch((err) => {
      if (!isAbort(err)) logger.error({ err, sessionId: id }, 'voice step failed');
    });
    return chain;
  };
  const touch = () => {
    if (!isReady || closed) return;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => end('idle'), IDLE_SEC * 1000);
  };
  const toLive = (fn) => {
    const run = () => {
      if (closed || !live) return;
      try {
        fn(live.session);
      } catch (err) {
        logger.warn({ err: err.message, sessionId: id }, 'voice send to Gemini failed');
      }
    };
    return resuming ? resuming.then(run) : run();
  };
  const notice = (turn, text, { store = true } = {}) => {
    if (turn && store) turn.parts.push({ type: 'notice', text });
    send('notice', { turnId: turn?.id ?? null, data: { text } });
  };
  const totals = () => {
    const usage = zeroUsage();
    const audioSec = { in: 0, out: 0 };
    for (const c of connections) {
      for (const k of Object.keys(usage)) usage[k] += c.usage[k];
      audioSec.in += c.audioSec.in;
      audioSec.out += c.audioSec.out;
    }
    return { ...usage, audioSec: { in: round1(audioSec.in), out: round1(audioSec.out) } };
  };
  const sendUsage = () =>
    send('usage', { ...totals(), seconds: Math.round((Date.now() - startedAt) / 1000) });

  // ── turns ──────────────────────────────────────────────────────────────────────────────────────────

  const newTurn = ({ userText = '', typed = false } = {}) => {
    seq += 1;
    conversationId ??= newId();
    const turn = {
      id: `t${seq}`,
      seq,
      conversationId,
      userMessageId: newId(),
      messageId: newId(),
      userText,
      typed,
      userDone: typed,
      answered: false,
      audioStarted: false,
      text: '',
      parts: [],
      blocks: 0,
      usage: zeroUsage(),
      status: 'complete',
      pending: false,
      awaiting: false,
      dropped: false,
      slowNotice: false,
      rounds: 0,
      outstanding: 0,
      latencyMs: null,
      results: new Map(),
      cache: new Map(),
      controller: new AbortController(),
    };
    current = turn;
    turns.set(turn.id, turn);
    touch();
    send('turn_start', {
      turnId: turn.id,
      conversationId: String(conversationId),
      messageId: String(turn.messageId),
      user: typed ? userText : null,
    });
    const model = live?.model;
    enqueue(async () => {
      conversation ??= await ensureConversation(ctx, { conversationId });
      await openTurn(ctx, conversation, {
        userText,
        context,
        model,
        userMessageId: turn.userMessageId,
        messageId: turn.messageId,
      });
    });
    return turn;
  };

  const userTranscript = (turn, text, final) => {
    turn.userText += text;
    send('transcript', { turnId: turn.id, role: 'user', text, final });
  };

  const closeCurrent = (status) => {
    const turn = current;
    if (!turn) return;
    current = null;
    lastClosed = turn;
    turn.closedAt = Date.now();
    outputSinceClose = false;
    enqueue(async () => {
      // After the queued tool rounds: the model said "on your screen" but rendered nothing → show its last rows.
      const net = fallbackTable(turn);
      if (net) emitBlocks(turn, [net]);
      await closeTurn(turn, {
        userText: turn.userText.trim(),
        text: turn.text.trim(),
        parts: turn.parts.splice(0),
        usage: turn.usage,
        latencyMs: turn.latencyMs,
        status,
        pending: turn.pending,
      });
      send('turn_complete', {
        turnId: turn.id,
        messageId: String(turn.messageId),
        conversationId: String(turn.conversationId),
        status: turn.awaiting ? 'awaiting_confirmation' : status,
        latencyMs: turn.latencyMs,
      });
      sendUsage();
    });
    if (closed) return;
    if (nextInput) {
      const next = nextInput;
      nextInput = null;
      const t = newTurn({ userText: next.typed ?? '', typed: next.typed != null });
      if (next.speech) userTranscript(t, next.speech, next.final);
      t.userDone = t.userDone || next.final;
    }
    if (resumeWanted) resume();
  };

  /** The turn model output belongs to (opened when none is); marks output since the last close. */
  const modelTurn = () => {
    outputSinceClose = true;
    touch();
    const turn = current ?? newTurn();
    turn.answered = true;
    return turn;
  };

  const onUserSpeech = (text, final) => {
    touch();
    lastUserAt = Date.now();
    if (current) {
      if (!current.userDone) {
        userTranscript(current, text, final);
        if (final) current.userDone = true;
        return;
      }
      nextInput ??= { speech: '', typed: null, final: false };
      nextInput.speech += text;
      nextInput.final = final;
      return;
    }
    const late = lastClosed;
    // Speech after `interrupted` or a finished chunk (userDone) belongs to the next turn, never the closed one.
    if (late && !late.userDone && !outputSinceClose && Date.now() - late.closedAt <= LATE_TRANSCRIPT_MS) {
      userTranscript(late, text, final);
      enqueue(() =>
        AiMessage.updateOne(
          { _id: late.userMessageId },
          { $set: { text: late.userText.trim() || '(voice message)' } },
        ),
      );
      return;
    }
    const turn = newTurn();
    userTranscript(turn, text, final);
    turn.userDone = final;
  };

  const onAudioOut = (conn, b64) => {
    const buf = Buffer.from(b64, 'base64');
    conn.audioSec.out += buf.length / OUT_BYTES_PER_SEC;
    const turn = modelTurn();
    if (turn.dropped) return;
    if (!turn.audioStarted) {
      turn.audioStarted = true;
      turn.latencyMs = lastUserAt ? Date.now() - lastUserAt : null;
    }
    if (socket.bufferedAmount > MAX_CLIENT_BUFFER) {
      if (!turn.slowNotice) {
        turn.slowNotice = true;
        notice(turn, "The connection is slow, so some of SARA's audio was skipped.", { store: false });
      }
      return;
    }
    if (socket.readyState === OPEN) socket.send(buf, { binary: true });
  };

  const onAssistantText = (text) => {
    const turn = modelTurn();
    if (turn.dropped) return;
    turn.text += text;
    const prev = turn.parts.at(-1);
    if (prev?.type === 'text') prev.text += text;
    else if (text.trim()) turn.parts.push({ type: 'text', text: text.trimStart() });
    send('transcript', { turnId: turn.id, role: 'assistant', text, final: false });
  };

  /** Typed text, or a click's `Confirmed: …` line: shown as the user's words, `toGemini` goes to Live. */
  const userInput = ({ display, toGemini }) => {
    touch();
    lastUserAt = Date.now();
    lastClosed = null;
    if (current && !current.answered) {
      const sep = current.userText.trim() ? ' ' : '';
      userTranscript(current, `${sep}${display}`, true);
      current.userDone = true;
    } else if (current) {
      nextInput = { speech: nextInput?.speech ?? '', typed: display, final: true };
    } else newTurn({ userText: display, typed: true });
    return toLive((s) => s.sendRealtimeInput({ text: toGemini }));
  };

  // ── tools and pending actions ────────────────────────────────────────────────────────────────────────

  const io = (turn, ref) => ({
    emit: () => {},
    signal: turn.controller.signal,
    results: turn.results,
    callId: ref,
    conversationId: turn.conversationId,
    context,
  });

  /** Stores and sends blocks on a turn (counted, so the safety net knows something is on the screen). */
  const emitBlocks = (turn, blocks) => {
    for (const { part, event } of blockParts(turn.messageId, blocks)) {
      turn.parts.push(part);
      turn.blocks += 1;
      send('block', { turnId: turn.id, data: event });
      // F3: open_page also goes out as its own message so the browser navigates at once.
      if (event.type === 'navigate') send('navigate', { turnId: turn.id, data: event.payload });
    }
  };

  const toolResult = (turn, ref, name, outcome) => {
    const event = { ...resultEvent(ref, name, outcome), ...(outcome.cached ? { cached: true } : {}) };
    const data = outcome.cached ? null : storedRows(outcome.value);
    turn.parts.push({ type: 'tool_result', ...event, ...(data ? { data } : {}) });
    send('tool_result', { turnId: turn.id, data: event });
    if (!outcome.error && !outcome.cached) emitBlocks(turn, outcome.value.blocks);
    if (!outcome.cached)
      audit(ctx, { conversationId: turn.conversationId, messageId: turn.messageId }, name, outcome);
    return outcome.error ? { ref, ...outcome.error } : { ref, result: outcome.value.forModel };
  };

  /** Confirms or rejects `latestAction` (§3.4); `{ response }` for the model, `{ error }` for a click. */
  const settleAction = async (kind, via) => {
    const target = latestAction;
    const conv = { _id: conversationId };
    const turn = target.turnId ? turns.get(target.turnId) : null;
    const turnId = turn?.id ?? current?.id ?? null;
    try {
      if (kind === 'reject') {
        const action = await rejectPendingAction({ conversation: conv, actionId: target.id });
        latestAction = null;
        if (turn) turn.awaiting = false;
        send('confirm', {
          turnId,
          action: publicAction({ ...action, status: 'rejected', result: { status: 'rejected' } }),
        });
        return { response: { status: 'rejected' } };
      }
      const { message, action, tool } = await claimPendingAction({
        ctx,
        conversation: conv,
        actionId: target.id,
      });
      latestAction = null;
      if (turn) turn.awaiting = false;
      // Never tied to a turn or stop signal: a committed write must be recorded (as in chat).
      const outcome = await execute({
        tool,
        args: action.args,
        ctx,
        io: { emit: () => {}, signal: undefined, results: new Map(), callId: action.callId },
      });
      const event = resultEvent(action.callId, tool.name, outcome);
      const blocks = outcome.error ? [] : blockParts(message._id, outcome.value.blocks);
      const ok = event.ok;
      const summary = outcome.value?.summary ?? outcome.error?.error;
      const answer = outcome.error
        ? { status: 'failed', ref: action.callId, ...outcome.error }
        : { status: 'confirmed', ref: action.callId, result: outcome.value.forModel };
      await AiMessage.updateOne(
        { _id: message._id },
        {
          $push: {
            parts: {
              $each: [
                { type: 'tool_result', ...event },
                ...blocks.map((b) => b.part),
                { type: 'notice', text: via === 'voice' ? 'Confirmed by voice' : 'Confirmed on screen' },
              ],
            },
            gemini: stepResponses(action, answer),
          },
          $set: { 'pendingAction.result': { ok, summary }, 'pendingAction.via': via, status: 'complete' },
        },
      );
      audit(ctx, { conversationId, messageId: message._id }, tool.name, outcome);
      if (turn) {
        send('tool_result', { turnId: turn.id, data: event });
        for (const b of blocks) send('block', { turnId: turn.id, data: b.event });
      } else if (current) {
        notice(current, `Confirmed: ${target.label} — ${summary}`);
      } else send('notice', { turnId: null, data: { text: `Confirmed: ${target.label} — ${summary}` } });
      send('confirm', {
        turnId,
        action: publicAction({ ...action, status: 'confirmed', result: { ok, summary } }),
      });
      return {
        response: outcome.error
          ? { status: 'failed', ...outcome.error }
          : { status: 'confirmed', summary, result: outcome.value.forModel },
        summary,
      };
    } catch (err) {
      if (err.status === 403)
        return {
          response: { status: 'forbidden', error: err.message },
          error: { code: 'FORBIDDEN', message: err.message },
        };
      if (err.status === 404 || err.status === 410) {
        latestAction = null;
        if (turn) turn.awaiting = false;
        // Expired or handled elsewhere (another tab, Chat): the card shows the stored outcome, not a live countdown.
        const stored = await AiMessage.findOne({ _id: target.messageId }, { pendingAction: 1 }).lean();
        if (stored?.pendingAction) send('confirm', { turnId, action: publicAction(stored.pendingAction) });
        return {
          response: { status: 'gone', error: err.message },
          error: { code: 'ACTION_GONE', message: err.message },
        };
      }
      throw err;
    }
  };

  /**
   * Runs one toolCall message (§3.3): control calls, reads, the first write as a pending action; one
   * sendToolResponse in call order; the round stored like chat (the write call left unanswered).
   */
  // ponytail: mirrors agent/loop.js call dispatch; extract a shared dispatcher if a third caller appears.
  const dispatch = async (turn, calls) => {
    const overBudget = turn.rounds >= env.MAX_TOOL_ITERATIONS;
    let fresh = false; // a tool actually ran this round (cached repeats are free)
    const blockedByPending = turn.pending;
    const answers = new Array(calls.length).fill(null);
    const stored = [];
    let write = null;
    for (const [i, raw] of calls.entries()) {
      if (cancelled.has(raw.id) || closed) continue;
      const call = { id: raw.id ?? `t_${shortId()}`, name: raw.name, args: raw.args ?? {} };
      if (CONTROL_NAMES.has(call.name)) {
        const ok = latestAction && call.args.actionId === latestAction.id && turn.seq > latestAction.turnSeq;
        answers[i] = ok
          ? (await settleAction(call.name === 'confirm_action' ? 'confirm' : 'reject', 'voice')).response
          : VOICE_ERRORS.noAction;
        continue;
      }
      if (blockedByPending) {
        answers[i] = VOICE_ERRORS.waiting;
        continue;
      }
      turn.parts.push({ type: 'tool_call', id: call.id, name: call.name, args: call.args });
      send('tool_call', { turnId: turn.id, data: { id: call.id, name: call.name, args: call.args } });
      toolCalls += 1;
      const entry = { call, response: null, i };
      stored.push(entry);
      const resolved = resolveVoiceTool(ctx, call.name);
      const tool = resolved.tool;
      const error = resolved.error && !getTool(call.name) ? unknownToolError(call.name) : resolved.error;
      let outcome;
      if (error) outcome = { ms: 0, args: call.args, error };
      else if (overBudget) outcome = { ms: 0, args: call.args, error: { error: TOOL_BUDGET_MESSAGE } };
      else if (tool.requiresConfirmation && write)
        outcome = { ms: 0, args: call.args, error: VOICE_ERRORS.oneChange };
      else if (tool.requiresConfirmation) {
        outcome = await execute({ tool, args: call.args, ctx, io: io(turn, call.id), mode: 'preview' });
        if (!outcome.error) {
          write = { entry, tool, args: outcome.args, payload: outcome.value.payload };
          continue;
        }
      } else {
        const key = callKey(tool.name, call.args);
        const hit = turn.cache.get(key);
        if (hit) {
          hit.hits += 1;
          outcome = { ...hit.outcome, ms: 0, cached: true };
          if (hit.hits > 1) fresh = true;
        } else {
          outcome = await execute({ tool, args: call.args, ctx, io: io(turn, call.id) });
          if (!outcome.error) turn.cache.set(key, { outcome, hits: 0 });
          fresh = true;
        }
        if (outcome.value) turn.results.set(call.id, outcome.value);
      }
      entry.response = toolResult(turn, call.id, call.name, outcome);
      answers[i] = entry.response;
    }
    if (fresh) turn.rounds += 1;

    const keep = stored.filter((e) => !cancelled.has(e.call.id));
    if (write && !keep.includes(write.entry)) write = null; // cancelled: no pending action
    const modelContent = keep.length
      ? {
          role: 'model',
          parts: keep.map((e, k) => ({
            functionCall: { id: e.call.id, name: e.call.name, args: e.call.args },
            ...(k === 0 ? { thoughtSignature: SKIP_SIGNATURE } : {}),
          })),
        }
      : null;
    if (write) {
      const { entry, payload } = write;
      await expirePendingActions(turn.conversationId);
      // The write call stays unanswered in storage, exactly like chat: confirm / reject / expiry answer it.
      await flushRound(turn.messageId, { parts: turn.parts.splice(0), gemini: [modelContent] });
      const action = await createPendingAction(
        { _id: turn.messageId },
        {
          tool: write.tool.name,
          args: write.args,
          callId: entry.call.id,
          geminiId: entry.call.id,
          callIndex: keep.indexOf(entry),
          siblingResponses: keep.filter((e) => e !== entry).map((e) => responsePart(e.call, e.response)),
          preview: payload,
        },
      );
      emitBlocks(turn, [
        {
          type: 'confirm',
          payload: { ...payload, actionId: action.id, expiresAt: action.expiresAt, status: 'pending' },
        },
      ]);
      await flushRound(turn.messageId, { parts: turn.parts.splice(0) });
      send('confirm', { turnId: turn.id, action: publicAction(action) });
      turn.pending = true;
      turn.awaiting = true;
      latestAction = {
        id: action.id,
        messageId: turn.messageId,
        turnId: turn.id,
        turnSeq: turn.seq,
        label: payload.label,
      };
      answers[entry.i] = {
        status: 'awaiting_confirmation',
        actionId: action.id,
        label: payload.label,
        expiresInMin: env.PENDING_ACTION_TTL_MIN,
        next: 'Say what will change in one sentence and ask the user to confirm. Call confirm_action only after they clearly agree.',
      };
    } else if (modelContent) {
      await flushRound(turn.messageId, {
        parts: turn.parts.splice(0),
        gemini: [modelContent, { role: 'user', parts: keep.map((e) => responsePart(e.call, e.response)) }],
      });
    }
    const functionResponses = calls
      .map(
        (call, i) =>
          answers[i] && !cancelled.has(call.id) && { id: call.id, name: call.name, response: answers[i] },
      )
      .filter(Boolean);
    if (functionResponses.length) await toLive((s) => s.sendToolResponse({ functionResponses }));
  };

  const onToolCall = (calls) => {
    const turn = modelTurn();
    turn.outstanding += 1;
    enqueue(async () => {
      try {
        await dispatch(turn, calls);
      } finally {
        turn.outstanding -= 1;
      }
    });
  };

  /** Browser Confirm / Reject on the card: same guards minus the turn rule, then an App note to Live. */
  const onClick = (kind, actionId) =>
    enqueue(async () => {
      if (!latestAction || latestAction.id !== actionId) {
        send('error', {
          code: 'ACTION_NOT_FOUND',
          message: 'That change is no longer waiting for an answer.',
          fatal: false,
        });
        return;
      }
      const { label } = latestAction;
      const { error, summary } = await settleAction(kind, 'click');
      if (error) {
        send('error', { ...error, fatal: false });
        return;
      }
      userInput(
        kind === 'confirm'
          ? {
              display: `Confirmed: ${label}`,
              toGemini: `App note: the user confirmed "${label}" on screen. Result: ${summary}. Tell them in one short sentence.`,
            }
          : {
              display: `Rejected: ${label}`,
              toGemini: `App note: the user rejected "${label}" on screen; nothing was saved. Acknowledge briefly.`,
            },
      );
    });

  // ── Live connection ─────────────────────────────────────────────────────────────────────────────────

  const recordConn = async (conn) => {
    if (conn.recorded || !conn.model) return;
    conn.recorded = true;
    await recordUsage({
      model: conn.model,
      purpose: 'voice',
      companyId: ctx.companyId,
      status: conn.mock ? 'mock' : 'ok',
      usage: conn.usage,
      latencyMs: conn.connectMs,
      audioSec: { in: round1(conn.audioSec.in), out: round1(conn.audioSec.out) },
    }).catch((err) => logger.warn({ err: err.message }, 'voice usage not recorded'));
  };

  const onLive = (conn, msg) => {
    if (closed || conn.retired) return;
    if (msg.usageMetadata) {
      addLiveUsage(conn.usage, msg.usageMetadata);
      if (current) addLiveUsage(current.usage, msg.usageMetadata);
    }
    const update = msg.sessionResumptionUpdate;
    if (update?.resumable && update.newHandle) handle = update.newHandle;
    for (const callId of msg.toolCallCancellation?.ids ?? []) cancelled.add(callId);
    const sc = msg.serverContent;
    if (sc?.inputTranscription?.text)
      onUserSpeech(sc.inputTranscription.text, Boolean(sc.inputTranscription.finished));
    for (const part of sc?.modelTurn?.parts ?? []) {
      if (part.inlineData?.data && /^audio\//.test(part.inlineData.mimeType ?? ''))
        onAudioOut(conn, part.inlineData.data);
    }
    if (sc?.outputTranscription?.text) onAssistantText(sc.outputTranscription.text);
    if (sc?.interrupted && current) {
      current.status = 'stopped';
      current.userDone = true;
      current.interrupted = true;
      send('interrupted', { turnId: current.id });
    }
    if (msg.toolCall?.functionCalls?.length) onToolCall(msg.toolCall.functionCalls);
    // An interrupted turn gets no later turnComplete: close it now; its queued tool round still lands first.
    if (sc?.turnComplete && current && (current.outstanding === 0 || current.interrupted))
      closeCurrent(current.status);
    if (msg.goAway) {
      resumeWanted = true;
      if (!current) resume();
    }
  };

  const onLiveClose = (conn, e) => {
    if (closed || conn.retired) return;
    logger.warn({ sessionId: id, code: e?.code, reason: clean(e?.reason) }, 'Gemini Live closed');
    if (socket.readyState !== OPEN || Date.now() - startedAt >= maxMs - 5000) {
      end('error');
      return;
    }
    // A close after goAway is the expected handover; any other close gets one reconnect per window.
    if (!resumeWanted) {
      if (Date.now() - lastDropAt < RECONNECT_WINDOW_MS) {
        send('error', {
          code: 'AI_ERROR',
          message: 'The voice connection keeps dropping. Please try again in a minute.',
          fatal: true,
        });
        end('error', CLOSE_CODES.AI_ERROR);
        return;
      }
      lastDropAt = Date.now();
    }
    resume();
  };

  /** Opens a Live connection for this session; null when the session ended meanwhile. */
  const connect = async (resumeHandle) => {
    const conn = { usage: zeroUsage(), audioSec: { in: 0, out: 0 }, retired: false, recorded: false };
    const opened = await openLive({
      settings,
      companyId: ctx.companyId,
      // A handle only resumes on the model that issued it: no primary → fallback walk.
      models: resumeHandle && live ? [live.model] : null,
      config: buildLiveConfig({ system, declarations, voiceName, handle: resumeHandle }),
      callbacks: {
        onmessage: (msg) => onLive(conn, msg),
        onerror: (e) =>
          logger.warn({ sessionId: id, err: clean(e?.message ?? 'error') }, 'Gemini Live error'),
        onclose: (e) => onLiveClose(conn, e),
      },
    });
    Object.assign(conn, opened);
    connections.push(conn);
    if (closed) {
      conn.retired = true;
      conn.session.close();
      await recordConn(conn);
      return null;
    }
    return conn;
  };

  const sendAudio = (buf) => {
    live.audioSec.in += buf.length / IN_BYTES_PER_SEC;
    live.session.sendRealtimeInput({
      audio: { data: buf.toString('base64'), mimeType: 'audio/pcm;rate=16000' },
    });
  };

  /** Reconnects with the last resumption handle (or a fresh prompt), buffering browser audio meanwhile. */
  const resume = () => {
    if (resuming || closed || !live) return;
    resumeWanted = false;
    const old = live;
    const resumeHandle = handle;
    resuming = (async () => {
      try {
        if (!resumeHandle) {
          system = await buildVoicePrompt({
            ctx,
            conversation,
            context,
            language,
            pendingAction: latestAction,
            now: new Date(),
          });
        }
        const conn = await connect(resumeHandle);
        if (!conn) return;
        old.retired = true;
        try {
          old.session.close();
        } catch {}
        recordConn(old);
        live = conn;
        const buffered = resumeAudio;
        resumeAudio = [];
        for (const buf of buffered) sendAudio(buf);
        if (!resumeHandle) notice(current, 'Reconnected');
      } catch (err) {
        send('error', { code: 'AI_ERROR', message: friendlyAiError(err), fatal: true });
        end('error', CLOSE_CODES.AI_ERROR);
      } finally {
        resuming = null;
      }
    })();
  };

  // ── lifecycle ──────────────────────────────────────────────────────────────────────────────────────

  const sameRights = (user) =>
    user &&
    user.role === ctx.role &&
    String(user.companyId) === String(ctx.companyId) &&
    String(user.plantId ?? null) === String(ctx.plantId ?? null) &&
    JSON.stringify(user.permissions ?? {}) === JSON.stringify(ctx.permissions ?? {});

  /** Still signed in with the rights the tools were declared for, and voice still on; else ends the session. */
  const revalidate = async () => {
    try {
      const [ok, user, ai] = await Promise.all([
        stillSignedIn(auth),
        getModule('users')
          .Model.findOne(
            { _id: ctx.userId, deleted: { $ne: true } },
            { role: 1, companyId: 1, plantId: 1, permissions: 1 },
          )
          .lean(),
        getAiSettings(),
      ]);
      // ponytail: a changed role or plant ends the session (tools are fixed at setup); a reconnect could re-declare them.
      if (!ok || !sameRights(user)) return void end('signed_out');
      if (ai.voice?.enabled === false) {
        send('error', { code: 'VOICE_DISABLED', message: 'Voice was switched off.', fatal: true });
        end('ended', CLOSE_CODES.VOICE_DISABLED);
      }
    } catch (err) {
      logger.warn({ err: err.message }, 'voice revalidation failed');
    }
  };

  const startTimers = () => {
    if (voice.maxSessionMin > 1)
      timers.push(
        setTimeout(
          () => notice(current, 'One minute left in this voice session.', { store: false }),
          maxMs - 60_000,
        ),
      );
    timers.push(setTimeout(() => end('max_duration'), maxMs));
    timers.push(setInterval(revalidate, REVALIDATE_MS));
    if (auth.tokenExpiresAt)
      timers.push(
        setTimeout(revalidate, Math.min(Math.max(auth.tokenExpiresAt - Date.now(), 0), MAX_TIMER_MS)),
      );
    touch();
  };

  const end = (reason, code = CLOSE_CODES[reason] ?? 1011) => {
    if (ending) return ending;
    closed = true;
    ending = (async () => {
      for (const t of timers) clearTimeout(t);
      clearTimeout(idleTimer);
      if (current) closeCurrent(current.status === 'stopped' || current.answered ? 'stopped' : 'complete');
      for (const t of turns.values()) t.controller.abort();
      for (const conn of connections) {
        if (conn.retired) continue;
        conn.retired = true;
        try {
          conn.session.close();
        } catch {}
      }
      await chain;
      await Promise.all(connections.map(recordConn));
      sendUsage();
      send('closed', { reason, conversationId: conversationId ? String(conversationId) : null });
      try {
        socket.close(code, reason);
      } catch {}
      const t = totals();
      logger.info(
        {
          sessionId: id,
          userId,
          companyId: String(ctx.companyId),
          model: live?.model ?? null,
          mock: live?.mock ?? null,
          seconds: Math.round((Date.now() - startedAt) / 1000),
          turns: seq,
          toolCalls,
          tokens: t.total,
          audioSec: t.audioSec,
          reason,
        },
        'voice session ended',
      );
      onClose?.(session);
    })();
    return ending;
  };

  const fail = (err) => {
    const known = err instanceof VoiceError || /^AI_/.test(err?.code ?? '');
    const code = known ? err.code : 'AI_ERROR';
    if (!known) logger.error({ err, sessionId: id }, 'voice session failed');
    const message =
      err instanceof VoiceError
        ? err.message
        : known
          ? friendlyAiError(err)
          : 'Voice could not start. Please try again.';
    send('error', { code, message, fatal: true });
    return end('error', CLOSE_CODES[code] ?? 1011);
  };

  const ready = (async () => {
    try {
      let pending = null;
      if (start.conversationId) {
        conversation = await AiConversation.findOne({
          _id: start.conversationId,
          companyId: ctx.companyId,
          userId: ctx.userId,
          deleted: false,
        }).lean();
        if (!conversation) throw new VoiceError('CONVERSATION_NOT_FOUND', 'That conversation was not found.');
        conversationId = conversation._id;
        const message = await AiMessage.findOne({
          conversationId,
          'pendingAction.status': 'pending',
          'pendingAction.expiresAt': { $gt: new Date() },
        })
          .sort({ createdAt: -1 })
          .lean();
        if (message) {
          pending = message.pendingAction;
          latestAction = {
            id: pending.id,
            messageId: message._id,
            turnId: null,
            turnSeq: 0,
            label: pending.preview?.label ?? 'the change',
          };
        }
      }
      system = await buildVoicePrompt({
        ctx,
        conversation,
        context,
        language,
        pendingAction: latestAction,
        now: new Date(),
      });
      declarations = voiceDeclarations(ctx);
      if (closed) return false;
      live = await connect(null);
      if (!live) return false;
      isReady = true;
      send('ready', {
        sessionId: id,
        conversationId: conversationId ? String(conversationId) : null,
        model: live.model,
        voice: voiceName,
        language,
        mock: live.mock,
        inputRate: INPUT_RATE,
        outputRate: OUTPUT_RATE,
        limits: { maxSessionMin: voice.maxSessionMin, idleSec: IDLE_SEC, maxTextChars: MAX_TEXT_CHARS },
        pendingAction: publicAction(pending) ?? null,
      });
      if (live.fallbackFrom)
        notice(null, `${live.fallbackFrom} is busy, so ${live.model} answers this session.`);
      startTimers();
      return true;
    } catch (err) {
      if (!closed) await fail(err);
      return false;
    }
  })();

  /** Token bucket for browser audio: false = drop the frame; ends the session when the overrun lasts. */
  const audioAllowed = (bytes) => {
    const now = Date.now();
    audioBudget = Math.min(AUDIO_IN_BURST, audioBudget + ((now - audioAt) / 1000) * AUDIO_IN_RATE);
    audioAt = now;
    if (audioBudget >= bytes) {
      audioBudget -= bytes;
      if (overrun && now - overrun.last > 1000) overrun = null;
      return true;
    }
    if (!overrun || now - overrun.last > 1000) overrun = { since: now, last: now };
    overrun.last = now;
    if (now - overrun.since > AUDIO_OVERRUN_MS) {
      send('error', {
        code: 'RATE_LIMITED',
        message: 'The microphone is sending audio too fast. Please restart voice.',
        fatal: true,
      });
      end('error', CLOSE_CODES.RATE_LIMITED);
    }
    return false;
  };

  /** One browser frame (§4.1). */
  const handleMessage = (data, isBinary) => {
    if (closed) return;
    let msg;
    try {
      msg = parseClientMessage(data, isBinary);
    } catch (err) {
      fail(err);
      return;
    }
    switch (msg.type) {
      case 'audio':
        if (!isReady || muted || !live || !audioAllowed(msg.data.length)) return;
        if (resuming) {
          const max = (RESUME_BUFFER_MS / 1000) * IN_BYTES_PER_SEC;
          resumeAudio.push(msg.data);
          while (resumeAudio.reduce((n, b) => n + b.length, 0) > max) resumeAudio.shift();
          return;
        }
        sendAudio(msg.data);
        return;
      case 'start':
        fail(new VoiceError('BAD_MESSAGE', 'The session has already started'));
        return;
      case 'text': {
        if (!textAllowed(userId)) {
          send('error', {
            code: 'RATE_LIMITED',
            message: 'You are sending messages very fast. Wait a minute and try again.',
            fatal: false,
          });
          return;
        }
        const text = stripAppNote(msg.text); // only the server writes App notes
        if (text) ready.then((ok) => ok && !closed && userInput({ display: text, toGemini: text }));
        return;
      }
      case 'mute':
        muted = msg.muted;
        if (muted) ready.then((ok) => ok && toLive((s) => s.sendRealtimeInput({ audioStreamEnd: true })));
        return;
      case 'interrupt':
        if (current) {
          current.dropped = true;
          current.status = 'stopped';
        }
        return;
      case 'confirm':
      case 'reject':
        ready.then((ok) => ok && !closed && onClick(msg.type, msg.actionId));
        return;
      case 'end':
        end('ended');
        return;
    }
  };

  const session = {
    id,
    userId,
    ready,
    handleMessage,
    close: (reason = 'ended', code) => end(reason, code),
    /** Resolves when queued writes and tool runs are done (tests). */
    settled: () => chain,
  };
  return session;
};
