import { MessageSquareOff, Sparkles } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { cn } from '../lib/format.js';
import { idOf, mergeStream, useStream } from '../store/streamStore.js';
import { EmptyState, Skeleton } from '../ui/core.jsx';
import { Composer } from './Composer.jsx';
import { EmptyThread } from './EmptyThread.jsx';
import { MessageBubble } from './MessageBubble.jsx';
import { useChatActions, useConversation, usePatchConversation } from './useChat.js';

const SUGGESTIONS = [
  'Which machines need attention right now?',
  'Open work orders by priority',
  'Energy use by machine yesterday',
  'Spare parts below minimum stock',
  'Downtime summary for last week',
];
const MACHINE_SUGGESTIONS = [
  'How is this machine doing?',
  'Show its key trends for the last 4 hours',
  'Any open anomalies or work orders on it?',
];

/** Starter questions, tuned to the record the user is looking at. */
export const suggestionsFor = (context) =>
  context?.recordRef?.module === 'assets'
    ? MACHINE_SUGGESTIONS
    : context?.recordRef
      ? ['Summarise this record', 'What should I do next here?', ...SUGGESTIONS.slice(0, 2)]
      : SUGGESTIONS;

/**
 * Message list and composer of one conversation (`conversationId` empty = a new chat, created on first send
 * and reported through `onCreated`). Used by the Chat page and the assistant drawer.
 */
export const Thread = ({ conversationId, onCreated, context, prefill, compact, className }) => {
  const { data, isLoading, error } = useConversation(conversationId);
  const stream = useStream(conversationId);
  const messages = mergeStream(data?.messages ?? [], stream);
  const streaming = stream?.message.status === 'streaming';
  const actions = useChatActions();
  const patch = usePatchConversation();
  const [tier, setTier] = useState('auto');
  const savedTier = data?.conversation?.tierPreference;
  useEffect(() => {
    setTier(savedTier ?? 'auto');
  }, [savedTier]);

  const scroller = useRef(null);
  const stick = useRef(true);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current && messages.length) el.scrollTop = el.scrollHeight;
  }, [messages]);
  const onScroll = (e) => {
    const el = e.currentTarget;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  const send = async (text, override) => {
    stick.current = true;
    try {
      const id = await actions.send({ conversationId, text, tier: override ?? tier, context });
      if (id !== conversationId) onCreated?.(id);
    } catch (err) {
      toast.error("Couldn't send your message", { description: err.message });
    }
  };
  // Stable so saved messages (memoised) don't re-render on every streamed token.
  const onConfirm = useCallback(
    (message, actionId) => actions.confirm(conversationId, message, actionId),
    [actions, conversationId],
  );
  const onReject = useCallback(
    (actionId) => actions.reject(conversationId, actionId),
    [actions, conversationId],
  );
  const changeTier = (value) => {
    setTier(value);
    if (conversationId) patch.mutate({ id: conversationId, tierPreference: value });
  };

  const lastAnswer = messages.findLastIndex((m) => m.role === 'assistant');
  const ask = (override) => {
    const question = messages.slice(0, lastAnswer).findLast((m) => m.role === 'user');
    if (question) send(question.text, override);
  };
  const pad = compact ? 'px-4' : 'px-4 sm:px-6';

  return (
    <div className={cn('flex h-full min-h-0 flex-col', className)}>
      <div ref={scroller} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
        <div className={cn('mx-auto w-full max-w-3xl space-y-6 py-6', pad)}>
          {conversationId && isLoading && !stream ? (
            <div className="space-y-4" role="status" aria-label="Loading conversation">
              <Skeleton className="ml-auto h-9 w-2/3 rounded-2xl" />
              <Skeleton className="h-24 w-full rounded-xl" />
              <Skeleton className="ml-auto h-9 w-1/2 rounded-2xl" />
            </div>
          ) : error && !stream ? (
            <EmptyState icon={MessageSquareOff} title="Conversation not available">
              {error.status === 404 ? 'It may have been deleted.' : error.message}
            </EmptyState>
          ) : messages.length === 0 && !compact ? (
            <EmptyThread onPick={send} />
          ) : messages.length === 0 ? (
            <EmptyState
              icon={Sparkles}
              title={
                context?.recordRef?.label
                  ? `Ask about ${context.recordRef.label}`
                  : 'Ask SARA about your plant'
              }
              className="py-8"
            >
              {context?.recordRef
                ? 'SARA knows which record you are looking at, so "it" and "this machine" just work.'
                : 'Machine health, work orders, production, stock, energy and costs. Changes wait for your Confirm.'}
            </EmptyState>
          ) : (
            messages.map((m, i) => (
              <MessageBubble
                key={idOf(m) ?? `${m.role}-${i}`}
                message={m}
                onConfirm={onConfirm}
                onReject={onReject}
                onRegenerate={
                  i === lastAnswer && !streaming && !['awaiting_confirmation', 'error'].includes(m.status)
                    ? () => ask('deep')
                    : undefined
                }
                onRetry={i === lastAnswer && !streaming && m.status === 'error' ? () => ask() : undefined}
              />
            ))
          )}
        </div>
      </div>
      <div className={cn('mx-auto w-full max-w-3xl pt-2 pb-4', pad)}>
        <Composer
          key={prefill?.key}
          defaultValue={prefill?.text}
          autoFocus={compact}
          onSend={send}
          onStop={() => actions.stop(conversationId)}
          streaming={streaming}
          tier={tier}
          onTierChange={changeTier}
          suggestions={compact && messages.length === 0 && !isLoading ? suggestionsFor(context) : []}
        />
      </div>
    </div>
  );
};
