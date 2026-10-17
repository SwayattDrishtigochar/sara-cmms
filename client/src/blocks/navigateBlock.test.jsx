import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { goTo, useAssistant } from '../assistant/useAssistant.js';
import { applyEvent, clearStream, startStream } from '../store/streamStore.js';
import { _resetVoice, useVoice } from '../voice/useVoice.js';
import { BlockRenderer } from './BlockRenderer.jsx';

const navigate = vi.fn();
vi.mock('../routes.jsx', () => ({ router: { navigate: (...args) => navigate(...args) } }));
vi.mock('../voice/audio/mic.js', () => ({
  micSupport: vi.fn(() => ({ ok: true })),
  startMic: vi.fn(async () => ({ setMuted: vi.fn(), stop: vi.fn() })),
}));
vi.mock('../voice/audio/player.js', () => ({
  createPlayer: vi.fn(() => ({ enqueue: vi.fn(), stop: vi.fn(), speaking: false, level: () => 0 })),
  createBargeIn: () => () => false,
}));

class FakeSocket {
  static last = null;
  constructor() {
    this.readyState = 0;
    FakeSocket.last = this;
  }
  send() {}
  close() {
    this.readyState = 3;
    this.onclose?.({ code: 1000 });
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  emit(msg) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

const block = (id, payload) => ({ type: 'block', id, blockType: 'navigate', payload });
const flush = () => new Promise((r) => setTimeout(r, 0));
const initialVoice = useVoice.getState();

beforeEach(() => {
  navigate.mockClear();
  localStorage.setItem('token', 't');
  vi.stubGlobal('WebSocket', FakeSocket);
});
afterEach(() => {
  cleanup();
  clearStream('c1');
  _resetVoice();
  useVoice.setState(initialVoice, true);
  useAssistant.setState({ isOpen: false, context: null });
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('goTo', () => {
  it('navigates app-relative paths through the router and closes the drawer; refuses anything else', async () => {
    useAssistant.setState({ isOpen: true });
    expect(goTo('/m/workorders?priority=High')).toBe(true);
    await flush();
    expect(navigate).toHaveBeenCalledWith('/m/workorders?priority=High');
    expect(useAssistant.getState().isOpen).toBe(false);
    for (const bad of ['https://evil.example', '//evil.example', 'javascript:alert(1)', '', null]) {
      expect(goTo(bad)).toBe(false);
    }
    expect(navigate).toHaveBeenCalledTimes(1);
  });
});

describe('NavigateBlock', () => {
  it('shows the card with an Open button and navigates on click; history never auto-navigates', async () => {
    render(
      <BlockRenderer
        part={block('b1', { url: '/machines/abc', label: 'IMM 3', reason: 'You asked for IMM 3' })}
        messageId="m1"
      />,
    );
    expect(screen.getByText('IMM 3')).toBeTruthy();
    expect(screen.getByText('You asked for IMM 3')).toBeTruthy();
    await flush();
    expect(navigate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /open/i }));
    await flush();
    expect(navigate).toHaveBeenCalledWith('/machines/abc');
  });

  it('auto-navigates once while its message is streaming live', async () => {
    startStream('c1', { text: 'open high priority work orders' });
    applyEvent('c1', 'meta', { messageId: 'm2' });
    applyEvent('c1', 'block', {
      id: 'b2',
      type: 'navigate',
      payload: { url: '/m/workorders?priority=High' },
    });
    const part = block('b2', { url: '/m/workorders?priority=High', label: 'Work Orders · priority High' });
    const { rerender } = render(<BlockRenderer part={part} messageId="m2" />);
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/m/workorders?priority=High'));
    act(() => applyEvent('c1', 'done', { status: 'complete' }));
    rerender(<BlockRenderer part={part} messageId="m2" />);
    await flush();
    expect(navigate).toHaveBeenCalledTimes(1);
  });
});

describe('voice navigate message', () => {
  it('opens the page and docks the panel small; bad urls are ignored', async () => {
    await act(() => useVoice.getState().start({ textOnly: true }));
    const ws = FakeSocket.last;
    act(() => ws.open());
    act(() => ws.emit({ type: 'ready', sessionId: 's1', limits: { maxTextChars: 2000 } }));
    act(() => useVoice.getState().setWide(true));
    act(() =>
      ws.emit({ type: 'navigate', turnId: 't1', data: { url: '/planner?maintenance=x', label: 'Planner' } }),
    );
    await flush();
    expect(navigate).toHaveBeenCalledWith('/planner?maintenance=x');
    expect(useVoice.getState()).toMatchObject({ phase: 'live', open: true, wide: false });
    act(() => ws.emit({ type: 'navigate', turnId: 't1', data: { url: 'https://evil.example' } }));
    await flush();
    expect(navigate).toHaveBeenCalledTimes(1);
  });
});
