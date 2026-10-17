import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LoginPage } from './LoginPage.jsx';

const person = (n, role, title, department = 'Maintenance') => ({
  email: `${title.toLowerCase().replace(/ /g, '_')}_${n}@acme.test`,
  name: `${title} ${n}`,
  role,
  title,
  department,
});
const accounts = [
  {
    company: { id: 'c1', name: 'Acme Components' },
    users: [
      person(1, 'owner', 'Managing Director'),
      person(1, 'admin', 'Plant Manager', 'Production'),
      ...[1, 2, 3, 4, 5, 6, 7].map((n) => person(n, 'technician', 'Maintenance Technician')),
      person(1, 'view', 'Management Viewer', 'Production'),
    ],
  },
  { company: { id: 'c2', name: 'Beta Foods' }, users: [person(2, 'owner', 'Founder')] },
];

const reply = (status, data) => ({ ok: status < 400, status, json: async () => data });
let demoMode = true;
let loginFails = false;
const fetchMock = vi.fn(async (url, init) => {
  const path = String(url);
  if (path.endsWith('/api/auth/demo-accounts')) {
    return demoMode ? reply(200, { accounts }) : reply(404, { error: { code: 'NOT_FOUND' } });
  }
  if (path.endsWith('/api/auth/demo-login')) {
    if (loginFails) return reply(401, { error: { message: 'Wrong email or password' } });
    const { email } = JSON.parse(init.body);
    return reply(200, { token: `tok-${email}`, user: { email }, context: { role: 'owner', company: {} } });
  }
  return reply(404, { error: { message: `Unexpected ${path}` } });
});

const renderLogin = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RouterProvider
        router={createMemoryRouter(
          [
            { path: '/login', element: <LoginPage /> },
            { path: '*', element: <div>Home page</div> },
          ],
          { initialEntries: ['/login'] },
        )}
      />
    </QueryClientProvider>,
  );

beforeEach(() => {
  demoMode = true;
  loginFails = false;
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  fetchMock.mockClear();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('Login page demo accounts', () => {
  it('shows nothing when demo mode is off (404)', async () => {
    demoMode = false;
    renderLogin();
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith('/api/auth/demo-accounts'))).toBe(true),
    );
    expect(screen.queryByText('Demo accounts')).toBeNull();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy();
  });

  it('lists the people grouped by company, the first 8 of a long list', async () => {
    renderLogin();
    expect(await screen.findByText('Demo accounts')).toBeTruthy();
    expect(screen.getByText('Demo mode')).toBeTruthy();
    expect(screen.getByText('Acme Components')).toBeTruthy();
    expect(screen.getByText('Beta Foods')).toBeTruthy();
    expect(screen.getAllByText('Owner')).toHaveLength(2);
    expect(screen.getByText('Managing Director · Maintenance')).toBeTruthy();
    expect(screen.getAllByText('Technician')).toHaveLength(6);
    expect(screen.queryByText('Viewer')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Show all 10' }));
    expect(screen.getAllByText('Technician')).toHaveLength(7);
    expect(screen.getByText('Viewer')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Show fewer' }));
    expect(screen.queryByText('Viewer')).toBeNull();
  });

  it('signs in as the clicked person and stores the token', async () => {
    renderLogin();
    fireEvent.click(await screen.findByRole('button', { name: /Managing Director 1/ }));
    expect(await screen.findByText('Home page')).toBeTruthy();
    const call = fetchMock.mock.calls.find(([u]) => String(u).endsWith('/api/auth/demo-login'));
    expect(call[1].method).toBe('POST');
    expect(JSON.parse(call[1].body)).toEqual({ email: 'managing_director_1@acme.test' });
    expect(localStorage.getItem('token')).toBe('tok-managing_director_1@acme.test');
  });

  it('shows the server error under the panel when the sign-in fails', async () => {
    loginFails = true;
    renderLogin();
    fireEvent.click(await screen.findByRole('button', { name: /Managing Director 1/ }));
    expect((await screen.findByRole('alert')).textContent).toBe('Wrong email or password');
    expect(localStorage.getItem('token')).toBeNull();
  });
});
