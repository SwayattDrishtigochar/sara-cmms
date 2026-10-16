import bcrypt from 'bcryptjs';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import { getModule } from '../src/modules/registry.js';
import { superadminUsesDemoPassword } from '../src/sim/platform.js';
import { PASSWORD, setupDatabase, teardownDatabase } from './helpers/db.js';

// Before env.js loads: the demo login panel on, and a superadmin password apart from the demo one.
vi.hoisted(() => {
  process.env.DEMO_MODE = 'true';
  process.env.SUPERADMIN_PASSWORD = 'Admin@Test-2026';
});

let app;
beforeAll(async () => {
  await setupDatabase();
  app = createApp();
});
afterAll(teardownDatabase);

describe('auth', () => {
  it('rejects a wrong password without saying which part was wrong', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'owner_1@acme.test', password: 'nope' });
    expect(res.status).toBe(401);
    expect(res.body.error.message).toBe('Wrong email or password');
  });

  it('logs in, reads me, logs out, and the token stops working', async () => {
    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: 'OWNER_1@acme.test', password: PASSWORD });
    expect(login.status).toBe(200);
    expect(login.body.user.password).toBeUndefined();
    expect(login.body.context.company.name).toBe('Acme Components');
    const auth = { authorization: `Bearer ${login.body.token}` };

    const me = await request(app).get('/api/auth/me').set(auth);
    expect(me.status).toBe(200);
    expect(me.body.context.role).toBe('owner');

    expect((await request(app).post('/api/auth/logout').set(auth)).status).toBe(204);
    expect((await request(app).get('/api/auth/me').set(auth)).status).toBe(401);
  });

  it('requires a token for data routes', async () => {
    expect((await request(app).get('/api/m/assets')).status).toBe(401);
  });

  it('serves module metadata and lists with filters', async () => {
    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: 'owner_1@acme.test', password: PASSWORD });
    const auth = { authorization: `Bearer ${login.body.token}` };
    const meta = await request(app).get('/api/modules').set(auth);
    expect(meta.body.modules.map((m) => m.name)).toContain('workorders');
    const list = await request(app)
      .get('/api/m/workorders')
      .query({ 'filter[priority]': 'High', limit: 5 })
      .set(auth);
    expect(list.status).toBe(200);
    expect(list.body.items.every((w) => w.priority === 'High')).toBe(true);
  });
});

describe('demo accounts', () => {
  it('lists only simulated companies, never the platform tenant, a superadmin or its password', async () => {
    const acme = await getModule('companies').Model.findOne({ name: 'Acme Components' }).lean();
    await getModule('users').Model.create({
      companyId: acme._id,
      firstName: 'Hidden',
      email: 'hidden_superadmin@acme.test',
      password: await bcrypt.hash('Whatever@123', 4),
      role: 'superAdmin',
    });
    const res = await request(app).get('/api/auth/demo-accounts');
    expect(res.status).toBe(200);
    expect(res.body.accounts.map((a) => a.company).sort()).toEqual(['Acme Components', 'Beta Foods']);
    expect(res.body.accounts.every((a) => a.password === env.SIM_DEFAULT_PASSWORD)).toBe(true);
    const users = res.body.accounts.flatMap((a) => a.users);
    expect(users.some((u) => u.role === 'superAdmin')).toBe(false);
    const text = JSON.stringify(res.body);
    expect(text).not.toContain(env.SUPERADMIN_EMAIL);
    expect(text).not.toContain(env.SUPERADMIN_PASSWORD);
    expect(text).not.toContain('Swayatt Platform');
  });

  it('knows when the superadmin could sign in with the demo password', async () => {
    expect(await superadminUsesDemoPassword()).toBe(false);
    const hash = await bcrypt.hash(env.SIM_DEFAULT_PASSWORD, 4);
    await getModule('users').Model.updateOne({ email: env.SUPERADMIN_EMAIL }, { $set: { password: hash } });
    expect(await superadminUsesDemoPassword()).toBe(true);
  });

  it('withholds the demo password while the superadmin could sign in with it', async () => {
    const res = await request(app).get('/api/auth/demo-accounts');
    expect(res.status).toBe(200);
    expect(res.body.accounts.length).toBeGreaterThan(0);
    expect(res.body.accounts.every((a) => a.password === '')).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain(env.SIM_DEFAULT_PASSWORD);
  });
});
