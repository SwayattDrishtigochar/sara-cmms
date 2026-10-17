import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { Toaster } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NotificationsBell, notificationPath } from '../layout/NotificationsBell.jsx';
import { flaggedParameters, trendOf } from '../machines/AnomalyCard.jsx';
import { HealthRing, healthBand } from '../machines/HealthRing.jsx';
import { TooltipProvider } from '../ui/overlay.jsx';
import { AnomaliesPage, filterAnomalies } from './AnomaliesPage.jsx';
import { evidenceWindow } from './AnomalyDetail.jsx';
import { assetOf, deviationOf, typeLabel, urgencyText } from './parts.jsx';

const fx = vi.hoisted(() => {
  const now = Date.now();
  const at = (min) => new Date(now + min * 60_000).toISOString();
  const press = { _id: 'p1', name: 'Press 1', assetTag: 'PRS-01', typeOfAsset: 'Power Press' };
  const compressor = { _id: 'c1', name: 'Compressor 1', assetTag: 'CMP-01', typeOfAsset: 'Compressor' };
  const a1 = {
    _id: 'a1',
    anomalyCode: 'ANM-1',
    assetId: press,
    type: 'vibration_high',
    severity: 'critical',
    state: 'open',
    summary: 'Vibration is climbing while the load is steady.',
    // As the watch stores it: the summary is the explanation's first sentence.
    explanation:
      'Vibration is climbing while the load is steady. It rose with current and temperature: bearing wear pattern.',
    confidence: 0.82,
    parameters: [{ field: 'vibration', unit: 'mm/s', observed: 7.4, expected: 3.2, deviation: '+4.2σ' }],
    likelyCauses: ['Bearing wear'],
    recommendedActions: ['Inspect the main bearing'],
    urgencyHours: 24,
    detectedAt: at(-30),
    lastSeenAt: at(-1),
    model: 'gemini-3.5-flash-lite',
    workOrderId: { _id: 'w9', workOrderId: 'WO-9', name: 'Vibration high on Press 1 – auto' },
    autoWorkOrderAt: at(-28),
  };
  const a2 = {
    _id: 'a2',
    anomalyCode: 'ANM-2',
    assetId: compressor,
    type: 'idle_power_high',
    severity: 'warning',
    state: 'acknowledged',
    summary: 'Draws 3× the usual power while idle.',
    confidence: 0.6,
    parameters: [{ field: 'POWER TOTAL', unit: 'kW', observed: 12, expected: 4 }],
    detectedAt: at(-120),
  };
  const investigation = {
    summary: 'Bearing wear on the main shaft.',
    rootCause: 'Worn drive-side bearing',
    confidence: 0.77,
    recommendedActions: ['Replace the bearing'],
    suggestedWorkOrder: {
      name: 'Replace main bearing on Press 1',
      description: 'Vibration and current pattern points to bearing wear.',
      priority: 'High',
      category: 'Mechanical',
      estimatedDurationMin: 180,
    },
    urgencyHours: 24,
    markdown: '## Findings\n\n- Vibration **+4.2σ**\n- Current up 9 %',
    model: 'gemini-3.5-flash-lite',
    mock: true,
    at: at(-5),
  };
  const notifications = [
    {
      _id: 'n1',
      message: { title: 'Critical anomaly on Press 1', description: 'Vibration high' },
      type: 'alert',
      details: { module: 'anomalies', recordId: 'a1', assetId: 'p1' },
      createdAt: at(-29),
      read: false,
    },
    {
      _id: 'n2',
      message: { title: 'WO-12 assigned to you' },
      type: 'normal',
      details: { module: 'workorders', recordId: 'w12' },
      createdAt: at(-200),
      read: true,
    },
  ];
  return { now, press, a1, a2, investigation, notifications };
});

const reply = (status, data) => ({ ok: status < 400, status, json: async () => data });

const me = {
  user: { id: 'u1', name: 'Vikram Mehta' },
  context: {
    role: 'owner',
    company: { isPlatform: false, name: 'Swayatt' },
    plants: [],
    modules: ['assets', 'anomalies', 'workorders', 'notifications'],
    can: { anomalies: { update: true }, workorders: { create: true } },
  },
};

let investigated = false;
/** The SARA API as the anomaly screens see it; anything else is a 404 so a wrong URL fails loudly. */
const fetchMock = vi.fn(async (url, init = {}) => {
  const path = String(url).replace(/^.*?\/api/, '');
  const method = init.method ?? 'GET';
  if (path === '/auth/me') return reply(200, me);
  if (path.startsWith('/m/anomalies?'))
    return reply(200, { items: [fx.a1, fx.a2], total: 2, page: 1, limit: 100 });
  if (path === '/m/anomalies/a1') {
    return reply(200, { item: investigated ? { ...fx.a1, investigation: fx.investigation } : fx.a1 });
  }
  if (path === '/anomalies/a1/investigate' && method === 'POST') {
    investigated = true;
    return reply(200, { investigation: fx.investigation });
  }
  if (path === '/anomalies/a1/state' && method === 'POST') {
    return reply(200, { anomaly: { ...fx.a1, assetId: 'p1', state: JSON.parse(init.body).state } });
  }
  if (path.startsWith('/m/workorders?')) return reply(200, { items: [], total: 0 });
  if (path === '/m/workorders' && method === 'POST') {
    return reply(201, { item: { _id: 'w1', workOrderId: 'WO-77', ...JSON.parse(init.body) } });
  }
  if (path.startsWith('/telemetry/fields')) {
    return reply(200, {
      fields: [
        { field: 'vibration', unit: 'mm/s', normalMin: 0, normalMax: 4.5, measurement: 'machineParams' },
      ],
    });
  }
  if (path.startsWith('/telemetry/series')) {
    const t = fx.now - 30 * 60_000;
    return reply(200, {
      every: '1m',
      series: [
        {
          field: 'vibration',
          unit: 'mm/s',
          points: [
            [t - 60e3, 3.1],
            [t, 5.2],
            [t + 60e3, 7.4],
          ],
        },
      ],
    });
  }
  if (path === '/ai/scan' && method === 'POST') return reply(200, { reviewed: 20, anomalies: 2 });
  if (path === '/notifications') return reply(200, { items: fx.notifications, unread: 1 });
  if (path === '/notifications/read-all' && method === 'POST') return reply(200, { ok: true });
  return reply(404, { error: { message: `Unexpected ${method} ${path}` } });
});

/** Body of the request sent to `path` with `method`, or undefined when none was. */
const sent = (method, path) => {
  const call = fetchMock.mock.calls.find(
    ([url, init = {}]) => String(url).endsWith(`/api${path}`) && (init.method ?? 'GET') === method,
  );
  return call && (call[1].body ? JSON.parse(call[1].body) : null);
};

const renderAt = (ui, path = '/anomalies') =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[path]}>
        <TooltipProvider>{ui}</TooltipProvider>
        <Toaster />
      </MemoryRouter>
    </QueryClientProvider>,
  );

beforeEach(() => {
  investigated = false;
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
  Element.prototype.scrollIntoView ??= () => {};
});
afterEach(() => {
  cleanup();
  fetchMock.mockClear();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('anomaly helpers', () => {
  it('labels and deviations', () => {
    expect(typeLabel('vibration_high')).toBe('Vibration high');
    expect(typeLabel(undefined)).toBe('Anomaly');
    expect(deviationOf({ deviation: '+4.2σ' })).toBe('+4.2σ');
    expect(deviationOf({ observed: 12, expected: 4 })).toBe('+200%');
    expect(deviationOf({ observed: 3, expected: 0 })).toBeNull();
    expect(urgencyText(24)).toBe('24 h');
    expect(urgencyText(0.5)).toBe('the hour');
    expect(urgencyText(72)).toBe('3 days');
    expect(urgencyText(null)).toBeNull();
    expect(assetOf(fx.a1)).toEqual({ id: 'p1', name: 'Press 1', tag: 'PRS-01', type: 'Power Press' });
    expect(assetOf({ assetId: 'x' })).toMatchObject({ id: 'x', name: 'Machine' });
  });

  it('filters by severity, machine and text', () => {
    const items = [fx.a1, fx.a2];
    expect(filterAnomalies(items, { severity: 'warning' }).map((a) => a._id)).toEqual(['a2']);
    expect(filterAnomalies(items, { asset: 'p1' }).map((a) => a._id)).toEqual(['a1']);
    expect(filterAnomalies(items, { q: 'power total' }).map((a) => a._id)).toEqual(['a2']);
    expect(filterAnomalies(items, { q: 'prs-01' }).map((a) => a._id)).toEqual(['a1']);
  });

  it('windows the evidence ±2 h, capped at now', () => {
    const t = Date.UTC(2026, 9, 16, 6);
    expect(evidenceWindow(new Date(t).toISOString(), t + 60 * 60e3)).toEqual({
      start: t - 2 * 3600e3,
      stop: t + 60 * 60e3,
      detected: t,
    });
    expect(evidenceWindow('nope')).toBeNull();
  });

  it('bands health scores and reads trends', () => {
    expect(healthBand(92).label).toBe('Good');
    expect(healthBand(60).label).toBe('Watch');
    expect(healthBand(12).label).toBe('Poor');
    expect(healthBand(null).label).toBe('Not scored');
    const t = fx.now;
    expect(
      trendOf([
        [t - 240e3, 4],
        [t, 5],
      ]),
    ).toBe('rising');
    expect(
      trendOf([
        [t - 240e3, 5],
        [t, 4],
      ]),
    ).toBe('falling');
    expect(
      trendOf([
        [t - 240e3, 5],
        [t, 5.05],
      ]),
    ).toBeNull();
    expect(trendOf([])).toBeNull();
  });

  it('keeps the worst anomaly per flagged field', () => {
    const flagged = flaggedParameters([
      { _id: 'x', state: 'open', severity: 'warning', parameters: [{ field: 'vibration' }] },
      {
        _id: 'y',
        state: 'open',
        severity: 'critical',
        parameters: [{ field: 'vibration' }, { field: 'current' }],
      },
      { _id: 'z', state: 'resolved', severity: 'critical', parameters: [{ field: 'temp' }] },
    ]);
    expect(flagged.map((f) => [f.param.field, f.anomaly._id])).toEqual([
      ['vibration', 'y'],
      ['current', 'y'],
    ]);
  });

  it('routes notifications to the right page', () => {
    expect(notificationPath(fx.notifications[0])).toBe('/anomalies?open=a1');
    expect(notificationPath(fx.notifications[1])).toBe('/m/workorders/w12');
    expect(notificationPath({ details: { assetId: 'p1' } })).toBe('/machines/p1');
    expect(notificationPath({})).toBeNull();
  });

  it('renders the health ring with its word', () => {
    render(<HealthRing score={86} label summary="Running smoothly." />);
    expect(screen.getByRole('img', { name: 'AI health 86 out of 100, good' })).toBeTruthy();
    expect(screen.getByText('Good')).toBeTruthy();
    expect(screen.getByText('Running smoothly.')).toBeTruthy();
    cleanup();
    render(<HealthRing score={null} label />);
    expect(screen.getByRole('img', { name: 'AI health not scored yet' })).toBeTruthy();
    expect(screen.getByText('Not scored yet')).toBeTruthy();
  });
});

describe('Anomalies page', () => {
  it('lists anomalies with severity chips, filters them and scans on demand', async () => {
    renderAt(<AnomaliesPage />);
    const list = await screen.findByRole('list', { name: 'Anomalies' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    expect(within(list).getByText('Press 1')).toBeTruthy();
    expect(within(list).getByText('Vibration high')).toBeTruthy();
    expect(within(list).getByText('+4.2σ')).toBeTruthy();
    expect(within(list).getByText('82% confident')).toBeTruthy();
    // The work order SARA opened by itself: one badge per anomaly, linked to the record.
    const auto = within(list).getAllByRole('link', { name: 'WO-9 opened automatically' });
    expect(auto).toHaveLength(1);
    expect(auto[0].getAttribute('href')).toBe('/m/workorders/w9');
    // Not nested in the row's button (invalid HTML, unreachable by Tab).
    expect(auto[0].closest('button')).toBeNull();
    expect(screen.getByRole('button', { name: 'Critical 1' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Warning 1' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Warning 1' }));
    expect(within(list).getAllByRole('listitem')).toHaveLength(1);
    expect(within(list).getByText('Compressor 1')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Warning 1' }));

    fireEvent.change(screen.getByLabelText('Search anomalies'), { target: { value: 'bearing' } });
    expect(within(list).getAllByRole('listitem')).toHaveLength(1);
    fireEvent.change(screen.getByLabelText('Search anomalies'), { target: { value: 'nothing here' } });
    expect(await screen.findByText('No anomalies match')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));

    fireEvent.click(screen.getByRole('button', { name: 'Scan now' }));
    await vi.waitFor(() => expect(sent('POST', '/ai/scan')).toEqual({}));
    expect(await screen.findByText('SARA reviewed 20 machines')).toBeTruthy();
  });

  it('opens the detail sheet: summary, evidence, investigation, work order and state actions', async () => {
    renderAt(<AnomaliesPage />, '/anomalies?open=a1');
    const sheet = await screen.findByRole('dialog');
    expect(await within(sheet).findByText('ANM-1 · Vibration high')).toBeTruthy();
    expect(within(sheet).getByText('What SARA found')).toBeTruthy();
    expect(within(sheet).getByText('Vibration is climbing while the load is steady.')).toBeTruthy();
    expect(
      within(sheet).getByText('It rose with current and temperature: bearing wear pattern.'),
    ).toBeTruthy();
    expect(within(sheet).getByText('Bearing wear')).toBeTruthy();
    expect(within(sheet).getByText('Act within 24 h')).toBeTruthy();
    expect(within(sheet).getByText('Generated by gemini-3.5-flash-lite · 30 minutes ago')).toBeTruthy();
    expect(within(sheet).getByRole('link', { name: 'Press 1' }).getAttribute('href')).toBe('/machines/p1');
    expect(
      within(sheet)
        .getByRole('link', { name: /^WO-9 · / })
        .getAttribute('href'),
    ).toBe('/m/workorders/w9');
    const autoBadge = within(sheet).getByRole('link', { name: 'WO-9 opened automatically' });
    expect(autoBadge.getAttribute('href')).toBe('/m/workorders/w9');
    // Not cut off by a one-line, truncated value cell (it was hidden in the drawer's narrow column).
    expect(autoBadge.closest('dd').className).not.toContain('truncate');
    expect(await within(sheet).findByText('Normal 0–4.5 mm/s')).toBeTruthy();
    const url = new URL(
      fetchMock.mock.calls.find(([u]) => String(u).includes('/telemetry/series'))[0],
      'http://x',
    );
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ assetId: 'p1', fields: 'vibration' });
    // 2 h before the detection; the end is capped at now because the anomaly is only 30 minutes old.
    expect(Date.parse(url.searchParams.get('start'))).toBe(Date.parse(fx.a1.detectedAt) - 2 * 3600e3);
    expect(Math.abs(Date.parse(url.searchParams.get('stop')) - Date.now())).toBeLessThan(60_000);

    fireEvent.click(within(sheet).getByRole('button', { name: 'Investigate' }));
    expect(await within(sheet).findByText('Worn drive-side bearing')).toBeTruthy();
    expect(within(sheet).getByRole('heading', { name: 'Findings' })).toBeTruthy();
    // A mocked investigation says so, like the briefing, KPI and planner texts.
    expect(within(sheet).getByText(/Generated by gemini-3\.5-flash-lite \(mock\)/)).toBeTruthy();
    expect(within(sheet).getByText('Replace main bearing on Press 1')).toBeTruthy();
    expect(
      within(sheet).getByRole('button', { name: 'Plan maintenance' }).getAttribute('aria-disabled'),
    ).toBeNull();

    fireEvent.click(within(sheet).getByRole('button', { name: 'Create work order' }));
    const dialog = (await screen.findAllByRole('dialog')).find((d) =>
      within(d).queryByText('Create work order', { selector: 'h2' }),
    );
    expect(within(dialog).getByLabelText(/^Title/).value).toBe('Replace main bearing on Press 1');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create work order' }));
    await vi.waitFor(() =>
      expect(sent('POST', '/m/workorders')).toEqual({
        name: 'Replace main bearing on Press 1',
        description: 'Vibration and current pattern points to bearing wear.',
        priority: 'High',
        category: 'Mechanical',
        estimatedDurationMin: 180,
        asset: 'p1',
        anomalyId: 'a1',
      }),
    );
    expect(await screen.findByText('Work order WO-77 created')).toBeTruthy();

    fireEvent.click(within(sheet).getByRole('button', { name: 'Acknowledge' }));
    await vi.waitFor(() => expect(sent('POST', '/anomalies/a1/state')).toEqual({ state: 'acknowledged' }));
    expect(await screen.findByText('Anomaly acknowledged')).toBeTruthy();
  });
});

describe('Notifications bell', () => {
  it('shows the unread count, lists notifications and marks all read', async () => {
    renderAt(<NotificationsBell />);
    const bell = await screen.findByRole('button', { name: 'Notifications, 1 unread' });
    expect(bell.textContent).toContain('1');
    fireEvent.keyDown(bell, { key: 'Enter' });
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByText('Critical anomaly on Press 1')).toBeTruthy();
    expect(within(menu).getByText('WO-12 assigned to you')).toBeTruthy();
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Mark all as read' }));
    await vi.waitFor(() => expect(sent('POST', '/notifications/read-all')).toBeNull());
    expect(
      fetchMock.mock.calls.some(
        ([u, i]) => String(u).endsWith('/api/notifications/read-all') && i.method === 'POST',
      ),
    ).toBe(true);
  });
});
