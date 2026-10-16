import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client.js';
import { useRecords } from '../modules/useModules.js';

/** CostSummary for `{ text } | { start, stop }` plus `groupBy`; disabled while `params` is null. */
export const useCostSummary = (params) =>
  useQuery({
    queryKey: ['costs', 'summary', params],
    queryFn: ({ signal }) => api('/costs/summary', { query: params, signal }),
    enabled: Boolean(params),
    placeholderData: keepPreviousData,
  });

/** Live totals, drivers and SARA's cached overview text for day | week | month (null disables it). */
export const useCostOverview = (period) =>
  useQuery({
    queryKey: ['costs', 'overview', period],
    queryFn: ({ signal }) => api('/costs/overview', { query: { period }, signal }),
    enabled: Boolean(period),
    placeholderData: keepPreviousData,
  });

/** Regenerates the overview text (owner/admin); the answer replaces the cached overview. */
export const useRefreshOverview = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (period) => api('/costs/overview/refresh', { method: 'POST', body: { period } }),
    onSuccess: (data, period) => qc.setQueryData(['costs', 'overview', period], data),
  });
};

/** Cost alerts through the generic module list, so record events refresh it. */
export const useCostAlerts = () => useRecords('costalerts', { limit: 100, sort: 'name' });

/** Evaluates one alert now (owner/admin); fires at most once per period. */
export const useCheckAlert = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id) => api(`/costs/alerts/${id}/check`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['m', 'costalerts'] }),
  });
};
