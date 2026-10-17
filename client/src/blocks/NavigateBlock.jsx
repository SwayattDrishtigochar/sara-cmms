import { ArrowUpRight, Compass } from 'lucide-react';
import { useEffect } from 'react';
import { goTo } from '../assistant/useAssistant.js';
import { useStreamStore } from '../store/streamStore.js';
import { Button } from '../ui/core.jsx';

/** Block ids already followed, so a re-render or the saved copy of the message never navigates twice. */
const followed = new Set();

/**
 * "SARA opened …" card of an open_page block. It navigates by itself only while its message is still
 * streaming in a chat turn (a live answer); reading history, or a voice turn (the `navigate` message does it),
 * only shows the Open button.
 */
export const NavigateBlock = ({ id, url, label, reason }) => {
  const live = useStreamStore((s) =>
    Object.values(s.streams).some(
      (st) => st.message.status === 'streaming' && st.message.parts.some((p) => p.id === id),
    ),
  );
  useEffect(() => {
    if (!live || !id || followed.has(id)) return;
    followed.add(id);
    goTo(url);
  }, [live, id, url]);

  return (
    <div className="flex items-center gap-3 rounded-xl border border-border bg-surface px-3 py-2">
      <Compass className="size-4 shrink-0 text-ai" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-fg">{label ?? url}</p>
        {reason && <p className="truncate text-xs text-muted">{reason}</p>}
      </div>
      <Button size="sm" icon={ArrowUpRight} onClick={() => goTo(url)}>
        Open
      </Button>
    </div>
  );
};
