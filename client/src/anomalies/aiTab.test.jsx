import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { Toaster } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AiTab, backgroundBudget, clampLevel, modelsInUse } from '../superadmin/AiTab.jsx';

const fx = vi.hoisted(() => ({
  settings: {
    tiers: {
      router: { model: 'gemini-3.1-flash-lite', thinkingLevel: null, fallback: null },
      fast: { model: 'gemini-3.6-flash', thinkingLevel: 'minimal', fallback: 'gemini-3.8-flash' },
      balanced: { model: 'gemini-3.8-flash', thinkingLevel: 'medium', fallback: 'gemini-3.6-flash' },
      deep: { model: 'gemini-3.8-flash', thinkingLevel: 'high', fallback: 'gemini-3.6-flash' },
      background: { model: 'gemini-3.5-flash-lite', thinkingLevel: 'low', fallback: null },
    },
    limits: { 'gemini-3.8-flash': { rpm: 10, rpd: 250 } },
    chatReservePct: 40,
    showThoughts: true,
    anomaly: { enabled: true, tickSec: 60, quietIntervalMin: 30, alwaysAskAi: false, investigate: true },
    costWatch: { enabled: true, intervalMin: 60 },
    kpiInsightTtlMin: 30,
    briefingTtlHours: 6,
  },
  models: [
    { id: 'gemini-3.8-flash', free: true, thinking: ['low', 'medium', 'high'] },
    { id: 'gemini-3.6-flash', free: true, thinking: ['minimal', 'low', 'medium', 'high'] },
    { id: 'gemini-3.5-flash-lite', free: true, thinking: ['minimal', 'low', 'medium', 'high'] },
    { id: 'gemini-3.1-pro-preview', free: false, thinking: ['low', 'medium', 'high'] },
  ],
  usage: {
    day: '2026-10-16',
    models: [
      {
        model: 'gemini-3.8-flash',
        calls: 230,
        tokens: 51000,
        rateLimited: 3,
        errors: 0,
        limits: { rpm: 10, rpd: 250 },
        free: true,
      },
    ],
  },
}));

const reply = (status, data) => ({ ok: status < 400, status, json: async () => data });
const fetchMock = vi.fn(async (url, init = {}) => {
  const path = String(url).replace(/^.*?\/api/, '');
  const method = init.method ?? 'GET';
  if (path === '/admin/ai' && method === 'GET') {
    return reply(200, {
      settings: fx.settings,
      apiKeyConfigured: false,
      mock: true,
      quotaStretch: { at: 0.7, factor: 3 },
    });
  }
  if (path === '/admin/ai' && method === 'PUT') return reply(200, { settings: JSON.parse(init.body) });
  if (path === '/admin/ai/models')
    return reply(200, { models: fx.models, tiers: Object.keys(fx.settings.tiers) });
  if (path === '/admin/ai/usage') return reply(200, fx.usage);
  if (path === '/admin/ai/test' && method === 'POST') {
    const { tier } = JSON.parse(init.body);
    return tier === 'deep'
      ? reply(503, { error: { code: 'AI_QUOTA', message: 'Daily quota used up' } })
      : reply(200, { ok: true, model: fx.settings.tiers[tier].model, latencyMs: 412, text: 'pong' });
  }
  return reply(404, { error: { message: `Unexpected ${method} ${path}` } });
});

const sent = (method, path) => {
  const call = fetchMock.mock.calls.find(
    ([url, init = {}]) => String(url).endsWith(`/api${path}`) && (init.method ?? 'GET') === method,
  );
  return call && JSON.parse(call[1].body);
};

const renderTab = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RouterProvider router={createMemoryRouter([{ path: '*', element: <AiTab /> }])} />
      <Toaster />
    </QueryClientProvider>,
  );

beforeEach(() => {
  localStorage.setItem('token', 'test-token');
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  fetchMock.mockClear();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('AI tab helpers', () => {
  it('works out the background budget and the quota stretch', () => {
    const row = (calls) => [{ model: 'gemini-3.5-flash-lite', calls, limits: { rpm: 10, rpd: 250 } }];
    const stretch = { at: 0.7, factor: 3 };
    const calm = backgroundBudget(fx.settings, row(104), stretch);
    expect(calm).toMatchObject({ budget: 150, stretchAt: 105, stretched: false, quietNow: 30 });
    expect(backgroundBudget(fx.settings, row(105), stretch)).toMatchObject({ stretched: true, quietNow: 90 });
    expect(backgroundBudget(fx.settings, [], stretch)).toMatchObject({ calls: 0, budget: 150 });
    // An older server without quotaStretch: no stretch.
    expect(backgroundBudget(fx.settings, row(200))).toMatchObject({ stretched: false, quietNow: 30 });
  });

  it('clamps thinking levels to what the model supports', () => {
    expect(clampLevel('minimal', ['low', 'medium', 'high'])).toBe('low');
    expect(clampLevel('high', ['minimal', 'low'])).toBe('low');
    expect(clampLevel('medium', ['low', 'medium', 'high'])).toBe('medium');
    expect(clampLevel('medium', [])).toBeNull();
    expect(clampLevel(null, ['low'])).toBeNull();
  });

  it('lists every model in use once', () => {
    expect(modelsInUse(fx.settings, fx.usage.models)).toEqual([
      'gemini-3.1-flash-lite',
      'gemini-3.6-flash',
      'gemini-3.8-flash',
      'gemini-3.5-flash-lite',
    ]);
  });
});

describe('Superadmin → AI', () => {
  it('shows the mock banner, tiers, usage, and saves a changed draft', async () => {
    renderTab();
    expect(await screen.findByText(/No Gemini API key/)).toBeTruthy();
    const fast = await screen.findByLabelText('Fast model');
    expect(fast.value).toBe('gemini-3.6-flash');
    expect(screen.getByLabelText('Fast thinking level').value).toBe('minimal');
    expect(screen.getByText('230 of 250 calls today')).toBeTruthy();
    expect(screen.getByText('3 rate-limited')).toBeTruthy();
    expect(screen.queryByText('You have unsaved changes.')).toBeNull();

    // Switching to a model without "minimal" clamps the level to its nearest supported one.
    fireEvent.change(fast, { target: { value: 'gemini-3.1-pro-preview' } });
    expect(screen.getByLabelText('Fast thinking level').value).toBe('low');
    expect(screen.getByText('You have unsaved changes.')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Chat reserve'), { target: { value: '50' } });
    fireEvent.click(screen.getByRole('switch', { name: 'Anomaly scans' }));
    fireEvent.change(screen.getByLabelText('gemini-3.8-flash requests per day'), {
      target: { value: '1000' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await vi.waitFor(() => expect(sent('PUT', '/admin/ai')).toBeTruthy());
    expect(sent('PUT', '/admin/ai')).toMatchObject({
      tiers: { fast: { model: 'gemini-3.1-pro-preview', thinkingLevel: 'low' } },
      chatReservePct: 50,
      anomaly: { enabled: false },
      limits: { 'gemini-3.8-flash': { rpm: 10, rpd: 1000 } },
    });
    expect(await screen.findByText('AI settings saved')).toBeTruthy();
    expect(screen.queryByText('You have unsaved changes.')).toBeNull();
  });

  it('tests a tier and shows latency or the error', async () => {
    renderTab();
    const buttons = await screen.findAllByRole('button', { name: 'Test' });
    fireEvent.click(buttons[1]); // fast
    await vi.waitFor(() => expect(sent('POST', '/admin/ai/test')).toEqual({ tier: 'fast' }));
    expect(await screen.findByText('412 ms · gemini-3.6-flash')).toBeTruthy();
    fireEvent.click(buttons[3]); // deep
    expect(await screen.findByText('Daily quota used up')).toBeTruthy();
  });
});
