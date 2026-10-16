import { Sparkles } from 'lucide-react';
import { cn } from '../lib/format.js';
import { Button, Kbd } from '../ui/core.jsx';
import { useAssistant } from './useAssistant.js';

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform ?? '');
export const MOD_KEY = isMac ? '⌘' : 'Ctrl';

/**
 * "Ask SARA" button for any page: opens the assistant drawer with `text` (sent at once with `send`) and an
 * optional `context`. `shortcut` shows the ⌘J hint (the header button).
 */
export const AskSara = ({
  text,
  context,
  send,
  label = 'Ask SARA',
  size = 'sm',
  variant = 'ai',
  shortcut,
  className,
}) => (
  <Button
    size={size}
    variant={variant}
    icon={Sparkles}
    className={cn(className)}
    onClick={() => useAssistant.getState().open({ text, context, send })}
    aria-label={shortcut ? label : undefined}
    aria-keyshortcuts={shortcut ? (isMac ? 'Meta+J' : 'Control+J') : undefined}
  >
    <span className={cn(shortcut && 'hidden sm:inline')}>{label}</span>
    {shortcut && (
      <span className="hidden opacity-80 md:inline">
        <Kbd>{MOD_KEY} J</Kbd>
      </span>
    )}
  </Button>
);
