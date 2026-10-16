import { ChevronDown, PanelLeftClose, PanelLeftOpen, Shield } from 'lucide-react';
import { useMemo, useState } from 'react';
import { NavLink } from 'react-router';
import { useSession } from '../auth/useAuth.js';
import { cn } from '../lib/format.js';
import { moduleIcon } from '../lib/icons.js';
import { useModulesMeta } from '../modules/useModules.js';
import { useUi } from '../store/ui.js';
import { Tooltip } from '../ui/overlay.jsx';
import { PRIMARY_NAV } from './nav.js';

const GROUP_ORDER = [
  'Maintenance',
  'Production',
  'Bins & stations',
  'Inventory',
  'Partners',
  'Costs',
  'AI',
  'Rules & reports',
  'Organisation',
  'System',
];

const Item = ({ to, icon: Icon, label, collapsed, end, badge }) => (
  <Tooltip content={collapsed ? label : null} side="right">
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        cn(
          'group flex h-9 items-center gap-3 rounded-lg px-2.5 text-sm font-medium transition-colors',
          isActive ? 'bg-brand-soft text-brand' : 'text-muted hover:bg-surface-2 hover:text-fg',
          collapsed && 'justify-center px-0',
        )
      }
    >
      <Icon className="size-[18px] shrink-0" aria-hidden />
      {!collapsed && <span className="truncate">{label}</span>}
      {!collapsed && badge}
    </NavLink>
  </Tooltip>
);

export const SidebarContent = ({ collapsed = false, onNavigate }) => {
  const ctx = useSession();
  const { data: modules } = useModulesMeta();
  const [closed, setClosed] = useState({});

  const groups = useMemo(() => {
    const byGroup = new Map();
    for (const m of modules ?? []) {
      if (!byGroup.has(m.group)) byGroup.set(m.group, []);
      byGroup.get(m.group).push(m);
    }
    return [...byGroup].sort(([a], [b]) => GROUP_ORDER.indexOf(a) - GROUP_ORDER.indexOf(b));
  }, [modules]);

  const isPlatform = ctx?.company?.isPlatform;
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: click only closes the mobile drawer after a link is followed
    <nav
      className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-3 py-4 scrollbar-thin"
      aria-label="Main"
      onClick={onNavigate}
    >
      {!isPlatform && (
        <div className="space-y-0.5">
          {PRIMARY_NAV.map((item) => (
            <Item key={item.to} {...item} collapsed={collapsed} />
          ))}
        </div>
      )}

      {!isPlatform &&
        groups.map(([group, mods]) => (
          <div key={group}>
            {!collapsed && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setClosed((c) => ({ ...c, [group]: !c[group] }));
                }}
                className="mb-1 flex w-full items-center justify-between px-2.5 text-[11px] font-semibold tracking-wider text-subtle uppercase hover:text-muted"
                aria-expanded={!closed[group]}
              >
                {group}
                <ChevronDown className={cn('size-3.5 transition-transform', closed[group] && '-rotate-90')} />
              </button>
            )}
            {!closed[group] && (
              <div className="space-y-0.5">
                {mods.map((m) => (
                  <Item
                    key={m.name}
                    to={`/m/${m.name}`}
                    icon={moduleIcon(m.icon)}
                    label={m.label}
                    collapsed={collapsed}
                  />
                ))}
              </div>
            )}
          </div>
        ))}

      {ctx?.role === 'superAdmin' && (
        <div className="space-y-0.5">
          {!collapsed && (
            <p className="mb-1 px-2.5 text-[11px] font-semibold tracking-wider text-subtle uppercase">
              Platform
            </p>
          )}
          <Item to="/superadmin" icon={Shield} label="Superadmin" collapsed={collapsed} />
        </div>
      )}
    </nav>
  );
};

export const Sidebar = () => {
  const { collapsed, toggleCollapsed } = useUi();
  return (
    <aside
      className={cn(
        'hidden shrink-0 flex-col border-r border-border bg-surface transition-[width] duration-200 lg:flex',
        collapsed ? 'w-16' : 'w-64',
      )}
    >
      <div
        className={cn(
          'flex h-14 items-center gap-2.5 border-b border-border px-4',
          collapsed && 'justify-center px-0',
        )}
      >
        <img src="/favicon.svg" alt="" className="size-7" />
        {!collapsed && (
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold tracking-tight text-fg">SARA</p>
            <p className="-mt-0.5 text-[11px] text-subtle">AI CMMS</p>
          </div>
        )}
      </div>
      <SidebarContent collapsed={collapsed} />
      <div className="border-t border-border p-3">
        <button
          type="button"
          onClick={toggleCollapsed}
          className={cn(
            'flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-xs text-muted hover:bg-surface-2 hover:text-fg',
            collapsed && 'justify-center px-0',
          )}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {collapsed ? <PanelLeftOpen className="size-4" /> : <PanelLeftClose className="size-4" />}
          {!collapsed && 'Collapse'}
        </button>
      </div>
    </aside>
  );
};
