import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import { toast } from 'sonner';
import { api } from '../api/client.js';
import { streamSse } from '../api/sse.js';
import {
  applyEvent,
  clearStream,
  finishStream,
  idOf,
  startStream,
  useStreamStore,
} from '../store/streamStore.js';

/** Tiers the user can pin; `auto` lets the router choose per question. */
export const TIERS = ['auto', 'fast', 'balanced', 'deep'];

const LIST_KEY = ['conversations'];
const oneKey = (id) => ['conversation', id];

/** Own conversations, newest first, paged by cursor. */
export const useConversations = (options = {}) =>
  useInfiniteQuery({
    queryKey: LIST_KEY,
    queryFn: ({ pageParam, signal }) => api('/conversations', { query: { cursor: pageParam }, signal }),
    initialPageParam: undefined,
    getNextPageParam: (last) => last?.nextCursor ?? undefined,
    ...options,
  });

/** `{ conversation, messages }` of one conversation. */
export const useConversation = (id) =>
  useQuery({
    queryKey: oneKey(id),
    queryFn: ({ signal }) => api(`/conversations/${id}`, { signal }),
    enabled: Boolean(id),
    staleTime: 30_000,
  });

/** PATCH title / tierPreference. */
export const usePatchConversation = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }) => api(`/conversations/${id}`, { method: 'PATCH', body }),
    onSuccess: (data, { id }) => {
      qc.setQueryData(oneKey(id), (old) => (old ? { ...old, conversation: data.conversation } : old));
      qc.invalidateQueries({ queryKey: LIST_KEY });
    },
  });
};

export const useDeleteConversation = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id) => api(`/conversations/${id}`, { method: 'DELETE' }),
    onSuccess: (_data, id) => {
      qc.removeQueries({ queryKey: oneKey(id) });
      clearStream(id);
      qc.invalidateQueries({ queryKey: LIST_KEY });
    },
  });
};

// One open stream per conversation; a new send or confirm aborts the previous one.
const controllers = new Map();
const STOP_GRACE_MS = 4000;

const runStream = async (qc, conversationId, path, body, { continuation } = {}) => {
  controllers.get(conversationId)?.abort();
  const controller = new AbortController();
  controllers.set(conversationId, controller);
  try {
    await streamSse(path, {
      method: 'POST',
      body,
      signal: controller.signal,
      onEvent: (type, data) => {
        applyEvent(conversationId, type, data);
        if (type === 'title') qc.invalidateQueries({ queryKey: LIST_KEY });
      },
    });
    finishStream(conversationId, 'error', 'The connection closed before SARA finished. Try again.');
  } catch (err) {
    if (err.name === 'AbortError') finishStream(conversationId, 'stopped');
    else if (continuation) {
      toast.error("Couldn't apply the change", { description: err.message });
      clearStream(conversationId);
    } else finishStream(conversationId, 'error', err.message);
  } finally {
    if (controllers.get(conversationId) === controller) controllers.delete(conversationId);
  }
  await qc.invalidateQueries({ queryKey: oneKey(conversationId) });
  qc.invalidateQueries({ queryKey: LIST_KEY });
  // The refetched message replaces the live one; a failed turn stays visible with its error.
  const stream = useStreamStore.getState().streams[conversationId];
  if (stream && stream.message.status !== 'error' && !controllers.has(conversationId)) {
    clearStream(conversationId);
  }
};

/** Send, stop, confirm and reject; each streams into `streamStore`. */
export const useChatActions = () => {
  const qc = useQueryClient();
  return useMemo(
    () => ({
      /** Sends a message (creating the conversation first when `conversationId` is empty); resolves to its id. */
      send: async ({ conversationId, text, tier, context }) => {
        let id = conversationId;
        if (!id) {
          const { conversation } = await api('/conversations', { method: 'POST', body: {} });
          id = idOf(conversation);
          qc.setQueryData(oneKey(id), { conversation, messages: [] });
          qc.invalidateQueries({ queryKey: LIST_KEY });
        }
        startStream(id, { text, context });
        runStream(qc, id, `/conversations/${id}/messages`, {
          text,
          ...(tier && tier !== 'auto' ? { tier } : {}),
          ...(context ? { context } : {}),
        });
        return id;
      },
      /**
       * Asks the server to stop: it saves what was streamed and ends the stream with `done { status: 'stopped' }`,
       * so the refetch never sees a half-saved message. The connection is only cut when that does not happen.
       */
      stop: (conversationId) => {
        const controller = controllers.get(conversationId);
        const messageId = useStreamStore.getState().streams[conversationId]?.message.id;
        const cut = () => {
          if (controllers.get(conversationId) === controller) controller?.abort();
        };
        if (!messageId) return cut();
        api(`/conversations/${conversationId}/messages/${messageId}/stop`, { method: 'POST' })
          .then((r) => (r?.ok ? setTimeout(cut, STOP_GRACE_MS) : cut()))
          .catch(cut);
      },
      /** Confirms a pending write: the continuation streams into the same assistant message. */
      confirm: (conversationId, message, actionId) => {
        startStream(conversationId, { seed: message });
        return runStream(
          qc,
          conversationId,
          `/conversations/${conversationId}/actions/${actionId}/confirm`,
          {},
          {
            continuation: true,
          },
        );
      },
      reject: async (conversationId, actionId) => {
        try {
          await api(`/conversations/${conversationId}/actions/${actionId}/reject`, { method: 'POST' });
        } catch (err) {
          toast.error("Couldn't reject the change", { description: err.message });
        }
        await qc.invalidateQueries({ queryKey: oneKey(conversationId) });
      },
    }),
    [qc],
  );
};
