import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import { Session } from '../src/db/models/Session.js';
import { getModule } from '../src/modules/registry.js';
import { setupDatabase, teardownDatabase } from './helpers/db.js';

// Before env.js loads: demo mode on for the Acme fixture's domain (Beta Foods stays outside it);
// the superadmin sits inside that domain so the role/platform guards, not the domain, must keep it out.
vi.hoisted(() => {
  process.env.DEMO_MODE = 'true';
  process.env.DEMO_DOMAIN = 'acme.test';
  process.env.SUPERADMIN_EMAIL = 'superadmin@acme.test';
});

let app;
beforeAll(async () => {
  await setupDatabase();
  await getModule('users').Model.updateOne({ email: 'viewer_1@acme.test' }, { $set: { deleted: true } });
  app = createApp();
});
afterAll(teardownDatabase);

const demoLogin = (email) => request(app).post('/api/auth/demo-login').send({ email });

describe('demo mode on', () => {
  it('lists the demo company people, grouped and ordered, without passwords or the superadmin', async () => {
    const res = await request(app).get('/api/auth/demo-accounts');
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toMatch(/password|superadmin|beta\.test/i);
    expect(res.body.accounts.map((a) => a.company.name)).toEqual(['Acme Components']);
    const users = res.body.accounts[0].users;
    expect(users.every((u) => u.email.endsWith('@acme.test'))).toBe(true);
    expect(users.map((u) => u.email)).not.toContain('viewer_1@acme.test');
    expect(users[0]).toEqual({
      email: 'owner_1@acme.test',
      name: expect.any(String),
      role: 'owner',
      title: 'Managing Director',
      department: 'Maintenance',
    });
    const rank = { owner: 0, admin: 1, technician: 2, view: 3 };
    const key = (u) => `${rank[u.role]}${u.department === 'Maintenance' ? 0 : 1}${u.title}${u.email}`;
    expect(users.map(key)).toEqual([...users.map(key)].sort());
  });

  it('signs a demo person in with no password and opens a session', async () => {
    const res = await demoLogin('OWNER_1@acme.test');
    expect(res.status).toBe(200);
    expect(res.body.user.password).toBeUndefined();
    expect(res.body.context.role).toBe('owner');
    const me = await request(app).get('/api/auth/me').set('authorization', `Bearer ${res.body.token}`);
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe('owner_1@acme.test');
    expect(await Session.exists({ userId: res.body.user._id, expired: false })).toBeTruthy();
  });

  it.each([
    ['the superadmin', env.SUPERADMIN_EMAIL],
    ['an e-mail outside DEMO_DOMAIN', 'owner_1@beta.test'],
    ['an unknown e-mail', 'nobody@acme.test'],
    ['a deleted user', 'viewer_1@acme.test'],
  ])('refuses %s like a wrong password', async (_what, email) => {
    const res = await demoLogin(email);
    expect(res.status).toBe(401);
    expect(res.body.error.message).toBe('Wrong email or password');
    expect(res.body.token).toBeUndefined();
  });

  it('rate-limits demo logins like password logins', async () => {
    let last;
    for (let i = 0; i <= env.RATE_LIMIT_LOGIN_PER_MIN; i++) {
      last = await demoLogin('nobody@acme.test');
      if (last.status === 429) break;
    }
    expect(last.status).toBe(429);
    expect(last.body.error.code).toBe('RATE_LIMITED');
  });
});
