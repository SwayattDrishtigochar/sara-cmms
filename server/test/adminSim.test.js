import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import { SimActivity, SimControl, SimEvent, SimInstance, SimState } from '../src/db/models/Sim.js';
import { getModule } from '../src/modules/registry.js';
import { adminSimRouter } from '../src/routes/adminSim.js';
import { dbNow } from '../src/telemetry/dbClock.js';
import { NOW, PASSWORD, setupDatabase, teardownDatabase } from './helpers/db.js';

const MIN = 60_000;
const SCENARIOS = [
  {
    id: 'bearing_wear',
    label: 'Bearing wear',
    appliesTo: ['Injection Moulding Machine', 'Power Press', 'CNC Machine', 'Compressor'],
    affects: ['vibration', 'motorCurrent', 'oilTempPv'],
  },
  { id: 'overheating', label: 'Overheating', appliesTo: ['Furnace'], affects: ['zoneTemp1'] },
];

let app;
let acme;
let beta;
let admin; // superadmin auth header
let adminId;
let owner; // Acme owner auth header
let platformId;

const Company = () => getModule('companies').Model;
const api = (method, path, auth = admin) =>
  request(app)
    [method](`/api/admin/sim${path}`)
    .set(auth ?? {});
const assetId = async (companyId, name) =>
  String((await getModule('assets').Model.findOne({ companyId, name }).lean())._id);
// The route judges heartbeats by the MongoDB clock (dbNow), which may differ from this host (remote DB).
let offset = 0;
const now = () => Date.now() + offset;
/** Keeps the test simulator online (online = heartbeat within 15 s). */
const heartbeat = (at = new Date(now())) =>
  SimInstance.updateOne({ _id: 'laptop' }, { $set: { lastSeenAt: at } });

beforeAll(async () => {
  ({ acme, beta } = await setupDatabase());
  offset = (await dbNow()) - Date.now();
  app = createApp({ routers: [{ path: '/api/admin/sim', router: adminSimRouter }] });
  const login = async (email, password) => {
    const res = await request(app).post('/api/auth/login').send({ email, password });
    expect(res.status).toBe(200);
    return { auth: { authorization: `Bearer ${res.body.token}` }, id: String(res.body.user._id) };
  };
  ({ auth: admin, id: adminId } = await login(env.SUPERADMIN_EMAIL, env.SUPERADMIN_PASSWORD));
  ({ auth: owner } = await login('owner_1@acme.test', PASSWORD));
  platformId = String((await Company().findOne({ isPlatform: true }).lean())._id);
  // Both generated accounts are simulated; make Acme the newest so the default pick is predictable.
  await Company().updateOne({ _id: beta.companyId }, { $set: { createdAt: new Date(NOW - 86_400_000) } });
});
afterAll(teardownDatabase);

describe('access', () => {
  it('is for the superadmin only', async () => {
    expect((await request(app).get('/api/admin/sim/status')).status).toBe(401);
    const routes = [
      ['get', '/status'],
      ['patch', '/control'],
      ['post', '/backfill'],
      ['post', '/inject'],
      ['post', '/clear'],
      ['get', '/events'],
      ['get', '/activity'],
      ['get', '/credentials'],
      ['get', '/assets'],
    ];
    for (const [method, path] of routes) {
      expect((await api(method, path, owner).send({})).status).toBe(403);
    }
  });
});

describe('status', () => {
  it('shows defaults and the simulated company before the simulator ever ran', async () => {
    const res = await api('get', '/status');
    expect(res.status).toBe(200);
    expect(res.body.control).toMatchObject({
      _id: 'default',
      companyId: null,
      running: true,
      telemetryTickMs: 5000,
      humanActivity: true,
      humanSpeed: 1,
      respondToAnomalies: false,
      backfill: { status: 'idle', progress: 0 },
    });
    expect(res.body).toMatchObject({ instances: [], scenarios: [], injections: [] });
    expect(res.body.company).toMatchObject({
      id: String(acme.companyId),
      name: 'Acme Components',
      domain: 'acme.test',
      seededAt: null,
      counts: {
        users: acme.counts.users,
        assets: acme.counts.assets,
        workorders: acme.counts.workOrders,
        jobcards: acme.counts.jobCards,
      },
    });
    expect(res.body.company.counts.requests).toBeGreaterThan(0);
    expect(await SimControl.countDocuments()).toBe(0); // reading never creates the control document
  });

  it('follows simcontrol.companyId, but only to a simulated company, and shows when it was seeded', async () => {
    await SimState.create({
      _id: beta.companyId,
      slug: 'betafoods',
      seededAt: new Date('2026-10-01T00:00:00Z'),
    });
    await SimControl.create({ _id: 'default', companyId: beta.companyId });
    const pinned = (await api('get', '/status')).body.company;
    expect(pinned).toMatchObject({ name: 'Beta Foods', seededAt: '2026-10-01T00:00:00.000Z' });

    await SimControl.updateOne({ _id: 'default' }, { $set: { companyId: platformId } });
    expect((await api('get', '/status')).body.company.name).toBe('Acme Components');
    await SimControl.deleteMany({});
  });

  it('lists simulators with their online state and offers the newest online catalogue', async () => {
    await SimInstance.create([
      { _id: 'pi-old', name: 'Old Pi', lastSeenAt: new Date(now() - MIN), scenarios: [{ id: 'gone' }] },
      {
        _id: 'laptop',
        name: 'Laptop',
        companyId: acme.companyId,
        lastSeenAt: new Date(now()),
        stats: { pointsPerSec: 42, people: { onShift: 9, busy: 3, actionsToday: 120 } },
        scenarios: SCENARIOS,
      },
    ]);
    const res = await api('get', '/status');
    expect(res.body.instances.map((i) => [i.id, i.online])).toEqual([
      ['laptop', true],
      ['pi-old', false],
    ]);
    expect(res.body.instances[0].stats).toMatchObject({ pointsPerSec: 42, people: { onShift: 9 } });
    expect(res.body.scenarios.map((s) => s.id)).toEqual(['bearing_wear', 'overheating']);

    await heartbeat(new Date(now() - MIN));
    expect((await api('get', '/status')).body.scenarios).toEqual([]);
    await heartbeat();
  });
});

describe('controls', () => {
  it('requests one backfill at a time and creates the control document when needed', async () => {
    expect((await api('post', '/backfill').send({ days: 0 })).status).toBe(400);
    expect((await api('post', '/backfill').send({ days: 31 })).status).toBe(400);
    const res = await api('post', '/backfill').send({ days: 7 });
    expect(res.status).toBe(200);
    expect(res.body.control).toMatchObject({
      companyId: String(acme.companyId),
      running: true,
      backfill: { status: 'requested', days: 7, progress: 0, requestedBy: adminId },
      updatedBy: adminId,
    });

    expect((await api('post', '/backfill').send({ days: 3 })).status).toBe(409);
    await SimControl.updateOne({ _id: 'default' }, { $set: { 'backfill.status': 'running' } });
    expect((await api('post', '/backfill').send({ days: 3 })).status).toBe(409);
    await SimControl.updateOne({ _id: 'default' }, { $set: { 'backfill.status': 'done' } });
    const again = await api('post', '/backfill').send({ days: 3 });
    expect(again.body.control.backfill).toMatchObject({ status: 'requested', days: 3 });
  });

  it('changes the runtime settings within their limits', async () => {
    const bad = [
      {},
      { telemetryTickMs: 500 },
      { telemetryTickMs: 60_001 },
      { humanSpeed: 0 },
      { humanSpeed: 121 },
      { running: 'yes' },
      { companyId: String(beta.companyId) },
    ];
    for (const body of bad) expect((await api('patch', '/control').send(body)).status).toBe(400);

    const res = await api('patch', '/control').send({
      running: false,
      telemetryTickMs: 2000,
      humanSpeed: 30,
      respondToAnomalies: true,
    });
    expect(res.status).toBe(200);
    expect(res.body.control).toMatchObject({
      running: false,
      telemetryTickMs: 2000,
      humanActivity: true,
      humanSpeed: 30,
      respondToAnomalies: true,
      companyId: String(acme.companyId),
      backfill: { status: 'requested', days: 3 },
      updatedBy: adminId,
    });
    expect(Date.parse(res.body.control.updatedAt)).toBeGreaterThan(Date.now() - MIN);
    const next = await api('patch', '/control').send({ running: true, humanActivity: false });
    expect(next.body.control).toMatchObject({ running: true, humanActivity: false, telemetryTickMs: 2000 });
    expect((await api('get', '/status')).body.control).toMatchObject({ running: true, humanSpeed: 30 });
  });
});

describe('anomaly injection', () => {
  let event;
  let pressId;
  let body;

  beforeAll(async () => {
    pressId = await assetId(acme.companyId, 'Press 1');
    body = { assetId: pressId, scenario: 'bearing_wear', severity: 'high', rampMin: 10, holdMin: 30 };
  });

  it('needs an online simulator', async () => {
    await heartbeat(new Date(now() - MIN));
    expect((await api('post', '/inject').send(body)).status).toBe(409);
    await heartbeat();
  });

  it('injects a catalogue scenario on a machine of the simulated company only', async () => {
    const res = await api('post', '/inject').send(body);
    expect(res.status).toBe(201);
    ({ event } = res.body);
    expect(event).toMatchObject({
      scenario: 'bearing_wear',
      severity: 'high',
      assetId: pressId,
      assetName: 'Press 1',
      companyId: String(acme.companyId),
      affects: SCENARIOS[0].affects,
      phase: 'ramp',
      progress: 0,
      clearedAt: null,
      active: true,
      createdBy: adminId,
    });
    expect(new Date(event.endsAt) - new Date(event.startedAt)).toBe(40 * MIN);

    const rejected = [
      { ...body, assetId: await assetId(beta.companyId, 'Compressor 1') }, // another company's machine
      { ...body, assetId: '0123456789abcdef01234567' },
      { ...body, scenario: 'sensor_stuck' }, // not in the simulator's catalogue
      { ...body, scenario: 'overheating' }, // furnaces only
      { ...body, severity: 'extreme' },
      { ...body, rampMin: 0 },
      { ...body, holdMin: 1441 },
      { ...body, field: 'x") |> drop()' },
    ];
    for (const bad of rejected) expect((await api('post', '/inject').send(bad)).status).toBe(400);
    expect(await SimEvent.countDocuments()).toBe(1);
  });

  it('shows active injections in the status', async () => {
    const { injections } = (await api('get', '/status')).body;
    expect(injections).toMatchObject([{ id: event.id, assetName: 'Press 1', active: true }]);
  });

  it('clears only active injections: one, then all', async () => {
    expect((await api('post', '/clear').send({})).status).toBe(400);
    expect((await api('post', '/clear').send({ eventId: event.id })).body).toEqual({ cleared: 1 });
    const stored = await SimEvent.findById(event.id).lean();
    expect(stored).toMatchObject({ clearedReason: 'superadmin', clearedAt: expect.any(Date) });
    expect(String(stored.clearedBy)).toBe(adminId);
    expect((await api('post', '/clear').send({ eventId: event.id })).body).toEqual({ cleared: 0 });

    const furnace = await assetId(acme.companyId, 'Furnace 1');
    const second = { assetId: furnace, scenario: 'overheating', severity: 'low', rampMin: 5, holdMin: 0 };
    expect((await api('post', '/inject').send(second)).status).toBe(201);
    const long = new Date(now() - 3 * 60 * MIN);
    const expired = await SimEvent.create({
      companyId: acme.companyId,
      assetId: furnace,
      scenario: 'overheating',
      rampMin: 1,
      holdMin: 0,
      startedAt: long,
      endsAt: new Date(long.getTime() + MIN),
    });
    expect((await api('post', '/clear').send({ all: true })).body).toEqual({ cleared: 1 });
    expect((await SimEvent.findById(expired._id).lean()).clearedAt).toBeNull();
    expect((await api('get', '/status')).body.injections).toEqual([]);
  });

  it('lists the injection history of the simulated company, newest first', async () => {
    await SimEvent.create({
      companyId: beta.companyId,
      assetId: await assetId(beta.companyId, 'Compressor 1'),
      scenario: 'bearing_wear',
      rampMin: 1,
      holdMin: 1,
      startedAt: new Date(now()),
      endsAt: new Date(now() + 2 * MIN),
    });
    const res = await api('get', '/events');
    expect(res.status).toBe(200);
    expect(res.body.events.map((e) => [e.assetName, e.scenario])).toEqual([
      ['Furnace 1', 'overheating'],
      ['Press 1', 'bearing_wear'],
      ['Furnace 1', 'overheating'],
    ]);
    expect(res.body.events[1]).toMatchObject({ id: event.id, clearedReason: 'superadmin', active: false });
    expect((await api('get', '/events?limit=1')).body.events).toHaveLength(1);
    expect((await api('get', '/events?limit=0')).status).toBe(400);
  });

  it('keeps an injected breakdown active after its fade, until a repair or the superadmin clears it', async () => {
    const long = new Date(now() - 3 * 60 * MIN);
    const breakdown = await SimEvent.create({
      companyId: acme.companyId,
      assetId: pressId,
      scenario: 'sudden_breakdown',
      rampMin: 1,
      holdMin: 0,
      startedAt: long,
      endsAt: new Date(long.getTime() + MIN),
      phase: 'hold',
      progress: 1,
    });
    const id = String(breakdown._id);
    expect((await api('get', '/status')).body.injections.map((i) => i.id)).toEqual([id]);
    expect((await api('get', '/events')).body.events.find((e) => e.id === id)).toMatchObject({
      active: true,
    });
    expect((await api('post', '/clear').send({ eventId: id })).body).toEqual({ cleared: 1 });
    expect((await api('get', '/status')).body.injections).toEqual([]);
    expect((await api('get', '/events')).body.events.find((e) => e.id === id)).toMatchObject({
      active: false,
      clearedReason: 'superadmin',
    });
  });
});

describe('activity, people and machines', () => {
  it('pages through the activity feed, newest first', async () => {
    const at = (minutesAgo) => new Date(now() - minutesAgo * MIN);
    await SimActivity.create([
      {
        companyId: acme.companyId,
        at: at(3),
        actor: { name: 'Ramesh Kumar', role: 'technician', title: 'Maintenance Technician' },
        action: 'workorder.start',
        summary: 'Ramesh Kumar started WO-112 · Hydraulic oil leak (IMM 3)',
        target: { module: 'workorders', id: 'abc', code: 'WO-112' },
      },
      { companyId: acme.companyId, at: at(2), action: 'attendance.checkin', summary: 'Asha checked in' },
      { companyId: acme.companyId, at: at(1), action: 'jobcard.start', summary: 'Sunil started JC-9' },
      { companyId: beta.companyId, at: at(1), action: 'attendance.checkin', summary: 'Someone at Beta' },
    ]);
    const first = await api('get', '/activity?limit=2');
    expect(first.status).toBe(200);
    expect(first.body.activity.map((a) => a.summary)).toEqual(['Sunil started JC-9', 'Asha checked in']);
    const next = await api('get', `/activity?limit=2&before=${first.body.activity[1].at}`);
    expect(next.body.activity).toMatchObject([
      { target: { code: 'WO-112' }, actor: { name: 'Ramesh Kumar' } },
    ]);
    expect((await api('get', '/activity?before=')).body.activity).toHaveLength(3);
    expect((await api('get', '/activity?before=soon')).status).toBe(400);
  });

  it('lists the simulated company people with the shared password, owners first', async () => {
    const res = await api('get', '/credentials');
    expect(res.status).toBe(200);
    expect(res.body.password).toBe(env.SIM_DEFAULT_PASSWORD);
    expect(res.body.users).toHaveLength(acme.counts.users);
    expect(res.body.users[0]).toEqual({
      email: 'owner_1@acme.test',
      name: 'Vikram Mehta',
      role: 'owner',
      title: 'Managing Director',
      department: 'Maintenance',
      shift: null,
    });
    const tech = res.body.users.find((u) => u.email === 'maintenance_technician_1@acme.test');
    expect(tech).toMatchObject({ role: 'technician', department: 'Maintenance' });
    expect(['A', 'B']).toContain(tech.shift);
    const roles = res.body.users.map((u) => u.role);
    expect(roles.indexOf('admin')).toBeLessThan(roles.indexOf('technician'));
    expect(roles.at(-1)).toBe('view');
  });

  it('lists the simulated company machines', async () => {
    const res = await api('get', '/assets');
    expect(res.body.assets).toHaveLength(acme.counts.assets);
    expect(res.body.assets.find((a) => a.name === 'Press 1')).toEqual({
      id: expect.any(String),
      name: 'Press 1',
      tag: 'PRS-01',
      type: 'Power Press',
      status: 'OFF',
      plantName: 'Pune Plant',
      isProductionAsset: true,
      isEnergyAsset: true,
      isSensorIntegration: false,
    });
  });

  it('answers calmly while there is no simulated company yet', async () => {
    await Company().updateMany({}, { $set: { isSimulated: false } });
    try {
      expect((await api('get', '/status')).body).toMatchObject({ company: null, injections: [] });
      expect((await api('get', '/assets')).body).toEqual({ assets: [] });
      expect((await api('get', '/credentials')).body).toEqual({
        users: [],
        password: env.SIM_DEFAULT_PASSWORD,
      });
      expect((await api('get', '/events')).body).toEqual({ events: [] });
      expect((await api('get', '/activity')).body).toEqual({ activity: [] });
      expect((await api('post', '/clear').send({ all: true })).body).toEqual({ cleared: 0 });
      const inject = await api('post', '/inject').send({
        assetId: await assetId(acme.companyId, 'Press 1'),
        scenario: 'bearing_wear',
        severity: 'low',
        rampMin: 1,
        holdMin: 0,
      });
      expect(inject.status).toBe(400);
    } finally {
      await Company().updateMany(
        { _id: { $in: [acme.companyId, beta.companyId] } },
        { $set: { isSimulated: true } },
      );
    }
  });
});
