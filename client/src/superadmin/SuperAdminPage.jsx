import { Cpu, Shield, Sparkles } from 'lucide-react';
import { useSearchParams } from 'react-router';
import { useSession } from '../auth/useAuth.js';
import { EmptyState, PageHeader } from '../ui/core.jsx';
import { TabPanel, Tabs } from '../ui/overlay.jsx';
import { AiTab } from './AiTab.jsx';
import { SimulationTab } from './SimulationTab.jsx';

const TABS = [
  { value: 'simulation', label: 'Simulation', icon: Cpu },
  { value: 'ai', label: 'AI', icon: Sparkles },
];

/** Platform admin's control room (/superadmin). The open tab lives in the URL (?tab=simulation). */
export const SuperAdminPage = () => {
  const ctx = useSession();
  const [params, setParams] = useSearchParams();
  const tab = TABS.find((t) => t.value === params.get('tab'))?.value ?? TABS[0].value;
  const openTab = (value) =>
    setParams(
      (prev) => {
        prev.set('tab', value);
        return prev;
      },
      { replace: true },
    );

  if (ctx && ctx.role !== 'superAdmin') {
    return (
      <EmptyState icon={Shield} title="Superadmin only">
        This page is for platform administrators.
      </EmptyState>
    );
  }
  return (
    <div className="mx-auto max-w-[1400px] px-4 py-6 sm:px-6">
      <PageHeader icon={Shield} title="Superadmin" description="Platform controls" />
      <Tabs value={tab} onValueChange={openTab} tabs={TABS}>
        <TabPanel value="simulation">
          <SimulationTab />
        </TabPanel>
        <TabPanel value="ai">
          <AiTab />
        </TabPanel>
      </Tabs>
    </div>
  );
};
