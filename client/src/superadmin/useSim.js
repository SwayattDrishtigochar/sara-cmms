import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '../api/client.js';

const BASE = '/admin/sim';
/** Live data polls every 3 s; TanStack pauses polling while the browser tab is hidden. */
const POLL = 3000;

const get =
  (path, key) =>
  ({ signal }) =>
    api(`${BASE}${path}`, { signal }).then((r) => (key ? r[key] : r));

/** `{ control, instances, company, scenarios, injections }` (active injections). */
export const useStatus = () =>
  useQuery({ queryKey: ['sim', 'status'], queryFn: get('/status'), refetchInterval: POLL });

/** Injection ground truth, newest first. */
export const useEvents = () =>
  useQuery({
    queryKey: ['sim', 'events'],
    queryFn: get('/events?limit=50', 'events'),
    refetchInterval: POLL,
  });

/** What the simulated people did, newest first; stops refreshing while `paused`. */
export const useActivity = (paused) =>
  useQuery({
    queryKey: ['sim', 'activity'],
    queryFn: get('/activity?limit=50', 'activity'),
    refetchInterval: paused ? false : POLL,
  });

/** Machines of the simulated company. */
export const useSimAssets = () =>
  useQuery({ queryKey: ['sim', 'assets'], queryFn: get('/assets', 'assets'), staleTime: 60_000 });

/** `{ users, password }` of the simulated company. */
export const useCredentials = () =>
  useQuery({ queryKey: ['sim', 'credentials'], queryFn: get('/credentials') });

/**
 * Any write under /api/admin/sim: `mutate({ path, method = 'POST', body, success })`. Toasts `success`,
 * refreshes the status and injections before settling (so controls show the saved value), and turns
 * failures into error toasts.
 */
export const useSimAction = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ path, method = 'POST', body = {} }) => api(`${BASE}${path}`, { method, body }),
    onSuccess: (_data, { success }) => {
      if (success) toast.success(success);
      return Promise.all([
        qc.invalidateQueries({ queryKey: ['sim', 'status'] }),
        qc.invalidateQueries({ queryKey: ['sim', 'events'] }),
      ]);
    },
    onError: (err) =>
      toast.error(err.message, {
        description: err.details?.map?.((d) => (d.path ? `${d.path}: ${d.message}` : d.message)).join('\n'),
      }),
  });
};
