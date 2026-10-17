import { Outlet } from 'react-router';
import { AssistantDrawer } from '../assistant/AssistantDrawer.jsx';
import { CommandPalette } from '../assistant/CommandPalette.jsx';
import { useSession } from '../auth/useAuth.js';
import { useLiveConnection, useRecordSync } from '../live/liveStore.js';
import { useUi } from '../store/ui.js';
import { Sheet } from '../ui/overlay.jsx';
import { VoicePanel } from '../voice/VoicePanel.jsx';
import { Header } from './Header.jsx';
import { Sidebar, SidebarContent } from './Sidebar.jsx';

/** Keeps the one /api/live stream open while mounted, and refreshes lists when the server says records changed. */
const LiveConnection = () => {
  useLiveConnection();
  useRecordSync();
  return null;
};

export const AppShell = () => {
  const { mobileNav, setMobileNav } = useUi();
  const ctx = useSession();
  const company = ctx && !ctx.company?.isPlatform;
  return (
    <div className="flex h-full">
      {company && (
        <>
          <LiveConnection />
          <AssistantDrawer />
          <VoicePanel />
          <CommandPalette />
        </>
      )}
      <a
        href="#content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded-lg focus:bg-surface focus:px-3 focus:py-2"
      >
        Skip to content
      </a>
      <Sidebar />
      <Sheet open={mobileNav} onOpenChange={setMobileNav} title="SARA" side="left" width="max-w-72">
        <div className="-mx-5 -my-4 flex h-full flex-col">
          <SidebarContent onNavigate={() => setMobileNav(false)} />
        </div>
      </Sheet>
      <div className="flex min-w-0 flex-1 flex-col">
        <Header />
        <main id="content" className="relative min-h-0 flex-1 overflow-y-auto scrollbar-thin">
          <Outlet />
        </main>
      </div>
    </div>
  );
};
