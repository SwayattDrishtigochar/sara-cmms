import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { PASSWORD, setupDatabase, teardownDatabase } from './helpers/db.js';

// Before env.js loads: demo mode off whatever the local .env says (auth-demo.test.js covers it on).
vi.hoisted(() => {
  process.env.DEMO_MODE = 'false';
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

  it('hides the demo routes while DEMO_MODE is off', async () => {
    const list = await request(app).get('/api/auth/demo-accounts');
    expect(list.status).toBe(404);
    expect(list.body).toEqual({ error: { code: 'NOT_FOUND', message: 'Not found' } });
    const login = await request(app).post('/api/auth/demo-login').send({ email: 'owner_1@acme.test' });
    expect(login.status).toBe(404);
    expect(login.body.token).toBeUndefined();
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
