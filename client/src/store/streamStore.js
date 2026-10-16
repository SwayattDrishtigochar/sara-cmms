import { create } from 'zustand';

/**
 * In-progress chat turns, one per conversation: the SSE events of `POST …/messages` (or a confirm
 * continuation) reduced into the same `{ parts, status, … }` shape the REST API returns for a stored
 * assistant message, so the thread renders a streaming and a saved message with one component.
 * `streams[conversationId]` = { user: optimistic user message | null, message, title }.
 */
export const useStreamStore = create(() => ({ streams: {} }));

export const idOf = (doc) => doc?.id ?? doc?._id ?? null;

/** A fresh assistant message, or a saved one re-opened for a confirm continuation (its parts kept). */
export const newMessage = (seed, at = Date.now()) => ({
  id: idOf(seed),
  role: 'assistant',
  parts: seed?.parts ? [...seed.parts] : [],
  status: 'streaming',
  tier: seed?.tier ?? null,
  model: seed?.model ?? null,
  thinkingLevel: seed?.thinkingLevel ?? null,
  routerDecision: seed?.routerDecision ?? null,
  usage: seed?.usage ?? null,
  pendingAction: seed?.pendingAction ? { ...seed.pendingAction, status: 'confirmed' } : null,
  error: null,
  startedAt: seed?.startedAt ?? at,
  endedAt: null,
});

const push = (message, part) => ({ ...message, parts: [...message.parts, part] });

/** Appends to the last part when it has the same type, so adjacent thoughts and text deltas merge. */
const appendText = (message, type, text) => {
  if (!text) return message;
  const prev = message.parts[message.parts.length - 1];
  if (prev?.type === type) {
    return { ...message, parts: [...message.parts.slice(0, -1), { ...prev, text: prev.text + text }] };
  }
  return push(message, { type, text });
};

/** One SSE event (phase 4 §5) folded into a stream; unknown events leave it unchanged. */
export const reduceEvent = (stream, type, data = {}, at = Date.now()) => {
  const m = stream.message;
  switch (type) {
    case 'meta':
      return {
        ...stream,
        message: {
          ...m,
          id: data.messageId ?? m.id,
          tier: data.tier ?? m.tier,
          model: data.model ?? m.model,
          thinkingLevel: data.thinkingLevel ?? m.thinkingLevel,
          routerDecision: data.routerDecision ?? m.routerDecision,
        },
      };
    case 'thought':
      return { ...stream, message: appendText(m, 'thought', data.text) };
    case 'delta':
      return { ...stream, message: appendText(m, 'text', data.text) };
    case 'tool_call':
      return {
        ...stream,
        message: push(m, { type: 'tool_call', id: data.id, name: data.name, args: data.args }),
      };
    case 'tool_result':
      return { ...stream, message: push(m, { ...data, type: 'tool_result' }) };
    case 'block':
      return {
        ...stream,
        message: push(m, { type: 'block', id: data.id, blockType: data.type, payload: data.payload }),
      };
    case 'notice':
      return { ...stream, message: push(m, { type: 'notice', text: data.text }) };
    case 'escalated':
      return { ...stream, message: push(m, { ...data, type: 'escalated' }) };
    case 'pending_action':
      return { ...stream, message: { ...m, pendingAction: data.pendingAction ?? data } };
    case 'usage':
      return { ...stream, message: { ...m, usage: data } };
    case 'title':
      return { ...stream, title: data.title ?? stream.title };
    case 'done':
      return {
        ...stream,
        message: {
          ...m,
          id: data.messageId ?? m.id,
          status: data.status ?? 'complete',
          pendingAction: data.pendingAction ?? m.pendingAction,
          endedAt: at,
        },
      };
    case 'error':
      return {
        ...stream,
        message: {
          ...m,
          status: 'error',
          error: { code: data.code ?? 'error', message: data.message ?? 'Something went wrong' },
          endedAt: at,
        },
      };
    default:
      return stream;
  }
};

/** Opens a stream: with `text` an optimistic user message is shown; with `seed` a saved message continues. */
export const startStream = (conversationId, { text, context, seed } = {}, at = Date.now()) =>
  useStreamStore.setState((s) => ({
    streams: {
      ...s.streams,
      [conversationId]: {
        user:
          text != null
            ? { role: 'user', text, context: context ?? null, createdAt: new Date(at).toISOString() }
            : null,
        message: newMessage(seed, at),
        title: null,
      },
    },
  }));

export const applyEvent = (conversationId, type, data, at) =>
  useStreamStore.setState((s) => {
    const stream = s.streams[conversationId];
    if (!stream) return s;
    const next = reduceEvent(stream, type, data, at);
    return next === stream ? s : { streams: { ...s.streams, [conversationId]: next } };
  });

/** Ends a stream that got no `done`: stopped by the user, or a transport error. */
export const finishStream = (conversationId, status, message, at = Date.now()) =>
  useStreamStore.setState((s) => {
    const stream = s.streams[conversationId];
    if (stream?.message.status !== 'streaming') return s;
    const next = {
      ...stream.message,
      status,
      error: status === 'error' ? { code: 'transport', message } : null,
      endedAt: at,
    };
    return { streams: { ...s.streams, [conversationId]: { ...stream, message: next } } };
  });

export const clearStream = (conversationId) =>
  useStreamStore.setState((s) => {
    if (!s.streams[conversationId]) return s;
    const { [conversationId]: _gone, ...streams } = s.streams;
    return { streams };
  });

/** The in-progress turn of a conversation, or null. */
export const useStream = (conversationId) =>
  useStreamStore((s) => (conversationId ? (s.streams[conversationId] ?? null) : null));

/**
 * Saved messages with the live turn folded in: the streaming message replaces its saved twin once the
 * refetch has it, else the optimistic user message and the assistant message are appended.
 */
export const mergeStream = (messages = [], stream) => {
  if (!stream) return messages;
  const id = stream.message.id;
  const saved = id != null && messages.some((m) => idOf(m) === id);
  if (saved) return messages.map((m) => (idOf(m) === id ? stream.message : m));
  if (!stream.user) return [...messages, stream.message];
  // A refetch may already hold the turn the stream shows optimistically: the user message, and maybe the
  // assistant message of a turn that failed before `meta` gave it an id (the live one, with its error, wins).
  const last = messages[messages.length - 1];
  if (last?.role === 'user' && last.text === stream.user.text) return [...messages, stream.message];
  const prev = messages[messages.length - 2];
  if (last?.role === 'assistant' && prev?.role === 'user' && prev.text === stream.user.text) {
    return [...messages.slice(0, -1), stream.message];
  }
  return [...messages, stream.user, stream.message];
};
