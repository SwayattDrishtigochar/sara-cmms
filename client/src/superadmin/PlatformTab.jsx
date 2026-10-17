import { useQuery } from '@tanstack/react-query';
import { Building2 } from 'lucide-react';
import { api } from '../api/client.js';
import { formatDate, formatNumber } from '../lib/format.js';
import { Card, EmptyState, Skeleton } from '../ui/core.jsx';
import { QueryError, Section } from './parts.jsx';

const COLUMNS = [
  { key: 'plants', label: 'Plants' },
  { key: 'users', label: 'Users' },
  { key: 'assets', label: 'Assets' },
];

/** Read-only list of every customer company on the platform with its headline counts. */
export const PlatformTab = () => {
  const query = useQuery({
    queryKey: ['admin', 'platform', 'companies'],
    queryFn: () => api('/admin/platform/companies'),
    staleTime: 30_000,
  });
  const companies = query.data?.companies ?? [];

  return (
    <Section
      id="platform-companies"
      icon={Building2}
      title="Companies"
      description="Every company on this platform, newest first. Their data stays theirs: this view only counts it."
    >
      <Card className="overflow-hidden p-0">
        {query.isPending ? (
          <div className="space-y-2 p-4" role="status" aria-busy="true" aria-label="Loading companies">
            <Skeleton className="w-1/2" />
            <Skeleton className="w-2/3" />
            <Skeleton className="w-1/3" />
          </div>
        ) : query.isError ? (
          <QueryError what="the companies" error={query.error} onRetry={query.refetch} />
        ) : companies.length === 0 ? (
          <EmptyState icon={Building2} title="No companies yet">
            Companies appear here once their plant is onboarded.
          </EmptyState>
        ) : (
          <>
            <table className="hidden w-full text-sm md:table">
              <thead className="bg-surface-2 text-left text-xs text-muted">
                <tr>
                  <th scope="col" className="px-4 py-2 font-medium">
                    Company
                  </th>
                  {COLUMNS.map((c) => (
                    <th key={c.key} scope="col" className="px-4 py-2 text-right font-medium">
                      {c.label}
                    </th>
                  ))}
                  <th scope="col" className="px-4 py-2 font-medium">
                    Created
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {companies.map((c) => (
                  <tr key={c.id}>
                    <th scope="row" className="px-4 py-2.5 text-left font-medium text-fg">
                      {c.name}
                    </th>
                    {COLUMNS.map((col) => (
                      <td key={col.key} className="px-4 py-2.5 text-right tabular text-fg">
                        {formatNumber(c[col.key], { digits: 0 })}
                      </td>
                    ))}
                    <td className="px-4 py-2.5 text-muted">{formatDate(c.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <ul className="divide-y divide-border md:hidden" aria-label="Companies">
              {companies.map((c) => (
                <li key={c.id} className="space-y-1.5 px-4 py-3">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="font-medium text-fg">{c.name}</span>
                    <span className="text-xs text-muted">{formatDate(c.createdAt)}</span>
                  </div>
                  <dl className="grid grid-cols-3 gap-2 text-sm">
                    {COLUMNS.map((col) => (
                      <div key={col.key}>
                        <dt className="text-[11px] text-subtle">{col.label}</dt>
                        <dd className="tabular text-fg">{formatNumber(c[col.key], { digits: 0 })}</dd>
                      </div>
                    ))}
                  </dl>
                </li>
              ))}
            </ul>
          </>
        )}
      </Card>
    </Section>
  );
};
