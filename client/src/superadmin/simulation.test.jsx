import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { Toaster } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StatusStrip } from './StatusStrip.jsx';
import { SuperAdminPage } from './SuperAdminPage.jsx';
import {
  ago,
  byType,
  credentialRows,
  injectionState,
  outcomeOf,
  splitError,
  targetLink,
  toDelimited,
} from './simUtils.js';

const fx = vi.hoisted(() => {
  const now = Date.now();
  const at = (min) => new Date(now + min * 60_000).toISOString();
  const scenarios = [
    {
      id: 'bearing_wear',
      label: 'Bearing wear',
      description: 'Vibration rises exponentially.',
      appliesTo: ['Power Press'],
      affects: ['vibration'],
    },
    {
      id: 'energy_leak',
      label: 'Energy leak',
      description: 'High power while idle.',
      appliesTo: ['Compressor'],
      affects: ['POWER TOTAL'],
    },
  ];
  const instance = {
    id: 'pi-1',
    name: 'Plant Pi',
    hostname: 'raspberrypi',
    platform: 'linux-arm64',
    version: '2.0.0',
    online: true,
    lastSeenAt: new Date(now - 2000).toISOString(),
    stats: {
      uptimeSec: 3720,
      running: true,
      humanSpeed: 1,
      pointsPerSec: 21.4,
      bufferSize: 12,
      droppedPoints: 0,
      cpuTempC: 48.2,
      lastError: 'InfluxDB timed out once',
      backfill: { active: false },
      people: { onShift: 9, busy: 4, actionsToday: 37 },
    },
    statuses: { a1: 'Running', a2: 'Maintenance' },
    injections: [],
    scenarios,
  };
  const control = {
    _id: 'default',
    running: true,
    telemetryTickMs: 5000,
    humanActivity: true,
    humanSpeed: 1,
    respondToAnomalies: false,
    backfill: { status: 'running', days: 7, progress: 0.42 },
  };
  const company = {
    id: 'c1',
    name: 'Swayatt Auto Components',
    domain: 'swayatt.com',
    seededAt: at(-600),
    counts: { users: 28, assets: 20, workorders: 412, jobcards: 96, requests: 57 },
  };
  const event = (id, extra) => ({
    id,
    companyId: 'c1',
    assetId: 'a1',
    assetName: 'Press 1',
    scenario: 'bearing_wear',
    severity: 'medium',
    rampMin: 10,
    holdMin: 30,
    affects: ['vibration'],
    clearedAt: null,
    clearedReason: null,
    active: false,
    ...extra,
  });
  const active = event('e1', { severity: 'high', startedAt: at(-5), endsAt: at(35), active: true });
  const events = [
    active,
    event('e2', {
      startedAt: at(-90),
      endsAt: at(-50),
      clearedAt: at(-60),
      clearedReason: 'repair',
      clearedBy: 'WO-123',
    }),
    event('e3', {
      startedAt: at(-200),
      endsAt: at(-160),
      clearedAt: at(-170),
      clearedReason: 'superadmin',
      clearedBy: 'u1',
    }),
    event('e4', { startedAt: at(-300), endsAt: at(-260) }), // ran its course
  ];
  const assets = [
    { id: 'a1', name: 'Press 1', tag: 'PRS-01', type: 'Power Press', status: 'Idle' },
    { id: 'a2', name: 'Compressor 1', tag: 'CMP-01', type: 'Compressor', status: 'Idle' },
  ];
  const activity = [
    {
      id: 'x1',
      at: at(-1),
      actor: { name: 'Ramesh Kumar', title: 'Maintenance Technician', role: 'technician' },
      action: 'workorder.start',
      summary: 'Ramesh Kumar started WO-112 · Hydraulic oil leak (IMM 3)',
      target: { module: 'workorders', id: 'w112', code: 'WO-112' },
    },
    {
      id: 'x2',
      at: at(-3),
      actor: { name: 'Manoj Shinde', title: 'Production Supervisor', role: 'technician' },
      action: 'asset.check',
      summary: 'Manoj Shinde checked Press 1 before the shift',
      target: { module: 'assets', id: 'a1', code: 'PRS-01' },
    },
  ];
  const users = [
    {
      email: 'owner_1@swayatt.com',
      name: 'Vikram Mehta',
      role: 'owner',
      title: 'Managing Director',
      department: 'Maintenance',
      shift: null,
    },
    {
      email: 'maintenance_technician_1@swayatt.com',
      name: 'Ramesh Kumar',
      role: 'technician',
      title: 'Maintenance Technician',
      department: 'Maintenance',
      shift: 'A',
    },
  ];
  return {
    now,
    events,
    assets,
    activity,
    users,
    status: { control, instances: [instance], company, scenarios, injections: [active] },
  };
});

const reply = (status, data) => ({ ok: status < 400, status, json: async () => data });

/** The SARA API as the Simulation tab sees it; anything else is a 404 so a wrong URL fails loudly. */
const fetchMock = vi.fn(async (url, init = {}) => {
  const path = String(url).replace(/^.*?\/api/, '');
  const method = init.method ?? 'GET';
  if (path === '/auth/me') {
    return reply(200, { user: {}, context: { role: 'superAdmin', company: { isPlatform: true } } });
  }
  if (path === '/admin/sim/status') return reply(200, fx.status);
  if (path.startsWith('/admin/sim/events')) return reply(200, { events: fx.events });
  if (path.startsWith('/admin/sim/activity')) return reply(200, { activity: fx.activity });
  if (path === '/admin/sim/assets') return reply(200, { assets: fx.assets });
  if (path === '/admin/sim/credentials') return reply(200, { users: fx.users, password: 'Sara@2026' });
  if (path === '/admin/sim/control' && method === 'PATCH') return reply(200, { control: fx.status.control });
  if (path === '/admin/sim/inject' && method === 'POST') return reply(201, { event: { id: 'new' } });
  if (path === '/admin/sim/clear' && method === 'POST') {
    return reply(409, { error: { code: 'CONFLICT', message: 'That injection already ended' } });
  }
  return reply(404, { error: { message: `Unexpected ${method} ${path}` } });
});

/** Body of the request sent to `path` with `method`, or undefined when none was. */
const sent = (method, path) => {
  const call = fetchMock.mock.calls.find(
    ([url, init = {}]) => String(url).endsWith(`/api${path}`) && (init.method ?? 'GET') === method,
  );
  return call && JSON.parse(call[1].body);
};

/** The value next to a stats label (`<dt>` → `<dd>`). */
const stat = (label) => screen.getByText(label, { selector: 'dt' }).nextElementSibling.textContent;

const renderPage = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={['/superadmin?tab=simulation']}>
        <SuperAdminPage />
        <Toaster />
      </MemoryRouter>
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

describe('simulation helpers', () => {
  it('writes formula-safe CSV and TSV', () => {
    const cells = ['=SUM(A1:A2)', '+91 98', '-x', '@me', '\tlead', '\rcr', 'plain', 'a,b', 'say "hi"'];
    expect(toDelimited([cells])).toBe(
      `'=SUM(A1:A2),'+91 98,'-x,'@me,'\tlead,"'\rcr",plain,"a,b","say ""hi"""`,
    );
    expect(toDelimited([['a', 'b,c'], ['=1']], '\t')).toBe("a\tb,c\n'=1");
  });

  it('builds the sign-in sheet', () => {
    const rows = credentialRows(
      [{ email: 'e@x', name: 'N', role: 'view', title: 'T', department: 'D', shift: 'A' }],
      'pw',
    );
    expect(rows).toEqual([
      ['Email', 'Password', 'Name', 'Role', 'Title', 'Department', 'Shift'],
      ['e@x', 'pw', 'N', 'Viewer', 'T', 'D', 'A'],
    ]);
  });

  it('says how an injection ended', () => {
    const label = (e) => outcomeOf(e).label;
    expect(label({ active: true })).toBe('Active');
    expect(label({ clearedReason: 'repair', clearedBy: 'WO-123' })).toBe('Fixed by WO-123');
    expect(label({ clearedReason: 'repair', clearedBy: { workOrderId: 'WO-9' } })).toBe('Fixed by WO-9');
    expect(label({ clearedReason: 'repair', clearedBy: '0123456789abcdef01234567' })).toBe(
      'Fixed by a work order',
    );
    expect(label({ clearedReason: 'superadmin', clearedBy: 'u1' })).toBe('Cleared by superadmin');
    expect(label({ clearedReason: 'expired' })).toBe('Ended');
    expect(label({})).toBe('Ended');
  });

  it('follows an injection through ramp, hold and fade', () => {
    const t0 = Date.UTC(2026, 9, 16, 6);
    const e = { startedAt: t0, endsAt: t0 + 40 * 60_000, rampMin: 10, holdMin: 30 };
    expect(injectionState(e, t0 + 5 * 60_000)).toMatchObject({
      phase: 'ramp',
      progress: 0.125,
      elapsedSec: 300,
    });
    expect(injectionState(e, t0 + 20 * 60_000)).toMatchObject({ phase: 'hold', progress: 0.5 });
    expect(injectionState(e, t0 + 41 * 60_000)).toMatchObject({ phase: 'fade', progress: 1 });
    // A breakdown keeps the machine Stopped after its fade, until the repair work order is completed.
    const breakdown = { ...e, scenario: 'sudden_breakdown' };
    expect(injectionState(breakdown, t0 + 41 * 60_000)).toMatchObject({ phase: 'fade' });
    expect(injectionState(breakdown, t0 + 43 * 60_000)).toMatchObject({ phase: 'waiting', progress: 1 });
  });

  it('links activity to machines and records', () => {
    expect(targetLink({ module: 'workorders', id: 'w1', code: 'WO-1' })).toBe('/m/workorders/w1');
    expect(targetLink({ module: 'assets', id: 'a1' })).toBe('/machines/a1');
    expect(targetLink({ module: 'workorders' })).toBeNull();
    expect(targetLink(undefined)).toBeNull();
  });

  it('groups machines by type with natural name order', () => {
    const groups = byType([
      { name: 'IMM 10', type: 'Injection Moulding Machine' },
      { name: 'IMM 2', type: 'Injection Moulding Machine' },
      { name: 'CNC 1', type: 'CNC Machine' },
    ]);
    expect(groups.map(([type, list]) => [type, list.map((a) => a.name)])).toEqual([
      ['CNC Machine', ['CNC 1']],
      ['Injection Moulding Machine', ['IMM 2', 'IMM 10']],
    ]);
  });

  it('says how long ago', () => {
    expect(ago(fx.now - 2000, fx.now)).toBe('2 s ago');
    expect(ago(fx.now - 2 * 86_400_000, fx.now)).toBe('2 days ago');
    expect(ago(null)).toBeNull();
  });

  it('splits the time off the last error and calms an old one once streaming', () => {
    const iso = new Date(fx.now - 97 * 60_000).toISOString();
    expect(splitError(`${iso} InfluxDB write failed: fetch failed`)).toEqual({
      at: iso,
      message: 'InfluxDB write failed: fetch failed',
    });
    expect(splitError('plain')).toEqual({ at: null, message: 'plain' });

    const pi = (lastError, running = true) => {
      const [base] = fx.status.instances;
      return { ...base, stats: { ...base.stats, lastError, running } };
    };
    const { rerender } = render(
      <StatusStrip instances={[pi(`${iso} InfluxDB write failed`)]} now={fx.now} />,
    );
    expect(screen.getByText('Recovered · last error 1 h ago: InfluxDB write failed')).toBeTruthy();
    expect(screen.queryByText(/^Last error/)).toBeNull();

    rerender(<StatusStrip instances={[pi(`${iso} InfluxDB write failed`, false)]} now={fx.now} />);
    expect(screen.getByText('Last error (1 h ago):')).toBeTruthy();

    const fresh = new Date(fx.now - 60_000).toISOString();
    rerender(<StatusStrip instances={[pi(`${fresh} Mongo down`)]} now={fx.now} />);
    expect(screen.getByText('Last error (1 min ago):')).toBeTruthy();
    expect(screen.getByText('Mongo down')).toBeTruthy();
  });
});

describe('Superadmin → Simulation', () => {
  it('shows the simulator, the company and the live activity', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { name: 'Plant Pi' })).toBeTruthy();
    expect(screen.getByText('Online')).toBeTruthy();
    expect(screen.getByText(/last seen \d+ s ago/)).toBeTruthy();
    expect(screen.getByText('Streaming')).toBeTruthy();
    expect(screen.getByText('v2.0.0 · linux-arm64 · raspberrypi')).toBeTruthy();
    expect(stat('Points / s')).toBe('21.4');
    expect(stat('CPU temp')).toBe('48.2 °C');
    expect(stat('People on shift')).toBe('9');
    expect(stat('Busy now')).toBe('4');
    expect(stat('Actions today')).toBe('37');
    expect(screen.getByText('InfluxDB timed out once')).toBeTruthy();

    expect(screen.getByRole('heading', { name: 'Swayatt Auto Components' })).toBeTruthy();
    expect(stat('Machines')).toBe('20');
    expect(stat('Work orders')).toBe('412');

    const feed = await screen.findByRole('list', { name: 'Recent activity' });
    expect(within(feed).getByText('Ramesh Kumar started WO-112 · Hydraulic oil leak (IMM 3)')).toBeTruthy();
    expect(within(feed).getByRole('link', { name: 'Open WO-112' }).getAttribute('href')).toBe(
      '/m/workorders/w112',
    );
    expect(within(feed).getByRole('link', { name: 'Open PRS-01' }).getAttribute('href')).toBe('/machines/a1');

    fireEvent.click(screen.getByRole('button', { name: 'Credentials' }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('Sara@2026')).toBeTruthy();
    expect(within(dialog).getByText('maintenance_technician_1@swayatt.com')).toBeTruthy();
    expect(within(dialog).getAllByText('Owner').length).toBeGreaterThan(0);
  });

  it('saves controls and shows backfill progress', async () => {
    renderPage();
    const running = await screen.findByRole('switch', { name: 'Simulation running' });
    expect(running.checked).toBe(true);
    expect(screen.getByText('Backfilling the last 7 days…')).toBeTruthy();
    expect(screen.getByText('42%')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Backfill' }).disabled).toBe(true);

    fireEvent.click(running);
    await vi.waitFor(() => expect(sent('PATCH', '/admin/sim/control')).toEqual({ running: false }));

    fetchMock.mockClear();
    fireEvent.click(screen.getByRole('radio', { name: '60×' }));
    await vi.waitFor(() => expect(sent('PATCH', '/admin/sim/control')).toEqual({ humanSpeed: 60 }));

    fetchMock.mockClear();
    fireEvent.change(screen.getByLabelText('Machine readings every'), { target: { value: '1000' } });
    await vi.waitFor(() => expect(sent('PATCH', '/admin/sim/control')).toEqual({ telemetryTickMs: 1000 }));

    fetchMock.mockClear();
    fireEvent.click(screen.getByRole('switch', { name: 'Managers respond to AI anomalies' }));
    await vi.waitFor(() => expect(sent('PATCH', '/admin/sim/control')).toEqual({ respondToAnomalies: true }));
  });

  it('injects a scenario, lists active injections and their history, and toasts failures', async () => {
    renderPage();
    // Active injection by its own clock, and the history in words.
    expect(await screen.findByRole('button', { name: 'Clear Bearing wear on Press 1' })).toBeTruthy();
    expect(screen.getByText('Ramping up')).toBeTruthy();
    expect(await screen.findByText('Fixed by WO-123')).toBeTruthy();
    expect(screen.getByText('Cleared by superadmin')).toBeTruthy();
    expect(screen.getByText('Ended')).toBeTruthy();
    expect(screen.getByText('Active · ramping up')).toBeTruthy();

    // Live status from the simulator wins over the stored one; scenario cards follow the machine type.
    const machine = screen.getByLabelText('Machine');
    await screen.findByRole('option', { name: 'Press 1 (PRS-01) — Running' });
    fireEvent.change(machine, { target: { value: 'a2' } });
    expect(screen.getByRole('radio', { name: /Bearing wear/ }).disabled).toBe(true);
    expect(screen.getByText(/Doesn't apply to Compressor 1 \(Compressor\)/)).toBeTruthy();

    fireEvent.change(machine, { target: { value: 'a1' } });
    fireEvent.click(screen.getByRole('radio', { name: /Bearing wear/ }));
    fireEvent.click(screen.getByRole('radio', { name: 'High' }));
    fireEvent.click(screen.getByRole('button', { name: 'Inject' }));
    await vi.waitFor(() =>
      expect(sent('POST', '/admin/sim/inject')).toEqual({
        assetId: 'a1',
        scenario: 'bearing_wear',
        severity: 'high',
        rampMin: 10,
        holdMin: 30,
      }),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Clear Bearing wear on Press 1' }));
    await vi.waitFor(() => expect(sent('POST', '/admin/sim/clear')).toEqual({ eventId: 'e1' }));
    expect(await screen.findByText('That injection already ended')).toBeTruthy();
  });
});
