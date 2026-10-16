import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '../api/client.js';
import { useSession } from '../auth/useAuth.js';
import { useRecords } from '../modules/useModules.js';

export const ACTIVE_STATES = ['open', 'acknowledged'];
export const isActive = (anomaly) => ACTIVE_STATES.includes(anomaly?.state);

/** The id of an anomaly's machine, populated or not. */
export const assetIdOf = (anomaly) => String(anomaly?.assetId?._id ?? anomaly?.assetId ?? '');

/** Refetches everything the AI touches: anomaly lists, machine health and the asset list (health scores). */
export const invalidateAnomalies = (qc) =>
  Promise.all(
    [
      ['m', 'anomalies'],
      ['ai', 'health'],
      ['m', 'assets'],
    ].map((queryKey) => qc.invalidateQueries({ queryKey })),
  );

/** `{ asset: { healthScore, healthSummary, healthUpdatedAt }, anomalies }` of one machine (open + last resolved). */
export const useHealth = (assetId) =>
  useQuery({
    queryKey: ['ai', 'health', assetId],
    queryFn: ({ signal }) => api('/ai/health', { query: { assetId }, signal }),
    enabled: Boolean(assetId),
  });

/** Open and acknowledged anomalies of the company: one shared query for every machine card. */
export const useOpenAnomalies = (options = {}) => {
  const ctx = useSession();
  return useRecords(
    'anomalies',
    { filter: { state: ACTIVE_STATES }, sort: '-detectedAt', limit: 100 },
    { enabled: Boolean(ctx?.modules?.includes('anomalies')), ...options },
  );
};

const NONE = [];
/** A machine's open and acknowledged anomalies, newest first (empty while loading). */
export const useMachineAnomalies = (assetId) => {
  const query = useOpenAnomalies({
    select: (data) => data.items.filter((a) => assetIdOf(a) === String(assetId)),
  });
  return query.data ?? NONE;
};

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "Scan now": every machine of the company goes to the AI at once (`POST /api/ai/scan`). */
export const useScan = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api('/ai/scan', { method: 'POST', body: {} }),
    onSuccess: (r) => {
      toast.success(`SARA reviewed ${plural(r?.reviewed ?? 0, 'machine')}`, {
        description: r?.anomalies
          ? `${plural(r.anomalies, 'anomaly', 'anomalies')} need attention.`
          : 'Nothing out of the ordinary.',
      });
      return invalidateAnomalies(qc);
    },
    onError: (err) => toast.error("Couldn't scan", { description: err.message }),
  });
};

const STATE_DONE = {
  acknowledged: 'Anomaly acknowledged',
  resolved: 'Anomaly resolved',
  false_positive: 'Marked as a false positive',
};

/** Acknowledge / resolve / dismiss one anomaly (`POST /api/anomalies/:id/state`). */
export const useAnomalyState = (id) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ state, note }) =>
      api(`/anomalies/${id}/state`, { method: 'POST', body: note ? { state, note } : { state } }),
    onSuccess: (r, { state }) => {
      // Keep the populated record; the route answers with raw refs.
      const next = r?.anomaly;
      if (next) {
        qc.setQueryData(['m', 'anomalies', 'one', id], (prev) =>
          prev ? { ...prev, state: next.state, notes: next.notes, resolvedAt: next.resolvedAt } : prev,
        );
      }
      toast.success(STATE_DONE[state] ?? 'Anomaly updated');
      return invalidateAnomalies(qc);
    },
    onError: (err) => toast.error("Couldn't update the anomaly", { description: err.message }),
  });
};

/** Asks SARA for an investigation (`POST /api/anomalies/:id/investigate`); the record gains `investigation`. */
export const useInvestigate = (id) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api(`/anomalies/${id}/investigate`, { method: 'POST', body: {} }),
    onSuccess: (r) => {
      if (r?.investigation) {
        qc.setQueryData(['m', 'anomalies', 'one', id], (prev) =>
          prev ? { ...prev, investigation: r.investigation } : prev,
        );
      }
      return qc.invalidateQueries({ queryKey: ['m', 'anomalies', 'list'] });
    },
    onError: (err) => toast.error("Couldn't investigate", { description: err.message }),
  });
};
