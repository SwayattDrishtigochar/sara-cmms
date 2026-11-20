import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '../api/client.js';

/** Machine types the optimizer knows; every other type gets no card. */
export const OPTIMIZER_TYPES = ['Injection Moulding Machine', 'Power Press', 'CNC Machine'];

/** 503 / 429: the AI is down or rate limited. */
export const isAiDown = (err) => err?.status === 503 || err?.status === 429;

const keyOf = (assetId) => ['optimizer', assetId];

/**
 * SARA's settings to make more parts on one machine (`GET /api/optimizer/:assetId`):
 * `{ query, refresh, refreshing }`; `refresh()` asks for a fresh answer (`?refresh=1`) and caches it.
 */
export const useOptimizer = (assetId, enabled = true) => {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: keyOf(assetId),
    queryFn: ({ signal }) => api(`/optimizer/${assetId}`, { signal }),
    enabled: Boolean(assetId) && enabled,
    staleTime: 10 * 60_000,
    retry: false, // every try is an AI call; the card has its own retry button
  });
  // The id travels as the variable, so a refresh still in flight after a machine switch caches under its own machine.
  const refresh = useMutation({
    mutationFn: (id) => api(`/optimizer/${id}`, { query: { refresh: 1 } }),
    onSuccess: (data, id) => qc.setQueryData(keyOf(id), data),
    onError: (err) =>
      toast.error("SARA couldn't refresh the estimate", {
        description: isAiDown(err)
          ? 'The AI is unavailable right now; the last estimate stays.'
          : err.message,
      }),
  });
  return { query, refresh: () => refresh.mutate(assetId), refreshing: refresh.isPending };
};
