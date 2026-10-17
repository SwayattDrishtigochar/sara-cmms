import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '../ui/overlay.jsx';
import { micSupport, startMic } from './audio/mic.js';
import { createPlayer } from './audio/player.js';
import { Orb } from './Orb.jsx';
import { _resetVoice, phaseOf, RECONNECT_DELAYS_MS, reduceVoice, useVoice, voiceUrl } from './useVoice.js';
import { VoiceButton } from './VoiceButton.jsx';
import { SAY_SOMETHING, VoicePanel } from './VoicePanel.jsx';

vi.mock('./audio/mic.js', () => ({
  micSupport: vi.fn(() => ({ ok: true })),
  startMic: vi.fn(async () => ({ setMuted: vi.fn(), stop: vi.fn() })),
}));
vi.mock('./audio/player.js', () => ({
  createPlayer: vi.fn(() => ({ enqueue: vi.fn(), stop: vi.fn(), speaking: false, level: () => 0 })),
  createBargeIn: () => () => false,
}));

class FakeSocket {
  static all = [];
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    FakeSocket.all.push(this);
  }
  send(data) {
    this.sent.push(typeof data === 'string' ? JSON.parse(data) : data);
  }
  close(code = 1000) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code });
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  emit(msg) {
    this.onmessage?.({
      data: typeof msg === 'string' || msg instanceof ArrayBuffer ? msg : JSON.stringify(msg),
    });
  }
  static last = () => FakeSocket.all.at(-1);
}

class FakeAudioContext {
  resume = vi.fn(async () => {});
  close = vi.fn(async () => {});
}

const initial = useVoice.getState();
let config = {
  enabled: true,
  mock: true,
  voices: [],
  languages: [],
  defaults: { voice: 'Kore', language: 'auto' },
};
const reply = (status, data) => ({ ok: status < 400, status, json: async () => data });
const fetchMock = vi.fn(async (url) => {
  const path = String(url).replace(/^.*?\/api/, '');
  if (path === '/auth/me') {
    return reply(200, {
      user: { name: 'Vikram' },
      context: { company: { name: 'Acme', isPlatform: false }, user: { name: 'Vikram' } },
    });
  }
  if (path === '/voice/config') return reply(200, config);
  return reply(404, { error: { message: 'not here' } });
});

const setMatchMedia = (reduced) =>
  vi.stubGlobal('matchMedia', (q) => ({
    matches: reduced && q.includes('reduced-motion'),
    media: q,
    addEventListener() {},
    removeEventListener() {},
  }));

beforeEach(() => {
  localStorage.setItem('token', 'test-token');
  FakeSocket.all = [];
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal('AudioContext', FakeAudioContext);
  setMatchMedia(false);
  config = {
    enabled: true,
    mock: true,
    voices: [],
    languages: [],
    defaults: { voice: 'Kore', language: 'auto' },
  };
  micSupport.mockImplementation(() => ({ ok: true }));
  startMic.mockImplementation(async () => ({ setMuted: vi.fn(), stop: vi.fn() }));
});
afterEach(() => {
  cleanup();
  _resetVoice();
  useVoice.setState(initial, true);
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  localStorage.clear();
  window.history.pushState({}, '', '/');
});

const renderUi = (ui = <VoicePanel />) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <TooltipProvider>
        <MemoryRouter>{ui}</MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>,
  );

const READY = {
  type: 'ready',
  sessionId: 's1',
  conversationId: null,
  model: 'gemini-live',
  voice: 'Kore',
  language: 'auto',
  mock: false,
  inputRate: 16000,
  outputRate: 24000,
  limits: { maxSessionMin: 10, idleSec: 90, maxTextChars: 2000 },
  pendingAction: null,
};
const ACTION = {
  id: 'act1',
  tool: 'create_record',
  status: 'pending',
  expiresAt: new Date(Date.now() + 600_000).toISOString(),
  preview: { label: 'Create work order', action: 'create', items: [] },
  result: null,
};

/** Starts a session through the store and opens its socket. */
const startLive = async (ready = READY, opts = {}) => {
  await act(() => useVoice.getState().start(opts));
  const ws = FakeSocket.last();
  act(() => ws.open());
  act(() => ws.emit(ready));
  return ws;
};

// ── Reducer ────────────────────────────────────────────────────────────────────────────────────────────────

const fold = (messages, state = { ...initial, phase: 'connecting' }) =>
  messages.reduce((s, m, i) => reduceVoice(s, m, 1000 + i), state);

describe('reduceVoice', () => {
  it('folds a whole spoken turn', () => {
    const s = fold([
      READY,
      { type: 'turn_start', turnId: 't1', conversationId: 'c1', messageId: 'm1', user: null },
      { type: 'transcript', turnId: 't1', role: 'user', text: 'How many ', final: false },
      { type: 'transcript', turnId: 't1', role: 'user', text: 'machines?', final: true },
      {
        type: 'tool_call',
        turnId: 't1',
        data: { id: 'f1', name: 'mongo_count', args: { module: 'assets' } },
      },
      { type: 'tool_result', turnId: 't1', data: { id: 'f1', name: 'mongo_count', ok: true, summary: '20' } },
      { type: 'block', turnId: 't1', data: { id: 'b1', type: 'kpis', payload: { items: [] } } },
      { type: 'transcript', turnId: 't1', role: 'assistant', text: 'Twelve of ', final: false },
      { type: 'transcript', turnId: 't1', role: 'assistant', text: 'twenty.', final: false },
      { type: 'notice', turnId: 't1', data: { text: 'Used the fallback' } },
      {
        type: 'turn_complete',
        turnId: 't1',
        messageId: 'm1',
        conversationId: 'c1',
        status: 'complete',
        latencyMs: 900,
      },
      {
        type: 'usage',
        prompt: 10,
        thoughts: 0,
        candidates: 5,
        total: 15,
        audioSec: { in: 2, out: 3 },
        seconds: 9,
      },
    ]);
    expect(s).toMatchObject({ phase: 'live', sessionId: 's1', conversationId: 'c1', model: 'gemini-live' });
    expect(s.usage.total).toBe(15);
    const [t] = s.turns;
    expect(t.user).toEqual({ text: 'How many machines?', final: true });
    expect(t.assistant).toMatchObject({ id: 'm1', status: 'complete', latencyMs: 900 });
    expect(t.assistant.parts.map((p) => p.type)).toEqual([
      'tool_call',
      'tool_result',
      'block',
      'text',
      'notice',
    ]);
    expect(t.assistant.parts[3].text).toBe('Twelve of twenty.');
  });

  it('starts typed turns final, routes turnless notices and ignores unknown turns', () => {
    let s = fold([READY, { type: 'notice', turnId: null, data: { text: 'Reconnected' } }]);
    expect(s.notice).toBe('Reconnected');
    s = fold([{ type: 'turn_start', turnId: 't1', messageId: 'm1', user: 'Hi' }], s);
    expect(s.turns[0].user).toEqual({ text: 'Hi', final: true });
    s = fold([{ type: 'notice', turnId: null, data: { text: 'One minute left' } }], s);
    expect(s.turns[0].assistant.parts.at(-1)).toEqual({ type: 'notice', text: 'One minute left' });
    const same = reduceVoice(s, { type: 'transcript', turnId: 'nope', role: 'user', text: 'x' });
    expect(same).toBe(s);
    expect(reduceVoice(s, { type: 'whatever' })).toBe(s);
  });

  it('tracks a confirm card from pending to confirmed', () => {
    let s = fold([
      READY,
      { type: 'turn_start', turnId: 't1', messageId: 'm1', user: null },
      { type: 'confirm', turnId: 't1', action: ACTION },
      { type: 'turn_complete', turnId: 't1', messageId: 'm1', status: 'awaiting_confirmation' },
    ]);
    expect(s.turns[0].assistant).toMatchObject({
      status: 'awaiting_confirmation',
      pendingAction: { id: 'act1' },
    });
    s = fold(
      [{ type: 'confirm', turnId: null, action: { ...ACTION, status: 'confirmed', result: { ok: true } } }],
      s,
    );
    expect(s.turns[0].assistant).toMatchObject({
      status: 'complete',
      pendingAction: { status: 'confirmed' },
    });
    // A pending action carried over from an earlier session updates in place.
    const carried = fold([{ ...READY, pendingAction: ACTION }]);
    const next = reduceVoice(carried, {
      type: 'confirm',
      turnId: null,
      action: { ...ACTION, status: 'rejected' },
    });
    expect(next.pendingAction.status).toBe('rejected');
  });

  it('stops on interrupted, keeps errors and ends on closed', () => {
    let s = fold([READY, { type: 'turn_start', turnId: 't1', messageId: 'm1', user: null }]);
    s = reduceVoice(s, { type: 'interrupted', turnId: 't1' });
    expect(s.turns[0].assistant.status).toBe('stopped');
    s = reduceVoice(s, { type: 'error', code: 'ACTION_GONE', message: 'Expired', fatal: false });
    expect(s).toMatchObject({ phase: 'live', error: { code: 'ACTION_GONE' } });
    const quota = reduceVoice(s, { type: 'error', code: 'AI_QUOTA', message: 'Quota used up', fatal: true });
    expect(quota.phase).toBe('error');
    expect(reduceVoice(quota, { type: 'closed', reason: 'error' })).toMatchObject({
      phase: 'error',
      closedReason: 'error',
    });
    const open = fold([{ type: 'turn_start', turnId: 't2', messageId: 'm2', user: 'x' }], s);
    const closed = reduceVoice(open, { type: 'closed', reason: 'idle', conversationId: 'c9' });
    expect(closed).toMatchObject({ phase: 'ended', closedReason: 'idle', conversationId: 'c9' });
    expect(closed.turns.at(-1).assistant.status).toBe('complete');
  });

  it('derives the phase', () => {
    const live = fold([READY]);
    expect(phaseOf({ ...initial })).toBe('idle');
    expect(phaseOf(live)).toBe('listening');
    expect(phaseOf({ ...live, speaking: true })).toBe('speaking');
    const asked = fold([{ type: 'turn_start', turnId: 't1', messageId: 'm1', user: 'Hi' }], live);
    expect(phaseOf(asked)).toBe('thinking');
    const answering = reduceVoice(asked, {
      type: 'transcript',
      turnId: 't1',
      role: 'assistant',
      text: 'Hello',
    });
    expect(phaseOf(answering)).toBe('listening');
    // A spoken preamble, then a tool run: still thinking until SARA speaks again.
    const tooling = fold(
      [
        { type: 'tool_call', turnId: 't1', data: { id: 'f1', name: 'plan', args: {} } },
        { type: 'tool_result', turnId: 't1', data: { id: 'f1', name: 'plan', ok: true, summary: 'ok' } },
      ],
      answering,
    );
    expect(phaseOf(tooling)).toBe('thinking');
    const said = reduceVoice(tooling, { type: 'transcript', turnId: 't1', role: 'assistant', text: 'Done.' });
    expect(phaseOf(said)).toBe('listening');
    expect(phaseOf({ ...live, phase: 'ended' })).toBe('ended');
  });

  it('builds the socket URL from the page', () => {
    expect(voiceUrl()).toBe(`ws://${location.host}/api/voice`);
  });
});

// ── Panel ──────────────────────────────────────────────────────────────────────────────────────────────────

describe('VoicePanel', () => {
  it('starts with the token and page context, listens, and shows captions', async () => {
    window.history.pushState({}, '', '/machines/abc123');
    renderUi();
    const ws = await startLive();
    expect(ws.url).toMatch(/\/api\/voice$/);
    expect(ws.binaryType).toBe('arraybuffer');
    expect(ws.sent[0]).toEqual({
      type: 'start',
      token: 'test-token',
      context: { page: 'machine', recordRef: { module: 'assets', id: 'abc123' } },
    });
    expect(createPlayer).toHaveBeenCalled();
    expect(screen.getAllByText('Listening… ask anything').length).toBeGreaterThan(0);

    act(() => {
      ws.emit({ type: 'turn_start', turnId: 't1', conversationId: 'c1', messageId: 'm1', user: null });
      ws.emit({ type: 'transcript', turnId: 't1', role: 'user', text: 'How many machines', final: false });
    });
    const caption = screen.getByText('How many machines');
    expect(caption.className).toMatch(/italic/);
    act(() => {
      ws.emit({ type: 'transcript', turnId: 't1', role: 'user', text: ' are running?', final: true });
      ws.emit({ type: 'transcript', turnId: 't1', role: 'assistant', text: 'Twelve are running.' });
    });
    expect(screen.getByText('How many machines are running?').className).not.toMatch(/italic/);
    expect(screen.getByText('Twelve are running.')).toBeTruthy();
    act(() =>
      ws.emit({
        type: 'turn_complete',
        turnId: 't1',
        messageId: 'm1',
        conversationId: 'c1',
        status: 'complete',
      }),
    );
    expect(screen.getAllByText('Open in Chat')[0].closest('a').getAttribute('href')).toBe('/chat/c1');
  });

  it('wires the confirm card and the typed fallback to the socket', async () => {
    renderUi();
    const ws = await startLive();
    act(() => {
      ws.emit({ type: 'turn_start', turnId: 't1', messageId: 'm1', user: 'Create a work order' });
      ws.emit({
        type: 'block',
        turnId: 't1',
        data: {
          id: 'b1',
          type: 'confirm',
          payload: { ...ACTION.preview, actionId: 'act1', status: 'pending' },
        },
      });
      ws.emit({ type: 'confirm', turnId: 't1', action: ACTION });
      ws.emit({ type: 'turn_complete', turnId: 't1', messageId: 'm1', status: 'awaiting_confirmation' });
    });
    expect(screen.getByText('Say yes or tap Confirm')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(ws.sent).toContainEqual({ type: 'confirm', actionId: 'act1' });

    fireEvent.change(screen.getByLabelText('Message SARA'), {
      target: { value: 'How many open work orders?' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(ws.sent).toContainEqual({ type: 'text', text: 'How many open work orders?' });
    expect(screen.getByLabelText('Message SARA').value).toBe('');
  });

  it('keeps a turn’s blocks on the screen after it ends and through the next turn', async () => {
    renderUi();
    const ws = await startLive();
    act(() => {
      ws.emit({ type: 'turn_start', turnId: 't1', messageId: 'm1', user: 'Which assets need attention?' });
      ws.emit({ type: 'transcript', turnId: 't1', role: 'assistant', text: 'Two machines need attention.' });
      ws.emit({
        type: 'block',
        turnId: 't1',
        data: {
          id: 'b1',
          type: 'table',
          payload: {
            title: 'Machines needing attention',
            columns: [{ key: 'asset', label: 'Asset' }],
            rows: [{ asset: 'IMM 3' }, { asset: 'Press 2' }],
          },
        },
      });
      ws.emit({ type: 'turn_complete', turnId: 't1', messageId: 'm1', status: 'complete' });
    });
    expect(screen.getByText('Machines needing attention')).toBeTruthy();
    expect(screen.getByText('IMM 3')).toBeTruthy();
    act(() => {
      ws.emit({ type: 'turn_start', turnId: 't2', messageId: 'm2', user: 'Thanks' });
      ws.emit({ type: 'transcript', turnId: 't2', role: 'assistant', text: 'Welcome.' });
      ws.emit({ type: 'turn_complete', turnId: 't2', messageId: 'm2', status: 'complete' });
    });
    expect(screen.getAllByText('Welcome.').length).toBeGreaterThan(0);
    expect(screen.getByText('Machines needing attention')).toBeTruthy();
    expect(screen.getByText('Press 2')).toBeTruthy();
    expect(useVoice.getState().turns[0].assistant.parts.map((p) => p.type)).toEqual(['text', 'block']);
  });

  it('offers Say something in mock mode', async () => {
    renderUi();
    const ws = await startLive({ ...READY, mock: true });
    expect(screen.getByText(/Mock mode: SARA can't hear audio/)).toBeTruthy();
    fireEvent.keyDown(screen.getByRole('button', { name: 'Say something' }), { key: 'Enter' });
    fireEvent.click(await screen.findByRole('menuitem', { name: SAY_SOMETHING[0] }));
    expect(ws.sent).toContainEqual({ type: 'text', text: SAY_SOMETHING[0] });
  });

  it('mutes, stops SARA and ends', async () => {
    renderUi();
    const ws = await startLive();
    fireEvent.click(screen.getByRole('button', { name: 'Mute microphone' }));
    expect(ws.sent).toContainEqual({ type: 'mute', muted: true });
    expect(screen.getByRole('button', { name: 'Unmute microphone' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    act(() => useVoice.setState({ speaking: true }));
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(ws.sent).toContainEqual({ type: 'interrupt' });
    fireEvent.click(screen.getByRole('button', { name: 'End' }));
    expect(ws.sent).toContainEqual({ type: 'end' });
    act(() => ws.emit({ type: 'closed', reason: 'ended', conversationId: 'c1' }));
    expect(screen.getByText('Voice session ended.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeTruthy();
  });

  it('plays the next answer after Stop during the tail of a finished turn', async () => {
    renderUi();
    const ws = await startLive();
    const player = createPlayer.mock.results.at(-1).value;
    const chunk = new ArrayBuffer(8);
    act(() => {
      ws.emit({ type: 'turn_start', turnId: 't1', messageId: 'm1', user: 'How many machines?' });
      ws.emit({ type: 'turn_complete', turnId: 't1', messageId: 'm1', status: 'complete' });
    });
    act(() => useVoice.getState().interrupt()); // the tail is still playing; the server sends nothing back
    act(() => {
      ws.emit({ type: 'turn_start', turnId: 't2', messageId: 'm2', user: 'How many open work orders?' });
      ws.emit(chunk);
    });
    expect(player.enqueue).toHaveBeenCalledWith(chunk);
    // Stop while a turn is still open drops its remaining audio.
    player.enqueue.mockClear();
    act(() => useVoice.getState().interrupt());
    act(() => ws.emit(new ArrayBuffer(4)));
    expect(player.enqueue).not.toHaveBeenCalled();
  });

  it('keeps the caption log where the user scrolled', async () => {
    renderUi();
    const ws = await startLive();
    const log = within(screen.getByTestId('voice-panel')).getByRole('log');
    Object.defineProperty(log, 'scrollHeight', { configurable: true, get: () => 1000 });
    Object.defineProperty(log, 'clientHeight', { configurable: true, get: () => 300 });
    Object.defineProperty(log, 'scrollTop', { configurable: true, writable: true, value: 0 });
    act(() => ws.emit({ type: 'turn_start', turnId: 't1', messageId: 'm1', user: 'Plan 5000 Housing-A' }));
    expect(log.scrollTop).toBe(1000);
    log.scrollTop = 0;
    fireEvent.scroll(log);
    act(() => ws.emit({ type: 'transcript', turnId: 't1', role: 'assistant', text: 'Here is the plan.' }));
    expect(log.scrollTop).toBe(0);
    // A new turn follows the conversation again.
    act(() => ws.emit({ type: 'turn_start', turnId: 't2', messageId: 'm2', user: 'Yes' }));
    expect(log.scrollTop).toBe(1000);
  });

  it('ends on Escape only when focus is in the panel', async () => {
    const outside = document.createElement('select');
    document.body.append(outside);
    try {
      renderUi();
      await startLive();
      outside.focus();
      fireEvent.keyDown(outside, { key: 'Escape' });
      expect(useVoice.getState()).toMatchObject({ open: true, phase: 'live' });
      const input = screen.getByLabelText('Message SARA');
      input.focus();
      fireEvent.keyDown(input, { key: 'Escape' });
      expect(useVoice.getState().open).toBe(false);
    } finally {
      outside.remove();
    }
  });

  it('keeps keyboard focus in the panel after Stop, End and a reconnect', async () => {
    renderUi();
    await startLive();
    act(() => useVoice.setState({ speaking: true }));
    const stop = screen.getByRole('button', { name: 'Stop' });
    stop.focus();
    fireEvent.click(stop);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Mute microphone' }));
    // A language change reconnects without disabling the typed input.
    const input = screen.getByLabelText('Message SARA');
    input.focus();
    act(() => useVoice.getState().setLanguage('hi'));
    expect(useVoice.getState().phase).toBe('connecting');
    expect(input.disabled).toBe(false);
    expect(document.activeElement).toBe(input);
    const next = FakeSocket.last();
    act(() => next.open());
    act(() => next.emit(READY));
    screen.getByRole('button', { name: 'End' }).focus();
    fireEvent.click(screen.getByRole('button', { name: 'End' }));
    act(() => next.emit({ type: 'closed', reason: 'ended', conversationId: 'c1' }));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Continue' }));
  });

  it('explains the ended reasons', async () => {
    renderUi();
    const ws = await startLive();
    act(() => ws.emit({ type: 'closed', reason: 'idle', conversationId: 'c1' }));
    expect(screen.getByText('Ended after 90 s of silence.')).toBeTruthy();
  });

  it('falls back to typing when the mic is blocked', async () => {
    startMic.mockImplementation(async () => {
      throw Object.assign(new Error('blocked'), { code: 'MIC_DENIED' });
    });
    renderUi();
    await act(() => useVoice.getState().start());
    expect(screen.getByText(/Microphone blocked: allow it in the site settings/)).toBeTruthy();
    expect(FakeSocket.all).toHaveLength(0);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Use typing instead' })));
    expect(startMic).toHaveBeenCalledTimes(1);
    const ws = FakeSocket.last();
    act(() => ws.open());
    expect(ws.sent[0].type).toBe('start');
    act(() => ws.emit(READY));
    expect(useVoice.getState().textOnly).toBe(true);
    expect(screen.getAllByText('Type to SARA').length).toBeGreaterThan(0);
  });

  it.each([
    ['insecure', 'Voice needs HTTPS or localhost.'],
    ['no-worklet', "This browser can't stream audio. Try a recent Chrome, Edge, Safari or Firefox."],
  ])('explains an unsupported browser (%s)', async (reason, text) => {
    micSupport.mockImplementation(() => ({ ok: false, reason }));
    renderUi();
    await act(() => useVoice.getState().start());
    expect(screen.getByText(text)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  it('says when the browser is offline', async () => {
    const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    renderUi();
    await act(() => useVoice.getState().start());
    expect(screen.getByText(/You're offline/)).toBeTruthy();
    onLine.mockRestore();
  });

  it('reconnects with backoff after an abnormal close, then explains', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      renderUi();
      const ws = await startLive();
      act(() => vi.advanceTimersByTime(4000));
      act(() => ws.close(1006));
      expect(useVoice.getState()).toMatchObject({ phase: 'connecting', notice: 'Reconnecting…' });
      // The API is still restarting: each attempt fails before the handshake, the next waits longer.
      for (const [n, delay] of RECONNECT_DELAYS_MS.entries()) {
        act(() => vi.advanceTimersByTime(delay));
        expect(FakeSocket.all).toHaveLength(n + 2);
        if (n < RECONNECT_DELAYS_MS.length - 1) {
          act(() => FakeSocket.last().close(1006));
          expect(useVoice.getState().phase).toBe('connecting');
        }
      }
      // The last attempt gets through on the same conversation.
      const back = FakeSocket.last();
      act(() => back.open());
      act(() => back.emit(READY));
      expect(useVoice.getState().phase).toBe('live');
      // A later drop starts over; when every attempt fails the panel says what happened.
      act(() => vi.advanceTimersByTime(4000));
      act(() => back.close(1006));
      for (const delay of RECONNECT_DELAYS_MS) {
        act(() => vi.advanceTimersByTime(delay));
        act(() => FakeSocket.last().close(1006));
      }
      expect(useVoice.getState()).toMatchObject({ phase: 'error', error: { code: 'CONNECTION_LOST' } });
      expect(screen.getByText(/Retry to pick up the same conversation/)).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('explains a frame the server refused as too large', async () => {
    renderUi();
    const ws = await startLive();
    act(() => ws.close(1009));
    expect(screen.getByText(/too large for the voice connection/)).toBeTruthy();
  });

  it('offers no typing fallback when the browser has no WebSocket', async () => {
    micSupport.mockImplementation(() => ({ ok: false, reason: 'no-websocket' }));
    renderUi();
    await act(() => useVoice.getState().start());
    expect(screen.getByText(/can't open a live connection to SARA/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Use typing instead' })).toBeNull();
  });

  it('keeps the chat bubbles quiet for screen readers and lets Tab leave the panel', async () => {
    const trigger = document.createElement('button');
    trigger.setAttribute('aria-keyshortcuts', 'Control+Shift+Space');
    const header = document.createElement('header');
    header.append(trigger);
    document.body.append(header);
    try {
      renderUi();
      const ws = await startLive();
      act(() => {
        ws.emit({ type: 'turn_start', turnId: 't1', messageId: 'm1', user: 'Hi' });
        ws.emit({ type: 'transcript', turnId: 't1', role: 'assistant', text: 'Hello. All good.' });
        ws.emit({ type: 'turn_complete', turnId: 't1', messageId: 'm1', status: 'complete' });
      });
      const panel = screen.getByTestId('voice-panel');
      const log = within(panel).getByRole('log');
      expect(log.querySelectorAll('[aria-live="polite"]')).toHaveLength(0);
      const announced = [...panel.querySelectorAll('[aria-live="polite"]')].map((e) => e.textContent);
      expect(announced).toContain('All good.');
      // Tab from the last control (and Shift+Tab from the first) returns to the page instead of looping.
      const send = within(panel).getByRole('button', { name: 'Send' });
      send.disabled = false;
      send.focus();
      fireEvent.keyDown(send, { key: 'Tab' });
      expect(document.activeElement).toBe(trigger);
      const first = within(panel).getByRole('button', { name: /Widen panel/ });
      first.focus();
      fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });
      expect(document.activeElement).toBe(trigger);
    } finally {
      header.remove();
    }
  });

  it('toggles with Ctrl+Shift+Space', async () => {
    renderUi();
    await act(async () =>
      fireEvent.keyDown(window, { code: 'Space', key: ' ', ctrlKey: true, shiftKey: true }),
    );
    expect(useVoice.getState().open).toBe(true);
    const ws = FakeSocket.last();
    act(() => ws.open());
    act(() => ws.emit(READY));
    await act(async () =>
      fireEvent.keyDown(window, { code: 'Space', key: ' ', ctrlKey: true, shiftKey: true }),
    );
    expect(ws.sent).toContainEqual({ type: 'end' });
  });

  it('lays out as a bottom sheet on phones', async () => {
    window.innerWidth = 360;
    renderUi();
    await startLive();
    const panel = screen.getByTestId('voice-panel');
    expect(panel.className).toMatch(/inset-x-0/);
    expect(panel.className).toMatch(/max-h-\[70dvh\]/);
    const footer = within(panel).getByRole('button', { name: 'End' }).closest('footer');
    expect(within(footer).getByLabelText('Message SARA')).toBeTruthy();
    expect(within(panel).getByText(/Audio isn't stored/)).toBeTruthy();
  });
});

describe('Orb and VoiceButton', () => {
  it('skips rAF scaling with reduced motion', () => {
    const raf = vi.fn(() => 1);
    vi.stubGlobal('requestAnimationFrame', raf);
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    setMatchMedia(true);
    const { container, unmount } = render(<Orb phase="listening" size="lg" />);
    expect(raf).not.toHaveBeenCalled();
    expect(container.firstChild.dataset.motion).toBe('reduced');
    expect(container.firstChild.className).not.toMatch(/scale-/);
    unmount();
    setMatchMedia(false);
    render(<Orb phase="listening" size="lg" />);
    expect(raf).toHaveBeenCalled();
  });

  it('hides the button when voice is off and toggles a session when on', async () => {
    config = { ...config, enabled: false };
    const off = renderUi(<VoiceButton />);
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(expect.stringMatching(/voice\/config/), expect.anything()),
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole('button', { name: 'Talk to SARA' })).toBeNull();
    off.unmount();
    config = { ...config, enabled: true };
    renderUi(<VoiceButton />);
    const button = await screen.findByRole('button', { name: 'Talk to SARA' });
    expect(button.getAttribute('aria-keyshortcuts')).toMatch(/Shift\+Space/);
    await act(async () => fireEvent.click(button));
    expect(useVoice.getState().phase).toBe('connecting');
  });
});
