import { Brain, Gauge, Sparkles, Zap } from 'lucide-react';
import { useId } from 'react';
import { useSession } from '../auth/useAuth.js';
import { cn } from '../lib/format.js';
import { Tooltip } from '../ui/overlay.jsx';

// Defaults of server/src/config/env.js; the /api/auth/me context wins when it carries `ai.tiers`.
const DEFAULT_MODELS = { fast: 'gemini-3.6-flash', balanced: 'gemini-3.8-flash', deep: 'gemini-3.8-flash' };

export const TIER_OPTIONS = [
  { value: 'auto', label: 'Auto', icon: Sparkles, help: 'SARA picks the tier for each question' },
  { value: 'fast', label: 'Fast', icon: Zap, help: 'Quick lookups and short answers' },
  { value: 'balanced', label: 'Balanced', icon: Gauge, help: 'Analysis, trends and reports' },
  { value: 'deep', label: 'Deep', icon: Brain, help: 'Diagnosis, planning and changes; thinks longest' },
];

/** Model behind a tier, from the session context or the server defaults. */
export const useTierModel = () => {
  const ctx = useSession();
  return (tier) => ctx?.ai?.tiers?.[tier]?.model ?? DEFAULT_MODELS[tier] ?? null;
};

/** Auto | Fast | Balanced | Deep as a compact radio group; each tooltip names the model. */
export const TierSelect = ({ value = 'auto', onChange, disabled, className }) => {
  const modelOf = useTierModel();
  const name = useId();
  return (
    <fieldset className={cn('flex rounded-lg bg-surface-2 p-0.5', className)} disabled={disabled}>
      <legend className="sr-only">Answer tier</legend>
      {TIER_OPTIONS.map((t) => {
        const active = value === t.value;
        const model = modelOf(t.value);
        return (
          <Tooltip key={t.value} content={model ? `${t.help} · ${model}` : t.help}>
            <label
              className={cn(
                'flex h-7 cursor-pointer items-center gap-1 rounded-md px-2 text-xs font-medium transition-colors has-[:disabled]:cursor-default has-[:disabled]:opacity-50 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-brand/40',
                active ? 'bg-surface text-fg shadow-card' : 'text-muted hover:text-fg',
              )}
            >
              <input
                type="radio"
                name={name}
                value={t.value}
                checked={active}
                onChange={() => onChange?.(t.value)}
                aria-label={t.label}
                className="sr-only"
              />
              <t.icon className={cn('size-3.5', active && 'text-brand')} aria-hidden />
              <span className={cn(!active && 'hidden sm:inline')} aria-hidden>
                {t.label}
              </span>
            </label>
          </Tooltip>
        );
      })}
    </fieldset>
  );
};
