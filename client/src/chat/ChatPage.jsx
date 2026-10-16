import { Building2, Cpu, Info, Keyboard, PanelLeft, PanelRight, Route, SquarePen } from 'lucide-react';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { MOD_KEY } from '../assistant/AskSara.jsx';
import { useSession } from '../auth/useAuth.js';
import { formatNumber } from '../lib/format.js';
import { mergeStream, useStream } from '../store/streamStore.js';
import { useUi } from '../store/ui.js';
import { humanize } from '../superadmin/simUtils.js';
import { Badge, Button, Kbd } from '../ui/core.jsx';
import { Sheet } from '../ui/overlay.jsx';
import { ConversationList } from './ConversationList.jsx';
import { Thread } from './Thread.jsx';
import { TIER_OPTIONS, useTierModel } from './TierSelect.jsx';
import { useConversation } from './useChat.js';

const Item = ({ icon: Icon, label, children }) => (
  <div className="flex items-start gap-2.5">
    <Icon className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
    <div className="min-w-0 flex-1">
      <p className="text-[11px] font-medium text-subtle">{label}</p>
      <div className="text-sm text-fg">{children}</div>
    </div>
  </div>
);

/** Right column: who SARA is answering for, and how the last answer was produced. */
const ContextPanel = ({ conversationId }) => {
  const ctx = useSession();
  const plantId = useUi((s) => s.plantId);
  const { data } = useConversation(conversationId);
  const stream = useStream(conversationId);
  const modelOf = useTierModel();
  const last = mergeStream(data?.messages ?? [], stream).findLast((m) => m.role === 'assistant');
  const pinned = data?.conversation?.tierPreference ?? 'auto';
  const plant = ctx?.plants?.find((p) => p._id === (ctx.plantLocked ? ctx.plantId : plantId));
  const route = last?.routerDecision;
  return (
    <div className="space-y-5 p-4">
      <Item icon={Building2} label="Company">
        {ctx?.company?.name}
        <p className="text-xs text-muted">
          {plant ? plant.name : 'All plants'} · {ctx?.company?.timeZone}
        </p>
      </Item>
      <Item icon={Info} label="Signed in as">
        {ctx?.user?.name} <Badge value={ctx?.role} className="ml-1" />
      </Item>
      <Item icon={Cpu} label="Tier">
        {TIER_OPTIONS.find((t) => t.value === pinned)?.label ?? humanize(pinned)}
        <p className="text-xs text-muted">{pinned === 'auto' ? 'Chosen per question' : modelOf(pinned)}</p>
      </Item>
      {last && (last.model || route) && (
        <Item icon={Route} label="Last answer">
          {[last.tier && humanize(last.tier), last.model].filter(Boolean).join(' · ')}
          {route && (
            <p className="text-xs text-muted">
              {[route.intent && humanize(route.intent), route.complexity && `${route.complexity} complexity`]
                .filter(Boolean)
                .join(' · ')}
            </p>
          )}
          {last.usage?.total > 0 && (
            <p className="text-xs text-muted">{formatNumber(last.usage.total, { digits: 0 })} tokens</p>
          )}
        </Item>
      )}
      <Item icon={Keyboard} label="Shortcuts">
        <ul className="mt-1 space-y-1.5 text-xs text-muted">
          {[
            ['Send', 'Enter'],
            ['New line', 'Shift Enter'],
            ['SARA on any page', `${MOD_KEY} J`],
            ['Search and jump', `${MOD_KEY} K`],
          ].map(([what, keys]) => (
            <li key={what} className="flex items-center justify-between gap-2">
              {what} <Kbd>{keys}</Kbd>
            </li>
          ))}
        </ul>
      </Item>
      <p className="rounded-lg bg-surface-2 px-3 py-2 text-xs text-muted">
        SARA only reads data you can see. Changes it proposes wait for your Confirm.
      </p>
    </div>
  );
};

/** /chat/:id? — conversation list, thread and context; the side columns become drawers on small screens. */
export const ChatPage = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const [listOpen, setListOpen] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const { data } = useConversation(id);
  const title = data?.conversation?.title || (id ? 'Conversation' : 'New chat');
  const startNew = () => {
    setListOpen(false);
    navigate('/chat');
  };
  const list = (
    <ConversationList
      activeId={id}
      onNew={startNew}
      onNavigate={() => setListOpen(false)}
      onDeleted={startNew}
    />
  );

  return (
    <div className="flex h-full min-h-0">
      <aside className="hidden w-64 shrink-0 border-r border-border bg-surface lg:block">{list}</aside>
      <section className="flex min-w-0 flex-1 flex-col" aria-label="Chat">
        <div className="flex h-11 shrink-0 items-center gap-1 border-b border-border px-2 lg:px-4">
          <Button
            variant="ghost"
            size="iconSm"
            className="lg:hidden"
            aria-label="Show chats"
            onClick={() => setListOpen(true)}
          >
            <PanelLeft className="size-4" />
          </Button>
          <h1 className="min-w-0 flex-1 truncate px-1 text-sm font-semibold text-fg">{title}</h1>
          <Button variant="ghost" size="iconSm" aria-label="New chat" title="New chat" onClick={startNew}>
            <SquarePen className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="iconSm"
            className="xl:hidden"
            aria-label="Show details"
            onClick={() => setInfoOpen(true)}
          >
            <PanelRight className="size-4" />
          </Button>
        </div>
        <Thread
          key={id ?? 'new'}
          conversationId={id}
          onCreated={(newId) => navigate(`/chat/${newId}`, { replace: !id })}
          className="min-h-0 flex-1"
        />
      </section>
      <aside className="hidden w-72 shrink-0 overflow-y-auto border-l border-border bg-surface scrollbar-thin xl:block">
        <ContextPanel conversationId={id} />
      </aside>
      <Sheet open={listOpen} onOpenChange={setListOpen} title="Chats" side="left" width="max-w-72">
        <div className="-mx-5 -my-4 h-full">{list}</div>
      </Sheet>
      <Sheet open={infoOpen} onOpenChange={setInfoOpen} title="Details" width="max-w-80">
        <div className="-mx-5 -my-4">
          <ContextPanel conversationId={id} />
        </div>
      </Sheet>
    </div>
  );
};
