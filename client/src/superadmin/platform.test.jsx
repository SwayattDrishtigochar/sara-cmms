import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toDelimited } from '../lib/format.js';
import { PlatformTab } from './PlatformTab.jsx';
import { SuperAdminPage } from './SuperAdminPage.jsx';

vi.mock('../auth/useAuth.js', () => ({ useSession: () => ({ role: 'superAdmin' }) }));
vi.mock('./AiTab.jsx', () => ({ AiTab: () => <div>AI settings</div> }));

const companies = [
  {
    id: 'c1',
    name: 'Acme Components',
    plants: 2,
    users: 1250,
    assets: 24,
    createdAt: '2026-09-01T00:00:00Z',
  },
  { id: 'c2', name: 'Beta Foods', plants: 1, users: 8, assets: 6, createdAt: '2026-03-15T00:00:00Z' },
];
const reply = (status, data) => ({ ok: status < 400, status, json: async () => data });
let fail = false;
const fetchMock = vi.fn(async (url) => {
  if (String(url).endsWith('/api/admin/platform/companies')) {
    return fail ? reply(500, { error: { message: 'Database away' } }) : reply(200, { companies });
  }
  return reply(404, { error: { message: `Unexpected ${url}` } });
});

const renderAt = (element, path = '/superadmin') =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RouterProvider router={createMemoryRouter([{ path: '*', element }], { initialEntries: [path] })} />
    </QueryClientProvider>,
  );

beforeEach(() => {
  fail = false;
  localStorage.setItem('token', 'test-token');
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  fetchMock.mockClear();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('Superadmin page', () => {
  it('opens on the AI tab and switches to the Platform tab', async () => {
    renderAt(<SuperAdminPage />);
    expect(screen.getByText('AI settings')).toBeTruthy();
    fireEvent.mouseDown(screen.getByRole('tab', { name: /Platform/ }), { button: 0 });
    expect((await screen.findAllByText('Acme Components')).length).toBeGreaterThan(0);
  });

  it('reads the tab from the URL', async () => {
    renderAt(<SuperAdminPage />, '/superadmin?tab=platform');
    expect((await screen.findAllByText('Beta Foods')).length).toBeGreaterThan(0);
  });
});

describe('Platform tab', () => {
  it('lists every company with its counts', async () => {
    renderAt(<PlatformTab />);
    const table = await screen.findByRole('table');
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows.map((r) => within(r).getByRole('rowheader').textContent)).toEqual([
      'Acme Components',
      'Beta Foods',
    ]);
    expect(
      within(rows[0])
        .getAllByRole('cell')
        .map((c) => c.textContent.trim()),
    ).toEqual(['2', '1,250', '24', expect.stringMatching(/2026/)]);
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/api/admin/platform/companies'))).toBe(
      true,
    );
  });

  it('shows an empty state and an error with retry', async () => {
    companies.length = 0;
    renderAt(<PlatformTab />);
    expect(await screen.findByText('No companies yet')).toBeTruthy();
    cleanup();
    fail = true;
    renderAt(<PlatformTab />);
    expect(await screen.findByText(/Database away/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });
});

describe('text helpers', () => {
  it('writes formula-safe CSV and TSV', () => {
    expect(
      toDelimited([
        ['a', '=1+1'],
        ['b,c', 'say "hi"'],
      ]),
    ).toBe('a,\'=1+1\n"b,c","say ""hi"""');
    expect(toDelimited([['a', 'b\tc']], '\t')).toBe('a\t"b\tc"');
  });
});
