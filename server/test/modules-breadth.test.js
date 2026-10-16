import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { records } from '../src/modules/records.js';
import { getModule } from '../src/modules/registry.js';
import { contextFor, PASSWORD, setupDatabase, teardownDatabase } from './helpers/db.js';

const NEW_MODULES = ['tags', 'bins', 'binsessions', 'stationpools', 'workflowrules', 'scheduledreports'];
const BIN_MODULES = ['bins', 'binsessions', 'stationpools'];

let app;
let acme;
let owner; // Acme owner, company-wide
let supervisor; // Acme technician locked to Pune, production add/update
let betaOwner; // bin tracking off
let press;
let jobCard;

const login = async (email) => {
  const res = await request(app).post('/api/auth/login').send({ email, password: PASSWORD });
  return { authorization: `Bearer ${res.body.token}` };
};

beforeAll(async () => {
  ({ acme } = await setupDatabase());
  await getModule('companies').Model.updateOne(
    { _id: acme.companyId },
    { $set: { 'features.binTrackingEnabled': true } },
  );
  app = createApp();
  owner = await contextFor('owner_1@acme.test');
  supervisor = await contextFor('production_supervisor_1@acme.test');
  betaOwner = await contextFor('owner_1@beta.test');
  press = await getModule('assets').Model.findOne({ companyId: acme.companyId, name: 'Press 1' }).lean();
  jobCard = await getModule('jobcards').Model.findOne({ companyId: acme.companyId }).lean();
});
afterAll(teardownDatabase);

describe('GET /api/modules', () => {
  it('lists the new modules with UI meta for a bin-tracking company', async () => {
    const res = await request(app)
      .get('/api/modules')
      .set(await login('owner_1@acme.test'));
    expect(res.status).toBe(200);
    const byName = new Map(res.body.modules.map((m) => [m.name, m]));
    for (const name of NEW_MODULES) {
      const m = byName.get(name);
      expect(m, name).toBeDefined();
      expect(m.label && m.group && m.icon && m.description, name).toBeTruthy();
      expect(
        m.list.every((key) => m.fields.some((f) => f.key === key) || key === 'updatedAt'),
        name,
      ).toBe(true);
      expect(m.can).toEqual({ read: true, create: true, update: true, delete: true });
    }
    expect(byName.get('workflowrules').codeField).toBe('ruleId');
    expect(byName.get('bins').group).toBe('Bins & stations');
    expect(byName.get('scheduledreports').group).toBe('Rules & reports');
  });

  it('hides bin modules when bin tracking is off, but keeps rules, reports and tags', async () => {
    const res = await request(app)
      .get('/api/modules')
      .set(await login('owner_1@beta.test'));
    const names = res.body.modules.map((m) => m.name);
    for (const name of BIN_MODULES) expect(names).not.toContain(name);
    expect(names).toEqual(expect.arrayContaining(['tags', 'workflowrules', 'scheduledreports']));
    const bins = await request(app)
      .get('/api/m/bins')
      .set(await login('owner_1@beta.test'));
    expect(bins.status).toBe(404);
  });
});

describe('records on the new modules', () => {
  it('numbers rules RULE-n and inherits the plant from the machine', async () => {
    const rule = await records.create(owner, 'workflowrules', {
      name: 'Press 1 vibration high',
      assetId: String(press._id),
      conditions: [{ field: 'vibration', operator: '>', value: 6, unit: 'mm/s', forAtLeastMin: 5 }],
      actions: [{ type: 'workOrder', title: 'Check Press 1 bearings', priority: 'High', dueInHours: 4 }],
    });
    expect(rule.ruleId).toBe('RULE-1');
    expect(String(rule.plantId)).toBe(String(press.plantId));
    expect(rule.status).toBe('enabled');
    const next = await records.create(owner, 'workflowrules', { name: 'Second', assetId: String(press._id) });
    expect(next.ruleId).toBe('RULE-2');
    await expect(
      records.create(owner, 'workflowrules', { name: 'Bad', assetId: String(press._id), conditions: [{}] }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('lists, updates and soft-deletes every new module', async () => {
    const created = {
      tags: await records.create(owner, 'tags', { name: 'Kaizen' }),
      bins: await records.create(owner, 'bins', { binRfId: 'RF-T-1', binSizeType: 'Medium crate' }),
      scheduledreports: await records.create(owner, 'scheduledreports', {
        subject: 'Weekly maintenance',
        recipients: [String(owner.userId)],
      }),
    };
    created.binsessions = await records.create(owner, 'binsessions', {
      binId: String(created.bins._id),
      jobCardId: String(jobCard._id),
      assetId: String(jobCard.asset),
      partName: jobCard.partName,
      binPartCount: 120,
    });
    created.stationpools = await records.create(owner, 'stationpools', {
      stationName: 'Final inspection',
      stationAssetId: String(jobCard.asset),
      jobCardId: String(jobCard._id),
      qtyIn: 300,
    });
    expect(created.scheduledreports.dateRange).toEqual({ value: 7, unit: 'Days' });
    expect(String(created.binsessions.plantId)).toBe(String(jobCard.plantId));

    const patches = {
      tags: { description: 'Improvement ideas' },
      bins: { status: 'Out', productionStatus: 'In Production' },
      binsessions: { stationState: 'in_process' },
      stationpools: { qtyOut: 120 },
      scheduledreports: { frequency: 'Daily' },
    };
    for (const [name, doc] of Object.entries(created)) {
      const { items } = await records.list(owner, name, { limit: 100 });
      expect(
        items.some((d) => String(d._id) === String(doc._id)),
        name,
      ).toBe(true);
      const { after } = await records.update(owner, name, doc._id, patches[name]);
      expect(after, name).toMatchObject(patches[name]);
      await records.remove(owner, name, doc._id);
      await expect(records.get(owner, name, doc._id), name).rejects.toMatchObject({ status: 404 });
    }
  });

  it('keeps RFID tags unique among live bins only', async () => {
    const bin = await records.create(owner, 'bins', { binRfId: 'RF-DUP', binSizeType: 'Small crate' });
    await expect(
      records.create(owner, 'bins', { binRfId: 'RF-DUP', binSizeType: 'Small crate' }),
    ).rejects.toMatchObject({ status: 409 });
    await records.remove(owner, 'bins', bin._id);
    await expect(
      records.create(owner, 'bins', { binRfId: 'RF-DUP', binSizeType: 'Small crate' }),
    ).resolves.toMatchObject({ binRfId: 'RF-DUP' });
  });
});

describe('tenancy and plant lock', () => {
  it('forces a plant-locked user onto their plant and hides other plants', async () => {
    const chennai = owner.plants.find((p) => p.name.startsWith('Chennai'));
    const mine = await records.create(supervisor, 'bins', {
      binRfId: 'RF-PUNE-1',
      binSizeType: 'Large crate',
      plantId: String(chennai._id),
    });
    expect(String(mine.plantId)).toBe(String(supervisor.plantLock));

    const theirs = await records.create(owner, 'bins', {
      binRfId: 'RF-CHN-1',
      binSizeType: 'Large crate',
      plantId: String(chennai._id),
    });
    await expect(records.get(supervisor, 'bins', theirs._id)).rejects.toMatchObject({ status: 404 });
    const { items } = await records.list(supervisor, 'bins', { limit: 100 });
    expect(items.every((b) => String(b.plantId?._id ?? b.plantId) === String(supervisor.plantLock))).toBe(
      true,
    );
    await expect(records.create(supervisor, 'tags', { name: 'Nope' })).rejects.toMatchObject({ status: 403 });
  });

  it('never reads, changes or links another company record', async () => {
    const tag = await records.create(owner, 'tags', { name: 'Acme only' });
    await expect(records.get(betaOwner, 'tags', tag._id)).rejects.toMatchObject({ status: 404 });
    await expect(records.update(betaOwner, 'tags', tag._id, { name: 'x' })).rejects.toMatchObject({
      status: 404,
    });
    await expect(records.remove(betaOwner, 'tags', tag._id)).rejects.toMatchObject({ status: 404 });
    expect((await records.list(betaOwner, 'tags')).items.map((t) => t.name)).not.toContain('Acme only');
    await expect(
      records.create(betaOwner, 'workflowrules', { name: 'Cross', assetId: String(press._id) }),
    ).rejects.toMatchObject({ status: 400 });
  });
});
