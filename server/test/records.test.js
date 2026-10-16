import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ANOMALY_TYPES } from '../src/modules/defs/maintenance.js';
import { records } from '../src/modules/records.js';
import { getModule } from '../src/modules/registry.js';
import { contextFor, setupDatabase, systemContext, teardownDatabase } from './helpers/db.js';

let acme;
let beta;
let owner; // Acme owner (company-wide)
let ramesh; // Acme technician locked to Pune
let viewer;
let betaOwner;

beforeAll(async () => {
  ({ acme, beta } = await setupDatabase());
  owner = await contextFor('owner_1@acme.test');
  ramesh = await contextFor('maintenance_technician_1@acme.test');
  viewer = await contextFor('viewer_1@acme.test');
  betaOwner = await contextFor('owner_1@beta.test');
});
afterAll(teardownDatabase);

const acmeAsset = (name) => getModule('assets').Model.findOne({ companyId: acme.companyId, name }).lean();

describe('tenancy', () => {
  it('lists only the caller company records', async () => {
    const mine = await records.list(betaOwner, 'assets', { limit: 100 });
    expect(mine.total).toBeGreaterThan(0);
    expect(mine.items.every((a) => String(a.companyId) === String(beta.companyId))).toBe(true);
  });

  it('cannot read, update or delete another company record by id', async () => {
    const press = await acmeAsset('Press 1');
    await expect(records.get(betaOwner, 'assets', press._id)).rejects.toMatchObject({ status: 404 });
    await expect(records.update(betaOwner, 'assets', press._id, { location: 'x' })).rejects.toMatchObject({
      status: 404,
    });
    await expect(records.remove(betaOwner, 'assets', press._id)).rejects.toMatchObject({ status: 404 });
  });

  it('cannot link a record to another company record', async () => {
    const press = await acmeAsset('Press 1');
    await expect(
      records.create(betaOwner, 'workorders', { name: 'cross-tenant', asset: String(press._id) }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('ignores a companyId smuggled into a filter', async () => {
    await expect(
      records.list(betaOwner, 'assets', { filter: { companyId: String(acme.companyId) } }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('hides modules the company has switched off', () => {
    expect(betaOwner.modules).not.toContain('jobcards');
    expect(owner.modules).toContain('jobcards');
  });

  it('never returns password hashes', async () => {
    const people = await records.list(owner, 'users', { limit: 100 });
    expect(people.items.every((u) => !('password' in u))).toBe(true);
  });
});

describe('plant rule', () => {
  it('locks non-owners to their plant for reads', async () => {
    const all = await records.list(owner, 'assets', { limit: 100 });
    const pune = await records.list(ramesh, 'assets', { limit: 100 });
    expect(pune.total).toBeLessThan(all.total);
    expect(pune.items.every((a) => String(a.plantId?._id ?? a.plantId) === String(ramesh.plantLock))).toBe(
      true,
    );
  });

  it('forces their plant on writes even if another plant is given', async () => {
    const chennai = owner.plants.find((p) => p.name.startsWith('Chennai'));
    const wo = await records.create(ramesh, 'workorders', {
      name: 'Coolant leak',
      plantId: String(chennai._id),
    });
    expect(String(wo.plantId)).toBe(String(ramesh.plantLock));
  });

  it('shows company-wide KPIs (no plant) to plant-locked users, but not other plants', async () => {
    const chennai = owner.plants.find((p) => p.name.startsWith('Chennai'));
    const Kpi = getModule('kpis').Model;
    const base = { companyId: acme.companyId, viz: 'number' };
    const shared = await Kpi.create({ ...base, title: 'Company OEE' });
    await Kpi.create({ ...base, title: 'Pune OEE', plantId: ramesh.plantLock });
    await Kpi.create({ ...base, title: 'Chennai OEE', plantId: chennai._id });
    const { items } = await records.list(ramesh, 'kpis', { limit: 100 });
    expect(items.map((k) => k.title).sort()).toEqual(['Company OEE', 'Pune OEE']);
    expect((await records.get(ramesh, 'kpis', shared._id)).title).toBe('Company OEE');
    // other plant-scoped modules still hide plant-less records
    expect((await records.list(ramesh, 'assets', { limit: 100 })).items.every((a) => a.plantId)).toBe(true);
  });
});

describe('permissions', () => {
  it('blocks view-only users from writing', async () => {
    await expect(records.create(viewer, 'workorders', { name: 'x' })).rejects.toMatchObject({ status: 403 });
  });

  it('keeps people and companies out of chat writes', async () => {
    await expect(
      records.create(owner, 'users', { firstName: 'Bot', email: 'bot@acme.test' }, { source: 'agent' }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('stops an owner from creating a superadmin', async () => {
    await expect(
      records.create(owner, 'users', {
        firstName: 'Evil',
        email: 'evil@acme.test',
        password: 'Password1!',
        role: 'superAdmin',
      }),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe('counters, actions and hooks', () => {
  it('numbers work orders per plant', async () => {
    const press = await acmeAsset('Press 1');
    const a = await records.create(owner, 'workorders', { name: 'A', asset: String(press._id) });
    const b = await records.create(owner, 'workorders', { name: 'B', asset: String(press._id) });
    expect(Number(b.workOrderId.slice(3))).toBe(Number(a.workOrderId.slice(3)) + 1);
    expect(String(a.plantId)).toBe(String(press.plantId)); // inherited from the asset
  });

  it('walks the status lifecycle with timers and comments', async () => {
    const wo = await records.create(owner, 'workorders', {
      name: 'Lifecycle',
      plantId: String(ramesh.plantLock),
    });
    await records.runAction(ramesh, 'workorders', wo._id, 'status', { workStatus: 'In Progress' });
    await records.runAction(ramesh, 'workorders', wo._id, 'status', { workStatus: 'On Hold' });
    await records.runAction(ramesh, 'workorders', wo._id, 'status', { workStatus: 'In Progress' });
    const done = await records.runAction(ramesh, 'workorders', wo._id, 'status', {
      workStatus: 'Completed',
      note: 'all good',
    });
    expect(done.workStatus).toBe('Completed');
    expect(done.pauseHistory[0].resumedAt).toBeTruthy();
    expect(done.comments.at(-1)).toMatchObject({ type: 'manual', comment: 'all good' });
    await expect(
      records.runAction(ramesh, 'workorders', wo._id, 'status', { workStatus: 'In Progress' }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('consumes spare parts from stock when a work order completes', async () => {
    const part = await getModule('spareparts')
      .Model.findOne({ companyId: acme.companyId, partNumber: 'AC-OF-37' })
      .lean();
    const lotBefore = await getModule('sparepartinventories').Model.findOne({ sparePartId: part._id }).lean();
    const wo = await records.create(owner, 'workorders', {
      name: 'Filter change',
      spareParts: [{ sparePart: String(part._id), consumedQuantity: 2 }],
    });
    await records.runAction(owner, 'workorders', wo._id, 'status', { workStatus: 'In Progress' });
    await records.runAction(owner, 'workorders', wo._id, 'status', { workStatus: 'Completed' });
    const lotAfter = await getModule('sparepartinventories').Model.findById(lotBefore._id).lean();
    expect(lotAfter.stockQuantity).toBe(lotBefore.stockQuantity - 2);
  });

  it('stamps lastMaintenanceDate on the PM when its work order completes', async () => {
    const PM = getModule('preventivemaintenances').Model;
    const pm = await PM.findOne({ companyId: acme.companyId }).lean();
    const wo = await records.create(owner, 'workorders', { name: 'PM run', pmId: String(pm._id) });
    const before = Date.now();
    await records.runAction(owner, 'workorders', wo._id, 'status', { workStatus: 'In Progress' });
    await records.runAction(owner, 'workorders', wo._id, 'status', { workStatus: 'Completed' });
    const after = await PM.findById(pm._id).lean();
    expect(after.lastMaintenanceDate.getTime()).toBeGreaterThanOrEqual(before);
  });

  it('links a work order raised for an anomaly back to it and acknowledges it', async () => {
    const press = await acmeAsset('Press 1');
    const Anomaly = getModule('anomalies').Model;
    const anomaly = await Anomaly.create({
      companyId: acme.companyId,
      plantId: press.plantId,
      assetId: press._id,
      type: ANOMALY_TYPES[0],
      severity: 'critical',
    });
    const wo = await records.create(owner, 'workorders', {
      name: 'Inspect press',
      asset: String(press._id),
      anomalyId: String(anomaly._id),
    });
    const after = await Anomaly.findById(anomaly._id).lean();
    expect(after).toMatchObject({ state: 'acknowledged', workOrderId: wo._id });
    expect(String(after.acknowledgedBy)).toBe(String(owner.userId));
    // a second work order keeps the first link
    await records.create(owner, 'workorders', { name: 'Follow-up', anomalyId: String(anomaly._id) });
    expect(String((await Anomaly.findById(anomaly._id).lean()).workOrderId)).toBe(String(wo._id));
  });

  it('opens a work order for every new request', async () => {
    const press = await acmeAsset('Press 1');
    const request = await records.create(ramesh, 'requests', {
      name: 'Oil on floor',
      asset: String(press._id),
    });
    const wo = await getModule('workorders').Model.findById(request.workOrder).lean();
    expect(wo).toMatchObject({ priority: 'High', name: 'Oil on floor' });
    expect(String(wo.requestId)).toBe(String(request._id));
  });

  it('dry runs validate without writing', async () => {
    const count = await getModule('workorders').Model.countDocuments();
    const preview = await records.create(owner, 'workorders', { name: 'Preview only' }, { dryRun: true });
    expect(preview.dryRun).toBe(true);
    expect(await getModule('workorders').Model.countDocuments()).toBe(count);
  });

  it('stamped creates are idempotent', async () => {
    const system = await systemContext(acme.companyId);
    const stamp = { proposalId: 'p-1', seq: 1 };
    const first = await records.create(system, 'workorders', { name: 'Planned' }, { stamp });
    const again = await records.create(system, 'workorders', { name: 'Planned' }, { stamp });
    expect(String(again._id)).toBe(String(first._id));
  });
});
