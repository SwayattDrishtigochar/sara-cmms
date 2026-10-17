import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { Toaster } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { refLabel } from '../lib/format.js';
import { TooltipProvider } from '../ui/overlay.jsx';
import { chainsOf } from './PlanChain.jsx';
import { isEmptyValue, RecordPage } from './RecordPage.jsx';

const H = 36e5;
const at = (h) => new Date(Date.UTC(2026, 9, 18, 0) + h * H).toISOString();

const field = (key, type, extra = {}) => ({ key, type, label: key, ...extra });
const modules = [
  {
    name: 'productionplans',
    label: 'Production Plans',
    singular: 'Production plan',
    icon: 'ClipboardList',
    codeField: 'reqId',
    titleField: 'partName',
    list: ['reqId', 'partName', 'quantity', 'status'],
    plantScoped: true,
    children: [{ module: 'jobcards', field: 'productionPlanId', label: 'Job cards', order: 0 }],
    fields: [
      field('reqId', 'string', { readOnly: true }),
      field('partName', 'string', { required: true }),
      field('quantity', 'number', { unit: 'pcs' }),
      field('status', 'enum', { values: ['Pending', 'Planned'] }),
      field('feasibility', 'object', {
        label: 'Feasibility',
        fields: [field('verdict', 'string'), field('slackHours', 'number'), field('issues', 'array')],
      }),
      field('aiSummary', 'object', {
        readOnly: true,
        label: 'Ai Summary',
        fields: [
          field('text', 'text'),
          field('model', 'string'),
          field('at', 'date'),
          field('mock', 'boolean'),
        ],
      }),
    ],
    actions: [],
    can: { read: true, create: true, update: true, delete: true },
  },
  {
    name: 'jobcards',
    label: 'Job Cards',
    singular: 'Job card',
    icon: 'ClipboardCheck',
    codeField: 'jobCardId',
    titleField: 'jobName',
    list: ['jobCardId', 'jobName', 'asset', 'target', 'jobStatus', 'startDate'],
    plantScoped: true,
    children: [],
    fields: [
      field('jobCardId', 'string', { readOnly: true }),
      field('jobName', 'string', { required: true, label: 'Job name' }),
      field('asset', 'ref', { ref: 'assets', label: 'Machine' }),
      field('productionPlanId', 'ref', { ref: 'productionplans', label: 'Production plan' }),
      field('target', 'number', { unit: 'pcs' }),
      field('jobStatus', 'enum', { values: ['Open', 'In Progress', 'Completed'], label: 'Status' }),
      field('startDate', 'date'),
      field('endDate', 'date'),
    ],
    actions: [],
    can: { read: true, create: true, update: true, delete: true },
  },
  {
    name: 'maintenanceplans',
    label: 'Maintenance Plans',
    singular: 'Maintenance plan',
    icon: 'CalendarCheck',
    codeField: 'planCode',
    titleField: 'name',
    list: ['planCode', 'name', 'status'],
    plantScoped: true,
    children: [{ module: 'workorders', field: 'maintenancePlanId', label: 'Work orders', order: 0 }],
    fields: [
      field('planCode', 'string', { readOnly: true }),
      field('name', 'string', { required: true }),
      field('status', 'enum', { values: ['draft', 'planned'] }),
    ],
    actions: [],
    can: { read: true, create: true, update: true, delete: true },
  },
  {
    name: 'workorders',
    label: 'Work Orders',
    singular: 'Work order',
    icon: 'Wrench',
    codeField: 'workOrderId',
    titleField: 'name',
    list: ['workOrderId', 'name', 'workStatus', 'people'],
    plantScoped: true,
    children: [],
    fields: [
      field('workOrderId', 'string', { readOnly: true }),
      field('name', 'string', { required: true, label: 'Title' }),
      field('workStatus', 'enum', { values: ['Open', 'Completed'], readOnly: true, label: 'Status' }),
      field('people', 'refs', { ref: 'users', label: 'Assignees' }),
      field('maintenancePlanId', 'ref', { ref: 'maintenanceplans', label: 'Maintenance plan' }),
      field('plannedStart', 'date'),
      field('plannedEnd', 'date'),
    ],
    actions: [],
    can: { read: true, create: true, update: true, delete: true },
  },
];

const imm5 = { _id: 'imm5', name: 'IMM 5', assetTag: 'IMM-05' };
const imm3 = { _id: 'imm3', name: 'IMM 3', assetTag: 'IMM-03' };
const ravi = { _id: 'u1', firstName: 'Ravi', lastName: 'Prasad' };
const plan = {
  _id: 'pp1',
  reqId: 'PP-7',
  partName: 'Housing-A',
  quantity: 5000,
  status: 'Planned',
  feasibility: { verdict: 'doable', slackHours: 0, issues: [] },
  aiSummary: {
    text: 'Doable: three moulds share the order.',
    model: 'gemini-3.5-flash',
    at: at(-1),
    mock: true,
  },
  createdAt: at(-2),
  updatedAt: at(-1),
};
// Deliberately out of start order: the chain must sort them.
const jobCards = [
  {
    _id: 'jc22',
    jobCardId: 'JC-22',
    jobName: 'Housing-A – TAC',
    asset: imm5,
    productionPlanId: { _id: 'pp1', reqId: 'PP-7', partName: 'Housing-A' },
    target: 1500,
    jobStatus: 'Open',
    startDate: at(30),
    endDate: at(50),
    assignedTo: [ravi],
  },
  {
    _id: 'jc19',
    jobCardId: 'JC-19',
    jobName: 'Housing-A – TAC',
    asset: imm5,
    productionPlanId: { _id: 'pp1', reqId: 'PP-7', partName: 'Housing-A' },
    target: 2000,
    jobStatus: 'In Progress',
    startDate: at(0),
    endDate: at(28),
    assignedTo: [ravi],
    operations: [{ operationName: 'Moulding', progress: { partsOut: 400 } }],
  },
  {
    _id: 'jc20',
    jobCardId: 'JC-20',
    jobName: 'Housing-A – TAC',
    asset: imm3,
    productionPlanId: { _id: 'pp1', reqId: 'PP-7', partName: 'Housing-A' },
    target: 1500,
    jobStatus: 'Open',
    startDate: at(10),
    endDate: at(40),
    assignedTo: [],
  },
];
const mp = {
  _id: 'mp1',
  planCode: 'MP-2',
  name: 'Maintenance plan – Pune',
  status: 'planned',
  createdAt: at(-2),
};

const reply = (status, data) => ({ ok: status < 400, status, json: async () => data });
const me = {
  user: { id: 'u0', name: 'Vikram Mehta' },
  context: { role: 'owner', company: { name: 'Acme' }, plants: [{ _id: 'pl1', name: 'Pune' }], modules: [] },
};

const fetchMock = vi.fn(async (url, init = {}) => {
  const path = String(url).replace(/^.*?\/api/, '');
  const method = init.method ?? 'GET';
  if (path === '/auth/me') return reply(200, me);
  if (path === '/modules') return reply(200, { modules });
  if (path === '/m/productionplans/pp1') return reply(200, { item: plan });
  // A plan made without a proposal: its feasibility sub-fields are all empty.
  if (path === '/m/productionplans/pp2') {
    return reply(200, {
      item: { ...plan, _id: 'pp2', feasibility: { verdict: null, slackHours: null, issues: [], notes: '' } },
    });
  }
  if (/^\/m\/productionplans\/pp[12]\/related$/.test(path)) {
    return reply(200, {
      parent: { module: 'productionplans', id: 'pp1' },
      children: [
        {
          module: 'jobcards',
          field: 'productionPlanId',
          label: 'Job cards',
          order: 0,
          count: 3,
          can: { read: true, create: true },
        },
      ],
    });
  }
  if (/^\/m\/productionplans\/pp[12]\/related\/jobcards/.test(path)) {
    return reply(200, { child: {}, items: jobCards, total: 3, page: 1, limit: 25 });
  }
  if (path === '/m/maintenanceplans/mp1') return reply(200, { item: mp });
  if (path === '/m/maintenanceplans/mp1/related') {
    return reply(200, {
      parent: { module: 'maintenanceplans', id: 'mp1' },
      children: [
        {
          module: 'workorders',
          field: 'maintenancePlanId',
          label: 'Work orders',
          order: 0,
          count: 0,
          can: { read: true, create: true },
        },
      ],
    });
  }
  if (path.startsWith('/m/maintenanceplans/mp1/related/workorders')) {
    return reply(200, { child: {}, items: [], total: 0, page: 1, limit: 25 });
  }
  if (path === '/m/workorders' && method === 'POST') {
    return reply(201, { item: { _id: 'w9', workOrderId: 'WO-9', ...JSON.parse(init.body) } });
  }
  return reply(404, { error: { message: `Unexpected ${method} ${path}` } });
});

const sent = (method, path) => {
  const call = fetchMock.mock.calls.find(
    ([url, init = {}]) => String(url).endsWith(`/api${path}`) && (init.method ?? 'GET') === method,
  );
  return call && (call[1].body ? JSON.parse(call[1].body) : null);
};

const renderAt = (path) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[path]}>
        <TooltipProvider>
          <Routes>
            <Route path="/m/:module/:id" element={<RecordPage />} />
          </Routes>
        </TooltipProvider>
        <Toaster />
      </MemoryRouter>
    </QueryClientProvider>,
  );

beforeEach(() => {
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

describe('isEmptyValue', () => {
  it('treats null, blanks, [] and all-empty plain objects as empty, keeps 0/false/refs', () => {
    for (const v of [null, undefined, '', [], {}, { a: null, b: [], c: { d: '' } }])
      expect(isEmptyValue(v)).toBe(true);
    for (const v of [0, false, 'x', [null], { a: 0 }, { _id: 'u1' }]) expect(isEmptyValue(v)).toBe(false);
  });
});

describe('refLabel', () => {
  it('labels a plan proposal and a maintenance plan by code and title, never by raw id', () => {
    expect(refLabel({ _id: 'p1', proposalCode: 'PLN-7', title: '5,000 × Housing-A' })).toBe(
      'PLN-7 · 5,000 × Housing-A',
    );
    expect(refLabel({ _id: 'm1', planCode: 'MP-2', name: 'Maintenance plan – Furnace 1' })).toBe(
      'MP-2 · Maintenance plan – Furnace 1',
    );
  });
});

describe('chainsOf', () => {
  it('groups per machine and orders each chain by start', () => {
    const chains = chainsOf(
      jobCards.map((jc) => ({ ...jc, start: jc.startDate })),
      (jc) => jc.asset,
    );
    expect([...chains.keys()]).toEqual(['imm5', 'imm3']);
    expect(chains.get('imm5').items.map((jc) => jc.jobCardId)).toEqual(['JC-19', 'JC-22']);
    expect(chains.get('imm5').label).toBe('IMM-05 · IMM 5');
  });
});

describe('Record page related records', () => {
  it('shows the job card chain, totals and the related tab with its count', async () => {
    renderAt('/m/productionplans/pp1');
    expect(await screen.findByRole('heading', { name: 'Housing-A' })).toBeTruthy();

    const imm5Chain = await screen.findByRole('list', { name: 'Chain on IMM-05 · IMM 5' });
    const codes = within(imm5Chain)
      .getAllByRole('link')
      .map((a) => a.textContent.slice(0, 5));
    expect(codes).toEqual(['JC-19', 'JC-22']);
    expect(within(imm5Chain).getAllByRole('link')[0].getAttribute('href')).toBe('/m/jobcards/jc19');
    expect(within(imm5Chain).getByText('In Progress')).toBeTruthy();
    expect(screen.getByRole('list', { name: 'Chain on IMM-03 · IMM 3' })).toBeTruthy();

    expect(screen.getByText('5,000 of 5,000 pcs')).toBeTruthy();
    expect(screen.getByText('400 pcs')).toBeTruthy();
    expect(screen.getByText('Doable')).toBeTruthy();
    expect(screen.getByText('Doable: three moulds share the order.')).toBeTruthy();
    // The chain shows SARA's summary with its provenance; the generic field card does not repeat it.
    expect(screen.queryByRole('heading', { name: 'Ai Summary' })).toBeNull();
    expect(screen.getByText(/Generated by gemini-3\.5-flash \(mock\)/)).toBeTruthy();
    // The compact Gantt lists both machines as rows and the job cards as bars.
    expect(screen.getByRole('button', { name: /^JC-20 · Housing-A – TAC/ })).toBeTruthy();

    // A filled feasibility keeps its card (0 is a value, not empty).
    expect(screen.getByRole('heading', { name: 'Feasibility' })).toBeTruthy();

    // The chain already lists the job cards and carries "Add job card": no second Related table.
    expect(await screen.findByRole('button', { name: 'Add job card' })).toBeTruthy();
    expect(screen.queryByRole('tab', { name: 'Job cards · 3' })).toBeNull();
    expect(screen.queryByRole('table', { name: 'Job cards' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Related' })).toBeNull();
  });

  it('skips a wide field whose sub-fields are all empty', async () => {
    renderAt('/m/productionplans/pp2');
    expect(await screen.findByRole('heading', { name: 'Housing-A' })).toBeTruthy();
    await screen.findByRole('list', { name: 'Chain on IMM-05 · IMM 5' });
    expect(screen.queryByRole('heading', { name: 'Feasibility' })).toBeNull();
  });

  it('pre-fills the parent on Add and shows the empty chain for a maintenance plan', async () => {
    renderAt('/m/maintenanceplans/mp1');
    expect(await screen.findByText('No work orders yet')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Plan it in the Planner' }).getAttribute('href')).toBe(
      '/planner?tab=maintenance',
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Add work order' }));
    const sheet = await screen.findByRole('dialog');
    expect(within(sheet).getByRole('combobox', { name: 'Maintenance plan' }).placeholder).toBe(
      'MP-2 · Maintenance plan – Pune',
    );
    fireEvent.change(within(sheet).getByLabelText(/^Title/), { target: { value: 'Grease IMM 3' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Create work order' }));
    await vi.waitFor(() =>
      expect(sent('POST', '/m/workorders')).toEqual({ name: 'Grease IMM 3', maintenancePlanId: 'mp1' }),
    );
    expect(await screen.findByText('Work order created')).toBeTruthy();
  });
});
