import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { Toaster } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAssistant } from '../assistant/useAssistant.js';
import { TooltipProvider } from '../ui/overlay.jsx';
import { alertStatus } from './CostAlertsList.jsx';
import { foldRows } from './CostBreakdown.jsx';
import { CostsPage } from './CostsPage.jsx';

const zero = { energy: 0, spares: 0, consumables: 0, labour: 0, downtime: 0, maintenance: 0, total: 0 };
const row = (key, label, energy, spares, labour, downtime) => ({
  key,
  label,
  energy,
  spares,
  consumables: 0,
  labour,
  downtime,
  maintenance: spares + labour,
  total: energy + spares + labour + downtime,
});
const summaryFor = (groupBy) => {
  const rows =
    groupBy === 'day'
      ? [
          row('2026-10-15', '2026-10-15', 1000, 0, 200, 0),
          row('2026-10-16', '2026-10-16', 1200, 900, 0, 3000),
        ]
      : groupBy === 'category'
        ? [row('Energy', 'Energy', 2200, 0, 0, 0), row('Downtime', 'Downtime', 0, 0, 0, 3000)]
        : [row('c2', 'Compressor 2', 2200, 0, 0, 0), row('imm4', 'IMM 4', 0, 900, 200, 3000)];
  const totals = rows.reduce(
    (t, r) => {
      for (const k of Object.keys(zero)) t[k] += r[k];
      return t;
    },
    { ...zero },
  );
  return {
    groupBy,
    currency: { name: 'INR', symbol: '₹' },
    totals: { ...totals, kwh: 262, downtimeHours: 1, labourHours: 0.6 },
    rows,
    notes: ['A day without a tariff has no energy cost'],
  };
};
const ai = {
  headline: 'IMM 4 downtime drives this month',
  summary: 'Downtime on IMM 4 cost more than all energy.',
  drivers: [{ key: 'imm4', explanation: 'One long stop on IMM 4.', action: 'Check the hydraulic pump' }],
};
const overview = (withAi = true) => ({
  period: { key: 'month:2026-10', label: 'October 2026' },
  summary: summaryFor('asset'),
  previous: { totals: { ...zero, total: 5000, energy: 2000 } },
  topDrivers: [
    { key: 'imm4', label: 'IMM 4', component: 'downtime', amount: 4100, deltaPct: 25 },
    { key: 'c2', label: 'Compressor 2', component: 'energy', amount: 2200, deltaPct: null },
    { key: 'cnc4', label: 'CNC 4', component: 'spares', amount: 900, deltaPct: 1700 },
  ],
  ai: withAi ? ai : null,
  model: withAi ? 'gemini-2.5-flash' : null,
  at: withAi ? new Date().toISOString() : null,
  mock: true,
  stale: false,
  ...(withAi ? {} : { aiError: { code: 'AI_UNAVAILABLE', message: 'quota' } }),
});
const alert = {
  _id: 'a1',
  name: 'Compressor 2 energy',
  metric: 'energy',
  scope: 'asset',
  assetId: { _id: 'c2', name: 'Compressor 2', assetTag: 'CMP-02' },
  period: 'day',
  comparator: 'gt',
  threshold: 3000,
  enabled: true,
  lastValue: 3400,
  lastEvaluatedAt: new Date().toISOString(),
  lastTriggeredAt: new Date().toISOString(),
  history: [
    { periodKey: 'day:2026-10-15', value: 3100, threshold: 3000, triggeredAt: '2026-10-15T10:00:00Z' },
    {
      periodKey: 'day:2026-10-16',
      value: 3400,
      threshold: 3000,
      triggeredAt: '2026-10-16T10:00:00Z',
      explanation: 'The compressor ran unloaded all night.',
    },
  ],
};

let role = 'owner';
let alerts = [];
let withAi = true;
const reply = (status, data) => ({ ok: status < 400, status, json: async () => data });
const fetchMock = vi.fn(async (url, init = {}) => {
  const u = new URL(String(url), 'http://x');
  const path = u.pathname.replace(/^\/api/, '');
  const method = init.method ?? 'GET';
  const write = role === 'owner';
  if (path === '/auth/me') {
    return reply(200, {
      user: { id: 'u1', name: 'Owner' },
      context: { role, company: {}, can: { costalerts: { create: write, update: write, delete: write } } },
    });
  }
  if (path === '/costs/summary') return reply(200, summaryFor(u.searchParams.get('groupBy')));
  if (path === '/costs/overview') return reply(200, overview(withAi));
  if (path === '/costs/overview/refresh' && method === 'POST') return reply(200, overview(true));
  if (path === '/m/costalerts') return reply(200, { items: alerts, total: alerts.length });
  if (path === '/m/costalerts/a1' && method === 'PATCH')
    return reply(200, { item: { ...alert, enabled: false } });
  if (path === '/costs/alerts/a1/check' && method === 'POST') {
    return reply(200, { value: 3400, periodKey: 'day:2026-10-16', breached: true, fired: false });
  }
  return reply(404, { error: { message: `Unexpected ${method} ${path}` } });
});
const requests = (method, path) =>
  fetchMock.mock.calls.filter(
    ([url, init = {}]) =>
      new URL(String(url), 'http://x').pathname === `/api${path}` && (init.method ?? 'GET') === method,
  );

const renderPage = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <TooltipProvider>
          <CostsPage />
        </TooltipProvider>
        <Toaster />
      </MemoryRouter>
    </QueryClientProvider>,
  );

beforeEach(() => {
  role = 'owner';
  alerts = [alert];
  withAi = true;
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

describe('Costs page', () => {
  it('renders the AI overview, totals, breakdowns, drivers and alerts', async () => {
    renderPage();
    expect(await screen.findByText(ai.headline)).toBeTruthy();
    expect(screen.getByText(/Generated by gemini-2\.5-flash \(mock\)/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Regenerate' })).toBeTruthy();
    // totals 2,200 + 4,100 = ₹6,300, +26% against ₹5,000 before
    expect(await screen.findByText('₹6,300')).toBeTruthy();
    expect(screen.getByText('+26%')).toBeTruthy();
    expect(screen.getByText('A day without a tariff has no energy cost')).toBeTruthy();
    for (const t of ['Cost by asset', 'Cost by category', 'Cost by day'])
      expect(screen.getByText(t)).toBeTruthy();
    expect(screen.getByText('One long stop on IMM 4.')).toBeTruthy();
    expect(screen.getByText('Check the hydraulic pump')).toBeTruthy();
    expect(screen.getByText('+25% vs before')).toBeTruthy();
    expect(screen.getByText('No earlier data')).toBeTruthy();
    expect(screen.getByText('Little earlier data')).toBeTruthy(); // +1,700% is noise, not news
    expect(await screen.findByText('Compressor 2 energy')).toBeTruthy();
    expect(screen.getByText('Limit crossed')).toBeTruthy();
    expect(screen.getByText('History (2)')).toBeTruthy();
    expect(screen.getByRole('meter', { name: /Compressor 2 energy/ }).getAttribute('aria-valuetext')).toBe(
      '₹3,400 of a ₹3,000 limit',
    );
    const summary = requests('GET', '/costs/summary').map(([url]) => new URL(String(url), 'http://x'));
    expect(summary.every((u) => u.searchParams.get('text') === 'this month')).toBe(true);
    expect(new Set(summary.map((u) => u.searchParams.get('groupBy')))).toEqual(
      new Set(['asset', 'category', 'day']),
    );
  });

  it('the toggle pauses an alert through PATCH /m/costalerts/:id', async () => {
    renderPage();
    const toggle = await screen.findByRole('switch', { name: 'Enable Compressor 2 energy' });
    fireEvent.click(toggle);
    await waitFor(() => expect(requests('PATCH', '/m/costalerts/a1')).toHaveLength(1));
    expect(JSON.parse(requests('PATCH', '/m/costalerts/a1')[0][1].body)).toEqual({ enabled: false });
    expect(await screen.findByText('Compressor 2 energy is paused')).toBeTruthy();
  });

  it('check now evaluates the alert', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Check now' }));
    await waitFor(() => expect(requests('POST', '/costs/alerts/a1/check')).toHaveLength(1));
    expect(await screen.findByText(/still past the limit/)).toBeTruthy();
  });

  it('shows a friendly fallback when the AI is unavailable and keeps the numbers', async () => {
    withAi = false;
    renderPage();
    expect(await screen.findByText(/explanation is unavailable right now/)).toBeTruthy();
    expect(await screen.findByText('₹6,300')).toBeTruthy();
    expect(screen.getByText('IMM 4')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText(ai.headline)).toBeTruthy();
    expect(requests('POST', '/costs/overview/refresh')).toHaveLength(1);
  });

  it('viewers get no Regenerate, Check now or toggle', async () => {
    role = 'view';
    renderPage();
    expect(await screen.findByText(ai.headline)).toBeTruthy();
    expect(await screen.findByText('Compressor 2 energy')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Regenerate' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Check now' })).toBeNull();
    expect(screen.getByRole('switch', { name: 'Enable Compressor 2 energy' }).disabled).toBe(true);
  });

  it('a custom range asks the summary for start/stop and skips the AI overview', async () => {
    renderPage();
    await screen.findByText(ai.headline);
    fireEvent.click(screen.getByRole('button', { name: 'Custom' }));
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-10-01' } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-10-10' } });
    expect(await screen.findByText(/overview covers today, this week and this month/)).toBeTruthy();
    await waitFor(() =>
      expect(
        requests('GET', '/costs/summary').some(([url]) => {
          const q = new URL(String(url), 'http://x').searchParams;
          return q.get('start') === '2026-10-01' && q.get('stop') === '2026-10-10';
        }),
      ).toBe(true),
    );
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-10-12' } });
    expect(screen.getByText('Pick a start on or before the end.')).toBeTruthy();
  });

  it('no alerts: empty state hands the request to SARA', async () => {
    alerts = [];
    renderPage();
    expect(await screen.findByText('No cost alerts yet')).toBeTruthy();
    const buttons = screen.getAllByRole('button', { name: 'Create an alert with SARA' });
    fireEvent.click(buttons[buttons.length - 1]);
    expect(useAssistant.getState()).toMatchObject({ isOpen: true, text: 'Alert me if ', pendingSend: null });
  });
});

describe('cost helpers', () => {
  it('alertStatus reads the comparator and paused state', () => {
    expect(alertStatus({ enabled: false }).label).toBe('Paused');
    expect(alertStatus({ lastValue: null }).label).toBe('Not checked yet');
    expect(alertStatus({ lastValue: 10, threshold: 10, comparator: 'gte' }).breached).toBe(true);
    expect(alertStatus({ lastValue: 10, threshold: 10, comparator: 'gt' }).label).toBe('Within limit');
    expect(alertStatus({ lastValue: 5, threshold: 10, comparator: 'lt' }).breached).toBe(true);
  });

  it('foldRows sums the tail into Other', () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({
      key: `a${i}`,
      label: `A${i}`,
      energy: 1,
      total: 1,
    }));
    const out = foldRows(rows, 10);
    expect(out).toHaveLength(10);
    expect(out[9]).toMatchObject({ label: 'Other', energy: 3, total: 3 });
  });
});
