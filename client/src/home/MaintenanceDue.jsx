import { CalendarClock, CalendarRange, Gauge, TriangleAlert, Wrench } from 'lucide-react';
import { Link, useNavigate } from 'react-router';
import { cn, formatDateTime, formatRelative } from '../lib/format.js';
import { Badge, Button, Card, CardHeader, Skeleton } from '../ui/core.jsx';

const KIND = {
  workorder: { icon: Wrench, label: 'Work order', module: 'workorders' },
  pm: { icon: CalendarClock, label: 'Preventive maintenance', module: 'preventivemaintenances' },
  calibration: { icon: Gauge, label: 'Calibration', module: 'calibrations' },
};

/** Maintenance due soon (overdue first) from the briefing evidence, each with a jump to the AI planner. */
export const MaintenanceDue = ({ maintenance, loading, className }) => {
  const navigate = useNavigate();
  const now = Date.now();
  let body;
  if (loading) {
    body = (
      <div className="space-y-3 p-4" role="status" aria-label="Loading maintenance">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-10" />
        ))}
      </div>
    );
  } else if (!maintenance) {
    body = <p className="px-4 py-6 text-sm text-muted">Maintenance isn't available for your role.</p>;
  } else if (!maintenance.dueSoon?.length) {
    body = <p className="px-4 py-6 text-sm text-muted">Nothing due in the next 7 days.</p>;
  } else {
    body = (
      <ul className="divide-y divide-border">
        {maintenance.dueSoon.map((t) => {
          const kind = KIND[t.kind] ?? KIND.workorder;
          const overdue = new Date(t.due).getTime() < now;
          return (
            <li key={`${t.kind}-${t.id}`} className="flex items-start gap-2.5 px-4 py-2.5">
              <kind.icon className="mt-0.5 size-4 shrink-0 text-muted" aria-label={kind.label} />
              <div className="min-w-0 flex-1">
                <Link
                  to={`/m/${kind.module}/${t.id}`}
                  className="block truncate text-sm font-medium text-fg hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {[t.code, t.name].filter(Boolean).join(' · ')}
                </Link>
                <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
                  {t.asset && <span className="truncate">{t.asset}</span>}
                  <time dateTime={t.due} title={formatDateTime(t.due)} className="tabular">
                    due {formatRelative(t.due)}
                  </time>
                  {overdue && (
                    <Badge tone="critical">
                      <TriangleAlert className="size-3" aria-hidden />
                      Overdue
                    </Badge>
                  )}
                </p>
              </div>
              {t.assetId && (
                <Button
                  size="sm"
                  variant="ghost"
                  icon={CalendarRange}
                  aria-label={`Plan maintenance for ${t.asset ?? t.code}`}
                  onClick={() => navigate(`/planner?maintenance=${t.assetId}`)}
                >
                  Plan
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    );
  }
  return (
    <Card className={cn('flex min-w-0 flex-col', className)}>
      <CardHeader
        icon={Wrench}
        title="Maintenance due"
        subtitle={
          maintenance
            ? `${maintenance.overdue} overdue · ${maintenance.dueToday} due today · ${maintenance.openWorkOrders} open work orders`
            : 'Next 7 days'
        }
      />
      {body}
    </Card>
  );
};
