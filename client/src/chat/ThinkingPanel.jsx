import { Brain, ChevronRight } from 'lucide-react';
import { useState } from 'react';
import { cn, formatDuration, humanize } from '../lib/format.js';
import { Markdown } from '../lib/markdown.jsx';
import { useNow } from '../superadmin/parts.jsx';

/** Seconds a message has been (or was) working: live while streaming, else its stored latency. */
export const elapsedOf = (message, now = Date.now()) => {
  if (message.latencyMs != null && message.status !== 'streaming') return message.latencyMs / 1000;
  if (!message.startedAt) return null;
  return ((message.endedAt ?? now) - message.startedAt) / 1000;
};

/** "Balanced · gemini-3.8-flash" of an assistant message. */
export const modelLine = (message) =>
  [message.tier && humanize(message.tier), message.model].filter(Boolean).join(' · ');

/**
 * The model's streamed thoughts, collapsible. Open on its own while the model thinks before answering;
 * the header carries elapsed time, tier and model.
 */
export const ThinkingPanel = ({ text, message, answering }) => {
  const streaming = message.status === 'streaming';
  const now = useNow(streaming ? 500 : 60_000);
  const [open, setOpen] = useState(null);
  const isOpen = open ?? (streaming && !answering && Boolean(text));
  const seconds = elapsedOf(message, now);
  const thinking = streaming && !answering;
  const model = modelLine(message);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen(!isOpen)}
        aria-expanded={isOpen}
        disabled={!text}
        className="-ml-1.5 flex h-7 max-w-full items-center gap-1.5 rounded-md px-1.5 text-xs text-muted transition-colors duration-150 enabled:hover:bg-surface-2 enabled:hover:text-fg"
      >
        <ChevronRight
          className={cn(
            'size-3.5 shrink-0 transition-transform duration-150',
            isOpen && 'rotate-90',
            !text && 'opacity-0',
          )}
          aria-hidden
        />
        <Brain className={cn('size-3.5 shrink-0 text-ai', thinking && 'animate-pulse')} aria-hidden />
        <span className={cn('shrink-0 font-medium', thinking && 'text-fg')}>
          {thinking ? 'Thinking' : 'Thought'}
          {seconds != null && ` for ${formatDuration(Math.max(1, Math.round(seconds)))}`}
          {thinking && '…'}
        </span>
        {model && <span className="min-w-0 truncate text-subtle">· {model}</span>}
      </button>
      {isOpen && text && (
        <div className="mt-0.5 ml-[11px] max-h-64 overflow-y-auto border-l border-border pl-3.5 py-1 scrollbar-thin animate-fade-in">
          <Markdown className="text-xs leading-relaxed text-muted [&_strong]:text-fg">{text}</Markdown>
        </div>
      )}
    </div>
  );
};
