import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, BellOff, CheckCheck, CircleCheck, Info, OctagonAlert, TriangleAlert } from 'lucide-react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { anomalyPath, assetOf, deviationOf, severityOf } from '../anomalies/parts.jsx';
import { api } from '../api/client.js';
import { useSession } from '../auth/useAuth.js';
import { cn, formatRelative } from '../lib/format.js';
import { useLiveEvent } from '../live/liveStore.js';
import { fieldLabel } from '../machines/telemetry.js';
import { Button } from '../ui/core.jsx';
import { Menu, MenuItem, MenuLabel, MenuSeparator } from '../ui/overlay.jsx';

const ICON = {
  critical: { icon: OctagonAlert, className: 'text-critical' },
  alert: { icon: TriangleAlert, className: 'text-warn' },
  success: { icon: CircleCheck, className: 'text-success' },
  normal: { icon: Info, className: 'text-info' },
};
/** High-priority alerts (critical anomalies) get the critical look; other alerts the warning one. */
const iconOf = (n) =>
  n.type === 'alert' && n.priority === 'high' ? ICON.critical : (ICON[n.type] ?? ICON.normal);

/** Where a notification points: its anomaly, machine or record; null when it is just a message. */
export const notificationPath = (n) => {
  const d = n?.details ?? {};
  if (d.module === 'anomalies' && d.recordId) return anomalyPath(d.recordId);
  if (d.module === 'assets' && d.recordId) return `/machines/${d.recordId}`;
  if (d.module && d.recordId) return `/m/${d.module}/${d.recordId}`;
  if (d.assetId) return `/machines/${d.assetId}`;
  return null;
};

/** Bell in the header: unread badge, the latest notifications, mark read, and toasts for live alerts. */
export const NotificationsBell = () => {
  const ctx = useSession();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const enabled = Boolean(ctx && !ctx.company?.isPlatform);
  const query = useQuery({
    queryKey: ['notifications'],
    queryFn: ({ signal }) => api('/notifications', { signal }),
    enabled,
    refetchInterval: 60_000,
  });
  const read = useMutation({
    mutationFn: (id) => api(id ? `/notifications/${id}/read` : '/notifications/read-all', { method: 'POST' }),
    onSettled: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
  });

  useLiveEvent('notification', (n) => {
    qc.invalidateQueries({ queryKey: ['notifications'] });
    if (!n?.message?.title || n.details?.module === 'anomalies') return; // the anomaly toast below covers those
    const path = notificationPath(n);
    (n.type === 'alert' ? toast.warning : toast)(n.message.title, {
      id: `notification-${n._id}`,
      description: n.message.description,
      action: path ? { label: 'View', onClick: () => navigate(path) } : undefined,
    });
  });
  useLiveEvent('anomaly', (data) => {
    const anomaly = data?.anomaly;
    qc.invalidateQueries({ queryKey: ['m', 'anomalies'] });
    qc.invalidateQueries({ queryKey: ['ai', 'health'] });
    if (!anomaly?._id || anomaly.state !== 'open' || anomaly.severity === 'info' || anomaly.investigation)
      return;
    const s = severityOf(anomaly.severity);
    const p = anomaly.parameters?.[0];
    const what = p ? [fieldLabel(p.field), deviationOf(p)].filter(Boolean).join(' ') : 'anomaly';
    (anomaly.severity === 'critical' ? toast.error : toast.warning)(
      `${s.label}: ${what} on ${assetOf(anomaly).name}`,
      {
        id: `anomaly-${anomaly._id}`,
        description: anomaly.summary,
        action: { label: 'View', onClick: () => navigate(anomalyPath(anomaly._id)) },
      },
    );
  });

  if (!enabled) return null;
  const items = query.data?.items ?? [];
  const unread = query.data?.unread ?? 0;
  const open = (n) => {
    if (!n.read) read.mutate(n._id);
    const path = notificationPath(n);
    if (path) navigate(path);
  };

  return (
    <Menu
      trigger={
        <Button
          variant="ghost"
          size="icon"
          className="relative"
          aria-label={unread ? `Notifications, ${unread} unread` : 'Notifications'}
        >
          <Bell className="size-[18px]" />
          {unread > 0 && (
            <span
              className="absolute right-1 top-1 min-w-4 rounded-full bg-critical px-1 text-center text-[10px] font-semibold leading-4 text-white"
              aria-hidden
            >
              {unread > 99 ? '99+' : unread}
            </span>
          )}
        </Button>
      }
    >
      <MenuLabel>
        <span className="flex items-center justify-between gap-3">
          <span className="font-medium text-fg">Notifications</span>
          {unread > 0 && <span>{unread} unread</span>}
        </span>
      </MenuLabel>
      <MenuSeparator />
      <div className="max-h-96 w-80 max-w-[calc(100vw-2rem)] overflow-y-auto scrollbar-thin">
        {query.isLoading ? (
          <p className="px-2.5 py-6 text-center text-sm text-muted">Loading…</p>
        ) : query.isError ? (
          <p className="px-2.5 py-6 text-center text-sm text-critical">Couldn't load notifications.</p>
        ) : !items.length ? (
          <p className="flex flex-col items-center gap-2 px-2.5 py-8 text-center text-sm text-muted">
            <BellOff className="size-5 text-subtle" aria-hidden />
            You're all caught up.
          </p>
        ) : (
          items.map((n) => {
            const t = iconOf(n);
            return (
              <MenuItem key={n._id} onSelect={() => open(n)}>
                <span className="flex w-full items-start gap-2.5">
                  <t.icon className={cn('mt-0.5 size-4 shrink-0', t.className)} aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span
                      className={cn('block truncate text-sm', n.read ? 'text-muted' : 'font-medium text-fg')}
                    >
                      {n.message?.title}
                    </span>
                    {n.message?.description && (
                      <span className="mt-0.5 line-clamp-2 block text-xs text-muted">
                        {n.message.description}
                      </span>
                    )}
                    <span className="mt-0.5 block text-[11px] text-subtle">
                      {formatRelative(n.createdAt)}
                    </span>
                  </span>
                  {!n.read && (
                    <span
                      className="mt-1.5 size-2 shrink-0 rounded-full bg-brand"
                      aria-label="Unread"
                      role="img"
                    />
                  )}
                </span>
              </MenuItem>
            );
          })
        )}
      </div>
      <MenuSeparator />
      <MenuItem
        icon={CheckCheck}
        disabled={!unread || read.isPending}
        onSelect={() => read.mutate(undefined)}
      >
        Mark all as read
      </MenuItem>
    </Menu>
  );
};
