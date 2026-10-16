import { useQueries } from '@tanstack/react-query';
import { Command } from 'cmdk';
import {
  Activity,
  CornerDownLeft,
  Factory,
  History,
  MessageSquareText,
  Search,
  Shield,
  Sparkles,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { api } from '../api/client.js';
import { useSession } from '../auth/useAuth.js';
import { useConversations } from '../chat/useChat.js';
import { PRIMARY_NAV } from '../layout/nav.js';
import { refLabel } from '../lib/format.js';
import { moduleIcon } from '../lib/icons.js';
import { useModulesMeta } from '../modules/useModules.js';
import { Kbd } from '../ui/core.jsx';
import { useAssistant } from './useAssistant.js';

const SEARCHED = ['assets', 'workorders', 'spareparts', 'jobcards', 'requests', 'users'];
const BASE_PAGES = [
  { to: '/chat', icon: MessageSquareText, label: 'Chat' },
  { to: '/machines', icon: Factory, label: 'Machines' },
  { to: '/anomalies', icon: Activity, label: 'Anomalies' },
];

const recordPath = (module, id) => (module === 'assets' ? `/machines/${id}` : `/m/${module}/${id}`);

const useDebounced = (value, ms) => {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
};

const ITEM =
  'flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm text-fg data-[selected=true]:bg-surface-2';
const GROUP =
  '[&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-subtle';

/** ⌘/Ctrl+K: jump to pages and records, or ask SARA the typed question. Mount once in the shell. */
export const CommandPalette = () => {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const navigate = useNavigate();
  const ctx = useSession();
  const { data: modules = [] } = useModulesMeta();
  const q = useDebounced(query.trim(), 250);
  const chats = useConversations({ enabled: open && !ctx?.company?.isPlatform });
  const recent = ctx?.company?.isPlatform
    ? []
    : (chats.data?.pages?.[0]?.items ?? []).filter((c) => c.title).slice(0, query.trim() ? 0 : 4);

  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => {
    if (!open) setQuery('');
  }, [open]);

  const pages = useMemo(() => {
    const company = ctx?.company?.isPlatform
      ? []
      : [
          ...BASE_PAGES,
          ...PRIMARY_NAV,
          ...modules.map((m) => ({ to: `/m/${m.name}`, icon: moduleIcon(m.icon), label: m.label })),
        ];
    const all = [
      ...company,
      ...(ctx?.role === 'superAdmin' ? [{ to: '/superadmin', icon: Shield, label: 'Super admin' }] : []),
    ];
    const seen = new Set();
    const needle = query.trim().toLowerCase();
    return all.filter(
      (p) => !seen.has(p.to) && seen.add(p.to) && (!needle || p.label.toLowerCase().includes(needle)),
    );
  }, [modules, ctx, query]);

  const searched = modules.filter((m) => SEARCHED.includes(m.name));
  const results = useQueries({
    queries: searched.map((m) => ({
      queryKey: ['palette', m.name, q],
      queryFn: ({ signal }) => api(`/m/${m.name}`, { query: { q, limit: 5 }, signal }),
      enabled: open && q.length >= 2,
      staleTime: 30_000,
    })),
  });
  const records = searched.flatMap((m, i) =>
    (results[i]?.data?.items ?? []).map((item) => ({ module: m, item, to: recordPath(m.name, item._id) })),
  );
  const loading = results.some((r) => r.isFetching);

  const go = (to) => {
    setOpen(false);
    navigate(to);
  };
  const ask = () => {
    setOpen(false);
    useAssistant.getState().open({ text: query.trim(), send: true });
  };

  return (
    <Command.Dialog
      open={open}
      onOpenChange={setOpen}
      label="Search SARA"
      shouldFilter={false}
      overlayClassName="fixed inset-0 z-50 bg-black/40 backdrop-blur-[2px] animate-fade-in"
      contentClassName="fixed top-[12vh] left-1/2 z-50 w-[calc(100vw-2rem)] max-w-xl -translate-x-1/2 overflow-hidden rounded-2xl border border-border bg-surface shadow-pop animate-fade-in focus:outline-none"
    >
      <div className="flex items-center gap-2 border-b border-border px-3.5">
        <Search className="size-4 shrink-0 text-subtle" aria-hidden />
        <Command.Input
          value={query}
          onValueChange={setQuery}
          placeholder="Search pages and records, or ask SARA…"
          className="h-12 w-full bg-transparent text-sm text-fg outline-none placeholder:text-subtle"
        />
        <Kbd>Esc</Kbd>
      </div>
      <Command.List className="max-h-[60vh] overflow-y-auto p-1.5 scrollbar-thin">
        <Command.Empty className="px-3 py-8 text-center text-sm text-muted">
          {loading ? 'Searching…' : 'Nothing found.'}
        </Command.Empty>
        {query.trim() && (
          <Command.Group heading="SARA" className={GROUP}>
            <Command.Item value="ask" onSelect={ask} className={ITEM}>
              <Sparkles className="size-4 shrink-0 text-ai" aria-hidden />
              <span className="min-w-0 truncate">
                Ask SARA: <span className="font-medium">{query.trim()}</span>
              </span>
              <CornerDownLeft className="ml-auto size-3.5 shrink-0 text-subtle" aria-hidden />
            </Command.Item>
          </Command.Group>
        )}
        {recent.length > 0 && (
          <Command.Group heading="Recent chats" className={GROUP}>
            {recent.map((c) => (
              <Command.Item
                key={c.id}
                value={`chat ${c.id}`}
                onSelect={() => go(`/chat/${c.id}`)}
                className={ITEM}
              >
                <History className="size-4 shrink-0 text-muted" aria-hidden />
                <span className="min-w-0 truncate">{c.title}</span>
              </Command.Item>
            ))}
          </Command.Group>
        )}
        {pages.length > 0 && (
          <Command.Group heading="Pages" className={GROUP}>
            {pages.slice(0, query ? 8 : 40).map((p) => (
              <Command.Item key={p.to} value={`page ${p.to}`} onSelect={() => go(p.to)} className={ITEM}>
                <p.icon className="size-4 shrink-0 text-muted" aria-hidden />
                {p.label}
              </Command.Item>
            ))}
          </Command.Group>
        )}
        {records.length > 0 && (
          <Command.Group heading="Records" className={GROUP}>
            {records.map(({ module, item, to }) => {
              const Icon = moduleIcon(module.icon);
              return (
                <Command.Item key={to} value={`record ${to}`} onSelect={() => go(to)} className={ITEM}>
                  <Icon className="size-4 shrink-0 text-muted" aria-hidden />
                  <span className="min-w-0 truncate">{refLabel(item)}</span>
                  <span className="ml-auto shrink-0 text-xs text-subtle">
                    {module.singular ?? module.label}
                  </span>
                </Command.Item>
              );
            })}
          </Command.Group>
        )}
      </Command.List>
      <div className="flex items-center gap-3 border-t border-border px-3.5 py-2 text-[11px] text-subtle">
        <span className="flex items-center gap-1">
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd> move
        </span>
        <span className="flex items-center gap-1">
          <Kbd>Enter</Kbd> open
        </span>
        <span className="ml-auto flex items-center gap-1">
          <Sparkles className="size-3 text-ai" aria-hidden /> Type a question to ask SARA
        </span>
      </div>
    </Command.Dialog>
  );
};
