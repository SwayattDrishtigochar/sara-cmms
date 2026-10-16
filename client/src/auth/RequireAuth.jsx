import { Navigate, useLocation } from 'react-router';
import { getToken } from '../api/client.js';
import { Spinner } from '../ui/core.jsx';
import { useMe } from './useAuth.js';

export const RequireAuth = ({ children, superAdmin = false }) => {
  const location = useLocation();
  const { data, isLoading, isError } = useMe();

  if (!getToken() || isError) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  if (isLoading || !data) {
    return (
      <div className="grid h-full place-items-center">
        <div className="flex items-center gap-3 text-sm text-muted">
          <Spinner /> Loading your plant…
        </div>
      </div>
    );
  }
  if (superAdmin && data.context.role !== 'superAdmin') return <Navigate to="/" replace />;
  return children;
};
