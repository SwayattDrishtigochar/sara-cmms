import {
  CircleAlert,
  CircleStop,
  Info,
  Link2,
  Mic,
  RefreshCw,
  RotateCcw,
  Sparkles,
  TrendingUp,
} from 'lucide-react';
import { memo, useMemo } from 'react';
import { BlockRenderer } from '../blocks/BlockRenderer.jsx';
import { cn, humanize } from '../lib/format.js';
import { Markdown } from '../lib/markdown.jsx';
import { idOf } from '../store/streamStore.js';
import { CopyButton } from '../superadmin/parts.jsx';
import { modelLine, ThinkingPanel } from './ThinkingPanel.jsx';
import { ToolTrace } from './ToolTrace.jsx';

/**
 * Message parts → render segments: all thoughts joined (one panel), every tool call of the turn in one trace
 * (placed where the first call happened, results matched by id), and text / blocks / notices in their
 * streamed order.
 */
export const segmentsOf = (parts = []) => {
  const thoughts = [];
  const segments = [];
  const steps = new Map();
  let trace = null;
  for (const part of parts) {
    if (part.type === 'thought') thoughts.push(part.text);
    else if (part.type === 'tool_call' || part.type === 'tool_result') {
      let step = steps.get(part.id);
      if (!step) {
        step = { call: { id: part.id, name: part.name, args: part.args } };
        steps.set(part.id, step);
        if (!trace) {
          trace = { type: 'tools', steps: [] };
          segments.push(trace);
        }
        trace.steps.push(step);
      }
      if (part.type === 'tool_call') step.call = { id: part.id, name: part.name, args: part.args };
      else step.result = part;
    } else if (part.type === 'text') {
      const last = segments[segments.length - 1];
      if (last?.type === 'text') last.text += part.text;
      else segments.push({ type: 'text', text: part.text ?? '' });
    } else segments.push({ type: part.type, part });
  }
  return { thoughts: thoughts.join('\n\n'), segments };
};

// A blinking bar after the last streamed paragraph.
const CARET =
  "[&>div>:last-child]:after:ml-0.5 [&>div>:last-child]:after:animate-pulse [&>div>:last-child]:after:text-ai [&>div>:last-child]:after:content-['▍']";

const textOf = (segments) =>
  segments
    .filter((s) => s.type === 'text')
    .map((s) => s.text)
    .join('\n\n');

const contextLabel = (context) => {
  const ref = context?.recordRef;
  if (!ref) return context?.page && context.page !== 'chat' ? `${humanize(context.page)} page` : null;
  return (
    ref.label ?? (ref.module === 'assets' ? 'this machine' : `this ${humanize(ref.module).toLowerCase()}`)
  );
};

const UserBubble = ({ message }) => {
  const about = contextLabel(message.context);
  return (
    <div className="flex flex-col items-end gap-1 animate-fade-in">
      <div className="max-w-[85%] rounded-2xl rounded-br-md border border-brand/15 bg-brand-soft px-3.5 py-2 text-sm leading-relaxed whitespace-pre-wrap break-words text-fg">
        {message.channel === 'voice' && (
          <>
            <Mic className="mr-1.5 inline size-3.5 align-[-2px] text-ai" aria-hidden />
            <span className="sr-only">Spoken: </span>
          </>
        )}
        {message.text}
      </div>
      {about && (
        <span className="flex items-center gap-1 text-[11px] text-subtle">
          <Link2 className="size-3" aria-hidden /> About {about}
        </span>
      )}
    </div>
  );
};

const Notice = ({ icon: Icon = Info, children }) => (
  <p className="flex items-start gap-1.5 text-xs text-muted">
    <Icon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
    <span>{children}</span>
  </p>
);

const ErrorNotice = ({ message, onRetry }) => (
  <div
    role="alert"
    className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-critical/30 bg-critical/5 px-3 py-2"
  >
    <CircleAlert className="size-4 shrink-0 text-critical" aria-hidden />
    <p className="min-w-0 flex-1 text-sm text-fg">
      <span className="font-medium">SARA couldn't finish this answer.</span>{' '}
      <span className="text-muted">{message}</span>
    </p>
    {onRetry && (
      <button
        type="button"
        onClick={onRetry}
        className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border bg-surface px-2.5 text-xs font-medium text-fg hover:bg-surface-2"
      >
        <RotateCcw className="size-3.5" aria-hidden /> Try again
      </button>
    )}
  </div>
);

/**
 * One chat message. Assistant messages render their parts (thoughts, tool trace, markdown, blocks, notices) the
 * same way while streaming and once saved. `onConfirm` / `onReject` act on the pending write; `onRegenerate`
 * (Deep) and `onRetry` (same tier, after an error) appear on the last answer.
 */
export const MessageBubble = memo(({ message, onConfirm, onReject, onRegenerate, onRetry }) => {
  const { thoughts, segments } = useMemo(() => segmentsOf(message.parts), [message.parts]);
  if (message.role === 'user') return <UserBubble message={message} />;

  const streaming = message.status === 'streaming';
  const awaiting = message.status === 'awaiting_confirmation';
  const answering = segments.some((s) => s.type === 'text' || s.type === 'block');
  const text = textOf(segments);
  const messageId = idOf(message);
  const confirm = {
    action: message.pendingAction,
    onConfirm: onConfirm ? (actionId) => onConfirm(message, actionId) : undefined,
    onReject,
  };
  const lastText = segments.findLastIndex((s) => s.type === 'text');
  const showThinking = Boolean(thoughts) || (streaming && !answering);

  return (
    <article className="flex gap-3" aria-label="SARA's answer">
      <span className="mt-0.5 hidden size-7 shrink-0 place-items-center rounded-full sm:grid bg-[linear-gradient(135deg,var(--brand),var(--ai))] text-white shadow-card">
        <Sparkles className={cn('size-3.5', streaming && 'animate-pulse')} aria-hidden />
      </span>
      <div className="min-w-0 flex-1 space-y-3">
        {showThinking && <ThinkingPanel text={thoughts} message={message} answering={answering} />}
        <div className="space-y-3" aria-live="polite" aria-busy={streaming}>
          {segments.map((s, i) => {
            const key = `${s.type}-${i}`;
            if (s.type === 'tools')
              return <ToolTrace key={key} steps={s.steps} streaming={streaming} awaiting={awaiting} />;
            if (s.type === 'text') {
              return (
                <div key={key} className={cn(streaming && i === lastText && CARET)}>
                  <Markdown>{s.text}</Markdown>
                </div>
              );
            }
            if (s.type === 'block') {
              return (
                <BlockRenderer key={s.part.id ?? key} part={s.part} messageId={messageId} confirm={confirm} />
              );
            }
            if (s.type === 'escalated') {
              return (
                <Notice key={key} icon={TrendingUp}>
                  Switched from {humanize(s.part.from ?? '')} to {humanize(s.part.to ?? '')}
                  {s.part.reason ? `: ${s.part.reason}` : ''}
                </Notice>
              );
            }
            if (s.type === 'notice') return <Notice key={key}>{s.part.text}</Notice>;
            return null;
          })}
        </div>
        {message.status === 'error' && (
          <ErrorNotice
            message={message.error?.message ?? 'Something went wrong while answering.'}
            onRetry={onRetry}
          />
        )}
        {message.status === 'stopped' && <Notice icon={CircleStop}>You stopped this answer.</Notice>}
        {!streaming && (text || onRegenerate || !showThinking) && (
          <div className="-ml-2 flex min-h-8 flex-wrap items-center gap-0.5 text-[11px] text-subtle">
            {text && <CopyButton text={text} label="Copy answer" iconOnly variant="ghost" />}
            {onRegenerate && (
              <button
                type="button"
                onClick={onRegenerate}
                title="Ask the same question again on the Deep tier"
                className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2 font-medium text-muted transition-colors duration-150 hover:bg-surface-2 hover:text-fg"
              >
                <RefreshCw className="size-3.5" aria-hidden /> Regenerate with Deep
              </button>
            )}
            {!showThinking && modelLine(message) && (
              <span className="ml-auto truncate pl-2">{modelLine(message)}</span>
            )}
          </div>
        )}
      </div>
    </article>
  );
});
