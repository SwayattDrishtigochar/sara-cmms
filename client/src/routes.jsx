import { Compass } from 'lucide-react';
import { createBrowserRouter, Link, Navigate } from 'react-router';
import { AnomaliesPage } from './anomalies/AnomaliesPage.jsx';
import { LoginPage } from './auth/LoginPage.jsx';
import { RequireAuth } from './auth/RequireAuth.jsx';
import { useSession } from './auth/useAuth.js';
import { ChatPage } from './chat/ChatPage.jsx';
import { CostsPage } from './costs/CostsPage.jsx';
import { CommandCenter } from './home/CommandCenter.jsx';
import { KpisPage } from './kpis/KpisPage.jsx';
import { AppShell } from './layout/AppShell.jsx';
import { MachinePage } from './machines/MachinePage.jsx';
import { MachinesPage } from './machines/MachinesPage.jsx';
import { ModuleListPage } from './modules/ModuleListPage.jsx';
import { RecordPage } from './modules/RecordPage.jsx';
import { PlannerPage } from './planner/PlannerPage.jsx';
import { SuperAdminPage } from './superadmin/SuperAdminPage.jsx';
import { Button, EmptyState } from './ui/core.jsx';

/** `/`: the Command Center for company users; the superadmin lands on /superadmin. */
const Home = () => {
  const ctx = useSession();
  if (ctx?.role === 'superAdmin') return <Navigate to="/superadmin" replace />;
  return <CommandCenter />;
};

const NotFound = () => (
  <EmptyState
    icon={Compass}
    title="Page not found"
    action={
      <Link to="/">
        <Button variant="primary">Go home</Button>
      </Link>
    }
  >
    The page you were looking for doesn't exist.
  </EmptyState>
);

export const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  {
    path: '/',
    element: (
      <RequireAuth>
        <AppShell />
      </RequireAuth>
    ),
    children: [
      { index: true, element: <Home /> },
      { path: 'machines', element: <MachinesPage /> },
      { path: 'machines/:id', element: <MachinePage /> },
      { path: 'anomalies', element: <AnomaliesPage /> },
      { path: 'planner', element: <PlannerPage /> },
      { path: 'costs', element: <CostsPage /> },
      { path: 'kpis', element: <KpisPage /> },
      { path: 'chat', element: <ChatPage /> },
      { path: 'chat/:id', element: <ChatPage /> },
      {
        path: 'superadmin',
        element: (
          <RequireAuth superAdmin>
            <SuperAdminPage />
          </RequireAuth>
        ),
      },
      { path: 'm/:module', element: <ModuleListPage /> },
      { path: 'm/:module/:id', element: <RecordPage /> },
      { path: '*', element: <NotFound /> },
    ],
  },
]);
