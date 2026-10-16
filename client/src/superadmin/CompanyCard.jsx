import { Building2, KeyRound } from 'lucide-react';
import { useState } from 'react';
import { formatDateTime, formatNumber } from '../lib/format.js';
import { Button, Card, CardHeader, EmptyState, Skeleton } from '../ui/core.jsx';
import { CredentialsDialog } from './CredentialsDialog.jsx';

const COUNTS = [
  ['users', 'Users'],
  ['assets', 'Machines'],
  ['workorders', 'Work orders'],
  ['jobcards', 'Job cards'],
  ['requests', 'Requests'],
];

/** Section (b): the one simulated company, its record counts and who can sign in. */
export const CompanyCard = ({ company }) => {
  const [showCredentials, setShowCredentials] = useState(false);
  if (company === undefined) {
    return (
      <Card className="space-y-4 p-4">
        <Skeleton className="h-5 w-48" />
        <Skeleton className="h-16 w-full" />
      </Card>
    );
  }
  if (!company) {
    return (
      <Card>
        <EmptyState icon={Building2} title="No simulated company yet">
          The simulator creates it on its very first run, with its machines, people and history. Later runs
          reuse it and never seed again.
        </EmptyState>
      </Card>
    );
  }
  return (
    <Card className="flex flex-col">
      <CardHeader
        icon={Building2}
        title={company.name}
        subtitle={[company.domain, company.seededAt && `Seeded ${formatDateTime(company.seededAt)}`]
          .filter(Boolean)
          .join(' · ')}
        actions={
          <Button size="sm" icon={KeyRound} onClick={() => setShowCredentials(true)}>
            Credentials
          </Button>
        }
      />
      <dl className="flex flex-wrap gap-x-8 gap-y-3 px-4 py-4">
        {COUNTS.map(([key, label]) => (
          <div key={key}>
            <dt className="text-xs text-muted">{label}</dt>
            <dd className="text-xl font-semibold tracking-tight text-fg tabular">
              {formatNumber(company.counts?.[key], { digits: 0 })}
            </dd>
          </div>
        ))}
      </dl>
      <p className="mt-auto border-t border-border px-4 py-3 text-xs text-muted">
        Seeded once on the simulator's first run. Restarts carry on with this company and never add the
        starting data again.
      </p>
      {showCredentials && (
        <CredentialsDialog companyName={company.name} onClose={() => setShowCredentials(false)} />
      )}
    </Card>
  );
};
