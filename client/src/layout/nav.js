import {
  Activity,
  CalendarRange,
  Factory,
  Gauge,
  IndianRupee,
  LayoutDashboard,
  MessageSquareText,
} from 'lucide-react';

/**
 * Hand-built product pages shown above the generic module groups: { to, icon, label, end? }
 * (`end`: active only on that exact path, so `/` is not active everywhere).
 */
export const PRIMARY_NAV = [
  { to: '/', icon: LayoutDashboard, label: 'Command Center', end: true },
  { to: '/machines', icon: Factory, label: 'Machines' },
  { to: '/anomalies', icon: Activity, label: 'Anomalies' },
  { to: '/planner', icon: CalendarRange, label: 'Planner' },
  { to: '/costs', icon: IndianRupee, label: 'Costs' },
  { to: '/kpis', icon: Gauge, label: 'KPI Builder' },
  { to: '/chat', icon: MessageSquareText, label: 'Chat' },
];
