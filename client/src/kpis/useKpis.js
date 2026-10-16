import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client.js';
import { useRecords } from '../modules/useModules.js';

/** KPI definitions, newest change first (the generic module list, so record events refresh it). */
export const useKpis = () => useRecords('kpis', { limit: 100, sort: '-updatedAt' });

/**
 * Live result of one KPI, run in the viewer's scope. `version` (the KPI's updatedAt) re-runs it after the
 * definition changes; the key still starts with ['kpis', 'run', id].
 */
export const useKpiRun = (id, version) =>
  useQuery({
    queryKey: ['kpis', 'run', id, version],
    queryFn: ({ signal }) => api(`/kpis/${id}/run`, { signal }).then((r) => r.result),
    enabled: Boolean(id),
    staleTime: 60_000,
  });

/** Regenerates one KPI's insight (owner/admin). */
export const useExplainKpi = (id) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api(`/kpis/${id}/explain`, { method: 'POST' }).then((r) => r.insight),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['m', 'kpis'] }),
  });
};

/** Refreshes stale insights (TTL-bound on the server); the KPI page calls it once on mount. */
export const useRefreshInsights = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api('/kpis/insights/refresh', { method: 'POST' }),
    onSuccess: (r) => r?.refreshed && qc.invalidateQueries({ queryKey: ['m', 'kpis'] }),
  });
};
