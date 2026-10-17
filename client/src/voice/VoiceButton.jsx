import { useQueryClient } from '@tanstack/react-query';
import { AudioLines, Loader2, Mic, MicOff } from 'lucide-react';
import { MOD_KEY } from '../assistant/AskSara.jsx';
import { useSession } from '../auth/useAuth.js';
import { cn } from '../lib/format.js';
import { Button } from '../ui/core.jsx';
import { Tooltip } from '../ui/overlay.jsx';
import { useVoice, useVoiceConfig } from './useVoice.js';

const isMac = MOD_KEY === '⌘';
export const SHORTCUT_LABEL = `${MOD_KEY} Shift Space`;
export const SHORTCUT_ARIA = `${isMac ? 'Meta' : 'Control'}+Shift+Space`;

/**
 * Starts / ends a voice session. `header`: icon button with the shortcut hint and a live dot; `inline`:
 * "Continue by voice" on a conversation. Hidden when voice is off or for the platform company.
 */
export const VoiceButton = ({ conversationId, variant = 'header', className }) => {
  const ctx = useSession();
  const platform = Boolean(ctx?.company?.isPlatform);
  const config = useVoiceConfig(!platform);
  const qc = useQueryClient();
  const phase = useVoice((s) => s.phase);
  if (platform || !config.data?.enabled) return null;

  const live = phase === 'live';
  const busy = phase === 'connecting';
  const onClick = () => useVoice.getState().toggle({ conversationId, qc });

  if (variant === 'inline') {
    return (
      <Button size="sm" variant="soft" icon={AudioLines} onClick={onClick} className={className}>
        {live || busy ? 'End voice' : 'Continue by voice'}
      </Button>
    );
  }
  const Icon = busy ? Loader2 : phase === 'error' ? MicOff : Mic;
  return (
    <Tooltip content={`Talk to SARA (${SHORTCUT_LABEL})`}>
      <Button
        variant="ghost"
        size="icon"
        onClick={onClick}
        aria-label={live ? 'End voice session' : 'Talk to SARA'}
        aria-pressed={live || busy}
        aria-keyshortcuts={SHORTCUT_ARIA}
        className={cn('relative', live && 'bg-ai/15 text-ai hover:bg-ai/20 hover:text-ai', className)}
      >
        <Icon className={cn('size-[18px]', busy && 'animate-spin')} aria-hidden />
        {(live || phase === 'error') && (
          <span
            className={cn(
              'absolute top-1.5 right-1.5 size-2 rounded-full ring-2 ring-surface',
              live ? 'animate-pulse bg-ai' : 'bg-critical',
            )}
            aria-hidden
          />
        )}
      </Button>
    </Tooltip>
  );
};
