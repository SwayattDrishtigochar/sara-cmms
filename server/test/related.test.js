import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { records } from '../src/modules/records.js';
import { getModule, moduleMeta } from '../src/modules/registry.js';
import { relatedCounts, relatedList } from '../src/modules/related.js';
import { contextFor, PASSWORD, setupDatabase, teardownDatabase } from './helpers/db.js';

let app;
let acme;
let owner; // Acme, company-wide
let ramesh; // Acme technician locked to Pune
let betaOwner; // production off
let plan; // an Acme production plan with job cards
let planCards;

const login = async (email) => {
  const res = await request(app).post('/api/auth/login').send({ email, password: PASSWORD });
  return { authorization: `Bearer ${res.body.token}` };
};

beforeAll(async () => {
  ({ acme } = await setupDatabase());
  app = createApp();
  owner = await contextFor('owner_1@acme.test');
  ramesh = await contextFor('maintenance_technician_1@acme.test');
  betaOwner = await contextFor('owner_1@beta.test');
  const card = await getModule('jobcards')
    .Model.findOne({ companyId: acme.companyId, productionPlanId: { $ne: null } })
    .lean();
  plan = await getModule('productionplans').Model.findById(card.productionPlanId).lean();
  planCards = await getModule('jobcards').Model.find({ productionPlanId: plan._id }).lean();
});
afterAll(teardownDatabase);

describe('metadata', () => {
  it('exposes children on module meta, limited to modules the company has on', async () => {
    expect(moduleMeta(getModule('productionplans'), {}).children).toEqual([
      { module: 'jobcards', field: 'productionPlanId', label: 'Job cards', order: 0 },
    ]);
    const acmeMeta = await request(app)
      .get('/api/modules')
      .set(await login('owner_1@acme.test'));
    const assets = acmeMeta.body.modules.find((m) => m.name === 'assets');
    expect(assets.children.map((c) => c.module)).toEqual(
      expect.arrayContaining(['workorders', 'jobcards', 'anomalies']),
    );
    const betaMeta = await request(app)
      .get('/api/modules')
      .set(await login('owner_1@beta.test'));
    const betaAssets = betaMeta.body.modules.find((m) => m.name === 'assets');
    expect(betaAssets.children.map((c) => c.module)).toContain('workorders');
    expect(betaAssets.children.map((c) => c.module)).not.toContain('jobcards');
  });
});

describe('counts and lists', () => {
  it('counts the job cards of a production plan and lists them sorted', async () => {
    const counts = await relatedCounts(owner, 'productionplans', plan._id);
    expect(counts.parent).toEqual({ module: 'productionplans', id: String(plan._id) });
    expect(counts.children).toEqual([
      expect.objectContaining({
        module: 'jobcards',
        field: 'productionPlanId',
        label: 'Job cards',
        count: planCards.length,
        can: { read: true, create: true },
      }),
    ]);

    const list = await relatedList(owner, 'productionplans', plan._id, 'jobcards', { sort: 'startDate' });
    expect(list.child).toEqual({ module: 'jobcards', field: 'productionPlanId', label: 'Job cards' });
    expect(list.total).toBe(planCards.length);
    expect(list.items.every((jc) => String(jc.productionPlanId._id) === String(plan._id))).toBe(true);
    const starts = list.items.map((jc) => new Date(jc.startDate).getTime());
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
  });

  it('serves both routes and 404s an undeclared child', async () => {
    const auth = await login('owner_1@acme.test');
    const counts = await request(app).get(`/api/m/productionplans/${plan._id}/related`).set(auth);
    expect(counts.status).toBe(200);
    expect(counts.body.children[0]).toMatchObject({ module: 'jobcards', count: planCards.length });
    const list = await request(app)
      .get(`/api/m/productionplans/${plan._id}/related/jobcards?limit=1&page=2`)
      .set(auth);
    expect(list.status).toBe(200);
    expect(list.body).toMatchObject({ page: 2, limit: 1, total: planCards.length });
    expect(list.body.items).toHaveLength(planCards.length > 1 ? 1 : 0);
    const bad = await request(app).get(`/api/m/productionplans/${plan._id}/related/workorders`).set(auth);
    expect(bad.status).toBe(404);
    await expect(relatedList(owner, 'productionplans', plan._id, 'nope', {})).rejects.toMatchObject({
      status: 404,
    });
  });

  it('filters array refs: work orders assigned to a user', async () => {
    const wo = await records.create(owner, 'workorders', { name: 'Mine', people: [String(ramesh.userId)] });
    const counts = await relatedCounts(owner, 'users', ramesh.userId);
    const child = counts.children.find((c) => c.module === 'workorders');
    expect(child.count).toBeGreaterThanOrEqual(1);
    const list = await relatedList(owner, 'users', ramesh.userId, 'workorders', { limit: 100 });
    expect(list.items.map((w) => String(w._id))).toContain(String(wo._id));
  });
});

describe('tenancy and plant lock', () => {
  it('shows company B nothing of company A', async () => {
    await expect(relatedCounts(betaOwner, 'productionplans', plan._id)).rejects.toMatchObject({
      status: 404,
    });
    await expect(relatedList(betaOwner, 'assets', plan._id, 'workorders', {})).rejects.toMatchObject({
      status: 404,
    });
    const res = await request(app)
      .get(`/api/m/assets/${plan._id}/related`)
      .set(await login('owner_1@beta.test'));
    expect(res.status).toBe(404);
  });

  it('drops children the company has switched off', async () => {
    const asset = await getModule('assets').Model.findOne({ companyId: betaOwner.companyId }).lean();
    const counts = await relatedCounts(betaOwner, 'assets', asset._id);
    expect(counts.children.map((c) => c.module)).toContain('workorders');
    expect(counts.children.map((c) => c.module)).not.toContain('jobcards');
  });

  it('locks plant-bound users to their plant', async () => {
    const chennai = owner.plants.find((p) => p.name.startsWith('Chennai'));
    const Asset = getModule('assets').Model;
    const away = await Asset.findOne({ companyId: acme.companyId, plantId: chennai._id }).lean();
    await expect(relatedCounts(ramesh, 'assets', away._id)).rejects.toMatchObject({ status: 404 });

    // A Pune machine: work orders of another plant never show, even when linked to it.
    const home = await Asset.findOne({ companyId: acme.companyId, plantId: ramesh.plantLock }).lean();
    await records.create(owner, 'workorders', {
      name: 'Chennai-side',
      asset: String(home._id),
      plantId: String(chennai._id),
    });
    const list = await relatedList(ramesh, 'assets', home._id, 'workorders', { limit: 100 });
    expect(list.items.length).toBeGreaterThan(0);
    expect(list.items.every((w) => String(w.plantId?._id ?? w.plantId) === String(ramesh.plantLock))).toBe(
      true,
    );
    expect(list.items.map((w) => w.name)).not.toContain('Chennai-side');
    const counts = await relatedCounts(ramesh, 'assets', home._id);
    expect(counts.children.find((c) => c.module === 'workorders').count).toBe(list.total);
  });
});
