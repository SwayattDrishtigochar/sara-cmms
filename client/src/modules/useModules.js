import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client.js';

export const useModulesMeta = () =>
  useQuery({
    queryKey: ['modules'],
    queryFn: () => api('/modules').then((r) => r.modules),
    staleTime: 10 * 60_000,
  });

export const useModuleMeta = (name) => {
  const { data, ...rest } = useModulesMeta();
  return { data: data?.find((m) => m.name === name), modules: data, ...rest };
};

export const useRecords = (name, params, options = {}) =>
  useQuery({
    queryKey: ['m', name, 'list', params],
    queryFn: ({ signal }) => api(`/m/${name}`, { query: params, signal }),
    placeholderData: keepPreviousData,
    enabled: Boolean(name),
    ...options,
  });

export const useRecord = (name, id) =>
  useQuery({
    queryKey: ['m', name, 'one', id],
    queryFn: () => api(`/m/${name}/${id}`).then((r) => r.item),
    enabled: Boolean(name && id),
  });

/** Create (no id) or update (id) a record; refreshes every query of that module. */
export const useSaveRecord = (name) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }) =>
      id
        ? api(`/m/${name}/${id}`, { method: 'PATCH', body: data })
        : api(`/m/${name}`, { method: 'POST', body: data }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['m', name] }),
  });
};

export const useDeleteRecord = (name) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }) => api(`/m/${name}/${id}`, { method: 'DELETE', body: { reason } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['m', name] }),
  });
};

export const useRecordAction = (name) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, action, input }) =>
      api(`/m/${name}/${id}/actions/${action}`, { method: 'POST', body: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['m', name] }),
  });
};
