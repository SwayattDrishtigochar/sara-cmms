import { ArrowUp, Square } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '../ui/core.jsx';
import { TierSelect } from './TierSelect.jsx';

/**
 * Message box: Enter sends, Shift+Enter adds a line, Stop while an answer streams. Suggestion chips send
 * at once. `defaultValue` pre-fills it (re-key the composer to pre-fill again).
 */
export const Composer = ({
  onSend,
  onStop,
  streaming,
  tier,
  onTierChange,
  suggestions = [],
  defaultValue = '',
  autoFocus,
  placeholder = 'Ask SARA about machines, work orders, costs…',
}) => {
  const [text, setText] = useState(defaultValue);
  const ref = useRef(null);
  const id = useId();
  useEffect(() => {
    if (autoFocus || defaultValue) ref.current?.focus();
  }, [autoFocus, defaultValue]);

  const send = (value = text) => {
    const clean = value.trim();
    if (!clean || streaming) return;
    onSend(clean);
    setText('');
  };
  const onKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div className="space-y-2">
      {suggestions.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {suggestions.map((s) => (
            <button
              key={s}
              type="button"
              disabled={streaming}
              onClick={() => send(s)}
              className="rounded-full border border-border bg-surface px-3 py-1 text-xs text-muted transition-colors hover:border-brand/40 hover:text-fg disabled:opacity-50"
            >
              {s}
            </button>
          ))}
        </div>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
        className="rounded-2xl border border-border bg-surface shadow-card focus-within:border-brand/50 focus-within:ring-2 focus-within:ring-brand/15"
      >
        <label htmlFor={id} className="sr-only">
          Message SARA
        </label>
        <textarea
          id={id}
          ref={ref}
          rows={1}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          className="block max-h-48 min-h-11 w-full resize-none bg-transparent px-3.5 pt-3 pb-1 text-sm text-fg outline-none [field-sizing:content] placeholder:text-subtle"
        />
        <div className="flex items-center justify-between gap-2 px-2 pb-2">
          <TierSelect value={tier} onChange={onTierChange} />
          {streaming ? (
            <Button
              size="iconSm"
              variant="secondary"
              icon={Square}
              onClick={onStop}
              aria-label="Stop answering"
              title="Stop"
            />
          ) : (
            <Button
              type="submit"
              size="iconSm"
              variant="primary"
              icon={ArrowUp}
              disabled={!text.trim()}
              aria-label="Send message"
              title="Send (Enter)"
              className="rounded-full"
            />
          )}
        </div>
      </form>
    </div>
  );
};
