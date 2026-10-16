import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BellRing, CircleCheck, Info, OctagonAlert, TriangleAlert } from 'lucide-react';
import { useMemo } from 'react';
import { Link } from 'react-router';
import { anomalyPath, assetOf, severityOf } from '../anomalies/parts.jsx';
import { useOpenAnomalies } from '../anomalies/useAnomalies.js';
import { api } from '../api/client.js';
import { useSession } from '../auth/useAuth.js';
import { notificationPath } from '../layout/NotificationsBell.jsx';
import { cn, formatRelative } from '../lib/format.js';
import { useLiveEvent } from '../live/liveStore.js';
import { Card, CardHeader, Skeleton } from '../ui/core.jsx';

const LIMIT = 8;
const NOTE = {
  critical: { icon: OctagonAlert, text: 'text-critical', label: 'Critical alert' },
  alert: { icon: TriangleAlert, text: 'text-warn', label: 'Alert' },
  success: { icon: CircleCheck, text: 'text-success', label: 'Done' },
  normal: { icon: Info, text: 'text-info', label: 'Notice' },
};
const noteLook = (n) =>
  n.type === 'alert' && n.priority === 'high' ? NOTE.critical : (NOTE[n.type] ?? NOTE.normal);

/** Notifications and open anomalies as one newest-first list; an anomaly's own notification is folded into it. */
export const mergeAlerts = (notifications = [], anomalies = []) => {
  const anomalyIds = new Set(anomalies.map((a) => String(a._id)));
  const fromAnomalies = anomalies.map((a) => {
    const s = severityOf(a.severity);
    return {
      id: `a-${a._id}`,
      title: [a.anomalyCode, assetOf(a)?.name].filter(Boolean).join(' · '),
      text: a.summary,
      at: a.detectedAt ?? a.createdAt,
      look: { icon: s.icon, text: s.text, label: `${s.label} anomaly` },
      path: anomalyPath(a._id),
    };
  });
  const fromNotes = notifications
    .filter((n) => !(n.details?.module === 'anomalies' && anomalyIds.has(String(n.details.recordId))))
    .map((n) => ({
      id: `n-${n._id}`,
      title: n.message?.title ?? 'Notification',
      text: n.message?.description,
      at: n.createdAt,
      look: noteLook(n),
      path: notificationPath(n),
      unread: n.read === false,
    }));
  return [...fromAnomalies, ...fromNotes]
    .sort((a, b) => new Date(b.at ?? 0) - new Date(a.at ?? 0))
    .slice(0, LIMIT);
};

const Row = ({ item }) => {
  const Icon = item.look.icon;
  const inner = (
    <>
      <Icon className={cn('mt-0.5 size-4 shrink-0', item.look.text)} aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="sr-only">{item.look.label}: </span>
        <span className={cn('block truncate text-sm text-fg', item.unread && 'font-semibold')}>
          {item.title}
        </span>
        {item.text && <span className="line-clamp-2 text-xs text-muted">{item.text}</span>}
      </span>
      <time className="shrink-0 text-[11px] text-subtle tabular" dateTime={item.at}>
        {formatRelative(item.at)}
      </time>
    </>
  );
  const cls = 'flex items-start gap-2.5 px-4 py-2.5';
  return (
    <li>
      {item.path ? (
        <Link
          to={item.path}
          className={cn(
            cls,
            'transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
          )}
        >
          {inner}
        </Link>
      ) : (
        <div className={cls}>{inner}</div>
      )}
    </li>
  );
};

/** Latest alerts: notifications for me plus the open anomalies, refreshed by live notification events. */
export const AlertsFeed = ({ className }) => {
  const ctx = useSession();
  const qc = useQueryClient();
  const notes = useQuery({
    queryKey: ['notifications'],
    queryFn: ({ signal }) => api('/notifications', { signal }),
    enabled: Boolean(ctx && !ctx.company?.isPlatform),
  });
  const anomalies = useOpenAnomalies();
  useLiveEvent('notification', () => qc.invalidateQueries({ queryKey: ['notifications'] }));
  const items = useMemo(
    () => mergeAlerts(notes.data?.items, anomalies.data?.items),
    [notes.data, anomalies.data],
  );
  const loading = notes.isLoading || anomalies.isLoading;

  return (
    <Card className={cn('flex min-w-0 flex-col', className)}>
      <CardHeader icon={BellRing} title="Alerts" subtitle="Notifications and open anomalies, newest first" />
      {loading ? (
        <div className="space-y-3 p-4" role="status" aria-label="Loading alerts">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-9" />
          ))}
        </div>
      ) : items.length ? (
        <ul className="divide-y divide-border">
          {items.map((item) => (
            <Row key={item.id} item={item} />
          ))}
        </ul>
      ) : (
        <p className="flex items-center gap-2 px-4 py-6 text-sm text-muted">
          <CircleCheck className="size-4 text-success" aria-hidden />
          {notes.isError && anomalies.isError
            ? "Alerts couldn't be loaded."
            : 'All quiet: no alerts or open anomalies.'}
        </p>
      )}
    </Card>
  );
};
