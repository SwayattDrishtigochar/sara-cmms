import { CalendarRange, LayoutDashboard, Sparkles } from 'lucide-react';
import { useMemo } from 'react';
import { Link } from 'react-router';
import { useAssistant } from '../assistant/useAssistant.js';
import { useSession } from '../auth/useAuth.js';
import { formatDate, getFormatPrefs } from '../lib/format.js';
import { startOfDay } from '../machines/telemetry.js';
import { Gantt } from '../planner/Gantt.jsx';
import { useCalendar } from '../planner/usePlanning.js';
import { Button, Card, CardHeader, PageHeader, Skeleton } from '../ui/core.jsx';
import { AlertsFeed } from './AlertsFeed.jsx';
import { BriefingCard } from './BriefingCard.jsx';
import { KpiStrip } from './KpiStrip.jsx';
import { LiveFloor } from './LiveFloor.jsx';
import { MaintenanceDue } from './MaintenanceDue.jsx';
import { useBriefing, useBriefingPlant } from './useBriefing.js';

const DAY = 86_400_000;

/** Today's mini Gantt: every machine from local midnight for 24 h, job cards and maintenance. */
const TodayPlan = ({ className }) => {
  const plantId = useBriefingPlant();
  const day = startOfDay(getFormatPrefs().timeZone);
  const params = useMemo(
    () => ({
      start: new Date(day).toISOString(),
      end: new Date(day + DAY).toISOString(),
      ...(plantId ? { plantId } : {}),
    }),
    [day, plantId],
  );
  const cal = useCalendar(params);
  let body;
  if (cal.isLoading) body = <Skeleton className="m-4 h-40" />;
  else if (cal.isError) body = <p className="px-4 py-6 text-sm text-muted">The plan couldn't be loaded.</p>;
  else if (!cal.data?.gantt?.rows?.length)
    body = <p className="px-4 py-6 text-sm text-muted">No machines to plan today.</p>;
  else body = <Gantt data={cal.data.gantt} compact className="p-2" />;
  return (
    <Card className={className}>
      <CardHeader
        icon={CalendarRange}
        title="Today's plan"
        subtitle="Job cards and maintenance on every machine"
        actions={
          <Link to="/planner" className="text-xs font-medium text-brand hover:underline">
            Open Planner
          </Link>
        }
      />
      {body}
    </Card>
  );
};

const greeting = (hour) => (hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening');

/** "/" — the Command Center: SARA's briefing, alerts, KPIs, the live floor, today's plan and maintenance due. */
export const CommandCenter = () => {
  const ctx = useSession();
  const briefing = useBriefing();
  const hour = Number(
    new Intl.DateTimeFormat('en-GB', {
      hour: 'numeric',
      hourCycle: 'h23',
      timeZone: getFormatPrefs().timeZone,
    }).format(new Date()),
  );
  const first = ctx?.user?.name?.split(' ')[0];
  return (
    <div className="mx-auto w-full max-w-[1600px] space-y-4 px-4 py-6 sm:px-6">
      <PageHeader
        icon={LayoutDashboard}
        title="Command Center"
        description={`${greeting(hour)}${first ? `, ${first}` : ''}. Here is ${formatDate(new Date())} so far.`}
        actions={
          <Button
            variant="ai"
            icon={Sparkles}
            onClick={() => useAssistant.getState().open({ context: { page: 'home' } })}
          >
            Ask SARA
          </Button>
        }
      />
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="min-w-0 lg:col-span-2">
          <BriefingCard />
        </div>
        <AlertsFeed className="lg:max-h-[42rem] lg:overflow-y-auto" />
      </div>
      <KpiStrip />
      <LiveFloor />
      <div className="grid gap-4 lg:grid-cols-3">
        <TodayPlan className="min-w-0 lg:col-span-2" />
        <MaintenanceDue maintenance={briefing.data?.evidence?.maintenance} loading={briefing.isLoading} />
      </div>
    </div>
  );
};
