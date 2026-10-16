import { FileText, Gauge, LayoutGrid, Maximize2, SquarePen, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router';
import { toast } from 'sonner';
import { Thread } from '../chat/Thread.jsx';
import { useChatActions } from '../chat/useChat.js';
import { refLabel } from '../lib/format.js';
import { useModuleMeta, useRecord } from '../modules/useModules.js';
import { humanize } from '../superadmin/simUtils.js';
import { Button, Kbd } from '../ui/core.jsx';
import { Sheet } from '../ui/overlay.jsx';
import { MOD_KEY } from './AskSara.jsx';
import { contextFromPath, useAssistant } from './useAssistant.js';

/** The page context with the record's display name (IMM 3, WO-12 · Coolant leak) once it has loaded. */
const useLabelledContext = (context) => {
  const ref = context?.recordRef;
  const { data: record } = useRecord(ref?.module, ref?.id);
  return useMemo(() => {
    if (!ref) return context;
    const label = ref.label ?? (record ? (record.name ?? refLabel(record)) : null);
    return { ...context, recordRef: { ...ref, ...(label ? { label: String(label).slice(0, 120) } : {}) } };
  }, [context, ref, record]);
};

/** "IMM 3 · Machine", "Work orders page": what SARA is pointed at. */
const ContextChip = ({ context, onClear }) => {
  const ref = context?.recordRef;
  const { data: mod } = useModuleMeta(ref?.module);
  const Icon = ref?.module === 'assets' ? Gauge : ref ? FileText : LayoutGrid;
  const text = ref
    ? [ref.label ?? 'This record', ref.module === 'assets' ? 'Machine' : mod?.singular]
        .filter(Boolean)
        .join(' · ')
    : `${humanize(context?.page ?? 'home')} page`;
  return (
    <span className="inline-flex h-7 max-w-full items-center gap-1.5 rounded-full border border-border bg-surface-2 pr-1 pl-2.5 text-xs text-fg">
      <Icon className="size-3.5 shrink-0 text-ai" aria-hidden />
      <span className="truncate">
        <span className="text-muted">Context: </span>
        {text}
      </span>
      <button
        type="button"
        onClick={onClear}
        aria-label="Ask without this context"
        title="Ask without this context"
        className="grid size-5 shrink-0 place-items-center rounded-full text-muted hover:bg-surface-3 hover:text-fg"
      >
        <X className="size-3" aria-hidden />
      </button>
    </span>
  );
};

/** Global SARA drawer (⌘/Ctrl+J): the chat thread with the current page as context. Mount once in the shell. */
export const AssistantDrawer = () => {
  const {
    isOpen,
    text,
    context: given,
    pendingSend,
    nonce,
    conversationId,
    close,
    toggle,
    setConversationId,
  } = useAssistant();
  const { pathname } = useLocation();
  const [cleared, setCleared] = useState(null); // the page whose context the user dropped
  const pageContext = useLabelledContext(
    useMemo(() => given ?? contextFromPath(pathname), [given, pathname]),
  );
  const context = cleared === pathname ? undefined : pageContext;
  const actions = useChatActions();
  const sentFor = useRef(0);

  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'j') {
        e.preventDefault();
        toggle();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggle]);

  // open({ send: true }) sends right away into the drawer's conversation.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once per open() call
  useEffect(() => {
    if (!pendingSend || sentFor.current === nonce) return;
    sentFor.current = nonce;
    useAssistant.setState({ pendingSend: null });
    actions
      .send({ conversationId, text: pendingSend, context })
      .then(setConversationId)
      .catch((err) => toast.error("Couldn't ask SARA", { description: err.message }));
  }, [nonce]);

  return (
    <Sheet
      open={isOpen}
      onOpenChange={(open) => (open ? null : close())}
      title="Ask SARA"
      description={
        <span className="inline-flex items-center gap-1.5">
          <Kbd>{MOD_KEY} J</Kbd> opens SARA from any page
        </span>
      }
      width="max-w-2xl"
    >
      <div className="-mx-5 -my-4 flex h-full min-h-0 flex-col">
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-1.5">
          <div className="min-w-0 flex-1">
            {context ? (
              <ContextChip context={context} onClear={() => setCleared(pathname)} />
            ) : (
              <span className="px-1 text-xs text-subtle">No page context: SARA answers in general.</span>
            )}
          </div>
          <Button
            size="sm"
            variant="ghost"
            icon={SquarePen}
            onClick={() => setConversationId(null)}
            disabled={!conversationId}
          >
            New chat
          </Button>
          {conversationId && (
            <Link
              to={`/chat/${conversationId}`}
              onClick={close}
              className="inline-flex h-8 items-center gap-2 rounded-lg px-3 text-xs font-medium text-muted transition-colors duration-150 hover:bg-surface-2 hover:text-fg"
            >
              <Maximize2 className="size-4" aria-hidden /> Open in Chat
            </Link>
          )}
        </div>
        <Thread
          conversationId={conversationId}
          onCreated={setConversationId}
          context={context}
          prefill={{ key: nonce, text }}
          compact
          className="min-h-0 flex-1"
        />
      </div>
    </Sheet>
  );
};
