import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client.js';
import { useSession } from '../auth/useAuth.js';
import { useUi } from '../store/ui.js';

/** The header's plant pick for company-wide users; plant-locked users always get their own plant. */
export const useBriefingPlant = () => {
  const ctx = useSession();
  const picked = useUi((s) => s.plantId);
  return ctx?.plantLocked ? null : picked || null;
};

/** `{ briefing, evidence, model, at, mock, stale, aiError? }` of today in the viewer's scope. */
export const useBriefing = () => {
  const plantId = useBriefingPlant();
  return useQuery({
    queryKey: ['briefing', plantId],
    queryFn: ({ signal }) => api('/briefing', { query: plantId ? { plantId } : {}, signal }),
    staleTime: 5 * 60_000,
  });
};

/** Owner/admin: rewrites the AI briefing now; the answer replaces the cached query. */
export const useRefreshBriefing = () => {
  const qc = useQueryClient();
  const plantId = useBriefingPlant();
  return useMutation({
    mutationFn: () => api('/briefing/refresh', { method: 'POST', body: plantId ? { plantId } : {} }),
    onSuccess: (data) => qc.setQueryData(['briefing', plantId], data),
  });
};
