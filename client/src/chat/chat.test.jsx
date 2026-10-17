import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { useState } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { contextFromPath, useAssistant } from '../assistant/useAssistant.js';
import { BlockRenderer, blockOf } from '../blocks/BlockRenderer.jsx';
import { pieSlices } from '../blocks/ChartBlock.jsx';
import { mergeStream, newMessage, reduceEvent, useStreamStore } from '../store/streamStore.js';
import { TooltipProvider } from '../ui/overlay.jsx';
import { Composer } from './Composer.jsx';
import { ConfirmCard, countdownText } from './ConfirmCard.jsx';
import { groupByDate } from './ConversationList.jsx';
import { examplePrompts } from './EmptyThread.jsx';
import { segmentsOf } from './MessageBubble.jsx';
import { resultText, ToolTrace, toolLabel } from './ToolTrace.jsx';
import { useChatActions } from './useChat.js';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const wrap = (ui) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <MemoryRouter>{ui}</MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>,
  );
};

const fold = (events, at = 1000) =>
  events.reduce((s, [type, data], i) => reduceEvent(s, type, data, at + i), {
    user: null,
    message: newMessage(null, at),
    title: null,
  });

describe('stream reducer', () => {
  it('folds an SSE turn into message parts', () => {
    const s = fold([
      [
        'meta',
        { messageId: 'm1', tier: 'balanced', model: 'gemini-x', routerDecision: { intent: 'lookup' } },
      ],
      ['thought', { text: 'Looking ' }],
      ['thought', { text: 'up orders' }],
      ['tool_call', { id: 'c1', name: 'mongo_find', args: { module: 'workorders' } }],
      [
        'tool_result',
        { id: 'c1', name: 'mongo_find', ok: true, summary: '23 work orders', rowCount: 23, ms: 120 },
      ],
      ['block', { id: 'b1', type: 'table', payload: { title: 'Open', rows: [] } }],
      ['delta', { text: 'There are ' }],
      ['delta', { text: '23 open.' }],
      ['notice', { text: 'Used a fallback model' }],
      ['usage', { total: 900 }],
      ['title', { title: 'Open work orders' }],
      ['done', { messageId: 'm1', status: 'complete' }],
    ]);
    const m = s.message;
    expect(m).toMatchObject({
      id: 'm1',
      tier: 'balanced',
      model: 'gemini-x',
      status: 'complete',
      usage: { total: 900 },
    });
    expect(s.title).toBe('Open work orders');
    expect(m.parts.map((p) => p.type)).toEqual([
      'thought',
      'tool_call',
      'tool_result',
      'block',
      'text',
      'notice',
    ]);
    expect(m.parts[0].text).toBe('Looking up orders');
    expect(m.parts[3]).toMatchObject({ id: 'b1', blockType: 'table' });
    expect(m.parts[4].text).toBe('There are 23 open.');
    expect(m.endedAt).toBeGreaterThan(m.startedAt);
  });

  it('marks errors and ignores unknown events', () => {
    const s = fold([
      ['ping', {}],
      ['error', { code: 'RATE_LIMITED', message: 'Busy' }],
    ]);
    expect(s.message.status).toBe('error');
    expect(s.message.error).toEqual({ code: 'RATE_LIMITED', message: 'Busy' });
  });

  it('a confirm continuation keeps the saved parts and shows the action as confirmed', () => {
    const seed = {
      id: 'm1',
      parts: [{ type: 'text', text: 'Ok.' }],
      pendingAction: { id: 'a1', status: 'pending' },
    };
    const s = reduceEvent({ user: null, message: newMessage(seed), title: null }, 'delta', { text: ' Done' });
    expect(s.message.parts).toEqual([{ type: 'text', text: 'Ok. Done' }]);
    expect(s.message.pendingAction.status).toBe('confirmed');
  });

  it('merges the live turn into saved messages without duplicates', () => {
    const saved = [{ id: 'u1', role: 'user', text: 'hi' }];
    const live = { user: { role: 'user', text: 'hi' }, message: { id: 'm2', role: 'assistant', parts: [] } };
    expect(mergeStream(saved, live)).toHaveLength(2);
    expect(mergeStream([...saved, { id: 'm2', role: 'assistant', parts: [{}] }], live)[1]).toBe(live.message);
    // A turn that failed before `meta`: the saved twin is replaced by the live message with its error.
    const failed = { user: live.user, message: { id: null, role: 'assistant', status: 'error', parts: [] } };
    const merged = mergeStream([...saved, { id: 'm3', role: 'assistant', parts: [] }], failed);
    expect(merged.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(merged[1]).toBe(failed.message);
  });
});

describe('message segments', () => {
  it('groups adjacent tool calls with their results and joins thoughts', () => {
    const { thoughts, segments } = segmentsOf([
      { type: 'thought', text: 'a' },
      { type: 'tool_call', id: 'c1', name: 'resolve', args: { kind: 'asset', query: 'Press 1' } },
      { type: 'tool_call', id: 'c2', name: 'mongo_count', args: { module: 'workorders' } },
      { type: 'tool_result', id: 'c1', ok: true, summary: '1 match' },
      { type: 'thought', text: 'b' },
      { type: 'text', text: 'Hello' },
      { type: 'block', id: 'b1', blockType: 'kpis', payload: {} },
    ]);
    expect(thoughts).toBe('a\n\nb');
    expect(segments.map((s) => s.type)).toEqual(['tools', 'text', 'block']);
    expect(segments[0].steps).toHaveLength(2);
    expect(segments[0].steps[0].result.summary).toBe('1 match');
    expect(segments[0].steps[1].result).toBeUndefined();
  });

  it('keeps every tool call of a turn in one trace, even with blocks in between', () => {
    const { segments } = segmentsOf([
      { type: 'tool_call', id: 'c1', name: 'work_orders_summary', args: {} },
      { type: 'tool_result', id: 'c1', ok: true, summary: '3 groups' },
      { type: 'tool_call', id: 'c2', name: 'render_kpis', args: {} },
      { type: 'tool_result', id: 'c2', ok: true },
      { type: 'block', id: 'b1', blockType: 'kpis', payload: {} },
      { type: 'tool_call', id: 'c3', name: 'render_chart', args: {} },
      { type: 'tool_result', id: 'c3', ok: true },
      { type: 'block', id: 'b2', blockType: 'chart', payload: {} },
      { type: 'text', text: 'Done' },
    ]);
    expect(segments.map((s) => s.type)).toEqual(['tools', 'block', 'block', 'text']);
    expect(segments[0].steps.map((s) => s.call.id)).toEqual(['c1', 'c2', 'c3']);
  });

  it('shows a write that waits for Confirm as waiting, not running', () => {
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { enabled: false } } })}>
        <ToolTrace
          steps={[{ call: { id: 'w1', name: 'create_record', args: { module: 'workorders' } } }]}
          awaiting
        />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: /Used 1 tool/ }));
    expect(screen.getByLabelText('Waiting for your confirmation')).toBeTruthy();
    expect(screen.queryByLabelText('Running')).toBeNull();
    expect(screen.getByText('Create workorders')).toBeTruthy();
  });

  it('builds example prompts from real machine names', () => {
    const prompts = examplePrompts([
      { name: 'Press 1', typeOfAsset: 'Power Press' },
      { name: 'IMM 7', typeOfAsset: 'Injection Moulding Machine' },
      { name: 'Compressor 2', typeOfAsset: 'Air Compressor' },
    ]);
    expect(prompts.map((p) => p.text).join(' | ')).toMatch(
      /IMM 7 vibration.*IMM 7: coolant leak.*Compressor 2 today/,
    );
    expect(examplePrompts([]).length).toBe(6);
  });

  it('labels tool steps for people', () => {
    expect(toolLabel('mongo_find', { module: 'workorders' }, () => 'Work Orders')).toBe(
      'Queried work orders',
    );
    expect(toolLabel('resolve', { kind: 'asset', query: 'Press 1' })).toBe('Looked up asset "Press 1"');
    expect(resultText({ summary: 'Found', rowCount: 23, ms: 120 })).toBe('Found · 23 rows · 120 ms');
    expect(resultText({ summary: '23 work orders', rowCount: 23 })).toBe('23 work orders');
  });
});

describe('ConfirmCard', () => {
  it('formats the countdown', () => {
    expect(countdownText('2026-10-16T10:10:00Z', Date.parse('2026-10-16T10:00:55Z'))).toBe('9:05');
    expect(countdownText('2026-10-16T10:00:00Z', Date.parse('2026-10-16T10:00:01Z'))).toBeNull();
  });

  it('counts down, confirms, and turns into expired at zero', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(Date.parse('2026-10-16T10:00:00Z'));
    const onConfirm = vi.fn();
    const payload = {
      action: 'status',
      label: 'Mark WO-42 as Completed',
      moduleLabel: 'Work Orders',
      workOrder: { code: 'WO-42', name: 'Fix leak' },
      from: 'In Progress',
      to: 'Completed',
    };
    wrap(
      <ConfirmCard
        payload={payload}
        action={{ id: 'a1', status: 'pending', expiresAt: '2026-10-16T10:00:03Z' }}
        onConfirm={onConfirm}
      />,
    );
    expect(screen.getByText('0:03')).toBeTruthy();
    expect(screen.getByText('In Progress')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /confirm/i }));
    expect(onConfirm).toHaveBeenCalledWith('a1');
    await act(async () => {
      vi.advanceTimersByTime(4000);
    });
    expect(screen.getByText(/Expired/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /confirm/i })).toBeNull();
  });

  it('shows the before/after diff of an update', () => {
    wrap(
      <ConfirmCard
        payload={{
          action: 'update',
          module: 'spareparts',
          items: [{ id: 's1', label: 'Seal kit', changes: [{ field: 'minimumQuantity', from: 5, to: 10 }] }],
        }}
        action={{ id: 'a1', status: 'confirmed' }}
      />,
    );
    expect(screen.getByText('Seal kit')).toBeTruthy();
    expect(screen.getByText('Minimum quantity')).toBeTruthy();
    expect(screen.getByText('5')).toBeTruthy();
    expect(screen.getByText('10')).toBeTruthy();
    expect(screen.getByText('Confirmed')).toBeTruthy();
  });
});

describe('Composer', () => {
  const setup = (props = {}) => {
    const onSend = vi.fn();
    const onStop = vi.fn();
    wrap(<Composer onSend={onSend} onStop={onStop} tier="auto" {...props} />);
    return { onSend, onStop, box: screen.getByLabelText('Message SARA') };
  };

  it('Enter sends, Shift+Enter does not', () => {
    const { onSend, box } = setup();
    fireEvent.change(box, { target: { value: 'Open work orders' } });
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith('Open work orders');
    expect(box.value).toBe('');
  });

  it('does not send blank text, and shows Stop while streaming', () => {
    const { onSend, onStop, box } = setup({ streaming: true });
    fireEvent.change(box, { target: { value: 'hi' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Stop answering' }));
    expect(onStop).toHaveBeenCalledOnce();
  });

  it('sends a suggestion chip', () => {
    const { onSend } = setup({ suggestions: ['Energy use yesterday'] });
    fireEvent.click(screen.getByRole('button', { name: 'Energy use yesterday' }));
    expect(onSend).toHaveBeenCalledWith('Energy use yesterday');
  });
});

describe('BlockRenderer', () => {
  it('renders tables and KPI tiles', () => {
    wrap(
      <>
        <BlockRenderer
          part={{
            type: 'block',
            id: 'b1',
            blockType: 'table',
            payload: { title: 'Orders', rows: [{ code: 'WO-1', hours: 2 }] },
          }}
        />
        <BlockRenderer
          part={{ type: 'block', blockType: 'kpis', payload: { items: [{ label: 'Open', value: 23 }] } }}
        />
      </>,
    );
    expect(screen.getByText('Orders')).toBeTruthy();
    expect(screen.getByText('WO-1')).toBeTruthy();
    expect(screen.getByText('23')).toBeTruthy();
  });

  it('shows unknown block types as JSON', () => {
    wrap(
      <BlockRenderer part={{ type: 'block', blockType: 'gizmo', payload: { title: 'Plan A', jobs: 3 } }} />,
    );
    expect(screen.getByText('Plan A')).toBeTruthy();
    expect(screen.getByText(/"jobs": 3/)).toBeTruthy();
  });

  it('falls back to JSON when a payload breaks its renderer', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    wrap(<BlockRenderer part={{ type: 'block', blockType: 'kpis', payload: { items: 'oops' } }} />);
    expect(screen.getByText(/couldn't be drawn/)).toBeTruthy();
    console.error.mockRestore();
  });

  it('reads nested block parts and folds pie slices past six', () => {
    expect(blockOf({ block: { id: 'x', type: 'chart', payload: { a: 1 } } })).toEqual({
      id: 'x',
      type: 'chart',
      payload: { a: 1 },
    });
    const data = Array.from({ length: 8 }, (_, i) => ({ k: `s${i}`, v: 8 - i }));
    const slices = pieSlices(data, 'k', 'v');
    expect(slices).toHaveLength(6);
    expect(slices[5]).toEqual({ name: 'Other', value: 3 + 2 + 1 });
  });
});

describe('assistant and list helpers', () => {
  it('derives chat context from the route', () => {
    expect(contextFromPath('/machines/abc')).toEqual({
      page: 'machine',
      recordRef: { module: 'assets', id: 'abc' },
    });
    expect(contextFromPath('/m/workorders/w1')).toEqual({
      page: 'record',
      recordRef: { module: 'workorders', id: 'w1' },
    });
    expect(contextFromPath('/m/workorders')).toEqual({ page: 'workorders list' });
  });

  it('open({ send }) queues the text instead of pre-filling it', () => {
    useAssistant.getState().open({ text: 'Build a KPI', send: true });
    expect(useAssistant.getState()).toMatchObject({ isOpen: true, text: '', pendingSend: 'Build a KPI' });
    useAssistant.getState().open({ text: 'Draft' });
    expect(useAssistant.getState()).toMatchObject({ text: 'Draft', pendingSend: null });
    useAssistant.getState().close();
    expect(useAssistant.getState().isOpen).toBe(false);
  });

  it('groups conversations by day', () => {
    const now = Date.parse('2026-10-16T12:00:00Z');
    const day = 86_400_000;
    const groups = groupByDate(
      [
        { id: 1, lastMessageAt: new Date(now - 1000).toISOString() },
        { id: 2, lastMessageAt: new Date(now - day).toISOString() },
        { id: 3, lastMessageAt: new Date(now - 3 * day).toISOString() },
        { id: 4, lastMessageAt: new Date(now - 60 * day).toISOString() },
      ],
      now,
    );
    expect(groups.map((g) => g.label)).toEqual(['Today', 'Yesterday', 'Previous 7 days', 'Older']);
  });
});

describe('Thread end to end', () => {
  it('sends, streams the SSE answer into the thread, and reports the new conversation', async () => {
    const sse = [
      ['meta', { conversationId: 'c1', messageId: 'm1', tier: 'fast', model: 'gemini-x' }],
      ['tool_call', { id: 't1', name: 'mongo_count', args: { module: 'workorders' } }],
      [
        'tool_result',
        { id: 't1', name: 'mongo_count', ok: true, summary: '23 work orders', rowCount: 23, ms: 40 },
      ],
      ['delta', { text: 'There are **23** open work orders.' }],
      ['done', { messageId: 'm1', status: 'complete' }],
    ]
      .map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`)
      .join('');
    const saved = {
      conversation: { id: 'c1', title: 'Open orders' },
      messages: [
        { id: 'u1', role: 'user', text: 'How many open work orders?' },
        {
          id: 'm1',
          role: 'assistant',
          status: 'complete',
          parts: [{ type: 'text', text: 'There are 23 open work orders.' }],
        },
      ],
    };
    const json = (body) =>
      new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    const fetchMock = vi.fn(async (url, init = {}) => {
      if (url.endsWith('/conversations') && init.method === 'POST')
        return json({ conversation: { id: 'c1' } });
      if (url.endsWith('/conversations/c1/messages')) {
        const body = new ReadableStream({
          start: (c) => {
            c.enqueue(new TextEncoder().encode(sse));
            c.close();
          },
        });
        return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
      }
      if (url.endsWith('/conversations/c1')) return json(saved);
      return json({ items: [] });
    });
    vi.stubGlobal('fetch', fetchMock);
    const { Thread } = await import('./Thread.jsx');
    const onCreated = vi.fn();
    const Host = () => {
      const [id, setId] = useState();
      return (
        <Thread
          conversationId={id}
          onCreated={(x) => {
            onCreated(x);
            setId(x);
          }}
        />
      );
    };
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <TooltipProvider>
          <MemoryRouter>
            <Host />
          </MemoryRouter>
        </TooltipProvider>
      </QueryClientProvider>,
    );
    const box = screen.getByLabelText('Message SARA');
    fireEvent.change(box, { target: { value: 'How many open work orders?' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await vi.waitFor(() => expect(onCreated).toHaveBeenCalledWith('c1'));
    const body = JSON.parse(fetchMock.mock.calls.find(([u]) => u.endsWith('/messages'))[1].body);
    expect(body).toEqual({ text: 'How many open work orders?' });
    expect(await screen.findByText(/open work orders\./)).toBeTruthy();
    expect(screen.getAllByText('How many open work orders?')).toHaveLength(1);
    // A complete turn hands over to the refetched message.
    await vi.waitFor(() => expect(useStreamStore.getState().streams.c1).toBeUndefined());
    vi.unstubAllGlobals();
  });
});

describe('stop', () => {
  it('asks the server to stop and lets it end the stream, without cutting the connection', async () => {
    let push;
    let signal;
    const enc = new TextEncoder();
    const frame = (e, d) =>
      enc.encode(`event: ${e}
data: ${JSON.stringify(d)}

`);
    const json = (body) =>
      new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    const fetchMock = vi.fn(async (url, init = {}) => {
      if (url.endsWith('/conversations/c9/messages')) {
        signal = init.signal;
        const body = new ReadableStream({
          start: (c) => {
            push = c;
            c.enqueue(frame('meta', { conversationId: 'c9', messageId: 'm9', tier: 'fast' }));
            c.enqueue(frame('delta', { text: 'Section 1.' }));
          },
        });
        return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
      }
      if (url.endsWith('/messages/m9/stop')) {
        // The server stops the turn, saves it and finishes the stream itself.
        setTimeout(() => {
          push.enqueue(frame('done', { messageId: 'm9', status: 'stopped' }));
          push.close();
        }, 10);
        return json({ ok: true });
      }
      if (url.endsWith('/conversations/c9')) return json({ conversation: { id: 'c9' }, messages: [] });
      return json({ items: [] });
    });
    vi.stubGlobal('fetch', fetchMock);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useChatActions(), {
      wrapper: ({ children }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>,
    });
    await act(() => result.current.send({ conversationId: 'c9', text: 'Long report' }));
    await vi.waitFor(() => expect(useStreamStore.getState().streams.c9?.message.id).toBe('m9'));
    let stopped;
    useStreamStore.subscribe((st) => {
      if (st.streams.c9?.message.status === 'stopped') stopped = st.streams.c9.message;
    });
    act(() => result.current.stop('c9'));
    await vi.waitFor(() => expect(stopped).toBeTruthy());
    expect(
      fetchMock.mock.calls.some(([u, i]) => u.endsWith('/messages/m9/stop') && i.method === 'POST'),
    ).toBe(true);
    expect(signal.aborted).toBe(false);
    expect(stopped.parts).toEqual([{ type: 'text', text: 'Section 1.' }]);
    vi.unstubAllGlobals();
  });
});

describe('pages mount', () => {
  const qc = () => new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false } } });
  const mount = (ui, path = '/') =>
    render(
      <QueryClientProvider client={qc()}>
        <TooltipProvider>
          <MemoryRouter initialEntries={[path]}>{ui}</MemoryRouter>
        </TooltipProvider>
      </QueryClientProvider>,
    );

  it('renders the chat page for a new chat', async () => {
    const { ChatPage } = await import('./ChatPage.jsx');
    mount(<ChatPage />, '/chat');
    expect(screen.getAllByRole('button', { name: /new chat/i }).length).toBeGreaterThan(0);
    // A new chat greets the user and offers example prompts with this plant's machine names.
    expect(screen.getByRole('list', { name: 'Example questions' })).toBeTruthy();
    expect(screen.getByText(/^Good (morning|afternoon|evening)/)).toBeTruthy();
  });

  it('opens the assistant drawer with Ctrl+J and pre-fills from open()', async () => {
    const { AssistantDrawer } = await import('../assistant/AssistantDrawer.jsx');
    mount(<AssistantDrawer />, '/machines/abc');
    act(() => {
      fireEvent.keyDown(window, { key: 'j', ctrlKey: true });
    });
    // The page context shows as a chip that can be dropped.
    expect(screen.getByText('This record · Machine')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Ask without this context' }));
    expect(screen.getByText(/No page context/)).toBeTruthy();
    act(() => useAssistant.getState().open({ text: 'Build a KPI for OEE' }));
    expect(screen.getByLabelText('Message SARA').value).toBe('Build a KPI for OEE');
    act(() => useAssistant.getState().close());
  });

  it('opens the command palette with Ctrl+K and offers Ask SARA', async () => {
    // cmdk measures its list; jsdom has neither API.
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    Element.prototype.scrollIntoView ??= () => {};
    const { CommandPalette } = await import('../assistant/CommandPalette.jsx');
    mount(<CommandPalette />);
    act(() => {
      fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    });
    expect(screen.getByText('Chat')).toBeTruthy();
    const input = screen.getByPlaceholderText(/ask SARA/i);
    fireEvent.change(input, { target: { value: 'oil temperature' } });
    expect(screen.getByText('oil temperature')).toBeTruthy();
    expect(screen.queryByText('Chat')).toBeNull();
    vi.unstubAllGlobals();
  });
});

describe('voice in chat', () => {
  it('marks voice conversations and spoken messages with a mic', async () => {
    const { ConversationList } = await import('./ConversationList.jsx');
    const { MessageBubble } = await import('./MessageBubble.jsx');
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false } } });
    const at = new Date().toISOString();
    qc.setQueryData(['conversations'], {
      pages: [
        {
          items: [
            { id: 'a'.repeat(24), title: 'Machines running now', voice: true, lastMessageAt: at },
            { id: 'b'.repeat(24), title: 'Typed chat', voice: false, lastMessageAt: at },
          ],
          nextCursor: null,
        },
      ],
      pageParams: [undefined],
    });
    render(
      <QueryClientProvider client={qc}>
        <TooltipProvider>
          <MemoryRouter>
            <ConversationList />
            <MessageBubble
              message={{ id: 'u1', role: 'user', channel: 'voice', text: 'How many?', parts: [] }}
            />
            <MessageBubble message={{ id: 'u2', role: 'user', channel: 'text', text: 'Typed', parts: [] }} />
          </MemoryRouter>
        </TooltipProvider>
      </QueryClientProvider>,
    );
    expect(screen.getAllByRole('img', { name: 'Voice conversation' })).toHaveLength(1);
    expect(screen.getAllByText('Spoken:')).toHaveLength(1);
  });
});
