import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import { Toaster } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '../ui/overlay.jsx';
import { Gantt } from './Gantt.jsx';
import { JobCardTable } from './JobCardTable.jsx';
import { feasibilityOf, PlanBlock, PlanPreview } from './PlanBlock.jsx';
import { PlanHeader, VerdictCard } from './PlanHeader.jsx';
import { PlannerPage } from './PlannerPage.jsx';

const H = 36e5;
const NOW = Date.now();
const at = (h) => new Date(NOW + h * H).toISOString();

const rows = [
  {
    id: 'imm5',
    label: 'IMM 5',
    sub: 'IMM-05 · 85 %',
    status: 'Running',
    health: 82,
    group: 'Injection Moulding Machine',
  },
  { id: 'p1', label: 'Press 1', sub: 'PRS-01 · 85 %', status: 'Idle', health: 64, group: 'Power Press' },
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

const card = (extra = {}) => ({
  key: 'op-1',
  assetId: 'imm5',
  asset: 'IMM 5',
  toolId: 't101',
  tool: 'T-101',
  target: 5000,
  start: at(3),
  end: at(40),
  finishAt: at(40),
  setupMin: 45,
  shots: 2500,
  operators: [{ userId: 'u-sachin', name: 'Sachin Pawar', shiftName: 'A', start: at(3), end: at(11) }],
  issues: [],
  ...extra,
});
const feasibility = {
  feasible: true,
  verdict: 'doable',
  dueDate: at(60),
  projectedFinish: at(40),
  slackHours: 20,
  shortfall: 0,
  notes: 'Finishes 20 h before the due date',
};
const planPayload = () => ({
  ...gantt(),
  title: '5,000 × Housing-A by 25-10-2026',
  bars: [
    ...gantt().bars,
    {
      id: 'op-1',
      rowId: 'imm5',
      start: at(3),
      end: at(40),
      kind: 'jobcard',
      ghost: true,
      change: 'new',
      label: 'Housing-A · 5,000 pcs',
      tooltip: 'T-101 · Sachin Pawar',
    },
  ],
  feasibility,
  delays: [],
  verdict: 'doable',
  jobCards: [card()],
});
const explanation = {
  text: 'Doable: 5,000 × Housing-A fits on IMM 5 with 1 operator shift assigned.\n• IMM 5: 5,000 pcs with T-101',
  model: 'gemini-3.5-flash',
  at: at(-0.1),
};
const production = (id = 'pp1', code = 'PLN-3', extra = {}) => ({
  proposal: {
    _id: id,
    proposalCode: code,
    kind: 'production',
    title: '5,000 × Housing-A by 25-10-2026',
    status: 'draft',
    expiresAt: at(12),
    createdAt: at(-0.2),
    input: { partName: 'Housing-A', quantity: 5000, dueDate: at(60) },
    feasibility,
    issues: [],
    adjustments: [],
    risks: [{ kind: 'pm_due', severity: 'warning', text: 'PM-1 (Monthly PM – IMM 1) is due on IMM 1' }],
    diff: { bars: [], delays: [], jobCards: [card()] },
    explanation,
    ...extra,
  },
  plan: planPayload(),
});
const checkOk = () => ({
  verdict: 'doable',
  feasibility,
  issues: [],
  adjustments: [],
  jobCards: [card()],
  risks: [],
  plan: planPayload(),
  explanation,
});
const checkBad = () => ({
  verdict: 'not_doable',
  feasibility: { ...feasibility, feasible: false, verdict: 'not_doable' },
  issues: [
    {
      kind: 'machine_overlap',
      severity: 'critical',
      text: 'Press 1 is busy with JC-14 until then',
      jobCard: 'op-1',
    },
  ],
  adjustments: [
    {
      id: 'adj-1',
      kind: 'move_start',
      label: 'Start after JC-14 ends',
      patch: { jobCards: [{ key: 'op-1', start: at(21), end: at(58) }] },
      resolves: [0],
    },
  ],
  jobCards: [card({ assetId: 'p1', asset: 'Press 1', issues: [0] })],
  risks: [],
  plan: {
    ...planPayload(),
    bars: planPayload().bars.map((b) => (b.ghost ? { ...b, rowId: 'p1', conflict: true } : b)),
  },
  explanation: {
    text: 'Not doable: Press 1 is busy with JC-14 until then.',
    model: 'gemini-3.5-flash',
    at: at(0),
  },
});

const task = {
  key: 't-1',
  kind: 'anomaly',
  refId: 'anm7',
  code: 'ANM-7',
  assetId: 'p1',
  asset: 'Press 1',
  assetType: 'Power Press',
  title: 'Quality check',
  category: 'Inspection',
  priority: 'High',
  durationMin: 90,
  deadline: at(8),
  start: at(4),
  end: at(5.5),
  impactHours: 1.5,
  impactCost: 6750,
  zeroImpact: false,
  late: false,
  technician: { userId: 'u-arjun', name: 'Arjun Rao', shiftName: 'B' },
  issues: [],
};
const metrics = {
  tasks: 1,
  zeroImpactTasks: 0,
  productionHoursLost: 1.5,
  naiveProductionHoursLost: 3,
  productionImpactCost: 6750,
  naiveProductionImpactCost: 13500,
  downtimeCostAvoided: 6750,
};
const maintenancePlan = () => ({
  proposal: {
    _id: 'pm1',
    proposalCode: 'PLN-5',
    kind: 'maintenance_plan',
    title: 'Maintenance plan – Press 1',
    status: 'draft',
    expiresAt: at(12),
    createdAt: at(0),
    plantId: 'pl1',
    input: { scope: 'assets', assetIds: ['p1'], objective: 'protect_production' },
    feasibility: { feasible: true, verdict: 'doable', dueDate: at(8), projectedFinish: at(5.5), notes: [] },
    issues: [],
    adjustments: [],
    metrics,
    risks: [],
    diff: { bars: [], delays: [], tasks: [task] },
    explanation: null,
  },
  plan: {
    ...gantt(),
    bars: [
      ...gantt().bars,
      {
        id: 'mnt-anm7',
        rowId: 'p1',
        start: at(4),
        end: at(5.5),
        kind: 'maintenance',
        ghost: true,
        change: 'new',
        label: 'Quality check',
      },
    ],
    delays: [],
    metrics,
    tasks: [task],
  },
  check: {
    verdict: 'doable',
    feasibility: { feasible: true, verdict: 'doable', dueDate: at(8), projectedFinish: at(5.5) },
    issues: [],
    adjustments: [],
    tasks: [task],
    metrics,
    impactDelta: { hours: 0, cost: 0 },
    risks: [],
    plan: null,
    explanation: null,
    aiError: { code: 'AI_UNAVAILABLE', message: 'The AI is busy right now' },
  },
});

const people = {
  people: [
    {
      userId: 'u-sachin',
      name: 'Sachin Pawar',
      shift: 'A',
      skills: ['moulding'],
      skillMatch: true,
      free: true,
      busy: [],
    },
    {
      userId: 'u-deepak',
      name: 'Deepak More',
      shift: 'A',
      skills: ['press'],
      skillMatch: false,
      free: false,
      busy: [{ kind: 'jobcard', code: 'JC-14' }],
    },
    {
      userId: 'u-arjun',
      name: 'Arjun Rao',
      shift: 'B',
      skills: ['hydraulics'],
      skillMatch: true,
      free: true,
      busy: [],
    },
    {
      userId: 'u-priya',
      name: 'Priya Nair',
      shift: 'C',
      skills: ['utilities'],
      skillMatch: false,
      free: false,
      busy: [],
    },
  ],
};

const me = {
  user: { id: 'u1', name: 'Vikram Mehta' },
  context: {
    role: 'owner',
    plantId: null,
    plantLocked: false,
    company: { isPlatform: false, name: 'Acme Components', timeZone: 'Asia/Kolkata' },
    plants: [{ _id: 'pl1', name: 'Pune' }],
    modules: ['jobcards', 'workorders', 'planproposals', 'productionplans', 'maintenanceplans'],
    can: { jobcards: { create: true }, workorders: { create: true } },
  },
};

const reply = (status, data) => ({ ok: status < 400, status, json: async () => data });
let applyMode = 'ok';
const fetchMock = vi.fn(async (url, init = {}) => {
  const path = String(url).replace(/^.*?\/api/, '');
  const method = init.method ?? 'GET';
  const body = init.body ? JSON.parse(init.body) : null;
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
  if (path.startsWith('/planning/proposals?')) {
    const kind = new URLSearchParams(path.split('?')[1]).get('kind') ?? '';
    return reply(200, {
      items: kind.startsWith('maintenance') ? [maintenancePlan().proposal] : [production().proposal],
    });
  }
  if (path.startsWith('/planning/people?')) return reply(200, people);
  if (path.startsWith('/m/assets?'))
    return reply(200, {
      items: [
        { _id: 'p1', name: 'Press 1' },
        { _id: 'imm5', name: 'IMM 5' },
      ],
      total: 2,
    });
  if (path.startsWith('/m/productionplans?')) {
    return reply(200, {
      items: [
        {
          _id: 'plan0',
          reqId: 'PP-6',
          partName: 'Cap-B',
          quantity: 2000,
          dueDate: at(50),
          status: 'Planned',
          feasibility: { verdict: 'doable', slackHours: 12 },
        },
      ],
      total: 1,
    });
  }
  if (path.startsWith('/m/maintenanceplans?')) {
    return reply(200, {
      items: [{ _id: 'mp0', planCode: 'MP-2', name: 'Maintenance plan – Pune', status: 'planned', metrics }],
      total: 1,
    });
  }
  if (path === '/planning/parts') {
    return reply(200, {
      parts: [
        {
          partName: 'Housing-A',
          tools: [
            {
              id: 't101',
              toolNumber: 'T-101',
              assets: [
                { id: 'imm5', label: 'IMM 5' },
                { id: 'p1', label: 'Press 1' },
              ],
            },
          ],
        },
      ],
    });
  }
  if (path === '/planning/proposals/pp1') return reply(200, production());
  if (path === '/planning/proposals/pp2')
    return reply(200, production('pp2', 'PLN-4', { title: 'Updated Housing-A plan' }));
  if (path === '/planning/proposals/pm1')
    return reply(200, { proposal: maintenancePlan().proposal, plan: maintenancePlan().plan });
  if (path === '/planning/production' && method === 'POST')
    return reply(200, { ...production(), check: checkOk() });
  if (path === '/planning/production/check' && method === 'POST') {
    const c = body.jobCards[0].start === at(21) ? checkOk() : checkBad();
    return reply(200, {
      ...c,
      proposal: { ...production().proposal, feasibility: c.feasibility, explanation: c.explanation },
    });
  }
  if (path === '/planning/maintenance/plan' && method === 'POST') return reply(200, maintenancePlan());
  if (path === '/planning/maintenance/check' && method === 'POST') return reply(200, maintenancePlan().check);
  if (path === '/planning/proposals/pp1/apply' && method === 'POST') {
    if (applyMode === 'changed') {
      return reply(409, {
        error: {
          code: 'PLAN_CHANGED',
          message: 'The schedule changed since this plan was made. Here is an updated plan.',
          details: { proposalId: 'pp2', proposalCode: 'PLN-4' },
        },
      });
    }
    if (applyMode === 'not_doable') {
      return reply(409, {
        error: {
          code: 'PLAN_NOT_DOABLE',
          message: 'The last check found the plan not doable; adjust it or force',
          details: { verdict: 'not_doable' },
        },
      });
    }
    return reply(200, {
      proposal: { ...production().proposal, status: 'applied' },
      created: [
        { module: 'productionplans', id: 'plan1', label: 'PP-7', link: '/m/productionplans/plan1' },
        { module: 'jobcards', id: 'j1', label: 'JC-21', link: '/m/jobcards/j1' },
      ],
      updated: [],
    });
  }
  if (path === '/planning/proposals/pm1/apply' && method === 'POST') {
    return reply(200, {
      proposal: { ...maintenancePlan().proposal, status: 'applied' },
      created: [{ module: 'maintenanceplans', id: 'mp1', label: 'MP-3', link: '/m/maintenanceplans/mp1' }],
      updated: [],
    });
  }
  return reply(404, { error: { message: `Unexpected ${method} ${path}` } });
});

const sent = (method, path, nth = 0) => {
  const calls = fetchMock.mock.calls.filter(
    ([url, init = {}]) => String(url).endsWith(`/api${path}`) && (init.method ?? 'GET') === method,
  );
  const call = calls[nth];
  return call && (call[1].body ? JSON.parse(call[1].body) : null);
};

const Where = () => {
  const l = useLocation();
  return <p data-testid="where">{l.pathname + l.search}</p>;
};

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

const stubMedia = (matches) =>
  vi.stubGlobal('matchMedia', () => ({ matches, addEventListener() {}, removeEventListener() {} }));

beforeEach(() => {
  applyMode = 'ok';
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
    expect(screen.getByText('Injection Moulding Machine', { selector: 'p' })).toBeTruthy();
    const bar = screen.getByRole('button', { name: /JC-14 · Bracket-C – stock/ });
    expect(bar.getAttribute('aria-label')).toMatch(/In Progress\. 40% done/);
    fireEvent.focus(bar);
    expect(screen.getAllByText('JC-14 · Bracket-C – stock').length).toBeGreaterThan(0);
    expect(screen.getByRole('link', { name: /warning anomaly: ANM-7/ }).getAttribute('href')).toBe(
      '/anomalies?open=anm7',
    );
    expect(screen.getByText('Open anomaly')).toBeTruthy();
  });

  it('marks a conflicting ghost bar and lists operators in its description', () => {
    renderAt(
      <Gantt data={{ ...gantt(), bars: [{ ...planPayload().bars[1], conflict: true }], delays: [] }} />,
    );
    const bar = screen.getByRole('button', { name: /Housing-A · 5,000 pcs/ });
    expect(bar.getAttribute('aria-label')).toMatch(/Conflicts with another booking\. T-101 · Sachin Pawar/);
    expect(bar.className).toContain('ring-critical');
    expect(screen.getByText('Late or conflict')).toBeTruthy();
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

describe('PlannerPage · Production', () => {
  it('plans from the form, edits a machine, checks, applies the suggestion and creates the plan', async () => {
    renderAt(<PlannerPage />);
    const part = await screen.findByRole('combobox', { name: /Part/ });
    await screen.findByRole('option', { name: /Housing-A · 1 mould/ });
    fireEvent.click(screen.getByRole('button', { name: 'Plan with SARA' }));
    expect(await screen.findByText('Pick a part')).toBeTruthy();

    fireEvent.change(part, { target: { value: 'Housing-A' } });
    expect(screen.getByText('T-101 · IMM 5, Press 1')).toBeTruthy();
    fireEvent.change(screen.getByRole('spinbutton', { name: /Quantity/ }), { target: { value: '5000' } });
    fireEvent.change(screen.getByLabelText(/Due date/), { target: { value: '2026-10-25' } });
    fireEvent.click(screen.getByRole('button', { name: 'Plan with SARA' }));
    await waitFor(() =>
      expect(sent('POST', '/planning/production')).toEqual({
        partName: 'Housing-A',
        quantity: 5000,
        dueDate: '2026-10-25T18:29:59.000Z',
      }),
    );

    // the plan: header, AI summary with provenance, editable row, verdict
    expect(await screen.findByText('5,000 × Housing-A by 25-10-2026', { selector: 'h2' })).toBeTruthy();
    expect(screen.getByTestId('where').textContent).toBe('/planner?tab=production&proposal=pp1');
    expect(screen.getByText(/becomes PP-n on create/)).toBeTruthy();
    expect(screen.getByText(/fits on IMM 5 with 1 operator shift/)).toBeTruthy();
    expect(screen.getByText(/Generated by gemini-3.5-flash/)).toBeTruthy();
    expect(screen.getAllByText('Doable').length).toBeGreaterThan(0);
    expect(screen.getByText('No conflicts found.')).toBeTruthy();
    const check = screen.getByRole('button', { name: 'Check plan' });
    const create = screen.getByRole('button', { name: 'Create plan' });
    expect(check.disabled).toBe(true);
    expect(create.disabled).toBe(false);

    // operators: one native select per shift segment, free people first, busy disabled
    const operator = (await screen.findAllByRole('combobox', { name: /Operator of op-1/ }))[0];
    await within(operator).findByRole('option', { name: 'Sachin Pawar · A · fits' });
    expect(within(operator).getByRole('option', { name: 'Deepak More · busy: JC-14' }).disabled).toBe(true);
    expect(operator.value).toBe('u-sachin');

    // edit the machine → dirty → Check enabled, Create disabled
    const machine = screen.getByRole('combobox', { name: 'Machine of op-1' });
    expect(
      within(machine)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['IMM 5', 'Press 1']);
    fireEvent.change(machine, { target: { value: 'p1' } });
    expect(check.disabled).toBe(false);
    expect(create.disabled).toBe(true);
    expect(screen.getByText('Check the plan before creating it.')).toBeTruthy();

    fireEvent.click(check);
    await waitFor(() =>
      expect(sent('POST', '/planning/production/check')).toMatchObject({
        proposalId: 'pp1',
        partName: 'Housing-A',
        quantity: 5000,
      }),
    );
    expect(sent('POST', '/planning/production/check').jobCards[0]).toMatchObject({
      key: 'op-1',
      assetId: 'p1',
      toolId: 't101',
      target: 5000,
    });
    expect(sent('POST', '/planning/production/check').jobCards[0].operators[0]).toMatchObject({
      userId: 'u-sachin',
      shiftName: 'A',
    });

    // not doable: issue linked to the row, suggestion, Create still blocked
    const result = await screen.findByLabelText('Check result');
    expect(within(result).getAllByText('Not doable').length).toBeGreaterThan(0);
    expect(within(result).getByText(/Press 1 is busy with JC-14/)).toBeTruthy();
    expect(
      within(result)
        .getByRole('link', { name: /Go to row/ })
        .getAttribute('href'),
    ).toBe('#row-op-1');
    expect(screen.getByText('Machine overlap')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Create plan' }).disabled).toBe(true);
    expect(
      screen.getByRole('button', { name: /Housing-A · 5,000 pcs.*Conflicts with another booking/ }),
    ).toBeTruthy();

    // Apply suggestion patches the row and re-checks → doable → Create plan → navigates to the record
    fireEvent.click(within(result).getByRole('button', { name: 'Apply suggestion' }));
    await waitFor(() =>
      expect(sent('POST', '/planning/production/check', 1)?.jobCards[0].start).toBe(at(21)),
    );
    await waitFor(() => expect(screen.getByRole('button', { name: 'Create plan' }).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Create plan' }));
    await waitFor(() => expect(sent('POST', '/planning/proposals/pp1/apply')).toEqual({}));
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/m/productionplans/plan1'));
  });

  it('switches to the updated plan when the schedule changed, and offers force when not doable', async () => {
    applyMode = 'changed';
    renderAt(<PlannerPage />, '/planner?proposal=pp1');
    fireEvent.click(await screen.findByRole('button', { name: 'Create plan' }));
    expect(await screen.findByText('Plan changed — showing the updated plan')).toBeTruthy();
    expect(await screen.findByText('Updated Housing-A plan', { selector: 'h2' })).toBeTruthy();
    expect(screen.getByTestId('where').textContent).toBe('/planner?tab=production&proposal=pp2');
    cleanup();
    fetchMock.mockClear();

    applyMode = 'not_doable';
    renderAt(<PlannerPage />, '/planner?proposal=pp1');
    fireEvent.click(await screen.findByRole('button', { name: 'Create plan' }));
    expect(await screen.findByText('The last check found this plan not doable')).toBeTruthy();
    applyMode = 'ok';
    fireEvent.click(screen.getByRole('button', { name: 'Create anyway' }));
    await waitFor(() => expect(sent('POST', '/planning/proposals/pp1/apply', 1)).toEqual({ force: true }));
  });

  it('lists suggested plans and created plan records', async () => {
    renderAt(<PlannerPage />);
    expect(await screen.findByRole('button', { name: /PLN-3/ })).toBeTruthy();
    const link = await screen.findByRole('link', { name: /PP-6.*Cap-B/ });
    expect(link.getAttribute('href')).toBe('/m/productionplans/plan0');
    expect(within(link).getByText('Planned')).toBeTruthy();
    expect(within(link).getByText(/2,000 pcs/)).toBeTruthy();
    // Discarded and expired drafts stay out of the list until asked for.
    const lists = () =>
      fetchMock.mock.calls
        .map(([url]) => String(url))
        .filter((u) => u.includes('/planning/proposals?') && u.includes('kind=production'));
    expect(lists().every((u) => new URL(u, 'http://x').searchParams.get('status')?.includes('draft'))).toBe(
      true,
    );
    expect(
      lists().some((u) => new URL(u, 'http://x').searchParams.get('status')?.includes('discarded')),
    ).toBe(false);
    fireEvent.click(screen.getAllByRole('button', { name: 'Show discarded' })[0]);
    await waitFor(() =>
      expect(lists().some((u) => !new URL(u, 'http://x').searchParams.has('status'))).toBe(true),
    );
  });

  it('renders the job cards as stacked cards below md', async () => {
    stubMedia(true);
    renderAt(<PlannerPage />, '/planner?proposal=pp1');
    expect(await screen.findByRole('list', { name: 'Job cards' })).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.getByRole('combobox', { name: 'Machine of op-1' })).toBeTruthy();
  });

  it('stacks the job cards when the result column is narrower than the table, even on a wide screen', async () => {
    stubMedia(false);
    const width = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(700);
    try {
      renderAt(<PlannerPage />, '/planner?proposal=pp1');
      expect(await screen.findByRole('list', { name: 'Job cards' })).toBeTruthy();
      expect(screen.queryByRole('table')).toBeNull();
    } finally {
      width.mockRestore();
    }
  });

  it('gives an open plan both grid columns so its tables fit, and drops the form below it', async () => {
    stubMedia(false);
    renderAt(<PlannerPage />, '/planner?proposal=pp1');
    const cell = (await screen.findByText('5,000 × Housing-A by 25-10-2026', { selector: 'h2' })).closest(
      '.min-w-0.space-y-4',
    );
    expect(cell.className).toContain('lg:col-span-2');
    const form = screen.getByRole('button', { name: /Plan with SARA/ }).closest(String.raw`.lg\:col-start-2`);
    expect(form.className).toContain('lg:row-start-2');
    cleanup();
    renderAt(<PlannerPage />);
    const schedule = (await screen.findAllByText('Machine schedule'))[0].closest('.min-w-0.space-y-4');
    expect(schedule.className).not.toContain('lg:col-span-2');
  });
});

describe('PlannerPage · Maintenance', () => {
  it('pre-fills and runs the deep link, then shows the plan with metrics, tasks and the fallback line', async () => {
    renderAt(<PlannerPage />, '/planner?maintenance=p1&anomaly=anm7');
    await waitFor(() =>
      expect(sent('POST', '/planning/maintenance/plan')).toEqual({
        scope: 'assets',
        assetIds: ['p1'],
        horizonDays: 7,
        objective: 'protect_production',
        anomalyId: 'anm7',
      }),
    );
    expect(await screen.findByText('Maintenance plan – Press 1', { selector: 'h2' })).toBeTruthy();
    expect(screen.getByTestId('where').textContent).toBe('/planner?tab=maintenance&proposal=pm1');
    expect(
      fetchMock.mock.calls.filter(
        ([u, i = {}]) => String(u).endsWith('/planning/maintenance/plan') && i.method === 'POST',
      ),
    ).toHaveLength(1);
    expect(screen.getByRole('radio', { name: 'Selected machines' }).checked).toBe(true);
    expect(screen.getByRole('button', { name: 'Press 1', pressed: true })).toBeTruthy();

    // metrics tiles, the task row with its technician and impact, the AI fallback
    expect(screen.getAllByText('₹6,750').length).toBeGreaterThan(0);
    expect(screen.getByText('0 of 1')).toBeTruthy();
    expect(screen.getByText('Quality check')).toBeTruthy();
    expect(screen.getByText('1.5 h · ₹6,750')).toBeTruthy();
    const tech = screen.getByRole('combobox', { name: 'Technician of Quality check' });
    expect(tech.value).toBe('u-arjun');
    await within(tech).findByRole('option', { name: 'Arjun Rao · B · fits' });
    expect(screen.getByText('Doable: 1 tasks, 1.5 h of production moved')).toBeTruthy();
    expect(screen.getByText('AI explanation unavailable')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Quality check.*Proposed by SARA/ })).toBeTruthy();

    // a technician change marks the plan dirty; Check sends the edited tasks
    fireEvent.change(tech, { target: { value: 'u-priya' } });
    const check = screen.getByRole('button', { name: 'Check plan' });
    expect(check.disabled).toBe(false);
    fireEvent.click(check);
    await waitFor(() =>
      expect(sent('POST', '/planning/maintenance/check')).toEqual({
        proposalId: 'pm1',
        name: 'Maintenance plan – Press 1',
        objective: 'protect_production',
        tasks: [{ key: 't-1', start: at(4), end: at(5.5), durationMin: 90, technicianId: 'u-priya' }],
      }),
    );
    await waitFor(() => expect(screen.getByRole('button', { name: 'Create plan' }).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Create plan' }));
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/m/maintenanceplans/mp1'));
  });

  it('plans the whole plant from the form with the objective slider', async () => {
    renderAt(<PlannerPage />, '/planner?tab=maintenance');
    fireEvent.change(await screen.findByRole('slider', { name: 'Objective' }), { target: { value: '80' } });
    expect(screen.getByText('Fix fast', { selector: 'p' })).toBeTruthy();
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Days' }), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Plan with SARA' }));
    await waitFor(() =>
      expect(sent('POST', '/planning/maintenance/plan')).toEqual({
        scope: 'plant',
        horizonDays: 3,
        objective: 'fix_fast',
      }),
    );
  });
});

describe('plan blocks', () => {
  it('renders the chat plan block with verdict, operators and a Planner link', () => {
    const plan = planPayload();
    renderAt(
      <PlanBlock
        payload={{
          ...plan,
          proposal: { id: 'pp1', code: 'PLN-3', kind: 'production', status: 'draft' },
        }}
      />,
    );
    expect(screen.getByText('PLN-3 · Production plan')).toBeTruthy();
    expect(screen.getByText('Doable')).toBeTruthy();
    expect(screen.getByText(/Sachin Pawar/)).toBeTruthy();
    expect(screen.getByRole('link', { name: /Open in Planner/ }).getAttribute('href')).toBe(
      '/planner?proposal=pp1',
    );
  });

  it('renders the confirm preview with metrics, tasks and the ops', () => {
    const { plan } = maintenancePlan();
    renderAt(
      <PlanPreview
        payload={{
          tool: 'apply_plan',
          action: 'plan',
          proposal: { id: 'pm1', code: 'PLN-5', kind: 'maintenance_plan' },
          ops: [
            {
              seq: 0,
              op: 'create',
              module: 'maintenanceplans',
              label: 'Create maintenance plan',
              summary: '1 task',
            },
            {
              seq: 1,
              op: 'create',
              module: 'workorders',
              label: 'Create work order "Quality check"',
              summary: 'Press 1, 1.5 h',
            },
          ],
          plan: { ...plan, verdict: 'doable' },
        }}
      />,
    );
    expect(screen.getByText('Downtime cost avoided')).toBeTruthy();
    expect(screen.getByText(/Arjun Rao/)).toBeTruthy();
    expect(screen.getByText('Create work order "Quality check"')).toBeTruthy();
    expect(screen.getAllByLabelText('Create')).toHaveLength(2);
  });
});

describe('VerdictCard', () => {
  it('shows how much production an edit moves against the last check', () => {
    const check = {
      verdict: 'adjust',
      issues: [{ kind: 'jobcard_overlap', severity: 'warning', text: 'Pushes JC-30 on IMM 4', task: 't-3' }],
      adjustments: [],
      impactDelta: { hours: 1, cost: 5000 },
    };
    const { rerender } = render(<VerdictCard check={check} />);
    expect(screen.getByText(/Production impact \+1 h/).textContent).toMatch(/more than the last check/);
    rerender(<VerdictCard check={{ ...check, impactDelta: { hours: 0, cost: 0 } }} />);
    expect(screen.queryByText(/Production impact/)).toBeNull();
  });
});

describe('JobCardTable (read-only)', () => {
  it('names the operators of a plan that can no longer change instead of offering pickers', () => {
    const card = {
      key: 'op-1',
      assetId: 'imm4',
      toolId: 't1',
      target: 100,
      start: '2026-10-19T08:30:00.000Z',
      end: '2026-10-19T10:30:00.000Z',
      operators: [
        {
          userId: 'u-sunita',
          shiftName: null,
          start: '2026-10-19T08:30:00.000Z',
          end: '2026-10-19T10:30:00.000Z',
        },
      ],
    };
    render(
      <JobCardTable
        edited={{ partName: 'Housing-A', quantity: 100, jobCards: [card] }}
        check={{
          issues: [],
          jobCards: [{ ...card, operators: [{ userId: 'u-sunita', name: 'Sunita Kamble' }] }],
        }}
        machines={[{ id: 'imm4', label: 'IMM 4' }]}
      />,
    );
    expect(screen.getByText('Sunita Kamble')).toBeTruthy();
    expect(screen.queryByRole('combobox', { name: /Operator of op-1/ })).toBeNull();
  });
});

describe('PlanHeader', () => {
  it('marks a mock explanation as mock instead of crediting the model', () => {
    renderAt(
      <PlanHeader code="PLN-3" title="Plan" verdict="doable" explanation={{ ...explanation, mock: true }} />,
    );
    expect(screen.getByText(/gemini-3\.5-flash \(mock\)/)).toBeTruthy();
  });
});
