import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api } from '../api/client.js';

/** Child relations of a record with counts: `{ parent, children: [{ module, field, label, count, can }] }`. */
export const useRelatedCounts = (module, id) =>
  useQuery({
    queryKey: ['m', module, 'related', id],
    queryFn: ({ signal }) => api(`/m/${module}/${id}/related`, { signal }),
    enabled: Boolean(module && id),
  });

/** One page of a child relation; keyed under the child so its record events refresh it. */
export const useRelated = (module, id, child, params) =>
  useQuery({
    queryKey: ['m', child, 'related', { parent: module, id, ...params }],
    queryFn: ({ signal }) => api(`/m/${module}/${id}/related/${child}`, { query: params, signal }),
    placeholderData: keepPreviousData,
    enabled: Boolean(module && id && child),
  });
