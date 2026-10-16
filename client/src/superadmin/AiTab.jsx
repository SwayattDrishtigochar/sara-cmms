import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Check,
  Cpu,
  FlaskConical,
  Gauge,
  KeyRound,
  MessageSquare,
  Radar,
  Save,
  TriangleAlert,
  Undo2,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { useBlocker } from 'react-router';
import { toast } from 'sonner';
import { api } from '../api/client.js';
import { cn, formatNumber } from '../lib/format.js';
import { Badge, Button, Card, Skeleton } from '../ui/core.jsx';
import { Field, Input, Select, Switch } from '../ui/form.jsx';
import { Dialog } from '../ui/overlay.jsx';
import { Callout, ProgressBar, QueryError, Section } from './parts.jsx';

const BASE = '/admin/ai';
const TIERS = [
  { key: 'router', label: 'Router', help: 'Intent classification, titles and summaries' },
  { key: 'fast', label: 'Fast', help: 'Simple chat questions' },
  { key: 'balanced', label: 'Balanced', help: 'Most chat' },
  { key: 'deep', label: 'Deep', help: 'Hard questions, diagnosis and planning' },
  {
    key: 'background',
    label: 'Background',
    help: 'Anomaly scans, investigations, insights and briefings. Never falls back into the chat models.',
  },
];
const LEVELS = ['minimal', 'low', 'medium', 'high'];
const DEFAULT_LIMIT = { rpm: 10, rpd: 250 };

const get =
  (path) =>
  ({ signal }) =>
    api(`${BASE}${path}`, { signal });

/** Models the settings name plus those used today, so every one gets a quota row. */
export const modelsInUse = (settings, usage = []) => [
  ...new Set(
    [
      ...Object.values(settings?.tiers ?? {}).flatMap((t) => [t?.model, t?.fallback]),
      ...Object.keys(settings?.limits ?? {}),
      ...usage.map((u) => u.model),
    ].filter(Boolean),
  ),
];

/** The level kept when the model supports it, else the nearest supported one; null when the model has none. */
export const clampLevel = (level, supported = []) => {
  if (level == null || !supported.length) return null;
  if (supported.includes(level)) return level;
  const want = LEVELS.indexOf(level);
  return [...supported].sort(
    (a, b) => Math.abs(LEVELS.indexOf(a) - want) - Math.abs(LEVELS.indexOf(b) - want),
  )[0];
};

/**
 * Today's background budget (the background model's RPD minus the chat reserve), what is used, and the
 * quiet interval the scheduler applies now. `stretch` = GET /admin/ai `quotaStretch` { at, factor }: past
 * `at` of the budget, calm machines wait `factor`× longer.
 */
export const backgroundBudget = (settings, usage = [], stretch = { at: 1, factor: 1 }) => {
  const model = settings?.tiers?.background?.model;
  const row = usage.find((u) => u.model === model);
  const rpd = (settings?.limits?.[model] ?? row?.limits ?? DEFAULT_LIMIT).rpd;
  const budget = Math.floor(rpd * (1 - (settings?.chatReservePct ?? 0) / 100));
  const calls = row?.calls ?? 0;
  const stretchAt = Math.ceil(stretch.at * budget);
  const stretched = stretch.factor > 1 && calls >= stretch.at * budget;
  const quiet = settings?.anomaly?.quietIntervalMin ?? 0;
  return {
    model,
    rpd,
    budget,
    calls,
    stretchAt,
    stretched,
    factor: stretch.factor,
    quietNow: stretched ? quiet * stretch.factor : quiet,
  };
};

/** Plain-language read-out of the scan cadence and the background budget, recomputed from the draft. */
const Cadence = ({ draft, usage, stretch }) => {
  const a = draft.anomaly ?? {};
  const b = backgroundBudget(draft, usage, stretch);
  if (!a.enabled) {
    return (
      <p className="rounded-lg border border-border bg-surface-2/60 p-3 text-sm text-muted">
        Anomaly scans are off: SARA doesn't review machines on its own. Owners and admins can still use Scan
        now.
      </p>
    );
  }
  const quiet = a.quietIntervalMin ?? 0;
  return (
    <div className="space-y-2 rounded-lg border border-border bg-surface-2/60 p-3 text-sm" aria-live="polite">
      <p className="text-fg">
        Every <strong className="tabular">{a.tickSec} s</strong> SARA screens every machine and sends the ones
        that are due to <span className="font-mono text-xs">{b.model}</span> in one call:{' '}
        {a.alwaysAskAi ? (
          'every machine, every tick.'
        ) : (
          <>
            unusual readings and open anomalies right away, calm machines every{' '}
            <strong className="tabular">{b.quietNow} min</strong>.
          </>
        )}
      </p>
      <ProgressBar
        value={b.budget ? b.calls / b.budget : 0}
        label={`Background budget: ${b.calls} of ${b.budget} calls today`}
        tone={b.stretched ? 'warn' : 'brand'}
      />
      <p className="text-xs text-muted tabular">
        {b.calls} of {b.budget} background calls today ({b.rpd} RPD minus the {draft.chatReservePct ?? 0} %
        chat reserve).
      </p>
      <p
        className={cn(
          'flex items-start gap-1.5 text-xs',
          b.stretched ? 'font-medium text-warn' : 'text-muted',
        )}
      >
        {b.stretched && <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />}
        {b.stretched
          ? `Quota stretch is on: calm machines now wait ${b.quietNow} min instead of ${quiet} min.`
          : b.factor > 1 &&
            `Quota stretch: from ${b.stretchAt} calls, calm machines wait ${b.factor}× longer (${quiet * b.factor} min).`}
      </p>
    </div>
  );
};

/** Asks before leaving the page or the tab with unsaved changes (the browser asks on reload or close). */
const LeaveGuard = ({ dirty }) => {
  const blocker = useBlocker(
    ({ currentLocation: a, nextLocation: b }) =>
      dirty && (a.pathname !== b.pathname || a.search !== b.search),
  );
  return (
    <Dialog
      open={blocker.state === 'blocked'}
      onOpenChange={(o) => !o && blocker.reset?.()}
      title="Leave without saving?"
      size="sm"
      footer={
        <>
          <Button onClick={() => blocker.reset?.()}>Keep editing</Button>
          <Button variant="primary" onClick={() => blocker.proceed?.()}>
            Discard changes
          </Button>
        </>
      }
    >
      <p className="text-sm text-muted">
        Your changes to the AI settings haven't been saved and will be lost.
      </p>
    </Dialog>
  );
};

const ModelOptions = ({ models, current }) => (
  <>
    {models.map((m) => (
      <option key={m.id} value={m.id}>
        {m.id}
        {m.free ? ' · free' : ''}
      </option>
    ))}
    {current && !models.some((m) => m.id === current) && <option value={current}>{current}</option>}
  </>
);

const TestResult = ({ result }) => {
  if (!result) return null;
  if (!result.ok) {
    return (
      <span className="flex items-center gap-1 text-xs text-critical">
        <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
        <span className="line-clamp-2">{result.error ?? 'Failed'}</span>
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1 text-xs text-success" title={result.text}>
      <Check className="size-3.5 shrink-0" aria-hidden />
      <span className="truncate">
        {result.latencyMs} ms · {result.model}
      </span>
    </span>
  );
};

const TierRow = ({ tier, value, models, onChange, onTest, testing, result }) => {
  const byId = new Map(models.map((m) => [m.id, m]));
  const supported = byId.get(value.model)?.thinking ?? [];
  const free = byId.get(value.model)?.free;
  return (
    <fieldset className="grid gap-3 border-t border-border px-4 py-3 first:border-t-0 lg:grid-cols-[11rem_minmax(0,2fr)_8rem_minmax(0,2fr)_minmax(8rem,1fr)] lg:items-start">
      <legend className="sr-only">{tier.label} tier</legend>
      <div className="min-w-0">
        <p className="flex items-center gap-2 text-sm font-semibold text-fg">
          {tier.label}
          {free && <Badge tone="success">Free</Badge>}
        </p>
        <p className="text-xs text-muted">{tier.help}</p>
      </div>
      <Field label="Model">
        {(p) => (
          <Select
            {...p}
            aria-label={`${tier.label} model`}
            value={value.model ?? ''}
            onChange={(e) => {
              const model = e.target.value;
              onChange({
                model,
                thinkingLevel: clampLevel(value.thinkingLevel, byId.get(model)?.thinking ?? []),
              });
            }}
          >
            <ModelOptions models={models} current={value.model} />
          </Select>
        )}
      </Field>
      <Field label="Thinking">
        {(p) => (
          <Select
            {...p}
            aria-label={`${tier.label} thinking level`}
            value={value.thinkingLevel ?? ''}
            disabled={!supported.length}
            onChange={(e) => onChange({ thinkingLevel: e.target.value || null })}
          >
            <option value="">None</option>
            {supported.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </Select>
        )}
      </Field>
      {tier.key === 'background' ? (
        <p className="self-center text-xs text-subtle">No fallback: a 429 skips the cycle.</p>
      ) : (
        <Field label="Fallback">
          {(p) => (
            <Select
              {...p}
              aria-label={`${tier.label} fallback`}
              value={value.fallback ?? ''}
              onChange={(e) => onChange({ fallback: e.target.value || null })}
            >
              <option value="">None</option>
              <ModelOptions models={models} current={value.fallback} />
            </Select>
          )}
        </Field>
      )}
      <div className="flex flex-col gap-1.5 lg:pt-5">
        <Button size="sm" icon={FlaskConical} loading={testing} onClick={onTest} className="w-fit">
          Test
        </Button>
        <TestResult result={result} />
      </div>
    </fieldset>
  );
};

const QuotaRow = ({ model, limit, usage, free, onChange }) => {
  const calls = usage?.calls ?? 0;
  const share = limit.rpd ? calls / limit.rpd : 0;
  const tone = share >= 0.9 ? 'warn' : 'brand';
  const num = (key) => (e) => {
    const n = Number(e.target.value);
    onChange({ ...limit, [key]: Number.isNaN(n) ? limit[key] : n });
  };
  return (
    <div className="grid gap-3 border-t border-border px-4 py-3 first:border-t-0 sm:grid-cols-[minmax(0,1fr)_6.5rem_6.5rem]">
      <div className="min-w-0">
        <p className="flex items-center gap-2 text-sm font-medium text-fg">
          <span className="truncate font-mono">{model}</span>
          {free && <Badge tone="success">Free</Badge>}
        </p>
        <div className="mt-2">
          <ProgressBar value={share} label={`${model}: ${calls} of ${limit.rpd} calls today`} tone={tone} />
        </div>
        <p className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted tabular">
          <span className={cn(share >= 0.9 && 'font-medium text-warn')}>
            {calls} of {limit.rpd} calls today
          </span>
          {usage?.tokens > 0 && <span>{formatNumber(usage.tokens)} tokens</span>}
          {usage?.rateLimited > 0 && (
            <span className="flex items-center gap-1 text-warn">
              <TriangleAlert className="size-3" aria-hidden />
              {usage.rateLimited} rate-limited
            </span>
          )}
          {usage?.errors > 0 && <span className="text-critical">{usage.errors} errors</span>}
        </p>
      </div>
      <Field label="RPM">
        {(p) => (
          <Input
            {...p}
            type="number"
            min={1}
            value={limit.rpm}
            onChange={num('rpm')}
            aria-label={`${model} requests per minute`}
          />
        )}
      </Field>
      <Field label="RPD">
        {(p) => (
          <Input
            {...p}
            type="number"
            min={1}
            value={limit.rpd}
            onChange={num('rpd')}
            aria-label={`${model} requests per day`}
          />
        )}
      </Field>
    </div>
  );
};

const Status = ({ apiKeyConfigured, mock }) => {
  if (mock) {
    return (
      <Callout tone="warn" icon={KeyRound}>
        {apiKeyConfigured ? (
          <>
            <strong>Mock mode</strong> (AI_MOCK is on): SARA answers with built-in, deterministic replies. No
            Gemini calls are made.
          </>
        ) : (
          <>
            <strong>No Gemini API key</strong>: SARA answers with built-in, deterministic replies. Add
            GEMINI_API_KEY to the server's .env to use the real models.
          </>
        )}
      </Callout>
    );
  }
  return (
    <Callout tone="success" icon={KeyRound}>
      Gemini API key configured. Free-tier quotas reset at midnight Pacific (12:30 IST).
    </Callout>
  );
};

/** Superadmin → AI: models per tier, quotas and today's usage, chat reserve and the background AI schedule. */
export const AiTab = () => {
  const qc = useQueryClient();
  const config = useQuery({ queryKey: ['admin', 'ai'], queryFn: get('') });
  const models = useQuery({
    queryKey: ['admin', 'ai', 'models'],
    queryFn: get('/models'),
    staleTime: 10 * 60_000,
  });
  const usage = useQuery({
    queryKey: ['admin', 'ai', 'usage'],
    queryFn: get('/usage'),
    refetchInterval: 30_000,
  });
  const saved = config.data?.settings;
  const [draft, setDraft] = useState(null);
  useEffect(() => {
    if (saved) setDraft((d) => d ?? saved);
  }, [saved]);
  const dirty = Boolean(draft && saved) && JSON.stringify(draft) !== JSON.stringify(saved);
  useEffect(() => {
    if (!dirty) return;
    const warn = (e) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const save = useMutation({
    mutationFn: (settings) => api(BASE, { method: 'PUT', body: settings }),
    onSuccess: (r) => {
      qc.setQueryData(['admin', 'ai'], (prev) => ({ ...prev, settings: r.settings }));
      setDraft(r.settings);
      toast.success('AI settings saved');
      qc.invalidateQueries({ queryKey: ['admin', 'ai', 'usage'] });
    },
    onError: (err) =>
      toast.error("Couldn't save", {
        description:
          err.details?.map?.((d) => (d.path ? `${d.path}: ${d.message}` : d.message)).join('\n') ||
          err.message,
      }),
  });
  const [results, setResults] = useState({});
  const test = useMutation({
    mutationFn: (tier) => api(`${BASE}/test`, { method: 'POST', body: { tier } }),
    onSuccess: (r, tier) => setResults((s) => ({ ...s, [tier]: r })),
    onError: (err, tier) => setResults((s) => ({ ...s, [tier]: { ok: false, error: err.message } })),
  });

  if (config.isError) {
    return (
      <Card>
        <QueryError what="the AI settings" error={config.error} onRetry={config.refetch} />
      </Card>
    );
  }
  if (!draft) {
    return (
      <div className="space-y-4" aria-busy="true">
        <Skeleton className="h-12" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  const modelList = models.data?.models ?? [];
  const usageRows = usage.data?.models ?? [];
  const setTier = (key, patch) =>
    setDraft((d) => ({ ...d, tiers: { ...d.tiers, [key]: { ...d.tiers?.[key], ...patch } } }));
  const setField = (key, value) => setDraft((d) => ({ ...d, [key]: value }));
  const setGroup = (group, key, value) => setDraft((d) => ({ ...d, [group]: { ...d[group], [key]: value } }));
  const number = (fn) => (e) => {
    const n = Number(e.target.value);
    if (!Number.isNaN(n)) fn(n);
  };
  const inUse = modelsInUse(draft, usageRows);
  const freeOf = (id) =>
    modelList.find((m) => m.id === id)?.free ?? usageRows.find((u) => u.model === id)?.free;

  return (
    <div className="space-y-8 pb-20">
      <LeaveGuard dirty={dirty} />
      <Status apiKeyConfigured={config.data.apiKeyConfigured} mock={config.data.mock} />

      <Section
        id="ai-tiers"
        icon={Cpu}
        title="Models per tier"
        description="Which Gemini model answers each kind of work. Thinking levels show only what the model supports."
        actions={
          models.isError && (
            <span className="text-xs text-critical">Couldn't list models: {models.error.message}</span>
          )
        }
      >
        <Card>
          {TIERS.map((tier) => (
            <TierRow
              key={tier.key}
              tier={tier}
              value={draft.tiers?.[tier.key] ?? {}}
              models={modelList}
              onChange={(patch) => setTier(tier.key, patch)}
              onTest={() => test.mutate(tier.key)}
              testing={test.isPending && test.variables === tier.key}
              result={results[tier.key]}
            />
          ))}
          {dirty && (
            <p className="border-t border-border px-4 py-2 text-xs text-subtle">
              Test uses the saved settings — save first to test a change.
            </p>
          )}
        </Card>
      </Section>

      <Section
        id="ai-quota"
        icon={Gauge}
        title="Quotas and usage today"
        description={`Copy each model's RPM / RPD from AI Studio. ${usage.data?.day ? `Counting ${usage.data.day}` : 'Counting today'} (Pacific).`}
      >
        <Card>
          {inUse.length === 0 && <p className="px-4 py-6 text-sm text-muted">No models configured yet.</p>}
          {inUse.map((model) => (
            <QuotaRow
              key={model}
              model={model}
              limit={
                draft.limits?.[model] ?? usageRows.find((u) => u.model === model)?.limits ?? DEFAULT_LIMIT
              }
              usage={usageRows.find((u) => u.model === model)}
              free={freeOf(model)}
              onChange={(limit) => setDraft((d) => ({ ...d, limits: { ...d.limits, [model]: limit } }))}
            />
          ))}
        </Card>
      </Section>

      <Section
        id="ai-chat"
        icon={MessageSquare}
        title="Chat"
        description="Background work stops once it would eat into the share of each day's quota kept for chat."
      >
        <Card className="grid gap-4 p-4 sm:grid-cols-2">
          <Field label="Chat reserve" help="Share of each model's daily quota kept for chat.">
            {(p) => (
              <Input
                {...p}
                type="number"
                min={0}
                max={90}
                suffix="%"
                value={draft.chatReservePct ?? 0}
                onChange={number((n) => setField('chatReservePct', n))}
              />
            )}
          </Field>
          <div className="sm:pt-6">
            <Switch
              id="ai-show-thoughts"
              label="Show the model's thoughts in chat"
              checked={draft.showThoughts}
              onChange={(v) => setField('showThoughts', v)}
            />
          </div>
        </Card>
      </Section>

      <Section
        id="ai-background"
        icon={Radar}
        title="Background AI"
        description="What SARA does on its own, on the background tier."
      >
        <Card className="space-y-5 p-4">
          <div className="space-y-3">
            <Switch
              id="ai-anomaly-enabled"
              label="Anomaly scans"
              checked={draft.anomaly?.enabled}
              onChange={(v) => setGroup('anomaly', 'enabled', v)}
            />
            <Cadence draft={draft} usage={usageRows} stretch={config.data.quotaStretch} />
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Field label="Scan tick" help="How often the scheduler looks at each company.">
                {(p) => (
                  <Input
                    {...p}
                    type="number"
                    min={10}
                    suffix="s"
                    value={draft.anomaly?.tickSec ?? ''}
                    onChange={number((n) => setGroup('anomaly', 'tickSec', n))}
                  />
                )}
              </Field>
              <Field label="Quiet interval" help="A calm machine still goes to the AI this often.">
                {(p) => (
                  <Input
                    {...p}
                    type="number"
                    min={1}
                    suffix="min"
                    value={draft.anomaly?.quietIntervalMin ?? ''}
                    onChange={number((n) => setGroup('anomaly', 'quietIntervalMin', n))}
                  />
                )}
              </Field>
              <div className="space-y-3 sm:col-span-2 sm:pt-6">
                <Switch
                  id="ai-anomaly-always"
                  label="Always ask the AI (every machine, every tick)"
                  checked={draft.anomaly?.alwaysAskAi}
                  onChange={(v) => setGroup('anomaly', 'alwaysAskAi', v)}
                />
                <Switch
                  id="ai-anomaly-investigate"
                  label="Investigate new warning and critical anomalies"
                  checked={draft.anomaly?.investigate}
                  onChange={(v) => setGroup('anomaly', 'investigate', v)}
                />
              </div>
            </div>
          </div>
          <div className="grid gap-4 border-t border-border pt-5 sm:grid-cols-2 lg:grid-cols-4">
            <div className="sm:pt-6">
              <Switch
                id="ai-cost-enabled"
                label="Cost watch"
                checked={draft.costWatch?.enabled}
                onChange={(v) => setGroup('costWatch', 'enabled', v)}
              />
            </div>
            <Field label="Cost watch interval">
              {(p) => (
                <Input
                  {...p}
                  type="number"
                  min={5}
                  suffix="min"
                  value={draft.costWatch?.intervalMin ?? ''}
                  onChange={number((n) => setGroup('costWatch', 'intervalMin', n))}
                />
              )}
            </Field>
            <Field label="KPI insight cache">
              {(p) => (
                <Input
                  {...p}
                  type="number"
                  min={1}
                  suffix="min"
                  value={draft.kpiInsightTtlMin ?? ''}
                  onChange={number((n) => setField('kpiInsightTtlMin', n))}
                />
              )}
            </Field>
            <Field label="Briefing cache">
              {(p) => (
                <Input
                  {...p}
                  type="number"
                  min={1}
                  suffix="h"
                  value={draft.briefingTtlHours ?? ''}
                  onChange={number((n) => setField('briefingTtlHours', n))}
                />
              )}
            </Field>
          </div>
        </Card>
      </Section>

      {dirty && (
        <section
          className="sticky bottom-0 z-10 -mx-4 flex flex-wrap items-center justify-between gap-3 border-t border-border bg-surface/90 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6"
          aria-label="Unsaved changes"
        >
          <p className="flex items-center gap-2 text-sm text-fg">
            <TriangleAlert className="size-4 text-warn" aria-hidden />
            You have unsaved changes.
          </p>
          <div className="flex gap-2">
            <Button icon={Undo2} onClick={() => setDraft(saved)} disabled={save.isPending}>
              Discard
            </Button>
            <Button variant="primary" icon={Save} loading={save.isPending} onClick={() => save.mutate(draft)}>
              Save
            </Button>
          </div>
        </section>
      )}
    </div>
  );
};
