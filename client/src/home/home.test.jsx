import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import { Toaster } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAssistant } from '../assistant/useAssistant.js';
import { TooltipProvider } from '../ui/overlay.jsx';
import { mergeAlerts } from './AlertsFeed.jsx';
import { CommandCenter } from './CommandCenter.jsx';
import { KPI_PROMPT, stripKpis } from './KpiStrip.jsx';

const H = 36e5;
const at = (h) => new Date(Date.now() + h * H).toISOString();

const evidence = () => ({
  production: {
    produced: 550,
    planned: 900,
    pct: 61.1,
    byAsset: [],
    block: {
      type: 'kpis',
      payload: {
        title: 'Production today',
        items: [
          { label: 'Produced', value: 550, unit: 'pcs' },
          { label: 'Planned', value: 900, unit: 'pcs' },
        ],
      },
    },
  },
  anomalies: {
    open: 1,
    critical: 1,
    items: [],
    block: {
      type: 'table',
      payload: {
        title: 'Open anomalies: 1 (1 critical)',
        columns: [{ key: 'code', label: 'ID' }],
        rows: [{ code: 'ANM-2' }],
      },
    },
  },
  maintenance: {
    overdue: 1,
    dueToday: 2,
    openWorkOrders: 7,
    dueSoon: [
      {
        kind: 'workorder',
        id: 'w1',
        code: 'WO-9',
        name: 'Overdue check',
        asset: 'IMM 1',
        assetId: 'a1',
        due: at(-2),
      },
      {
        kind: 'pm',
        id: 'p1',
        code: 'PM-4',
        name: 'Grease screws',
        asset: 'IMM 2',
        assetId: 'a2',
        due: at(3),
      },
    ],
    block: { type: 'kpis', payload: { title: 'Maintenance', items: [] } },
  },
  costs: null,
});
const goodBriefing = () => ({
  briefing: {
    headline: 'Acme: 1 machine to watch',
    narrative: 'Production is at 61% of plan (550 of 900 pcs).',
    actions: [
      {
        title: 'Plan maintenance for IMM 1',
        why: 'Vibration high',
        link: '/planner?maintenance=a1',
        ask: null,
      },
      {
        title: 'Review the stops on IMM 2',
        why: '35 min of downtime',
        link: null,
        ask: 'Why did IMM 2 stop today?',
      },
      { title: 'Review cost drivers', why: 'Spend by asset', link: '/costs', ask: null },
    ],
    evidence: ['production', 'anomalies'],
  },
  evidence: evidence(),
  model: 'gemini-flash',
  at: at(-0.5),
  mock: false,
  stale: false,
});

let role;
let briefing;
let kpis;
const reply = (status, data) => ({ ok: status < 400, status, json: async () => data });
const fetchMock = vi.fn(async (url, init = {}) => {
  const path = String(url).replace(/^.*?\/api/, '');
  const method = init.method ?? 'GET';
  const owner = role === 'owner';
  if (path === '/auth/me') {
    return reply(200, {
      user: { id: 'u1', name: 'Asha Rao' },
      context: {
        role,
        user: { name: 'Asha Rao' },
        company: { timeZone: 'Asia/Kolkata' },
        plantLocked: false,
        modules: ['assets', 'anomalies', 'kpis'],
        can: { kpis: { create: owner, update: owner, delete: owner } },
      },
    });
  }
  if (path.startsWith('/briefing/refresh') && method === 'POST') {
    return reply(200, {
      ...goodBriefing(),
      briefing: { ...goodBriefing().briefing, headline: 'Fresh headline' },
    });
  }
  if (path.startsWith('/briefing')) {
    return briefing ? reply(200, briefing) : reply(500, { error: { message: 'Server error' } });
  }
  if (path.startsWith('/m/assets?')) {
    return reply(200, {
      items: [
        {
          _id: 'a1',
          name: 'IMM 1',
          typeOfAsset: 'Injection Moulding Machine',
          assetStatus: 'Running',
          isProductionAsset: true,
          healthScore: 72,
        },
        { _id: 'a2', name: 'Store room', typeOfAsset: 'Other', assetStatus: 'OFF' },
      ],
      total: 2,
    });
  }
  if (path.startsWith('/telemetry/latest')) return reply(200, { assets: [] });
  if (path.startsWith('/m/anomalies?')) {
    return reply(200, {
      items: [
        {
          _id: 'n1',
          anomalyCode: 'ANM-2',
          assetId: { _id: 'a1', name: 'IMM 1' },
          severity: 'critical',
          state: 'open',
          summary: 'Vibration well above normal',
          detectedAt: at(-1),
        },
      ],
      total: 1,
    });
  }
  if (path.startsWith('/notifications')) {
    return reply(200, {
      items: [
        {
          _id: 'x1',
          type: 'alert',
          priority: 'high',
          message: { title: 'Cost alert: Compressor 2 energy', description: 'Past the ₹3,000 limit' },
          details: { module: 'costalerts', recordId: 'c1' },
          createdAt: at(-0.2),
          read: false,
        },
      ],
      unread: 1,
    });
  }
  if (path.startsWith('/m/kpis?')) return reply(200, { items: kpis, total: kpis.length });
  if (path.startsWith('/kpis/k1/run')) {
    return reply(200, {
      result: {
        viz: 'number',
        title: 'Energy today',
        unit: 'kWh',
        value: 842,
        tone: 'neutral',
        timeRange: { label: 'today' },
        warnings: [],
        stats: {},
      },
    });
  }
  if (path.startsWith('/planning/calendar?')) {
    return reply(200, {
      gantt: {
        range: { start: at(-12), end: at(12) },
        timeZone: 'Asia/Kolkata',
        rows: [{ id: 'a1', label: 'IMM 1', status: 'Running', health: 72 }],
        bars: [
          {
            id: 'j1',
            rowId: 'a1',
            start: at(-2),
            end: at(5),
            label: 'Housing-A',
            code: 'JC-12',
            kind: 'jobcard',
          },
        ],
        shifts: [],
        markers: [],
      },
      machines: [],
    });
  }
  return reply(404, { error: { message: `Unexpected ${method} ${path}` } });
});
const calls = (method, prefix) =>
  fetchMock.mock.calls.filter(
    ([url, init = {}]) => String(url).includes(`/api${prefix}`) && (init.method ?? 'GET') === method,
  ).length;

let location;
const Probe = () => {
  location = useLocation();
  return null;
};
const renderPage = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <TooltipProvider>
          <CommandCenter />
        </TooltipProvider>
        <Probe />
        <Toaster />
      </MemoryRouter>
    </QueryClientProvider>,
  );

beforeEach(() => {
  role = 'owner';
  briefing = goodBriefing();
  kpis = [
    {
      _id: 'k1',
      title: 'Energy today',
      viz: 'number',
      pinned: true,
      updatedAt: at(-1),
      insight: { text: 'Energy is 12% above last week.', model: 'gemini-flash', at: at(-1) },
    },
  ];
  localStorage.setItem('token', 'test-token');
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  useAssistant.setState({ isOpen: false, text: '', pendingSend: null, context: null });
});
afterEach(() => {
  cleanup();
  fetchMock.mockClear();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('CommandCenter', () => {
  it('renders the briefing, alerts, KPIs, live floor, today’s plan and maintenance due', async () => {
    renderPage();
    expect(await screen.findByText('Acme: 1 machine to watch')).toBeTruthy();
    expect(screen.getByText(/61% of plan/)).toBeTruthy();
    expect(screen.getByText('Generated by gemini-flash · 30 minutes ago')).toBeTruthy();
    const actions = screen.getByRole('region', { name: 'Recommended actions' });
    expect(within(actions).getAllByRole('listitem')).toHaveLength(3);
    const ev = screen.getByRole('region', { name: 'Evidence' });
    expect(within(ev).getByText('Production today')).toBeTruthy();
    expect(within(ev).getByText('Open anomalies: 1 (1 critical)')).toBeTruthy();

    expect(await screen.findByText('Cost alert: Compressor 2 energy')).toBeTruthy();
    expect(screen.getByText('ANM-2 · IMM 1')).toBeTruthy();

    expect(await screen.findByText('Energy is 12% above last week.')).toBeTruthy();

    const floor = screen.getByText('Live floor').closest('div.rounded-xl');
    expect(await within(floor).findByRole('link', { name: 'IMM 1' })).toBeTruthy();
    expect(within(floor).getByText('Running')).toBeTruthy();
    expect(within(floor).queryByText('Store room')).toBeNull(); // not a connected machine
    expect(within(floor).getByRole('img', { name: /AI health 72 out of 100/ })).toBeTruthy();

    expect(screen.getByText("Today's plan")).toBeTruthy();
    expect(screen.getByText('1 overdue · 2 due today · 7 open work orders')).toBeTruthy();
    expect(screen.getByText('Overdue')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Plan maintenance for IMM 1' }));
    expect(`${location.pathname}${location.search}`).toBe('/planner?maintenance=a1');
  });

  it('runs actions as links or questions to SARA, and regenerates for owners', async () => {
    renderPage();
    fireEvent.click(await screen.findByText('Review the stops on IMM 2'));
    expect(useAssistant.getState()).toMatchObject({ isOpen: true, pendingSend: 'Why did IMM 2 stop today?' });
    fireEvent.click(screen.getByText('Review cost drivers'));
    expect(location.pathname).toBe('/costs');

    const prov = screen.getByText('Generated by gemini-flash · 30 minutes ago').parentElement;
    fireEvent.click(within(prov).getByRole('button', { name: 'Regenerate' }));
    expect(await screen.findByText('Fresh headline')).toBeTruthy();
    expect(calls('POST', '/briefing/refresh')).toBe(1);
  });

  it('shows the live numbers with a friendly note when the AI is unavailable', async () => {
    role = 'view';
    briefing = {
      briefing: { headline: 'Today so far', narrative: null, actions: [], evidence: ['production'] },
      evidence: evidence(),
      model: null,
      at: null,
      mock: false,
      stale: false,
      aiError: { code: 'AI_QUOTA', message: 'Daily limit reached' },
    };
    renderPage();
    expect(await screen.findByText('Today so far')).toBeTruthy();
    expect(screen.getByText(/SARA can't write the briefing right now/)).toBeTruthy();
    expect(screen.getByText('Production today')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Regenerate' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('marks a stale briefing', async () => {
    briefing = { ...goodBriefing(), stale: true, aiError: { code: 'AI_QUOTA', message: 'quota' } };
    renderPage();
    expect(await screen.findByText(/SARA couldn't refresh it/)).toBeTruthy();
    expect(screen.getByText('Acme: 1 machine to watch')).toBeTruthy();
  });

  it('offers "Ask SARA for KPIs" when there are none', async () => {
    kpis = [];
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Ask SARA for KPIs' }));
    expect(useAssistant.getState()).toMatchObject({ isOpen: true, pendingSend: KPI_PROMPT });
  });

  it('shows the error state with retry when the briefing fails', async () => {
    briefing = null;
    renderPage();
    expect(await screen.findByText("Couldn't load the briefing")).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(calls('GET', '/briefing')).toBe(2));
  });
});

describe('helpers', () => {
  it('folds an anomaly notification into its anomaly and sorts newest first', () => {
    const anomalies = [
      {
        _id: 'n1',
        anomalyCode: 'ANM-1',
        assetId: { _id: 'a9', name: 'Press 1' },
        severity: 'warning',
        detectedAt: at(-3),
      },
    ];
    const notes = [
      {
        _id: 'x1',
        message: { title: 'Anomaly found' },
        details: { module: 'anomalies', recordId: 'n1' },
        createdAt: at(-3),
      },
      { _id: 'x2', message: { title: 'WO done' }, type: 'success', createdAt: at(-1) },
    ];
    const items = mergeAlerts(notes, anomalies);
    expect(items.map((i) => i.title)).toEqual(['WO done', 'ANM-1 · Press 1']);
    expect(items[1]).toMatchObject({ path: '/anomalies?open=n1', look: { label: 'Warning anomaly' } });
  });

  it('puts pinned KPIs first, four at most', () => {
    const list = ['a', 'b', 'c', 'd', 'e'].map((id, i) => ({ _id: id, pinned: i === 4 }));
    expect(stripKpis(list).map((k) => k._id)).toEqual(['e', 'a', 'b', 'c']);
  });
});
