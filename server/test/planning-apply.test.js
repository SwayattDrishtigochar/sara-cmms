import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { records } from '../src/modules/records.js';
import { getModule } from '../src/modules/registry.js';
import { proposeProduction } from '../src/planning/production.js';
import { applyProposal, discardProposal, getProposal, listProposals } from '../src/planning/proposals.js';
import { planningTools } from '../src/planning/tools.js';
import { planningRouter } from '../src/routes/planning.js';
import { contextFor, PASSWORD, setupDatabase, teardownDatabase } from './helpers/db.js';

const Model = (name) => getModule(name).Model;
const DAY = 86_400_000;
const tool = (name) => planningTools.find((t) => t.name === name);
let owner;
let viewer;
let betaOwner;
const propose = (ctx = owner, quantity = 3000) =>
  proposeProduction(ctx, { partName: 'Housing-A', quantity, dueDate: new Date(Date.now() + 12 * DAY) });
const byStamp = (p) =>
  Model('jobcards')
    .find({ proposalId: String(p._id) })
    .lean();

beforeAll(async () => {
  await setupDatabase();
  owner = await contextFor('owner_1@acme.test');
  viewer = await contextFor('viewer_1@acme.test');
  betaOwner = await contextFor('owner_1@beta.test');
});
afterAll(teardownDatabase);

describe('applyProposal', () => {
  it('applies once; a double confirm returns the same records', async () => {
    const p = await propose();
    const cardOps = p.ops.filter((o) => o.module === 'jobcards');
    const first = await applyProposal(owner, p._id);
    expect(first.proposal).toMatchObject({ status: 'applied', appliedOps: p.ops.length });
    expect(first.created.map((c) => c.module)).toEqual(['productionplans', ...cardOps.map(() => 'jobcards')]);
    const again = await applyProposal(owner, p.proposalCode);
    expect(again.created.map((c) => c.id)).toEqual(first.created.map((c) => c.id));
    expect(await byStamp(p)).toHaveLength(cardOps.length);
    const plan = await Model('productionplans').findById(first.created[0].id).lean();
    expect(plan).toMatchObject({ status: 'Planned', quantity: 3000, feasibility: { feasible: true } });
    const cards = await byStamp(p);
    expect(cards.every((c) => String(c.productionPlanId) === first.created[0].id)).toBe(true);
  });

  it('answers 409 PLAN_CHANGED with a fresh plan when the schedule moved', async () => {
    const p = await propose();
    await records.create(owner, 'workorders', { name: 'Unplanned breakdown' }); // bumps scheduleVersion
    const err = await applyProposal(owner, p._id).catch((e) => e);
    expect(err).toMatchObject({ status: 409, code: 'PLAN_CHANGED' });
    const fresh = await getProposal(owner, err.details.proposalId);
    expect(fresh).toMatchObject({
      status: 'draft',
      kind: 'production',
      proposalCode: err.details.proposalCode,
    });
    expect((await getProposal(owner, p._id)).status).toBe('stale');
    await expect(applyProposal(owner, p._id)).rejects.toMatchObject({
      code: 'PLAN_CHANGED',
      details: err.details,
    });
    expect(await byStamp(p)).toHaveLength(0);
    await discardProposal(owner, fresh._id);
  });

  it('resumes after a failed op without duplicates', async () => {
    const p = await propose(owner, 6000);
    const last = p.ops.at(-1);
    await Model('assets').updateOne({ _id: last.data.asset }, { $set: { deleted: true } });
    await expect(applyProposal(owner, p._id)).rejects.toMatchObject({ status: 400 });
    const failed = await getProposal(owner, p._id);
    expect(failed).toMatchObject({ status: 'failed', appliedOps: last.seq });
    expect(failed.error).toMatch(/asset/i);
    await Model('assets').updateOne({ _id: last.data.asset }, { $set: { deleted: false } });
    const done = await applyProposal(owner, p._id);
    expect(done.proposal.status).toBe('applied');
    expect(await byStamp(p)).toHaveLength(p.ops.length - 1);
    expect(await Model('productionplans').countDocuments({ proposalId: String(p._id) })).toBe(1);
  });

  it('refuses discarded and expired plans with 410, and viewers with 403', async () => {
    const p = await propose();
    await expect(applyProposal(viewer, p._id)).rejects.toMatchObject({ status: 403 });
    await discardProposal(owner, p._id);
    await expect(applyProposal(owner, p._id)).rejects.toMatchObject({ status: 410 });
    const q = await propose();
    await Model('planproposals').updateOne(
      { _id: q._id },
      { $set: { expiresAt: new Date(Date.now() - 1000) } },
    );
    await expect(applyProposal(owner, q._id)).rejects.toMatchObject({ status: 410 });
    expect((await getProposal(owner, q._id)).status).toBe('expired');
  });

  it('keeps company B away from company A’s plans', async () => {
    const p = await propose();
    await expect(getProposal(betaOwner, p._id)).rejects.toMatchObject({ status: 404 });
    await expect(getProposal(betaOwner, p.proposalCode)).rejects.toMatchObject({ status: 404 });
    await expect(applyProposal(betaOwner, p._id)).rejects.toMatchObject({ status: 404 });
    expect((await listProposals(betaOwner)).items).toEqual([]);
    expect((await listProposals(owner, { status: 'draft' })).items.map((i) => i.proposalCode)).toContain(
      p.proposalCode,
    );
    expect((await getProposal(owner, p._id)).status).toBe('draft');
    await discardProposal(owner, p._id);
  });
});

describe('planning tools', () => {
  it('plan_production drafts, apply_plan previews and applies', async () => {
    const planned = await tool('plan_production').run(owner, {
      part: 'Housing-A',
      quantity: 2000,
      dueDate: new Date(Date.now() + 12 * DAY).toISOString().slice(0, 10),
    });
    expect(planned.summary).toMatch(/^PLN-\d+ · \d job cards? · (doable \(|needs adjustment)/);
    expect(planned.blocks[0].type).toBe('plan');
    expect(planned.blocks[0].payload.bars.some((b) => b.ghost)).toBe(true);
    const { proposalId } = planned.forModel;
    const preview = await tool('apply_plan').preview(owner, { proposalId });
    expect(preview.payload).toMatchObject({ tool: 'apply_plan', action: 'plan', module: 'planproposals' });
    expect(preview.payload.label).toMatch(/^Apply PLN-\d+: \d job cards? on /);
    expect(preview.payload.ops[0]).toMatchObject({ seq: 0, op: 'create', summary: 'Create production plan' });
    const run = await tool('apply_plan').run(owner, { proposalId });
    expect(run.forModel).toMatchObject({ applied: true, code: planned.forModel.code });
    expect(tool('apply_plan').permission(viewer)).toBe(false);
    expect(tool('plan_production').permission(betaOwner)).toBe(false); // production switched off
  });

  it('capacity_calendar summarises free hours', async () => {
    const out = await tool('capacity_calendar').run(owner, {});
    expect(out.summary).toMatch(/^Capacity of \d+ machines · \d+ h free$/);
    expect(out.forModel.machines[0]).toHaveProperty('freeWindows');
  });
});

describe('planning routes', () => {
  let app;
  const tokens = {};
  const as = (who) => ({ authorization: `Bearer ${tokens[who]}` });

  beforeAll(async () => {
    app = createApp({ routers: [{ path: '/api', router: planningRouter }] });
    for (const [who, email] of Object.entries({
      owner: 'owner_1@acme.test',
      viewer: 'viewer_1@acme.test',
      beta: 'owner_1@beta.test',
    })) {
      const res = await request(app).post('/api/auth/login').send({ email, password: PASSWORD });
      tokens[who] = res.body.token;
    }
  });

  it('proposes with an AI explanation, reads and lists', async () => {
    const res = await request(app)
      .post('/api/planning/production')
      .set(as('owner'))
      .send({
        partName: 'Housing-A',
        quantity: 1500,
        dueDate: new Date(Date.now() + 12 * DAY).toISOString(),
      });
    expect(res.status).toBe(200);
    expect(res.body.proposal.explanation).toMatchObject({
      mock: true,
      text: expect.stringMatching(/^(Doable|Needs adjustment):/),
    });
    expect(res.body.plan.proposal.code).toBe(res.body.proposal.proposalCode);
    const id = res.body.proposal._id;
    const one = await request(app).get(`/api/planning/proposals/${id}`).set(as('viewer'));
    expect(one.status).toBe(200);
    expect((await request(app).get(`/api/planning/proposals/${id}`).set(as('beta'))).status).toBe(404);
    const list = await request(app).get('/api/planning/proposals?kind=production').set(as('owner'));
    expect(list.body.items[0]).not.toHaveProperty('ops');
    const explain = await request(app).post(`/api/planning/proposals/${id}/explain`).set(as('owner'));
    expect(explain.body.explanation.text).toBeTruthy();
    expect((await request(app).post(`/api/planning/proposals/${id}/explain`).set(as('viewer'))).status).toBe(
      403,
    );
  });

  it('a stale apply answers 409 and the updated plan comes with its explanation', async () => {
    const p = await propose(owner, 1200);
    await records.create(owner, 'workorders', { name: 'Unplanned breakdown' }); // bumps scheduleVersion
    const res = await request(app).post(`/api/planning/proposals/${p._id}/apply`).set(as('owner')).send({});
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PLAN_CHANGED');
    const fresh = await getProposal(owner, res.body.error.details.proposalId);
    expect(fresh.explanation).toMatchObject({
      mock: true,
      text: expect.stringMatching(/^(Doable|Needs adjustment):/),
    });
    await discardProposal(owner, fresh._id);
  });

  it('serves the calendar and the parts list; viewers cannot plan', async () => {
    const cal = await request(app).get('/api/planning/calendar').set(as('owner'));
    expect(cal.status).toBe(200);
    expect(cal.body.gantt.rows.length).toBeGreaterThan(0);
    expect(cal.body.machines[0]).toHaveProperty('efficiencySource');
    const parts = await request(app).get('/api/planning/parts').set(as('owner'));
    const housing = parts.body.parts.find((p) => p.partName === 'Housing-A');
    expect(housing.tools.map((t) => t.toolNumber)).toEqual(
      expect.arrayContaining(['T-101', 'T-102', 'T-103']),
    );
    expect(housing.tools[0].assets[0]).toEqual({ id: expect.any(String), label: expect.any(String) });
    const denied = await request(app)
      .post('/api/planning/production')
      .set(as('viewer'))
      .send({ partName: 'Housing-A', quantity: 10, dueDate: new Date(Date.now() + DAY).toISOString() });
    expect(denied.status).toBe(403);
  });
});
