import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import { getModule } from '../src/modules/registry.js';
import { adminPlatformRouter } from '../src/routes/adminPlatform.js';
import { PASSWORD, setupDatabase, teardownDatabase } from './helpers/db.js';

let app;
let acme;
let beta;
let admin;
let owner;

const login = async (email, password) => {
  const res = await request(app).post('/api/auth/login').send({ email, password });
  expect(res.status).toBe(200);
  return { authorization: `Bearer ${res.body.token}` };
};

beforeAll(async () => {
  ({ acme, beta } = await setupDatabase());
  app = createApp({ routers: [{ path: '/api/admin/platform', router: adminPlatformRouter }] });
  admin = await login(env.SUPERADMIN_EMAIL, env.SUPERADMIN_PASSWORD);
  owner = await login('owner_1@acme.test', PASSWORD);
});
afterAll(teardownDatabase);

describe('GET /api/admin/platform/companies', () => {
  it('is for the superadmin only', async () => {
    expect((await request(app).get('/api/admin/platform/companies')).status).toBe(401);
    expect((await request(app).get('/api/admin/platform/companies').set(owner)).status).toBe(403);
  });

  it('lists every customer company with its counts, newest first, never the platform tenant', async () => {
    const Company = getModule('companies').Model;
    await Company.updateOne({ _id: beta.companyId }, { $set: { createdAt: new Date('2026-01-01') } });
    // Deleted documents do not count.
    await getModule('assets').Model.updateOne({ companyId: acme.companyId }, { $set: { deleted: true } });

    const res = await request(app).get('/api/admin/platform/companies').set(admin);
    expect(res.status).toBe(200);
    expect(res.body.companies.map((c) => c.name)).toEqual(['Acme Components', 'Beta Foods']);
    const [acmeRow] = res.body.companies;
    expect(acmeRow).toMatchObject({
      id: String(acme.companyId),
      plants: acme.counts.plants,
      users: acme.counts.users,
      assets: acme.counts.assets - 1,
    });
    expect(new Date(acmeRow.createdAt).getTime()).toBeGreaterThan(0);
    expect(JSON.stringify(res.body)).not.toContain('Swayatt Platform');
  });
});
