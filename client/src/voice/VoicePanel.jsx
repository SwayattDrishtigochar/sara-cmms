import { useQueryClient } from '@tanstack/react-query';
import {
  AudioLines,
  Check,
  ChevronDown,
  CircleAlert,
  CircleStop,
  Keyboard,
  Maximize2,
  MessageSquareText,
  Minimize2,
  PhoneOff,
  RotateCcw,
  Send,
  Sparkles,
  WifiOff,
  X,
} from 'lucide-react';
import { Dialog as D } from 'radix-ui';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { useSession } from '../auth/useAuth.js';
import { ConfirmCard } from '../chat/ConfirmCard.jsx';
import { MessageBubble } from '../chat/MessageBubble.jsx';
import { cn } from '../lib/format.js';
import { useNow } from '../superadmin/parts.jsx';
import { Button } from '../ui/core.jsx';
import { Input, Select } from '../ui/form.jsx';
import { Menu, MenuItem, MenuLabel } from '../ui/overlay.jsx';
import { Orb } from './Orb.jsx';
import { phaseOf, useVoice, useVoiceConfig } from './useVoice.js';
import { SHORTCUT_LABEL } from './VoiceButton.jsx';

/** Canned prompts for mock mode, in demo order (phase 8 §9). */
export const SAY_SOMETHING = [
  'How many machines are running right now?',
  'Which assets need attention?',
  'IMM 3 का vibration कैसा है?',
  'How many open work orders?',
  'Create a work order for Press 2: hydraulic leak, high priority',
  'Yes, go ahead',
  'Plan 5000 Housing-A parts due next Friday',
];

const PHASE_TEXT = {
  idle: 'Talk to SARA',
  connecting: 'Connecting…',
  listening: 'Listening… ask anything',
  thinking: 'Thinking…',
  speaking: 'SARA is speaking — talk to interrupt',
  ended: 'Session ended',
  error: "Voice isn't available",
};

/** Plain text for an error code; AI_QUOTA / AI_ERROR and unknown codes use the server's message. */
export const errorText = (error) =>
  ({
    MIC_DENIED: 'Microphone blocked: allow it in the site settings next to the address bar, then try again.',
    NO_MIC: 'No microphone found. Plug one in and try again, or type instead.',
    UNSUPPORTED: "This browser can't stream audio. Try a recent Chrome, Edge, Safari or Firefox.",
    NO_WEBSOCKET: "This browser can't open a live connection to SARA. Use Chat instead.",
    INSECURE: 'Voice needs HTTPS or localhost.',
    OFFLINE: "You're offline. Check the connection, then try again.",
    CONNECTION_LOST: 'The voice connection dropped. Retry to pick up the same conversation.',
    TOO_LARGE: 'A message was too large for the voice connection, so it closed. Retry to continue.',
    VOICE_BUSY: 'All voice lines are busy right now. Try again in a minute.',
    VOICE_DISABLED: 'Voice is turned off for your company.',
    UNAUTHORIZED: 'Your session ended. Sign in again to talk to SARA.',
    CONVERSATION_NOT_FOUND: "That conversation doesn't exist any more.",
  })[error?.code] ??
  error?.message ??
  'Something went wrong.';

const TYPING_INSTEAD = new Set(['MIC_DENIED', 'NO_MIC', 'MIC_ERROR', 'INSECURE', 'UNSUPPORTED']);
const TABBABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex="0"]';

const endedText = (reason, idleSec = 90) =>
  ({
    idle: `Ended after ${idleSec} s of silence.`,
    max_duration: 'Session limit reached.',
    replaced: 'Voice moved to another tab.',
    signed_out: 'You were signed out.',
    server_shutdown: 'SARA restarted.',
    error: 'The session stopped because of an error.',
  })[reason] ?? 'Voice session ended.';

const clock = (sec) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;

const Timer = ({ startedAt, maxMin }) => {
  const now = useNow(1000);
  const sec = Math.max(0, (now - startedAt) / 1000);
  return (
    <span className="tabular text-[11px] text-subtle" title="Elapsed / session limit">
      {clock(sec)}
      {maxMin ? ` / ${maxMin}:00` : ''}
    </span>
  );
};

const plainText = (message) =>
  message.parts
    .filter((p) => p.type === 'text')
    .map((p) => p.text)
    .join(' ')
    .trim();
/** The last sentence SARA finished, for the screen-reader announcer. */
const lastSentence = (turns) => {
  const done = turns.findLast((t) => t.assistant.status !== 'streaming' && plainText(t.assistant));
  const text = done ? plainText(done.assistant) : '';
  return (
    text
      .split(/(?<=[.!?।])\s+/)
      .filter(Boolean)
      .at(-1) ?? ''
  );
};

const LanguageChip = ({ languages, value, onChange }) => (
  <Select
    aria-label="Answer language"
    value={value}
    onChange={(e) => onChange(e.target.value)}
    className="h-7 w-auto max-w-32 rounded-full px-2 pr-7 text-xs"
  >
    {languages.map((l) => (
      <option key={l.code} value={l.code}>
        {l.code === 'auto' ? 'Auto' : l.label}
      </option>
    ))}
    {!languages.some((l) => l.code === value) && <option value={value}>{value}</option>}
  </Select>
);

const VoiceMenu = ({ voices, value, onChange }) => (
  <Menu
    trigger={
      <Button size="sm" variant="ghost" className="h-7 gap-1 px-2" aria-label={`SARA's voice: ${value}`}>
        {value}
        <ChevronDown className="size-3.5" aria-hidden />
      </Button>
    }
  >
    <MenuLabel>SARA's voice</MenuLabel>
    {(voices.length ? voices : [{ name: value }]).map((v) => (
      <MenuItem key={v.name} onSelect={() => onChange(v.name)}>
        {v.name}
        {v.style && <span className="text-muted">· {v.style}</span>}
        {v.name === value && <Check className="ml-auto size-4 text-brand" aria-hidden />}
      </MenuItem>
    ))}
  </Menu>
);

const UserCaption = ({ user }) =>
  user.text ? (
    <div className="flex justify-end">
      <p
        className={cn(
          'max-w-[85%] rounded-2xl rounded-br-md border border-brand/15 bg-brand-soft px-3.5 py-2 text-sm leading-relaxed whitespace-pre-wrap break-words',
          user.final ? 'text-fg' : 'italic text-muted',
        )}
      >
        <span className="sr-only">You: </span>
        {user.text}
      </p>
    </div>
  ) : null;

const SayYes = () => (
  <p className="pl-10 text-xs text-muted" aria-hidden>
    Say yes or tap Confirm
  </p>
);

const Turn = ({ turn, onConfirm, onReject }) => (
  <div className="space-y-2.5">
    <UserCaption user={turn.user} />
    {(turn.assistant.parts.length > 0 || turn.assistant.status === 'streaming') && (
      <MessageBubble message={turn.assistant} onConfirm={onConfirm} onReject={onReject} />
    )}
    {turn.assistant.pendingAction?.status === 'pending' && <SayYes />}
  </div>
);

/** A change left waiting from an earlier session on this conversation. */
const CarriedAction = ({ action, onConfirm, onReject }) => (
  <div className="space-y-1.5">
    <ConfirmCard
      payload={{ ...action.preview, actionId: action.id, expiresAt: action.expiresAt }}
      action={action}
      onConfirm={onConfirm}
      onReject={onReject}
    />
    {action.status === 'pending' && <SayYes />}
  </div>
);

/** Takes focus for its first button when focus was lost (End / Stop unmounted it) or is in the panel. */
const StateBlock = ({ icon: Icon = CircleAlert, tone = 'muted', text, children }) => {
  const ref = useRef(null);
  useEffect(() => {
    const at = document.activeElement;
    const panel = ref.current?.closest('[role="dialog"]');
    if (!at || at === document.body || panel?.contains(at)) ref.current?.querySelector('button')?.focus();
  }, []);
  return (
    <div
      ref={ref}
      role={tone === 'critical' ? 'alert' : 'status'}
      className="flex flex-col items-center gap-3 px-4 py-6 text-center"
    >
      <Icon className={cn('size-6', tone === 'critical' ? 'text-critical' : 'text-muted')} aria-hidden />
      <p className="max-w-xs text-sm text-fg">{text}</p>
      {children && <div className="flex flex-wrap justify-center gap-2">{children}</div>}
    </div>
  );
};

/** `onNavigate`: the ended panel closes so the chat is not covered (a live session keeps it open). */
const ChatLink = ({ conversationId, onNavigate }) =>
  conversationId ? (
    <Link
      to={`/chat/${conversationId}`}
      onClick={onNavigate}
      className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium text-muted transition-colors hover:bg-surface-2 hover:text-fg"
    >
      <MessageSquareText className="size-4" aria-hidden /> Open in Chat
    </Link>
  ) : null;

/**
 * The voice panel (mount once in the shell): a non-modal card (bottom sheet on phones) with the orb, live
 * captions, tool activity, blocks and confirm cards, typed fallback and session controls. Owns the
 * Ctrl/Cmd + Shift + Space shortcut.
 */
export const VoicePanel = () => {
  const s = useVoice();
  const qc = useQueryClient();
  const ctx = useSession();
  const config = useVoiceConfig(Boolean(ctx) && !ctx?.company?.isPlatform);
  const [text, setText] = useState('');
  const muteRef = useRef(null);
  const inputRef = useRef(null);
  const logRef = useRef(null);
  const contentRef = useRef(null);
  const stick = useRef(true); // follow new captions unless the user scrolled up to read
  const seenTurns = useRef(0);
  const view = phaseOf(s);
  const live = s.phase === 'live';
  const cfg = config.data;

  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.code === 'Space') {
        e.preventDefault();
        useVoice.getState().toggle({ qc });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [qc]);

  // Signing out (or the shell unmounting) ends the session.
  useEffect(() => {
    if (!ctx) useVoice.getState().close();
  }, [ctx]);
  useEffect(() => () => useVoice.getState().close(), []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on every new caption, block or state
  useLayoutEffect(() => {
    const el = logRef.current;
    if (!el) return;
    if (s.turns.length > seenTurns.current) stick.current = true;
    seenTurns.current = s.turns.length;
    if (stick.current) el.scrollTop = el.scrollHeight;
    // Chat bubbles are live regions; here SARA already speaks and the sr-only line announces her last sentence,
    // so the bubbles stay silent (React leaves the attribute alone while the prop is unchanged).
    for (const region of el.querySelectorAll('[aria-live="polite"]')) region.setAttribute('aria-live', 'off');
  }, [s.turns, s.phase]);

  /** Tab past the panel's edges returns to the page (the non-modal panel must not loop focus). */
  const onKeyDown = (e) => {
    if (e.key !== 'Tab' || e.altKey || e.ctrlKey || e.metaKey) return;
    const items = [...e.currentTarget.querySelectorAll(TABBABLE)].filter(
      (el) => el.checkVisibility?.() ?? true,
    );
    const edge = e.shiftKey ? items[0] : items.at(-1);
    const exit = document.querySelector('header [aria-keyshortcuts]') ?? document.getElementById('content');
    if (edge && document.activeElement === edge && exit) {
      e.preventDefault();
      exit.focus();
    }
  };

  const onScroll = (e) => {
    const el = e.currentTarget;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };
  /** Stop unmounts itself: keep focus in the panel. */
  const stop = () => {
    s.interrupt();
    (muteRef.current?.disabled ? inputRef : muteRef).current?.focus();
  };

  const sentence = useMemo(() => lastSentence(s.turns), [s.turns]);
  const onConfirm = (_m, id) => s.confirm(id);
  const onReject = (id) => s.reject(id);
  const retry = (textOnly = s.textOnly) => s.start({ conversationId: s.conversationId, qc, textOnly });
  const submit = (e) => {
    e.preventDefault();
    if (s.sendText(text)) setText('');
  };
  const language = s.language ?? cfg?.defaults?.language ?? 'auto';
  const voice = s.voice ?? cfg?.defaults?.voice ?? 'Kore';
  // Typing only or muted: SARA can't hear, so no "talk to interrupt".
  const deaf = s.textOnly || s.muted;
  const phaseText =
    view === 'listening' && deaf
      ? s.textOnly
        ? 'Type to SARA'
        : 'Muted'
      : view === 'speaking' && deaf
        ? 'SARA is speaking'
        : PHASE_TEXT[view];

  return (
    <D.Root open={s.open} onOpenChange={(open) => !open && s.close()} modal={false}>
      <D.Portal>
        <D.Content
          ref={contentRef}
          onInteractOutside={(e) => e.preventDefault()}
          onEscapeKeyDown={(e) => {
            // Escape on the page (closing a select or popup) must not hang up: only Escape in the panel ends.
            if (!contentRef.current?.contains(document.activeElement)) e.preventDefault();
          }}
          onKeyDown={onKeyDown}
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            (muteRef.current ?? inputRef.current)?.focus();
          }}
          data-testid="voice-panel"
          className={cn(
            'fixed inset-x-0 bottom-0 z-50 flex max-h-[70dvh] flex-col rounded-t-2xl border border-border bg-surface shadow-pop animate-fade-in focus:outline-none',
            'sm:inset-x-auto sm:right-4 sm:bottom-4 sm:max-h-[min(40rem,calc(100dvh-6rem))] sm:rounded-2xl',
            s.wide ? 'sm:w-[calc(100vw-2rem)] sm:max-w-2xl' : 'sm:w-[min(26rem,calc(100vw-2rem))]',
          )}
        >
          <header className="space-y-1.5 border-b border-border px-3 pt-2 pb-1.5">
            <div className="flex items-center gap-2.5">
              <Orb phase={view} size="sm" />
              <div className="min-w-0 flex-1">
                <D.Title className="text-sm font-semibold text-fg">SARA</D.Title>
                <D.Description className="truncate text-xs text-muted">{phaseText}</D.Description>
              </div>
              <Button
                size="iconSm"
                variant="ghost"
                className="max-sm:hidden"
                onClick={() => s.setWide(!s.wide)}
                aria-label={s.wide ? 'Narrow panel' : 'Widen panel'}
                aria-pressed={s.wide}
                icon={s.wide ? Minimize2 : Maximize2}
              />
              <D.Close asChild>
                <Button size="iconSm" variant="ghost" aria-label="End and close" icon={X} />
              </D.Close>
            </div>
            <div className="flex items-center gap-1">
              <LanguageChip languages={cfg?.languages ?? []} value={language} onChange={s.setLanguage} />
              <VoiceMenu voices={cfg?.voices ?? []} value={voice} onChange={s.setVoice} />
              {live && s.startedAt && (
                <span className="ml-auto">
                  <Timer startedAt={s.startedAt} maxMin={s.limits?.maxSessionMin} />
                </span>
              )}
            </div>
          </header>

          <div className="sr-only" aria-live="polite">
            {phaseText}
          </div>
          <div className="sr-only" aria-live="polite">
            {sentence}
          </div>

          <div
            ref={logRef}
            role="log"
            aria-live="off"
            aria-label="Voice conversation"
            onScroll={onScroll}
            className="min-h-0 flex-1 space-y-4 overflow-y-auto px-3 py-3 scrollbar-thin"
          >
            {s.pendingAction && (
              <CarriedAction action={s.pendingAction} onConfirm={s.confirm} onReject={onReject} />
            )}
            {s.turns.map((turn) => (
              <Turn key={turn.id} turn={turn} onConfirm={onConfirm} onReject={onReject} />
            ))}
            {s.turns.length === 0 && (view === 'listening' || view === 'connecting') && (
              <div className="flex flex-col items-center gap-1 px-4 py-6 text-center">
                <Sparkles className="size-5 text-ai" aria-hidden />
                <p className="text-sm text-fg">
                  {view === 'connecting'
                    ? 'Connecting to SARA…'
                    : 'Ask about machines, work orders or plans.'}
                </p>
                <p className="text-xs text-muted">
                  Speak in English, Hindi or your own language. {SHORTCUT_LABEL} ends the session.
                </p>
              </div>
            )}
            {s.notice && <p className="text-center text-xs text-muted">{s.notice}</p>}
            {s.phase === 'ended' && (
              <StateBlock icon={PhoneOff} text={endedText(s.closedReason, s.limits?.idleSec)}>
                <Button size="sm" variant="primary" icon={AudioLines} onClick={() => retry(false)}>
                  Continue
                </Button>
                <ChatLink conversationId={s.conversationId} onNavigate={s.close} />
              </StateBlock>
            )}
            {s.phase === 'error' && (
              <StateBlock
                icon={s.error?.code === 'OFFLINE' ? WifiOff : CircleAlert}
                tone="critical"
                text={errorText(s.error)}
              >
                <Button size="sm" variant="primary" icon={RotateCcw} onClick={() => retry()}>
                  Retry
                </Button>
                {TYPING_INSTEAD.has(s.error?.code) && !s.textOnly && (
                  <Button size="sm" icon={Keyboard} onClick={() => retry(true)}>
                    Use typing instead
                  </Button>
                )}
              </StateBlock>
            )}
          </div>

          {live && s.error && (
            <p
              role="alert"
              className="flex items-center gap-1.5 border-t border-border px-3 py-1.5 text-xs text-critical"
            >
              <CircleAlert className="size-3.5 shrink-0" aria-hidden />
              {errorText(s.error)}
            </p>
          )}

          {(live || s.phase === 'connecting') && (
            <footer className="space-y-2 border-t border-border px-3 py-2.5">
              {s.mock && (
                <div className="flex flex-wrap items-center gap-2 rounded-lg bg-surface-2 px-2.5 py-1.5 text-xs text-muted">
                  <span className="min-w-0 flex-1">
                    Mock mode: SARA can't hear audio; type or use Say something.
                  </span>
                  <Menu
                    trigger={
                      <Button size="sm" variant="soft" className="h-7" disabled={!live}>
                        Say something
                      </Button>
                    }
                  >
                    {SAY_SOMETHING.map((line) => (
                      <MenuItem key={line} onSelect={() => s.sendText(line)}>
                        {line}
                      </MenuItem>
                    ))}
                  </Menu>
                </div>
              )}
              <div className="flex items-center gap-3">
                <button
                  ref={muteRef}
                  type="button"
                  onClick={() => s.setMuted(!s.muted)}
                  disabled={s.textOnly}
                  aria-pressed={s.muted}
                  aria-label={
                    s.textOnly
                      ? 'Microphone off (typing only)'
                      : s.muted
                        ? 'Unmute microphone'
                        : 'Mute microphone'
                  }
                  className="rounded-full p-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
                >
                  <Orb
                    phase={s.muted || s.textOnly ? 'idle' : view}
                    size="lg"
                    className={cn(s.muted && 'grayscale')}
                  />
                </button>
                <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                  <p className="text-xs text-muted">
                    {s.textOnly ? 'Typing only' : s.muted ? 'Microphone muted' : 'Microphone on'}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {view === 'speaking' && (
                      <Button size="sm" icon={CircleStop} onClick={stop}>
                        Stop
                      </Button>
                    )}
                    <Button size="sm" variant="danger" icon={PhoneOff} onClick={s.end}>
                      End
                    </Button>
                    <ChatLink conversationId={s.conversationId} />
                  </div>
                </div>
              </div>
              <form onSubmit={submit} className="flex gap-2">
                <Input
                  ref={inputRef}
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  maxLength={s.limits?.maxTextChars ?? 2000}
                  placeholder="Type instead…"
                  aria-label="Message SARA"
                />
                <Button
                  type="submit"
                  size="icon"
                  variant="ai"
                  aria-label="Send"
                  icon={Send}
                  disabled={!live || !text.trim()}
                />
              </form>
              <p className="text-[11px] text-subtle">
                Audio isn't stored; transcripts are saved to your chat history.
              </p>
            </footer>
          )}
        </D.Content>
      </D.Portal>
    </D.Root>
  );
};
