import { useQuery } from '@tanstack/react-query';
import { create } from 'zustand';
import { api, apiUrl, getToken } from '../api/client.js';
import { contextFromPath, goTo } from '../assistant/useAssistant.js';
import { newMessage, reduceEvent } from '../store/streamStore.js';
import { micSupport, startMic } from './audio/mic.js';
import { createBargeIn, createPlayer } from './audio/player.js';

/** Close codes (phase 8 §4.3) → error codes, for a socket that closed without an `error` message. */
const CLOSE_CODES = {
  1009: 'TOO_LARGE', // ws refuses a frame above the server's maxPayload before any `error` can be sent
  4001: 'UNAUTHORIZED',
  4003: 'VOICE_DISABLED',
  4004: 'CONVERSATION_NOT_FOUND',
  4008: 'BAD_MESSAGE',
  4029: 'VOICE_BUSY',
  4502: 'AI_ERROR',
};
const SUPPORT_CODES = { insecure: 'INSECURE', 'no-websocket': 'NO_WEBSOCKET' };
/** Waits before each reconnect after a drop: a restarting API is usually back within a few seconds. */
export const RECONNECT_DELAYS_MS = [1500, 3000, 5000];
const RECONNECT_MIN_LIVE_MS = 3000;
const CLOSE_GRACE_MS = 2000;

const pref = (key) => {
  try {
    return localStorage.getItem(`voice.${key}`) || null;
  } catch {
    return null;
  }
};
const savePref = (key, value) => {
  try {
    localStorage.setItem(`voice.${key}`, value);
  } catch {
    // storage blocked: the choice lasts until reload
  }
};

const isOpenTurn = (turn) => turn?.assistant.status === 'streaming';
const TOOL_PARTS = new Set(['tool_call', 'tool_result', 'block']);

/** Applies `fn` to the assistant message of turn `turnId`; unknown ids leave the state unchanged. */
const onTurn = (state, turnId, fn) => {
  const i = state.turns.findIndex((t) => t.id === turnId);
  if (i < 0) return state;
  const turns = [...state.turns];
  turns[i] = fn(turns[i]);
  return { ...state, turns };
};
const foldEvent = (turn, type, data) => ({
  ...turn,
  assistant: reduceEvent({ message: turn.assistant }, type, data).message,
});

/** A confirm card's action update: the turn that owns it, else the session's carried-over pending action. */
const applyAction = (state, turnId, action) => {
  const owns = (t) => t.id === turnId || t.assistant.pendingAction?.id === action.id;
  const turn = state.turns.find(owns);
  if (!turn) {
    return state.pendingAction?.id === action.id ? { ...state, pendingAction: action } : state;
  }
  return onTurn(state, turn.id, (t) => {
    const status = t.assistant.status;
    const next =
      action.status === 'pending'
        ? status === 'streaming'
          ? status
          : 'awaiting_confirmation'
        : status === 'awaiting_confirmation'
          ? 'complete'
          : status;
    return { ...t, assistant: { ...t.assistant, pendingAction: action, status: next } };
  });
};

/** Pure: one server JSON message (phase 8 §4.2) folded into the voice state. */
export const reduceVoice = (state, message, at = Date.now()) => {
  const m = message ?? {};
  switch (m.type) {
    case 'ready':
      return {
        ...state,
        phase: 'live',
        sessionId: m.sessionId ?? null,
        conversationId: m.conversationId ?? state.conversationId,
        model: m.model ?? null,
        voice: m.voice ?? null,
        language: m.language ?? null,
        mock: Boolean(m.mock),
        limits: m.limits ?? null,
        pendingAction: m.pendingAction ?? null,
        startedAt: at,
        error: null,
        closedReason: null,
        notice: null,
      };
    case 'turn_start': {
      const assistant = { ...newMessage(null, at), tier: 'voice', model: state.model };
      return {
        ...state,
        conversationId: m.conversationId ?? state.conversationId,
        error: state.phase === 'live' ? null : state.error,
        turns: [
          ...state.turns,
          {
            id: m.turnId,
            messageId: m.messageId ?? null,
            user: { text: m.user ?? '', final: m.user != null },
            assistant: { ...assistant, id: m.messageId ?? null },
          },
        ],
      };
    }
    case 'transcript':
      return onTurn(state, m.turnId, (t) =>
        m.role === 'user'
          ? { ...t, user: { text: t.user.text + (m.text ?? ''), final: Boolean(m.final) } }
          : foldEvent(t, 'delta', { text: m.text }),
      );
    case 'tool_call':
    case 'tool_result':
    case 'block':
      return onTurn(state, m.turnId, (t) => foldEvent(t, m.type, m.data));
    case 'notice': {
      const turnId = m.turnId ?? state.turns.at(-1)?.id;
      if (turnId == null) return { ...state, notice: m.data?.text ?? null };
      return onTurn(state, turnId, (t) => foldEvent(t, 'notice', m.data));
    }
    case 'confirm':
      return m.action ? applyAction(state, m.turnId, m.action) : state;
    case 'interrupted':
      return onTurn(state, m.turnId, (t) => ({ ...t, assistant: { ...t.assistant, status: 'stopped' } }));
    case 'turn_complete':
      return onTurn(
        { ...state, conversationId: m.conversationId ?? state.conversationId },
        m.turnId,
        (t) => ({
          ...t,
          messageId: m.messageId ?? t.messageId,
          user: { ...t.user, final: true },
          assistant: {
            ...t.assistant,
            id: m.messageId ?? t.assistant.id,
            status: m.status ?? 'complete',
            latencyMs: m.latencyMs ?? null,
            endedAt: at,
          },
        }),
      );
    case 'usage':
      return { ...state, usage: m };
    case 'error': {
      const error = { code: m.code ?? 'AI_ERROR', message: m.message ?? 'Something went wrong.' };
      return m.fatal ? { ...state, phase: 'error', error } : { ...state, error };
    }
    case 'closed':
      return {
        ...state,
        phase: state.phase === 'error' ? 'error' : 'ended',
        closedReason: m.reason ?? 'ended',
        conversationId: m.conversationId ?? state.conversationId,
        speaking: false,
        notice: null,
        turns: state.turns.map((t) =>
          isOpenTurn(t) ? { ...t, assistant: { ...t.assistant, status: 'complete', endedAt: at } } : t,
        ),
      };
    default:
      return state;
  }
};

/** What the panel shows: idle | connecting | listening | thinking | speaking | ended | error. */
export const phaseOf = (state) => {
  if (state.phase !== 'live') return state.phase;
  if (state.speaking) return 'speaking';
  const last = state.turns.at(-1);
  const parts = last?.assistant.parts ?? [];
  // No words yet, or a tool still running after a spoken preamble ("Let me check that").
  const busy = !parts.some((p) => p.type === 'text') || TOOL_PARTS.has(parts.at(-1)?.type);
  if (isOpenTurn(last) && last.user.text && busy) return 'thinking';
  return 'listening';
};

/** The voice WebSocket URL: the API base resolved against the page, http → ws, https → wss. */
export const voiceUrl = () => {
  const url = new URL(apiUrl('/voice'), location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.href;
};

// ── Controller: socket, mic, player and AudioContext live here, never in the store ─────────────────────────

const rt = {
  ws: null,
  mic: null,
  player: null,
  context: null,
  bargeIn: null,
  micLevel: 0,
  dropping: false, // SARA audio ignored until the open turn ends (local barge-in or Stop)
  qc: null,
  args: null,
  liveAt: 0,
  gotClosed: false,
  userEnded: false,
  retries: 0, // reconnects since the last `ready`
  gen: 0,
  timer: null,
};

/** Mic and SARA output levels (0..1), read by the Orb in requestAnimationFrame without re-rendering. */
export const voiceLevels = () => ({ mic: rt.micLevel, sara: rt.player?.level?.() ?? 0 });

const send = (message) => {
  if (rt.ws?.readyState === 1) rt.ws.send(JSON.stringify(message));
};

const stopAudio = () => {
  rt.mic?.stop();
  rt.mic = null;
  rt.micLevel = 0;
  rt.player?.stop();
};

/** Everything off: mic tracks, playback, the AudioContext and any pending timer. */
const teardown = () => {
  clearTimeout(rt.timer);
  rt.timer = null;
  stopAudio();
  rt.player = null;
  rt.bargeIn = null;
  Promise.resolve(rt.context?.close?.()).catch(() => {});
  rt.context = null;
  rt.dropping = false;
};

const offline = () => typeof navigator !== 'undefined' && navigator.onLine === false;

export const useVoice = create((set, get) => {
  const fail = (code, message = null) => {
    teardown();
    set({ phase: 'error', error: { code, message }, speaking: false, notice: null });
  };

  const onMessage = (ws, data) => {
    if (rt.ws !== ws) return;
    if (typeof data !== 'string') {
      if (!rt.dropping) rt.player?.enqueue(data);
      return;
    }
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    const before = get();
    set(reduceVoice(before, msg));
    switch (msg.type) {
      case 'ready':
        rt.liveAt = Date.now();
        rt.retries = 0;
        break;
      case 'turn_start':
        rt.dropping = false;
        break;
      case 'interrupted':
        rt.player?.stop();
        rt.dropping = false;
        break;
      case 'turn_complete': {
        rt.dropping = false;
        const id = msg.conversationId ?? get().conversationId;
        if (id) rt.qc?.invalidateQueries({ queryKey: ['conversation', id] });
        if (!rt.args?.conversationId || before.turns.length === 0) {
          rt.qc?.invalidateQueries({ queryKey: ['conversations'] });
        }
        if (rt.args && id) rt.args.conversationId = id;
        break;
      }
      case 'closed':
        rt.gotClosed = true;
        teardown();
        break;
      case 'error':
        if (msg.fatal) rt.gotClosed = true;
        break;
      case 'navigate': // F3: open_page opened a page; the panel stays, docked small so the page shows
        if (goTo(msg.data?.url) && get().wide) set({ wide: false });
        break;
      default:
    }
  };

  const onClose = (ws, code) => {
    if (rt.ws !== ws) return;
    rt.ws = null;
    const s = get();
    if (rt.gotClosed || rt.userEnded || s.phase === 'error') {
      teardown();
      if (s.phase === 'connecting' || s.phase === 'live')
        set({ phase: 'ended', speaking: false, notice: null });
      return;
    }
    // A drop of a session that was live (or of a reconnect still trying) retries with backoff.
    const wasLive = rt.liveAt && Date.now() - rt.liveAt > RECONNECT_MIN_LIVE_MS;
    if (
      (code === 1006 || code === 1001) &&
      (wasLive || rt.retries > 0) &&
      rt.retries < RECONNECT_DELAYS_MS.length
    ) {
      const delay = RECONNECT_DELAYS_MS[rt.retries];
      rt.retries += 1;
      rt.player?.stop();
      set({ phase: 'connecting', notice: 'Reconnecting…', speaking: false });
      const gen = rt.gen;
      rt.timer = setTimeout(() => {
        if (gen === rt.gen && !rt.userEnded) openSocket({ ...rt.args, conversationId: get().conversationId });
      }, delay);
      return;
    }
    fail(offline() ? 'OFFLINE' : (CLOSE_CODES[code] ?? 'CONNECTION_LOST'));
  };

  const openSocket = (args) => {
    rt.args = args;
    rt.gotClosed = false;
    rt.liveAt = 0;
    let ws;
    try {
      ws = new WebSocket(voiceUrl());
    } catch {
      fail('UNSUPPORTED');
      return;
    }
    ws.binaryType = 'arraybuffer';
    rt.ws = ws;
    ws.onopen = () => {
      if (rt.ws !== ws) return;
      const language = pref('language');
      const voice = pref('voice');
      send({
        type: 'start',
        token: getToken() ?? '',
        ...(args.conversationId ? { conversationId: args.conversationId } : {}),
        ...(language ? { language } : {}),
        ...(voice ? { voice } : {}),
        context: args.context ?? contextFromPath(location.pathname),
      });
    };
    ws.onmessage = (e) => onMessage(ws, e.data);
    ws.onclose = (e) => onClose(ws, e.code);
  };

  /** Restarts the socket on the same conversation, keeping the mic and player (language / voice change). */
  const restart = () => {
    const old = rt.ws;
    rt.ws = null;
    if (old?.readyState === 1) old.send(JSON.stringify({ type: 'end' }));
    old?.close?.(1000);
    rt.player?.stop();
    set({ phase: 'connecting', speaking: false });
    openSocket({ ...rt.args, conversationId: get().conversationId });
  };

  /** Stops playback; audio still arriving for an open turn is dropped (a finished turn sends no more). */
  const silence = () => {
    rt.player?.stop();
    if (isOpenTurn(get().turns.at(-1))) rt.dropping = true;
  };

  const onLevel = (level) => {
    rt.micLevel = level;
    if (rt.player && rt.bargeIn?.(level, rt.player.speaking)) {
      silence(); // Gemini's VAD decides the interruption; `interrupted` / `turn_complete` / `turn_start` resume audio
    }
  };
  const onFrame = (buf) => {
    if (get().phase === 'live' && !get().muted && rt.ws?.readyState === 1) rt.ws.send(buf);
  };

  const active = () => ['connecting', 'live'].includes(get().phase);

  return {
    open: false,
    wide: false,
    phase: 'idle',
    sessionId: null,
    conversationId: null,
    model: null,
    voice: null,
    language: null,
    mock: false,
    limits: null,
    startedAt: null,
    muted: false,
    textOnly: false,
    speaking: false,
    turns: [],
    pendingAction: null,
    notice: null,
    usage: null,
    error: null,
    closedReason: null,

    toggle: (opts = {}) => {
      if (active()) get().end();
      else get().start(opts);
    },

    /** Opens the panel and starts a session. Call inside the click / shortcut (the AudioContext needs the gesture). */
    start: async ({ conversationId = null, context = null, qc, textOnly = false } = {}) => {
      if (active()) return;
      const gen = ++rt.gen;
      teardown();
      rt.userEnded = false;
      rt.retries = 0;
      if (qc) rt.qc = qc;
      const same = conversationId && conversationId === get().conversationId;
      set({
        open: true,
        phase: 'connecting',
        textOnly,
        muted: false,
        speaking: false,
        error: null,
        closedReason: null,
        notice: null,
        usage: null,
        pendingAction: null,
        conversationId,
        turns: same ? get().turns : [],
      });
      if (offline()) return fail('OFFLINE');
      const support = micSupport();
      if (!support.ok && (!textOnly || support.reason === 'no-websocket')) {
        return fail(SUPPORT_CODES[support.reason] ?? 'UNSUPPORTED');
      }
      try {
        const Ctx = globalThis.AudioContext ?? globalThis.webkitAudioContext;
        rt.context = Ctx ? new Ctx({ latencyHint: 'interactive' }) : null;
        Promise.resolve(rt.context?.resume?.()).catch(() => {});
      } catch {
        rt.context = null;
      }
      if (!rt.context && !textOnly) return fail('UNSUPPORTED');
      if (!textOnly) {
        try {
          const mic = await startMic({ context: rt.context, onFrame, onLevel });
          if (gen !== rt.gen) {
            mic.stop();
            return;
          }
          rt.mic = mic;
        } catch (err) {
          if (gen === rt.gen) fail(err?.code ?? 'MIC_ERROR', err?.message ?? null);
          return;
        }
      }
      if (rt.context) {
        rt.player = createPlayer(rt.context, { onSpeaking: (speaking) => set({ speaking }) });
        rt.bargeIn = createBargeIn();
      }
      openSocket({ conversationId, context, textOnly });
    },

    end: () => {
      if (!active()) return;
      rt.userEnded = true;
      rt.gen++;
      send({ type: 'end' });
      stopAudio();
      set({ speaking: false });
      const ws = rt.ws;
      const finish = () => {
        if (rt.ws === ws) {
          rt.ws = null;
          ws?.close?.(1000);
        }
        teardown();
        if (active()) set({ phase: 'ended', closedReason: 'ended', notice: null });
      };
      clearTimeout(rt.timer);
      // A live socket gets `end` and answers `closed` (persisted turns); otherwise stop at once.
      if (ws?.readyState === 1) rt.timer = setTimeout(finish, CLOSE_GRACE_MS);
      else finish();
    },

    sendText: (text) => {
      const t = String(text ?? '')
        .trim()
        .slice(0, get().limits?.maxTextChars ?? 2000);
      if (!t || get().phase !== 'live') return false;
      send({ type: 'text', text: t });
      return true;
    },
    confirm: (actionId) => send({ type: 'confirm', actionId }),
    reject: (actionId) => send({ type: 'reject', actionId }),
    setMuted: (muted) => {
      rt.mic?.setMuted(muted);
      send({ type: 'mute', muted });
      set({ muted });
    },
    interrupt: () => {
      send({ type: 'interrupt' });
      silence();
    },
    setLanguage: (code) => {
      savePref('language', code);
      if (get().phase === 'live' && code !== get().language) restart();
      else set({ language: code });
    },
    setVoice: (name) => {
      savePref('voice', name);
      if (get().phase === 'live' && name !== get().voice) restart();
      else set({ voice: name });
    },
    setWide: (wide) => set({ wide }),
    /** Ends any session and hides the panel (Escape, ×, sign-out). */
    close: () => {
      get().end();
      set({ open: false });
    },
  };
});

/** GET /voice/config: enabled, mock, female voices, languages, defaults (cached 5 min). */
export const useVoiceConfig = (enabled = true) =>
  useQuery({
    queryKey: ['voice', 'config'],
    queryFn: ({ signal }) => api('/voice/config', { signal }),
    staleTime: 5 * 60_000,
    enabled,
  });

/** Tests only: forget the module-scope controller state. */
export const _resetVoice = () => {
  teardown();
  rt.ws = null;
  rt.qc = null;
  rt.args = null;
  rt.gen++;
};
