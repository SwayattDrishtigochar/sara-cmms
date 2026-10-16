import { Download } from 'lucide-react';
import { Badge, Button, Skeleton } from '../ui/core.jsx';
import { Dialog } from '../ui/overlay.jsx';
import { CopyButton, QueryError } from './parts.jsx';
import { credentialRows, downloadText, roleLabel, slugify, toDelimited } from './simUtils.js';
import { useCredentials } from './useSim.js';

const th = 'px-3 py-2 font-medium';
const wide = 'hidden lg:table-cell';
const shiftText = (shift) => (shift ? `Shift ${shift}` : null);

/** Shared password, Copy all / Download CSV, and everyone who can sign in. */
const CredentialsTable = ({ companyName, users, password }) => {
  const rows = credentialRows(users, password);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5 rounded-lg border border-border bg-surface-2 py-1 pr-1 pl-3 text-sm">
          <span className="text-muted">Shared password:</span>
          <code className="font-mono font-semibold break-all text-fg select-all">{password ?? '—'}</code>
          <CopyButton text={password ?? ''} label="Copy password" iconOnly variant="ghost" />
        </div>
        <div className="flex gap-2">
          {/* Tab-separated, so it pastes straight into a spreadsheet. */}
          <CopyButton text={toDelimited(rows, '\t')} label="Copy all" />
          <Button
            size="sm"
            icon={Download}
            onClick={() => downloadText(`${slugify(companyName)}-credentials.csv`, toDelimited(rows))}
          >
            Download CSV
          </Button>
        </div>
      </div>
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-surface-2 text-left text-xs text-muted">
            <tr>
              <th scope="col" className={th}>
                Email
              </th>
              <th scope="col" className={`${th} ${wide}`}>
                Name
              </th>
              <th scope="col" className={th}>
                Role
              </th>
              <th scope="col" className={`${th} ${wide}`}>
                Title
              </th>
              <th scope="col" className={`${th} ${wide}`}>
                Department
              </th>
              <th scope="col" className={`${th} ${wide}`}>
                Shift
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {users.map((u) => (
              <tr key={u.email}>
                <td className="px-3 py-2">
                  <span className="font-mono text-xs break-all text-fg select-all">{u.email}</span>
                  <span className="block text-xs text-subtle lg:hidden">
                    {[u.name, u.title, u.department, shiftText(u.shift)].filter(Boolean).join(' · ')}
                  </span>
                </td>
                <td className={`${wide} px-3 py-2 whitespace-nowrap text-fg`}>{u.name}</td>
                <td className="px-3 py-2">
                  <Badge value={u.role}>{roleLabel(u.role)}</Badge>
                </td>
                <td className={`${wide} px-3 py-2 text-muted`}>{u.title ?? '—'}</td>
                <td className={`${wide} px-3 py-2 text-muted`}>{u.department ?? '—'}</td>
                <td className={`${wide} px-3 py-2 whitespace-nowrap text-muted`}>
                  {shiftText(u.shift) ?? '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

/** Sign-in details of the simulated company. */
export const CredentialsDialog = ({ companyName, onClose }) => {
  const { data, isError, error, refetch } = useCredentials();
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={`${companyName}: sign-in details`}
      description="Everyone in the simulated company shares one password."
      size="xl"
      footer={
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      }
    >
      {data ? (
        <CredentialsTable companyName={companyName} users={data.users} password={data.password} />
      ) : isError ? (
        <QueryError what="the users" error={error} onRetry={refetch} />
      ) : (
        <div className="space-y-2.5" aria-busy="true">
          <Skeleton className="h-9 w-72" />
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-8 w-full" />
          ))}
        </div>
      )}
    </Dialog>
  );
};
