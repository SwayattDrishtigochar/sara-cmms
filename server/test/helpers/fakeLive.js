import { randomUUID } from 'node:crypto';
import { signToken } from '../../src/auth/jwt.js';
import { Session } from '../../src/db/models/Session.js';
import { getModule } from '../../src/modules/registry.js';

/**
 * A scripted stand-in for `ai.live` (phase 8 §8): records what SARA sends and lets a test push Live server
 * messages with `emit`. Plus message builders, a fake browser socket and a sign-in helper.
 */

const realSetTimeout = globalThis.setTimeout; // kept real when a test fakes timers

/** `{ client, sessions, last(), failNext(...errOrClose) }`; `failNext({ close: { code, reason } })` closes during setup. */
export const createFakeLive = () => {
  const sessions = [];
  const failures = [];
  const client = {
    connect: async ({ model, config, callbacks }) => {
      const failure = failures.shift();
      if (failure?.close) {
        // Like the SDK: a refused setup closes the socket and connect() never settles.
        realSetTimeout(() => callbacks.onclose?.(failure.close), 0);
        return new Promise(() => {});
      }
      if (failure) throw failure;
      let closed = false;
      const session = {
        model,
        config,
        callbacks,
        realtime: [],
        toolResponses: [],
        get closed() {
          return closed;
        },
        sendRealtimeInput: (p) => session.realtime.push(p),
        sendToolResponse: (p) => session.toolResponses.push(p),
        sendClientContent: () => {},
        close: () => {
          if (closed) return;
          closed = true;
          callbacks.onclose?.({ code: 1000, reason: '' });
        },
        emit: (...messages) => {
          for (const m of messages) callbacks.onmessage(m);
        },
      };
      sessions.push(session);
      return session;
    },
  };
  return { client, sessions, last: () => sessions.at(-1), failNext: (...items) => failures.push(...items) };
};

// ── Live server message builders ─────────────────────────────────────────────────────────────────────

export const hear = (text, finished = false) => ({
  serverContent: { inputTranscription: { text, finished } },
});
export const say = (text) => ({ serverContent: { outputTranscription: { text } } });
/** Model audio: `bytes` of PCM16 at 24 kHz (a Buffer or a length). */
export const audio = (bytes = 960) => ({
  serverContent: {
    modelTurn: {
      parts: [
        {
          inlineData: {
            mimeType: 'audio/pcm;rate=24000',
            data: (Buffer.isBuffer(bytes) ? bytes : Buffer.alloc(bytes, 1)).toString('base64'),
          },
        },
      ],
    },
  },
});
let fc = 0;
/** `toolCall(['mongo_count', { module: 'assets' }], …)` → functionCalls with fresh ids (or `{ id, name, args }`). */
export const toolCall = (...calls) => ({
  toolCall: {
    functionCalls: calls.map((c) =>
      Array.isArray(c) ? { id: `fc-${++fc}`, name: c[0], args: c[1] ?? {} } : { id: `fc-${++fc}`, ...c },
    ),
  },
});
export const turnComplete = () => ({ serverContent: { turnComplete: true } });
export const interrupted = () => ({ serverContent: { interrupted: true } });
export const usage = (prompt = 100, response = 20) => ({
  usageMetadata: {
    promptTokenCount: prompt,
    responseTokenCount: response,
    totalTokenCount: prompt + response,
  },
});
export const goAway = () => ({ goAway: { timeLeft: '5s' } });
export const resumable = (newHandle) => ({ sessionResumptionUpdate: { newHandle, resumable: true } });
export const cancel = (...ids) => ({ toolCallCancellation: { ids } });

/** Waits (real time) until `check()` is truthy. */
export const until = async (check, { timeout = 5000, what = 'condition' } = {}) => {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => realSetTimeout(r, 10));
  }
};

/** The ws subset a voice session uses, recording JSON messages and binary frames. */
export const fakeSocket = () => {
  const socket = {
    readyState: 1,
    bufferedAmount: 0,
    messages: [],
    binary: [],
    closedWith: null,
    send: (data, opts) => {
      if (opts?.binary) socket.binary.push(data);
      else socket.messages.push(JSON.parse(data));
    },
    close: (code, reason) => {
      socket.readyState = 3;
      socket.closedWith = { code, reason };
    },
    of: (type) => socket.messages.filter((m) => m.type === type),
    /** The `n`th message of `type` (waits for it). */
    next: (type, n = 1) => until(() => socket.of(type)[n - 1], { what: `${type} #${n}` }),
  };
  return socket;
};

/** A live sessions doc + JWT for a seeded user, and what `userFromToken` makes of it. */
export const signIn = async (email) => {
  const user = await getModule('users').Model.findOne({ email }).lean();
  const sessionId = randomUUID();
  await Session.create({
    userId: user._id,
    companyId: user.companyId,
    sessionId,
    expiresAt: new Date(Date.now() + 86_400_000),
  });
  return { token: signToken({ userId: user._id, sessionId }), sessionId };
};
