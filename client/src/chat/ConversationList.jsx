import { MessageSquareText, Mic, MoreHorizontal, Pencil, Plus, Search, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { NavLink } from 'react-router';
import { toast } from 'sonner';
import { cn, getFormatPrefs } from '../lib/format.js';
import { idOf } from '../store/streamStore.js';
import { Button, Skeleton } from '../ui/core.jsx';
import { Input } from '../ui/form.jsx';
import { Dialog, Menu, MenuItem } from '../ui/overlay.jsx';
import { useConversations, useDeleteConversation, usePatchConversation } from './useChat.js';

const DAY = 86_400_000;

/** Calendar day number of a moment in the company time zone. */
const dayNumber = (value) => {
  const key = new Intl.DateTimeFormat('en-CA', { timeZone: getFormatPrefs().timeZone }).format(
    new Date(value),
  );
  return Math.floor(Date.parse(`${key}T00:00:00Z`) / DAY);
};

/** Today / Yesterday / Previous 7 days / Previous 30 days / Older, newest first, empty groups dropped. */
export const groupByDate = (items, now = Date.now()) => {
  const today = dayNumber(now);
  const labelOf = (item) => {
    const age = today - dayNumber(item.lastMessageAt ?? item.createdAt ?? now);
    if (age <= 0) return 'Today';
    if (age === 1) return 'Yesterday';
    if (age < 7) return 'Previous 7 days';
    if (age < 30) return 'Previous 30 days';
    return 'Older';
  };
  const groups = new Map();
  for (const item of items) {
    const label = labelOf(item);
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(item);
  }
  return [...groups].map(([label, list]) => ({ label, items: list }));
};

const Row = ({ item, onNavigate, onDelete }) => {
  const patch = usePatchConversation();
  const [editing, setEditing] = useState(false);
  const id = idOf(item);
  const title = item.title || 'New conversation';
  const save = (value) => {
    setEditing(false);
    const next = value.trim();
    if (next && next !== item.title) {
      patch.mutate(
        { id, title: next },
        { onError: (err) => toast.error("Couldn't rename", { description: err.message }) },
      );
    }
  };
  if (editing) {
    return (
      <Input
        autoFocus
        defaultValue={item.title ?? ''}
        aria-label="Conversation title"
        className="h-8 text-sm"
        onBlur={(e) => save(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') save(e.currentTarget.value);
          if (e.key === 'Escape') setEditing(false);
        }}
      />
    );
  }
  return (
    <div className="group relative">
      <NavLink
        to={`/chat/${id}`}
        onClick={onNavigate}
        className={({ isActive }) =>
          cn(
            'flex h-9 items-center gap-1.5 rounded-lg pr-8 pl-2.5 text-sm transition-colors',
            isActive ? 'bg-brand-soft font-medium text-brand' : 'text-fg hover:bg-surface-2',
          )
        }
      >
        {item.voice && (
          <Mic className="size-3.5 shrink-0 text-ai" role="img" aria-label="Voice conversation" />
        )}
        <span className="truncate">{title}</span>
      </NavLink>
      <Menu
        trigger={
          <button
            type="button"
            aria-label={`Actions for ${title}`}
            className="absolute top-1/2 right-1 grid size-7 -translate-y-1/2 place-items-center rounded-md text-muted hover:bg-surface-3 hover:text-fg focus:opacity-100 lg:opacity-0 lg:group-hover:opacity-100 data-[state=open]:opacity-100"
          >
            <MoreHorizontal className="size-4" />
          </button>
        }
      >
        <MenuItem icon={Pencil} onSelect={() => setEditing(true)}>
          Rename
        </MenuItem>
        <MenuItem icon={Trash2} danger onSelect={() => onDelete(item)}>
          Delete
        </MenuItem>
      </Menu>
    </div>
  );
};

/** Own conversations grouped by date, with search, rename and delete. `activeId` is left on delete. */
export const ConversationList = ({ activeId, onNew, onNavigate, onDeleted }) => {
  const list = useConversations();
  const remove = useDeleteConversation();
  const [query, setQuery] = useState('');
  const [doomed, setDoomed] = useState(null);
  const items = useMemo(() => (list.data?.pages ?? []).flatMap((p) => p?.items ?? []), [list.data]);
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    return groupByDate(q ? items.filter((i) => (i.title ?? '').toLowerCase().includes(q)) : items);
  }, [items, query]);

  const confirmDelete = () => {
    const id = idOf(doomed);
    setDoomed(null);
    remove.mutate(id, {
      onSuccess: () => {
        if (id === activeId) onDeleted?.();
      },
      onError: (err) => toast.error("Couldn't delete", { description: err.message }),
    });
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="space-y-2 p-3">
        <Button variant="primary" icon={Plus} className="w-full" onClick={onNew}>
          New chat
        </Button>
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search chats"
          aria-label="Search chats"
          className="h-8 text-sm"
          suffix={<Search className="size-3.5" aria-hidden />}
        />
      </div>
      <nav
        aria-label="Conversations"
        className="min-h-0 flex-1 space-y-4 overflow-y-auto px-3 pb-3 scrollbar-thin"
      >
        {list.isLoading && [0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-8 w-full rounded-lg" />)}
        {!list.isLoading && groups.length === 0 && (
          <p className="flex flex-col items-center gap-2 px-2 py-8 text-center text-sm text-muted">
            <MessageSquareText className="size-5 text-subtle" aria-hidden />
            {query ? 'No chats match.' : 'Your conversations with SARA show up here.'}
          </p>
        )}
        {groups.map((g) => (
          <section key={g.label}>
            <h3 className="px-2.5 pb-1 text-[11px] font-medium text-subtle">{g.label}</h3>
            <div className="space-y-0.5">
              {g.items.map((item) => (
                <Row key={idOf(item)} item={item} onNavigate={onNavigate} onDelete={setDoomed} />
              ))}
            </div>
          </section>
        ))}
        {list.hasNextPage && (
          <Button
            variant="ghost"
            size="sm"
            className="w-full"
            loading={list.isFetchingNextPage}
            onClick={() => list.fetchNextPage()}
          >
            Load older chats
          </Button>
        )}
      </nav>
      <Dialog
        open={Boolean(doomed)}
        onOpenChange={(open) => !open && setDoomed(null)}
        title="Delete this chat?"
        size="sm"
        footer={
          <>
            <Button onClick={() => setDoomed(null)}>Cancel</Button>
            <Button variant="danger" icon={Trash2} onClick={confirmDelete}>
              Delete
            </Button>
          </>
        }
      >
        <p className="text-sm text-muted">
          "{doomed?.title || 'New conversation'}" will be removed from your list.
        </p>
      </Dialog>
    </div>
  );
};
