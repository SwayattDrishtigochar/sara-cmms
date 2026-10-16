import { once } from 'node:events';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { influxEnabled, pingInflux } from '../src/config/influx.js';
import { ParameterSpec } from '../src/db/models/Sim.js';
import { publish } from '../src/lib/events.js';
import { getModule } from '../src/modules/registry.js';
import { telemetryRouter } from '../src/routes/telemetry.js';
import { PASSWORD, setupDatabase, teardownDatabase } from './helpers/db.js';

const { live, unsubscribed } = vi.hoisted(() => ({
  live: { cache: null, snapshot: [], released: 0 },
  unsubscribed: vi.fn(),
}));
vi.mock('../src/telemetry/livePoller.js', () => ({
  watchCompany: () => ({
    ready: Promise.resolve(),
    release: () => {
      live.released += 1;
    },
  }),
  cachedLatest: () => live.cache,
  liveSnapshot: () => live.snapshot,
}));
vi.mock('../src/lib/events.js', async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    subscribe: (handler) => {
      const off = real.subscribe(handler);
      return () => {
        unsubscribed();
        off();
      };
    },
  };
});

const influxUp = influxEnabled && (await pingInflux()) === 'up';

let app;
let acme;
let beta;
const tokens = {};
const ids = {}; // asset, plant and user ids as strings
const as = (who) => ({ authorization: `Bearer ${tokens[who]}` });

beforeAll(async () => {
  ({ acme, beta } = await setupDatabase());
  app = createApp({ routers: [{ path: '/api', router: telemetryRouter }] });

  const Asset = getModule('assets').Model;
  const find = async (name) => Asset.findOne({ companyId: acme.companyId, name }).lean();
  const [imm1, imm4, furnace] = await Promise.all([find('IMM 1'), find('IMM 4'), find('Furnace 1')]);
  Object.assign(ids, {
    pune: String(imm1._id),
    chennai: String(imm4._id),
    furnace: String(furnace._id),
    punePlant: String(imm1.plantId),
    chennaiPlant: String(imm4.plantId),
  });
  const chennaiAssets = await Asset.find({ companyId: acme.companyId, plantId: imm4.plantId }).lean();
  ids.chennaiAssets = chennaiAssets.map((a) => String(a._id));

  const users = {
    owner: 'owner_1@acme.test',
    chennaiTech: 'maintenance_technician_4@acme.test',
    betaOwner: 'owner_1@beta.test',
  };
  for (const [who, email] of Object.entries(users)) {
    const res = await request(app).post('/api/auth/login').send({ email, password: PASSWORD });
    tokens[who] = res.body.token;
    ids[who] = String(res.body.user._id);
  }

  await ParameterSpec.create([
    {
      assetType: 'Injection Moulding Machine',
      measurement: 'machineParams',
      field: 'oilTempPv',
      unit: '°C',
      valueType: 'number',
      normalMin: 35,
      normalMax: 55,
    },
    {
      assetType: 'Injection Moulding Machine',
      measurement: 'machineParams',
      field: 'toolName',
      valueType: 'string',
    },
    { assetType: 'Power Press', measurement: 'machineParams', field: 'press_speed', unit: 'spm' },
  ]);

  const reading = (value, measurement = 'machineParams') => ({
    value,
    time: new Date().toISOString(),
    measurement,
  });
  live.warm = new Map([
    [
      ids.pune,
      {
        status: 'Running',
        since: Date.now() - 60_000,
        values: { oilTempPv: reading(47.5), toolName: reading('Housing-A Mould #1') },
      },
    ],
    [ids.chennai, { status: 'Stopped', since: Date.now(), values: {} }],
  ]);
  live.snapshot = [
    { assetId: ids.pune, plantId: ids.punePlant, status: 'Running', values: { oilTempPv: 47.5 } },
    { assetId: ids.chennai, plantId: ids.chennaiPlant, status: 'Stopped', values: {} },
  ];
});
afterAll(teardownDatabase);

describe('access', () => {
  it('hides another company asset (404) on every route', async () => {
    for (const path of ['fields', 'series', 'timeline']) {
      const res = await request(app)
        .get(`/api/telemetry/${path}`)
        .query({ assetId: ids.pune })
        .set(as('betaOwner'));
      expect(res.status).toBe(404);
    }
    const latest = await request(app)
      .get('/api/telemetry/latest')
      .query({ assetIds: ids.pune })
      .set(as('betaOwner'));
    expect(latest.status).toBe(404);
  });

  it('hides another plant asset from a plant-locked user', async () => {
    const fields = await request(app)
      .get('/api/telemetry/fields')
      .query({ assetId: ids.pune })
      .set(as('chennaiTech'));
    expect(fields.status).toBe(404);
    const latest = await request(app)
      .get('/api/telemetry/latest')
      .query({ assetIds: `${ids.chennai},${ids.pune}` })
      .set(as('chennaiTech'));
    expect(latest.status).toBe(404);
  });

  it('requires a sign-in and an asset', async () => {
    expect((await request(app).get('/api/telemetry/fields').query({ assetId: ids.pune })).status).toBe(401);
    expect((await request(app).get('/api/telemetry/fields').set(as('owner'))).status).toBe(400);
  });
});

describe('GET /telemetry/fields', () => {
  it('lists the type specs, energy and shot fields with units and key flags', async () => {
    const res = await request(app).get('/api/telemetry/fields').query({ assetId: ids.pune }).set(as('owner'));
    expect(res.status).toBe(200);
    const byName = Object.fromEntries(res.body.fields.map((f) => [`${f.measurement}/${f.field}`, f]));
    expect(byName['machineParams/oilTempPv']).toEqual({
      measurement: 'machineParams',
      field: 'oilTempPv',
      unit: '°C',
      valueType: 'number',
      normalMin: 35,
      normalMax: 55,
      key: true,
    });
    expect(byName['machineParams/toolName']).toMatchObject({ valueType: 'string', unit: null, key: false });
    expect(byName['machineParams/press_speed']).toBeUndefined();
    expect(byName['energy/POWER TOTAL']).toMatchObject({ unit: 'kW', valueType: 'number', key: false });
    expect(byName['energy/ENERGY CONSUMPTION'].unit).toBe('kWh');
    expect(byName['energy/CURRENT TEMP']).toBeUndefined(); // furnaces only
    expect(byName['shotCountDetails/shotsProduced'].unit).toBe('shots');
    expect(byName['shotCountDetails/cycleTime'].key).toBe(true);
    expect(byName['timelineData/assetStatus']).toBeUndefined();
  });

  it('adds furnace temperatures for a furnace', async () => {
    const res = await request(app)
      .get('/api/telemetry/fields')
      .query({ assetId: ids.furnace })
      .set(as('owner'));
    const names = res.body.fields.map((f) => f.field);
    expect(names).toContain('CURRENT TEMP');
    expect(names).not.toContain('shotsProduced');
  });
});

describe('GET /telemetry/latest', () => {
  it('answers from the live poller cache while it is warm', async () => {
    live.cache = live.warm;
    const res = await request(app)
      .get('/api/telemetry/latest')
      .query({ assetIds: ids.pune })
      .set(as('owner'));
    expect(res.status).toBe(200);
    const [asset] = res.body.assets;
    expect(asset).toMatchObject({ assetId: ids.pune, status: 'Running' });
    expect(Date.parse(asset.since)).toBeLessThan(Date.now());
    expect(asset.values.oilTempPv).toMatchObject({ value: 47.5, measurement: 'machineParams' });
    expect(asset.values.toolName.value).toBe('Housing-A Mould #1');
  });

  it('falls back to the stored status when the cache is cold', async () => {
    live.cache = null;
    const res = await request(app)
      .get('/api/telemetry/latest')
      .query({ assetIds: ids.pune })
      .set(as('owner'));
    expect(res.status).toBe(200);
    expect(res.body.assets[0]).toMatchObject({
      assetId: ids.pune,
      status: 'OFF',
      values: expect.any(Object),
    });
  });

  it('defaults to the assets the user can see', async () => {
    live.cache = live.warm;
    const res = await request(app).get('/api/telemetry/latest').set(as('chennaiTech'));
    expect(res.status).toBe(200);
    const seen = res.body.assets.map((a) => a.assetId);
    expect(seen.sort()).toEqual([...ids.chennaiAssets].sort());
    expect(res.body.assets.find((a) => a.assetId === ids.chennai).status).toBe('Stopped');
    live.cache = null;
  });
});

describe('GET /telemetry/series and /timeline', () => {
  it('rejects a bad range or field before querying', async () => {
    const badRange = await request(app)
      .get('/api/telemetry/series')
      .query({ assetId: ids.pune, range: 'forever' })
      .set(as('owner'));
    expect(badRange.status).toBe(400);
    const badField = await request(app)
      .get('/api/telemetry/series')
      .query({ assetId: ids.pune, fields: 'oilTempPv") |> drop()' })
      .set(as('owner'));
    expect(badField.status).toBe(400);
    for (const fn of ['median', 'drop', 'count']) {
      const badFn = await request(app)
        .get('/api/telemetry/series')
        .query({ assetId: ids.pune, fields: 'oilTempPv', fn })
        .set(as('owner'));
      expect(badFn.status).toBe(400);
    }
  });

  it.skipIf(!influxUp)('answers with the contract shapes', async () => {
    const series = await request(app)
      .get('/api/telemetry/series')
      .query({ assetId: ids.pune, fields: 'oilTempPv,ENERGY CONSUMPTION', range: '24h' })
      .set(as('owner'));
    expect(series.status).toBe(200);
    expect(series.body).toMatchObject({ every: '5m', series: expect.any(Array) });
    for (const fn of ['mean', 'sum', 'max', 'min', 'last']) {
      const res = await request(app)
        .get('/api/telemetry/series')
        .query({ assetId: ids.pune, fields: 'oilTempPv', range: '1h', fn })
        .set(as('owner'));
      expect(res.status).toBe(200);
    }
    const timeline = await request(app)
      .get('/api/telemetry/timeline')
      .query({ assetId: ids.chennai, range: '6h' })
      .set(as('chennaiTech'));
    expect(timeline.status).toBe(200);
    expect(timeline.body).toMatchObject({ runs: expect.any(Array), totals: expect.any(Object) });
    expect(typeof timeline.body.availability).toBe('number');
  });
});

/** Reads `event:`/`data:` frames off a fetch body, skipping `:` comments. */
const sseReader = (res) => {
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  return async () => {
    for (;;) {
      const end = buffer.indexOf('\n\n');
      if (end >= 0) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (frame.startsWith(':')) continue;
        return { event: /^event: (.*)$/m.exec(frame)[1], data: JSON.parse(/^data: (.*)$/m.exec(frame)[1]) };
      }
      const { value, done } = await reader.read();
      if (done) throw new Error('stream ended');
      buffer += value;
    }
  };
};

describe('GET /live', () => {
  it('sends hello, then only the events this user may see, and unsubscribes on close', async () => {
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const controller = new AbortController();
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/api/live`, {
        headers: as('chennaiTech'),
        signal: controller.signal,
      });
      expect(res.status).toBe(200);
      const next = sseReader(res);
      const hello = await next();
      expect(hello.event).toBe('hello');
      expect(typeof hello.data.serverTime).toBe('number');
      expect(hello.data.snapshot.map((s) => s.assetId)).toEqual([ids.chennai]);

      publish(beta.companyId, 'telemetry', { n: 1 }, { plantId: ids.chennaiPlant });
      publish(acme.companyId, 'telemetry', { n: 2 }, { plantId: ids.punePlant });
      publish(acme.companyId, 'notice', { n: 3 }, { userIds: [ids.owner] });
      publish(acme.companyId, 'notice', { n: 4 }, { superAdmin: true });
      publish(acme.companyId, 'record', { n: 4.5 }, { plantId: null }); // company-wide record: owners only
      publish(acme.companyId, 'telemetry', { n: 5 }, { plantId: ids.chennaiPlant });
      publish(acme.companyId, 'record', { n: 6 });
      publish(acme.companyId, 'notice', { n: 7 }, { userIds: [ids.chennaiTech] });
      const got = [await next(), await next(), await next()];
      expect(got.map((e) => [e.event, e.data.n])).toEqual([
        ['telemetry', 5],
        ['record', 6],
        ['notice', 7],
      ]);
    } finally {
      controller.abort();
      await vi.waitFor(() => expect(unsubscribed).toHaveBeenCalledTimes(1));
      expect(live.released).toBe(1);
      server.closeAllConnections();
      server.close();
    }
  });

  it('ends the stream once the sign-in behind it is gone', async () => {
    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: 'maintenance_technician_4@acme.test', password: PASSWORD });
    const auth = { authorization: `Bearer ${login.body.token}` };
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/api/live`, { headers: auth });
      const next = sseReader(res);
      expect((await next()).event).toBe('hello');

      await vi.advanceTimersByTimeAsync(60_000); // still signed in: the stream stays open
      publish(acme.companyId, 'record', { n: 1 }, { plantId: ids.chennaiPlant });
      expect((await next()).data).toEqual({ n: 1 });

      expect((await request(app).post('/api/auth/logout').set(auth)).status).toBe(204);
      await vi.advanceTimersByTimeAsync(60_000);
      await expect(next()).rejects.toThrow('stream ended');
      await vi.waitFor(() => expect(live.released).toBe(2));
    } finally {
      vi.useRealTimers();
      server.closeAllConnections();
      server.close();
    }
  });
});
