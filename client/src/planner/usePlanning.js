import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client.js';
import { useRecords } from '../modules/useModules.js';

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

/** Plan proposals, newest first (`{ items }`); `kind` may be a comma list. */
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

/** `{ people }` of a department free or busy in `{ from, to }` (ISO); `skills` comma list, `plantId`. */
export const usePeople = (params) =>
  useQuery({
    queryKey: ['planning', 'people', params],
    queryFn: ({ signal }) => api('/planning/people', { query: params, signal }),
    staleTime: 30_000,
    enabled: Boolean(params?.from && params?.to),
  });

/** Latest production plan records. */
export const useProductionPlans = () => useRecords('productionplans', { limit: 20, sort: '-createdAt' });
/** Latest maintenance plan records. */
export const useMaintenancePlans = () => useRecords('maintenanceplans', { limit: 20, sort: '-createdAt' });

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

/** `{ partName, quantity, dueDate, … }` → `{ proposal, plan, check }` (a draft; nothing is booked yet). */
export const useProposeProduction = () =>
  usePlanMutation((body) => api('/planning/production', { method: 'POST', body }));

/** `EditedProductionPlan` → `CheckResult` (with `proposalId` the proposal is rewritten too). */
export const useCheckProduction = () =>
  usePlanMutation((body) => api('/planning/production/check', { method: 'POST', body }));

/** `{ assetId?, anomalyId?, workOrderId?, horizonDays?, allowNonRunningDays? }` → `{ proposal, plan }` (one task). */
export const useProposeMaintenance = () =>
  usePlanMutation((body) => api('/planning/maintenance', { method: 'POST', body }));

/** `{ scope, assetIds?, horizonDays?, objective?, … }` → `{ proposal, plan, check }` (a whole maintenance plan). */
export const useProposeMaintenancePlan = () =>
  usePlanMutation((body) => api('/planning/maintenance/plan', { method: 'POST', body }));

/** `EditedMaintenancePlan` → `CheckResult` with `tasks`, `metrics`, `impactDelta`. */
export const useCheckMaintenance = () =>
  usePlanMutation((body) => api('/planning/maintenance/check', { method: 'POST', body }));

/** Books a proposal (`{ option?, force? }`) → `{ proposal, created, updated }`; 409 PLAN_CHANGED carries the new plan. */
export const useApplyProposal = (id) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ option, force } = {}) =>
      api(`/planning/proposals/${id}/apply`, {
        method: 'POST',
        body: { ...(option ? { option } : {}), ...(force ? { force: true } : {}) },
      }),
    onSuccess: (r) => keep(id)(qc, r),
    onSettled: () => refresh(qc), // a 409 also changed the proposal (stale) and made a new one
  });
};

export const useDiscardProposal = (id) =>
  usePlanMutation(() => api(`/planning/proposals/${id}/discard`, { method: 'POST', body: {} }), keep(id));

/** Asks the AI to explain the proposal again → `{ explanation }`. */
export const useExplainProposal = (id) =>
  usePlanMutation(
    () => api(`/planning/proposals/${id}/explain`, { method: 'POST', body: {} }),
    (qc, r) => keep(id)(qc, { proposal: { explanation: r?.explanation } }),
  );
