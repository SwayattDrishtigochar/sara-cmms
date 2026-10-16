import { useQuery } from '@tanstack/react-query';
import { ChartGantt } from 'lucide-react';
import { useState } from 'react';
import { api } from '../api/client.js';
import { formatDuration, formatTime } from '../lib/format.js';
import { StatusTimelineBar } from '../ui/charts.jsx';
import { Button, Card, CardHeader, Skeleton, StatusPill } from '../ui/core.jsx';

const Availability = ({ data }) => {
  const scheduled = (data.runs ?? []).some((r) => r.status !== 'OFF');
  return (
    <div className="text-right">
      <p className="text-lg leading-none font-semibold text-fg tabular">
        {scheduled ? `${Math.round((data.availability ?? 0) * 100)}%` : '—'}
      </p>
      <p className="mt-1 text-[11px] text-subtle">{scheduled ? 'Availability' : 'Not scheduled'}</p>
    </div>
  );
};

/** Last 24 h of machine status: segmented strip, totals, availability and the full list of changes. */
export const TimelineCard = ({ assetId }) => {
  const [showList, setShowList] = useState(false);
  const query = useQuery({
    queryKey: ['telemetry', 'timeline', assetId],
    queryFn: ({ signal }) => api('/telemetry/timeline', { query: { assetId, range: '24h' }, signal }),
    refetchInterval: 60_000,
  });
  const data = query.data;
  const runs = data?.runs ?? [];

  return (
    <Card>
      <CardHeader
        icon={ChartGantt}
        title="Status timeline"
        subtitle="Last 24 hours · availability = running time ÷ scheduled time"
        actions={data && runs.length > 0 && <Availability data={data} />}
      />
      <div className="p-4">
        {query.isLoading && <Skeleton className="h-8 w-full" />}
        {query.isError && (
          <div className="flex flex-wrap items-center gap-3 text-sm text-critical">
            Couldn't load the timeline: {query.error.message}
            <Button size="sm" onClick={() => query.refetch()}>
              Try again
            </Button>
          </div>
        )}
        {data && !runs.length && (
          <p className="text-sm text-muted">No status was recorded for this machine in the last 24 hours.</p>
        )}
        {runs.length > 0 && <StatusTimelineBar runs={runs} start={data.start} stop={data.stop} />}
      </div>
      {runs.length > 0 && (
        <details className="border-t border-border" onToggle={(e) => setShowList(e.currentTarget.open)}>
          <summary className="cursor-pointer px-4 py-2.5 text-xs font-medium text-muted hover:text-fg">
            Show all {runs.length} status {runs.length === 1 ? 'period' : 'periods'}
          </summary>
          {showList && (
            <ol className="max-h-72 divide-y divide-border overflow-y-auto scrollbar-thin">
              {[...runs].reverse().map((r) => (
                <li
                  key={`${r.start}-${r.status}`}
                  className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-2 text-xs"
                >
                  <StatusPill status={r.status} />
                  <span className="text-muted tabular">
                    {formatTime(r.start)} – {formatTime(r.end)}
                  </span>
                  <span className="ml-auto font-medium text-fg tabular">{formatDuration(r.seconds)}</span>
                </li>
              ))}
            </ol>
          )}
        </details>
      )}
    </Card>
  );
};
