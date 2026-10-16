import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client.js';

const refresh = (qc) =>
  Promise.all([
    qc.invalidateQueries({ queryKey: ['planning'] }),
    qc.invalidateQueries({ queryKey: ['m', 'planproposals'] }),
  ]);

/** `{ gantt, machines }` of the plant's machines between `start` and `end` (ISO). */
export const useCalendar = (params) =>
  useQuery({
    queryKey: ['planning', 'calendar', params],
    queryFn: ({ signal }) => api('/planning/calendar', { query: params, signal }),
  });

/** Plan proposals, newest first (`{ items }`). */
export const useProposals = (params) =>
  useQuery({
    queryKey: ['m', 'planproposals', 'list', params],
    queryFn: ({ signal }) => api('/planning/proposals', { query: params, signal }),
  });

/** `{ proposal, plan }` of one proposal (id or PLN-code). */
export const useProposal = (id) =>
  useQuery({
    queryKey: ['m', 'planproposals', id],
    queryFn: ({ signal }) => api(`/planning/proposals/${id}`, { signal }),
    enabled: Boolean(id),
  });

/** Parts the moulds can make, with their moulds and machines (Planner form). */
export const useParts = () =>
  useQuery({
    queryKey: ['planning', 'parts'],
    queryFn: ({ signal }) => api('/planning/parts', { signal }),
    staleTime: 5 * 60_000,
  });

const usePlanMutation = (fn, onSuccess) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (r) => {
      onSuccess?.(qc, r);
      return refresh(qc);
    },
  });
};

/** Writes the proposal an apply/discard returned into the cache, so the page is right even if the refetch fails. */
const keep = (id) => (qc, r) =>
  r?.proposal &&
  qc.setQueryData(
    ['m', 'planproposals', id],
    (old) => old && { ...old, proposal: { ...old.proposal, ...r.proposal } },
  );

/** `{ partName, quantity, dueDate, … }` → `{ proposal, plan }` (a draft; nothing is booked yet). */
export const useProposeProduction = () =>
  usePlanMutation((body) => api('/planning/production', { method: 'POST', body }));

/** `{ assetId?, anomalyId?, workOrderId?, horizonDays?, allowNonRunningDays? }` → `{ proposal, plan }`. */
export const useProposeMaintenance = () =>
  usePlanMutation((body) => api('/planning/maintenance', { method: 'POST', body }));

/** Books a proposal (`{ option? }`) → `{ proposal, created, updated }`; 409 PLAN_CHANGED carries the new plan. */
export const useApplyProposal = (id) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ option } = {}) =>
      api(`/planning/proposals/${id}/apply`, { method: 'POST', body: option ? { option } : {} }),
    onSuccess: (r) => keep(id)(qc, r),
    onSettled: () => refresh(qc), // a 409 also changed the proposal (stale) and made a new one
  });
};

export const useDiscardProposal = (id) =>
  usePlanMutation(() => api(`/planning/proposals/${id}/discard`, { method: 'POST', body: {} }), keep(id));

/** Asks the AI to explain the proposal again → `{ explanation }`. */
export const useExplainProposal = (id) =>
  usePlanMutation(() => api(`/planning/proposals/${id}/explain`, { method: 'POST', body: {} }));
