import { Crown, Eye, FlaskConical, ShieldCheck, Wrench } from 'lucide-react';
import { useState } from 'react';
import { cn } from '../lib/format.js';
import { Avatar, Badge, Button, Spinner } from '../ui/core.jsx';

const ROLE = {
  owner: { label: 'Owner', icon: Crown },
  admin: { label: 'Admin', icon: ShieldCheck },
  technician: { label: 'Technician', icon: Wrench },
  view: { label: 'Viewer', icon: Eye },
};
const SHOW_FIRST = 8;

const AccountCard = ({ user, busy, pending, onClick }) => {
  const role = ROLE[user.role] ?? { label: user.role, icon: Eye };
  const detail = [user.title, user.department].filter(Boolean).join(' · ');
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      aria-busy={pending || undefined}
      className={cn(
        'flex w-full items-center gap-3 rounded-lg border border-border bg-surface p-2.5 text-left shadow-card transition-colors',
        'hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        'disabled:cursor-not-allowed disabled:opacity-60 aria-busy:opacity-100',
      )}
    >
      <Avatar name={user.name} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-fg">{user.name}</span>
          <Badge value={user.role}>
            <role.icon className="size-3" aria-hidden />
            {role.label}
          </Badge>
        </span>
        <span className="block truncate text-xs text-muted">{detail || user.email}</span>
      </span>
      {pending && <Spinner />}
    </button>
  );
};

/** Demo mode: one click signs in as any listed person. `signIn` is the useDemoLogin mutation. */
export const DemoAccounts = ({ accounts, signIn, onSignedIn }) => {
  const [expanded, setExpanded] = useState(() => new Set());
  const pendingEmail = signIn.isPending ? signIn.variables?.email : null;

  const toggle = (id) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  return (
    <section aria-labelledby="demo-accounts-title" className="mt-10 border-t border-border pt-8">
      <div className="flex flex-wrap items-center gap-2">
        <h3 id="demo-accounts-title" className="text-base font-semibold text-fg">
          Demo accounts
        </h3>
        <Badge tone="warn">
          <FlaskConical className="size-3" aria-hidden />
          Demo mode
        </Badge>
      </div>
      <p className="mt-1 text-sm text-muted">Pick a person to sign in as them. No password needed.</p>

      {accounts.map(({ company, users }) => {
        const open = expanded.has(company.id);
        const shown = open ? users : users.slice(0, SHOW_FIRST);
        return (
          <div key={company.id} className="mt-5">
            <h4 className="mb-2 text-sm font-medium text-fg">{company.name}</h4>
            <ul className="grid gap-2 sm:grid-cols-2">
              {shown.map((user) => (
                <li key={user.email}>
                  <AccountCard
                    user={user}
                    busy={signIn.isPending}
                    pending={pendingEmail === user.email}
                    onClick={() => signIn.mutate({ email: user.email }, { onSuccess: onSignedIn })}
                  />
                </li>
              ))}
            </ul>
            {users.length > SHOW_FIRST && (
              <Button variant="ghost" size="sm" className="mt-2" onClick={() => toggle(company.id)}>
                {open ? 'Show fewer' : `Show all ${users.length}`}
              </Button>
            )}
          </div>
        );
      })}

      {signIn.isError && (
        <p
          role="alert"
          className="mt-4 rounded-lg border border-critical/30 bg-critical/10 px-3 py-2 text-sm text-critical"
        >
          {signIn.error.message}
        </p>
      )}
    </section>
  );
};
