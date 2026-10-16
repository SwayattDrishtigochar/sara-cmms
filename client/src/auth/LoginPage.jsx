import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  CalendarClock,
  ChevronDown,
  Eye,
  EyeOff,
  MessageSquareText,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import { useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router';
import { api, getToken } from '../api/client.js';
import { cn } from '../lib/format.js';
import { Badge, Button } from '../ui/core.jsx';
import { Field, Input } from '../ui/form.jsx';
import { useLogin } from './useAuth.js';

const FEATURES = [
  {
    icon: Activity,
    title: 'Gemini watches every machine',
    text: 'Anomalies are caught from live telemetry and explained in plain words.',
  },
  {
    icon: CalendarClock,
    title: 'Production and maintenance, planned together',
    text: 'Targets become job cards; maintenance finds the gaps — or shows the trade-off.',
  },
  {
    icon: MessageSquareText,
    title: 'Ask anything, change anything',
    text: 'Every change waits for your confirmation.',
  },
];

const DemoAccounts = ({ onPick }) => {
  const { data } = useQuery({
    queryKey: ['demo-accounts'],
    queryFn: () => api('/auth/demo-accounts'),
    staleTime: 60_000,
  });
  const [open, setOpen] = useState(0);
  if (!data?.accounts?.length) return null;
  return (
    <div className="mt-8 rounded-xl border border-border bg-surface-2/60">
      <div className="flex items-center gap-2 px-4 pt-3 text-xs font-medium text-muted">
        <ShieldCheck className="size-3.5 text-ai" aria-hidden /> Demo accounts — click one to fill in
      </div>
      <div className="divide-y divide-border">
        {data.accounts.map((account, i) => (
          <div key={account.company}>
            <button
              type="button"
              className="flex w-full items-center justify-between px-4 py-2.5 text-left text-sm font-medium text-fg"
              onClick={() => setOpen(open === i ? -1 : i)}
              aria-expanded={open === i}
            >
              {account.company}
              <ChevronDown
                className={cn('size-4 text-muted transition-transform', open === i && 'rotate-180')}
              />
            </button>
            {open === i && (
              <ul className="max-h-56 space-y-0.5 overflow-y-auto px-2 pb-2 scrollbar-thin">
                {account.users.map((u) => (
                  <li key={u.email}>
                    <button
                      type="button"
                      onClick={() => onPick(u.email, account.password)}
                      className="flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-surface"
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-xs font-medium text-fg">{u.email}</span>
                        <span className="block truncate text-[11px] text-subtle">{u.title}</span>
                      </span>
                      <Badge value={u.role} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};

export const LoginPage = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const login = useLogin();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);

  if (getToken() && !login.isPending && !login.isError) return <Navigate to="/" replace />;

  const submit = (e) => {
    e.preventDefault();
    login.mutate(
      { email, password },
      {
        onSuccess: (data) =>
          navigate(data.context.role === 'superAdmin' ? '/superadmin' : (location.state?.from ?? '/'), {
            replace: true,
          }),
      },
    );
  };

  return (
    <div className="grid min-h-full lg:grid-cols-[1.05fr_1fr]">
      <aside className="relative hidden overflow-hidden bg-[linear-gradient(140deg,#312e81_0%,#1e1b4b_45%,#0f3d3e_100%)] p-12 text-white lg:flex lg:flex-col">
        <div
          className="pointer-events-none absolute inset-0 opacity-[0.15]"
          style={{
            backgroundImage: 'radial-gradient(circle at 1px 1px, white 1px, transparent 0)',
            backgroundSize: '22px 22px',
          }}
          aria-hidden
        />
        <div className="relative flex items-center gap-2.5">
          <img src="/favicon.svg" alt="" className="size-9" />
          <span className="text-lg font-semibold tracking-tight">SARA</span>
          <span className="rounded-md bg-white/10 px-2 py-0.5 text-[11px] font-medium text-white/80">
            AI CMMS
          </span>
        </div>
        <div className="relative mt-auto max-w-lg">
          <p className="mb-3 inline-flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1 text-xs font-medium text-teal-200">
            <Sparkles className="size-3.5" aria-hidden /> Powered by Gemini
          </p>
          <h1 className="text-4xl font-semibold leading-tight tracking-tight">Your plant, run with AI.</h1>
          <p className="mt-3 text-base text-white/70">
            Machines, maintenance, production, costs and KPIs — one assistant that watches, plans and
            explains.
          </p>
          <ul className="mt-10 space-y-5">
            {FEATURES.map(({ icon: Icon, title, text }) => (
              <li key={title} className="flex gap-3.5">
                <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-white/10 text-teal-200">
                  <Icon className="size-4.5" aria-hidden />
                </span>
                <span>
                  <span className="block text-sm font-semibold">{title}</span>
                  <span className="block text-sm text-white/60">{text}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
        <p className="relative mt-12 text-xs text-white/40">Hackathon prototype · Swayatt</p>
      </aside>

      <main className="flex items-center justify-center px-4 py-12 sm:px-8">
        <div className="w-full max-w-sm">
          <div className="mb-8 flex items-center gap-2.5 lg:hidden">
            <img src="/favicon.svg" alt="" className="size-8" />
            <span className="text-lg font-semibold">SARA</span>
          </div>
          <h2 className="text-2xl font-semibold tracking-tight text-fg">Sign in</h2>
          <p className="mt-1 text-sm text-muted">Use your SARA account to continue.</p>

          <form onSubmit={submit} className="mt-8 space-y-4" noValidate>
            <Field label="Email">
              {(a11y) => (
                <Input
                  {...a11y}
                  type="email"
                  autoComplete="username"
                  autoFocus
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@company.com"
                  required
                />
              )}
            </Field>
            <Field label="Password">
              {(a11y) => (
                <div className="relative">
                  <Input
                    {...a11y}
                    type={show ? 'text' : 'password'}
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="pr-10"
                    required
                  />
                  <button
                    type="button"
                    onClick={() => setShow(!show)}
                    className="absolute inset-y-0 right-0 grid w-10 place-items-center text-muted hover:text-fg"
                    aria-label={show ? 'Hide password' : 'Show password'}
                  >
                    {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                  </button>
                </div>
              )}
            </Field>
            {login.isError && (
              <p
                role="alert"
                className="rounded-lg border border-critical/30 bg-critical/10 px-3 py-2 text-sm text-critical"
              >
                {login.error.message}
              </p>
            )}
            <Button type="submit" variant="primary" size="lg" className="w-full" loading={login.isPending}>
              Sign in
            </Button>
          </form>

          <DemoAccounts
            onPick={(pickedEmail, pickedPassword) => {
              setEmail(pickedEmail);
              setPassword(pickedPassword);
            }}
          />
        </div>
      </main>
    </div>
  );
};
