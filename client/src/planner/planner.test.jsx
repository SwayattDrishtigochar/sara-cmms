import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import { Toaster } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '../ui/overlay.jsx';
import { Gantt } from './Gantt.jsx';
import { feasibilityOf, PlanBlock, PlanPreview } from './PlanBlock.jsx';
import { PlannerPage } from './PlannerPage.jsx';

const H = 36e5;
const at = (h) => new Date(Date.now() + h * H).toISOString();

const rows = [
  { id: 'imm5', label: 'IMM 5', sub: 'IMM-05 · 85 %', status: 'Running', health: 82 },
  { id: 'p1', label: 'Press 1', sub: 'PRS-01 · 85 %', status: 'Idle', health: 64 },
];
const gantt = () => ({
  range: { start: at(-2), end: at(70) },
  timeZone: 'Asia/Kolkata',
  rows,
  bars: [
    {
      id: 'jc14',
      code: 'JC-14',
      rowId: 'p1',
      start: at(-1),
      end: at(20),
      label: 'Bracket-C – stock',
      kind: 'jobcard',
      status: 'In Progress',
      href: '/m/jobcards/jc14',
      progress: 0.4,
    },
  ],
  shifts: [{ name: 'A', start: '06:00', end: '14:00' }],
  markers: [
    {
      id: 'anm7',
      rowId: 'p1',
      at: at(-1),
      kind: 'anomaly',
      severity: 'warning',
      label: 'ANM-7 Quality degradation',
      href: '/anomalies?open=anm7',
    },
  ],
});

const production = (id = 'pp1', code = 'PLN-3', extra = {}) => ({
  proposal: {
    _id: id,
    proposalCode: code,
    kind: 'production',
    title: '5,000 × Housing-A by 25-10-2026',
    status: 'draft',
    expiresAt: at(12),
    createdAt: at(-0.2),
    feasibility: { feasible: true, dueDate: at(60), projectedFinish: at(40), slackHours: 20, shortfall: 0 },
    risks: [{ kind: 'pm_due', severity: 'warning', text: 'PM-1 (Monthly PM – IMM 1) is due on IMM 1' }],
    alternatives: [],
    explanation: {
      text: 'Three moulds share the order so it lands a day early.',
      model: 'gemini-3.5-flash',
      at: at(-0.1),
    },
    ...extra,
  },
  plan: {
    ...gantt(),
    title: '5,000 × Housing-A by 25-10-2026',
    bars: [
      {
        id: 'g-setup',
        rowId: 'imm5',
        start: at(2),
        end: at(3),
        kind: 'setup',
        ghost: true,
        change: 'new',
        label: 'Changeover',
      },
      {
        id: 'g1',
        rowId: 'imm5',
        start: at(3),
        end: at(40),
        kind: 'jobcard',
        ghost: true,
        change: 'new',
        label: 'Housing-A – stock',
      },
    ],
    feasibility: { feasible: true, slackHours: 20, shortfall: 0 },
    delays: [],
  },
});

const maintenance = {
  proposal: {
    _id: 'pm1',
    proposalCode: 'PLN-4',
    kind: 'maintenance',
    title: 'Quality check – Press 1',
    status: 'draft',
    expiresAt: at(12),
    createdAt: at(0),
    recommendedOption: 'insert',
    feasibility: { feasible: true, maxDelayHours: 1.5, notes: [] },
    risks: [],
    alternatives: [],
    explanation: null,
  },
  plan: {
    ...gantt(),
    bars: [
      {
        id: 'wo-new',
        rowId: 'p1',
        start: at(4),
        end: at(5.5),
        kind: 'maintenance',
        ghost: true,
        change: 'new',
        label: 'Quality check',
      },
      {
        id: 'jc14',
        code: 'JC-14',
        rowId: 'p1',
        start: at(-1),
        end: at(21.5),
        kind: 'jobcard',
        ghost: true,
        change: 'extended',
        from: { start: at(-1), end: at(20) },
      },
    ],
    delays: [{ jobCardId: 'jc14', code: 'JC-14', rowId: 'p1', hours: 1.5, late: false }],
    options: [
      {
        id: 'insert',
        label: 'Insert into JC-14',
        lateHours: 0,
        delayHours: 1.5,
        maintenanceLateHours: 0,
        recommended: true,
      },
      {
        id: 'move',
        label: 'Move the rest of JC-14 to Press 2',
        lateHours: 0,
        delayHours: 0.5,
        maintenanceLateHours: 0,
        recommended: false,
      },
      {
        id: 'defer',
        label: 'Defer to Sunday',
        lateHours: 0,
        delayHours: 0,
        maintenanceLateHours: 30,
        recommended: false,
        risk: 'Runs 30 h after the AI deadline (urgency 8 h)',
      },
    ],
  },
};

const me = {
  user: { id: 'u1', name: 'Vikram Mehta' },
  context: {
    role: 'owner',
    plantId: null,
    plantLocked: false,
    company: { isPlatform: false, name: 'Acme Components', timeZone: 'Asia/Kolkata' },
    plants: [{ _id: 'pl1', name: 'Pune' }],
    modules: ['jobcards', 'workorders', 'planproposals'],
    can: { jobcards: { create: true }, workorders: { create: true } },
  },
};

const reply = (status, data) => ({ ok: status < 400, status, json: async () => data });
let applyMode = 'ok';
let appliedOnce = false;
const fetchMock = vi.fn(async (url, init = {}) => {
  const path = String(url).replace(/^.*?\/api/, '');
  const method = init.method ?? 'GET';
  if (path === '/auth/me') return reply(200, me);
  if (path.startsWith('/planning/calendar?')) {
    return reply(200, {
      gantt: gantt(),
      machines: [
        { assetId: 'imm5', freeHours: 40 },
        { assetId: 'p1', freeHours: 12 },
      ],
    });
  }
  if (path.startsWith('/planning/proposals?')) return reply(200, { items: [production().proposal] });
  if (path === '/planning/parts') {
    return reply(200, {
      parts: [
        { partName: 'Housing-A', tools: [{ id: 't101', toolNumber: 'T-101', assets: ['IMM 1', 'IMM 2'] }] },
      ],
    });
  }
  if (path === '/planning/proposals/pp1') {
    // 'flaky': the API restarts right after the apply, so the refetch fails.
    if (applyMode === 'flaky' && appliedOnce) return reply(502, { error: { message: 'Bad gateway' } });
    return reply(200, production());
  }
  if (path === '/planning/proposals/pp2')
    return reply(200, production('pp2', 'PLN-5', { title: 'Updated Housing-A plan' }));
  if (path === '/planning/proposals/pm1') return reply(200, maintenance);
  if (path === '/planning/proposals/pp1/apply' && method === 'POST') {
    appliedOnce = true;
    if (applyMode === 'changed') {
      return reply(409, {
        error: {
          code: 'PLAN_CHANGED',
          message: 'The schedule changed since this plan was made. Here is an updated plan.',
          details: { proposalId: 'pp2', proposalCode: 'PLN-5' },
        },
      });
    }
    return reply(200, {
      proposal: { ...production().proposal, status: 'applied' },
      created: [{ module: 'jobcards', id: 'j1', label: 'JC-21', link: '/m/jobcards/j1' }],
      updated: [],
    });
  }
  if (path === '/planning/proposals/pm1/apply' && method === 'POST') {
    return reply(200, { proposal: { ...maintenance.proposal, status: 'applied' }, created: [], updated: [] });
  }
  if (path === '/planning/production' && method === 'POST') return reply(201, production());
  if (path === '/planning/maintenance' && method === 'POST') return reply(201, maintenance);
  return reply(404, { error: { message: `Unexpected ${method} ${path}` } });
});

const sent = (method, path) => {
  const call = fetchMock.mock.calls.find(
    ([url, init = {}]) => String(url).endsWith(`/api${path}`) && (init.method ?? 'GET') === method,
  );
  return call && (call[1].body ? JSON.parse(call[1].body) : null);
};

const Where = () => <p data-testid="where">{useLocation().search}</p>;

const renderAt = (ui, path = '/planner') =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[path]}>
        <TooltipProvider>
          {ui}
          <Where />
        </TooltipProvider>
        <Toaster />
      </MemoryRouter>
    </QueryClientProvider>,
  );

beforeEach(() => {
  applyMode = 'ok';
  appliedOnce = false;
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
});
afterEach(() => {
  cleanup();
  fetchMock.mockClear();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('feasibilityOf', () => {
  it('words production and maintenance feasibility', () => {
    expect(feasibilityOf({ feasible: true, slackHours: 20, shortfall: 0 }).label).toBe('On time');
    expect(feasibilityOf({ feasible: false, slackHours: -6, shortfall: 0 }).label).toBe('Late 6 h');
    expect(feasibilityOf({ feasible: false, slackHours: -6, shortfall: 1200 }).label).toBe('Short 1,200 pcs');
    expect(feasibilityOf({ feasible: true, maxDelayHours: 1.5 }, 'maintenance').label).toBe('Delays 1.5 h');
    expect(feasibilityOf({ feasible: false }, 'maintenance').tone).toBe('critical');
    expect(feasibilityOf(null)).toBeNull();
  });
});

describe('Gantt', () => {
  it('draws focusable bars with details, markers and a legend', () => {
    renderAt(<Gantt data={{ ...gantt(), delays: [] }} />);
    expect(screen.getByText('IMM', { selector: 'p' })).toBeTruthy();
    const bar = screen.getByRole('button', { name: /JC-14 · Bracket-C – stock/ });
    expect(bar.getAttribute('aria-label')).toMatch(/In Progress\. 40% done/);
    fireEvent.focus(bar);
    expect(screen.getAllByText('JC-14 · Bracket-C – stock').length).toBeGreaterThan(0);
    expect(screen.getByRole('link', { name: /warning anomaly: ANM-7/ }).getAttribute('href')).toBe(
      '/anomalies?open=anm7',
    );
    expect(screen.getByText('Open anomaly')).toBeTruthy();
    fireEvent.click(bar);
    expect(screen.getByTestId('where').textContent).toBe('');
  });

  it('starts a shift label right of the Now pill instead of under it', () => {
    const t0 = Date.parse('2026-10-16T00:00:00Z');
    const iso = (h) => new Date(t0 + h * H).toISOString();
    const data = {
      ...gantt(),
      range: { start: iso(0), end: iso(72) },
      shifts: [{ name: 'B', start: iso(10), end: iso(18) }],
    };
    renderAt(<Gantt data={data} now={iso(10)} />);
    const pill = screen.getAllByText('Now').find((el) => el.className.includes('bg-critical'));
    const label = screen.getByText('Shift B');
    expect(Number.parseFloat(label.style.left)).toBeGreaterThan(Number.parseFloat(pill.style.left));
  });

  it('shows an empty state without machines', () => {
    renderAt(<Gantt data={{ ...gantt(), rows: [] }} compact />);
    expect(screen.getByText('No machines to show')).toBeTruthy();
  });
});

describe('PlannerPage', () => {
  it('shows a proposal as ghost bars and confirms it', async () => {
    renderAt(<PlannerPage />, '/planner?proposal=pp1');
    expect(await screen.findByText('Machine schedule')).toBeTruthy();
    expect(
      await screen.findByRole('button', { name: /Housing-A – stock.*Proposed by SARA \(new\)/ }),
    ).toBeTruthy();
    expect(screen.getByText('Showing PLN-3')).toBeTruthy();
    expect(screen.getByText('Three moulds share the order so it lands a day early.')).toBeTruthy();
    expect(screen.getByText(/Generated by gemini-3.5-flash/)).toBeTruthy();
    expect(screen.getAllByText('On time').length).toBeGreaterThan(0);
    expect(screen.getByText(/PM-1 \(Monthly PM – IMM 1\)/)).toBeTruthy();
    expect(await screen.findByText('52 h free', { exact: false })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Confirm plan' }));
    expect(await screen.findByText('Applied PLN-3')).toBeTruthy();
    expect(sent('POST', '/planning/proposals/pp1/apply')).toEqual({});
  });

  it('keeps the applied plan on screen, without ghost bars, when the refetch after Confirm fails', async () => {
    applyMode = 'flaky';
    renderAt(<PlannerPage />, '/planner?proposal=pp1');
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm plan' }));
    expect(await screen.findByText('Applied PLN-3')).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('button', { name: /Proposed by SARA (new)/ })).toBeNull());
    expect(screen.queryByText("Couldn't load this plan.")).toBeNull();
    expect(screen.getByRole('link', { name: /JC-21/ })).toBeTruthy();
  });

  it('switches to the updated plan when the schedule changed', async () => {
    applyMode = 'changed';
    renderAt(<PlannerPage />, '/planner?proposal=pp1');
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm plan' }));
    expect(await screen.findByText('Plan changed — showing the updated plan')).toBeTruthy();
    expect(await screen.findByText('Updated Housing-A plan')).toBeTruthy();
    expect(screen.getByTestId('where').textContent).toBe('?proposal=pp2');
  });

  it('plans maintenance from the deep link and applies the chosen option', async () => {
    renderAt(<PlannerPage />, '/planner?maintenance=p1&anomaly=anm7');
    await waitFor(() =>
      expect(sent('POST', '/planning/maintenance')).toEqual({ assetId: 'p1', anomalyId: 'anm7' }),
    );
    expect(await screen.findByText('Quality check – Press 1')).toBeTruthy();
    expect(screen.getByTestId('where').textContent).toBe('?proposal=pm1');
    expect(
      fetchMock.mock.calls.filter(
        ([u, i = {}]) => String(u).endsWith('/planning/maintenance') && i.method === 'POST',
      ),
    ).toHaveLength(1);

    const options = screen.getByRole('group', { name: 'Choose how to fit the work in' });
    expect(within(options).getByRole('radio', { name: /Insert into JC-14.*Recommended/ }).checked).toBe(true);
    expect(within(options).getByText('Runs 30 h after the AI deadline (urgency 8 h)')).toBeTruthy();
    expect(screen.getAllByText(/JC-14 \+1\.5 h/).length).toBeGreaterThan(0);
    // explanation null → deterministic line + chip
    expect(screen.getByText('Least delay: Insert into JC-14')).toBeTruthy();
    expect(screen.getByText('AI explanation unavailable')).toBeTruthy();
    // the extended ghost replaces the current JC-14 bar, the old slot is outlined
    expect(screen.getAllByRole('button', { name: /^JC-14/ })).toHaveLength(1);

    fireEvent.click(within(options).getByRole('radio', { name: /Move the rest/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm plan' }));
    await waitFor(() => expect(sent('POST', '/planning/proposals/pm1/apply')).toEqual({ option: 'move' }));
  });

  it('auto-plans production from the form', async () => {
    renderAt(<PlannerPage />);
    const part = await screen.findByRole('combobox', { name: /Part/ });
    await screen.findByRole('option', { name: /Housing-A · 1 mould/ });
    fireEvent.click(screen.getByRole('button', { name: 'Auto-plan production' }));
    expect(await screen.findByText('Pick a part')).toBeTruthy();

    fireEvent.change(part, { target: { value: 'Housing-A' } });
    expect(screen.getByText('Moulds: T-101 (IMM 1, IMM 2)')).toBeTruthy();
    fireEvent.change(screen.getByRole('spinbutton', { name: /Quantity/ }), { target: { value: '5000' } });
    fireEvent.change(screen.getByLabelText(/Due date/), { target: { value: '2026-10-25' } });
    fireEvent.click(screen.getByRole('button', { name: 'Auto-plan production' }));
    await waitFor(() =>
      expect(sent('POST', '/planning/production')).toEqual({
        partName: 'Housing-A',
        quantity: 5000,
        dueDate: '2026-10-25T18:29:59.000Z',
      }),
    );
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('?proposal=pp1'));
  });
});

describe('plan blocks', () => {
  it('renders the chat plan block with a Planner link', () => {
    const { plan } = maintenance;
    renderAt(
      <PlanBlock
        payload={{
          ...plan,
          title: 'Quality check – Press 1',
          proposal: { id: 'pm1', code: 'PLN-4', kind: 'maintenance', status: 'draft' },
          feasibility: maintenance.proposal.feasibility,
        }}
      />,
    );
    expect(screen.getByText('PLN-4 · Maintenance plan')).toBeTruthy();
    expect(screen.getByText('Delays 1.5 h')).toBeTruthy();
    expect(screen.getByText('Defer to Sunday')).toBeTruthy();
    expect(screen.getByRole('link', { name: /Open in Planner/ }).getAttribute('href')).toBe(
      '/planner?proposal=pm1',
    );
  });

  it('renders the confirm preview with the ops', () => {
    renderAt(
      <PlanPreview
        payload={{
          tool: 'apply_plan',
          action: 'plan',
          option: 'insert',
          proposal: { id: 'pm1', code: 'PLN-4', kind: 'maintenance' },
          ops: [
            {
              seq: 0,
              op: 'create',
              module: 'workorders',
              label: 'Create work order "Quality check"',
              summary: 'Press 1, 1.5 h',
            },
            { seq: 1, op: 'update', module: 'jobcards', label: 'Update JC-14', summary: 'ends 1.5 h later' },
          ],
          plan: { ...maintenance.plan, feasibility: maintenance.proposal.feasibility },
        }}
      />,
    );
    expect(screen.getByText('Insert into JC-14')).toBeTruthy();
    expect(screen.getByText('Update JC-14')).toBeTruthy();
    expect(screen.getByLabelText('Create')).toBeTruthy();
  });
});
