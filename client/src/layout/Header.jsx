import { Building2, LogOut, Menu as MenuIcon, Monitor, Moon, Sun } from 'lucide-react';
import { AskSara } from '../assistant/AskSara.jsx';
import { useLogout, useMe } from '../auth/useAuth.js';
import { useTheme } from '../lib/theme.js';
import { useUi } from '../store/ui.js';
import { Avatar, Badge, Button } from '../ui/core.jsx';
import { Select } from '../ui/form.jsx';
import { Menu, MenuItem, MenuLabel, MenuSeparator } from '../ui/overlay.jsx';
import { VoiceButton } from '../voice/VoiceButton.jsx';
import { NotificationsBell } from './NotificationsBell.jsx';

const THEMES = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor },
];

const PlantSwitcher = ({ ctx }) => {
  const { plantId, setPlantId } = useUi();
  if (ctx.company.isPlatform || ctx.plants.length === 0) return null;
  if (ctx.plantLocked) {
    const plant = ctx.plants.find((p) => p._id === ctx.plantId);
    return (
      <span className="hidden items-center gap-1.5 text-xs text-muted sm:flex">
        <Building2 className="size-3.5" aria-hidden /> {plant?.name}
      </span>
    );
  }
  return (
    <Select
      aria-label="Plant"
      value={plantId ?? ''}
      onChange={(e) => setPlantId(e.target.value || null)}
      className="hidden h-8 w-auto max-w-44 text-xs sm:block"
    >
      <option value="">All plants</option>
      {ctx.plants.map((p) => (
        <option key={p._id} value={p._id}>
          {p.name}
        </option>
      ))}
    </Select>
  );
};

export const Header = ({ extra }) => {
  const { data } = useMe();
  const logout = useLogout();
  const [theme, setTheme] = useTheme();
  const setMobileNav = useUi((s) => s.setMobileNav);
  const ctx = data?.context;
  if (!ctx) return null;
  const ThemeIcon = THEMES.find((t) => t.value === theme)?.icon ?? Monitor;

  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-surface/80 px-4 backdrop-blur supports-[backdrop-filter]:bg-surface/70">
      <Button
        variant="ghost"
        size="icon"
        className="lg:hidden"
        onClick={() => setMobileNav(true)}
        aria-label="Open menu"
      >
        <MenuIcon className="size-5" />
      </Button>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold text-fg">{ctx.company.name}</p>
        {ctx.company.industry && (
          <p className="-mt-0.5 hidden truncate text-[11px] text-subtle sm:block">{ctx.company.industry}</p>
        )}
      </div>

      {extra}
      <PlantSwitcher ctx={ctx} />
      {!ctx.company.isPlatform && <VoiceButton />}
      {!ctx.company.isPlatform && <AskSara shortcut />}
      <NotificationsBell />

      <Menu
        trigger={
          <Button variant="ghost" size="icon" aria-label="Theme">
            <ThemeIcon className="size-[18px]" />
          </Button>
        }
      >
        {THEMES.map((t) => (
          <MenuItem key={t.value} icon={t.icon} onSelect={() => setTheme(t.value)}>
            {t.label}
            {theme === t.value && <span className="ml-auto text-xs text-brand">✓</span>}
          </MenuItem>
        ))}
      </Menu>

      <Menu
        trigger={
          <button
            type="button"
            className="flex items-center gap-2 rounded-lg p-1 pr-2 hover:bg-surface-2"
            aria-label="Account menu"
          >
            <Avatar name={ctx.user.name} />
            <span className="hidden text-left md:block">
              <span className="block max-w-36 truncate text-xs font-semibold text-fg">{ctx.user.name}</span>
              <span className="block max-w-36 truncate text-[11px] text-subtle">
                {ctx.user.title ?? ctx.role}
              </span>
            </span>
          </button>
        }
      >
        <MenuLabel>
          <span className="block truncate font-medium text-fg">{ctx.user.email}</span>
          <span className="mt-1 flex gap-1.5">
            <Badge value={ctx.role} />
            {ctx.department && <Badge tone="neutral">{ctx.department}</Badge>}
          </span>
        </MenuLabel>
        <MenuSeparator />
        <MenuItem icon={LogOut} onSelect={logout} danger>
          Sign out
        </MenuItem>
      </Menu>
    </header>
  );
};
