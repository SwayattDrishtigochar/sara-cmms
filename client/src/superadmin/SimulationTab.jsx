import { TriangleAlert } from 'lucide-react';
import { Card } from '../ui/core.jsx';
import { ActivityFeed } from './ActivityFeed.jsx';
import { AnomalyLab } from './AnomalyLab.jsx';
import { CompanyCard } from './CompanyCard.jsx';
import { ControlsCard } from './ControlsCard.jsx';
import { Callout, QueryError, useNow } from './parts.jsx';
import { StatusStrip } from './StatusStrip.jsx';
import { useStatus } from './useSim.js';

/**
 * Superadmin → Simulation (docs/simulator-v2.md §6): simulator status, the simulated company, controls,
 * the anomaly lab and the live activity feed. Status refreshes every 3 s while the page is visible.
 */
export const SimulationTab = () => {
  const status = useStatus();
  const data = status.data;
  // Simulator times follow MongoDB's clock: shift this browser's clock by the server's reported offset.
  const offset = Number.isFinite(data?.serverTime) ? data.serverTime - status.dataUpdatedAt : 0;
  const now = useNow(1000) + offset;
  if (status.isError && !data) {
    return (
      <Card>
        <QueryError what="the simulation" error={status.error} onRetry={status.refetch} />
      </Card>
    );
  }
  const live = data?.instances?.find((i) => i.online) ?? null;
  return (
    <div className="space-y-8">
      {status.isError && (
        <Callout tone="warn" icon={TriangleAlert}>
          Couldn't refresh: {status.error.message}. Showing the last known state; retrying every 3 seconds.
        </Callout>
      )}
      <StatusStrip instances={data?.instances} now={now} />
      <div className="grid items-start gap-4 lg:grid-cols-2">
        <CompanyCard company={data?.company} />
        <ControlsCard control={data?.control} online={Boolean(live)} now={now} />
      </div>
      <AnomalyLab status={data} statuses={live?.statuses} online={Boolean(live)} now={now} />
      <ActivityFeed peopleOff={data?.control?.humanActivity === false} now={now} />
    </div>
  );
};
