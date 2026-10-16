import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getModule } from '../src/modules/registry.js';
import { validateCompany } from '../src/modules/validateCompany.js';
import { setupDatabase, teardownDatabase } from './helpers/db.js';

let acme;
const raw = (name) => getModule(name).Model.collection;
const row = (report, name) => report.modules.find((m) => m.module === name);

beforeAll(async () => {
  ({ acme } = await setupDatabase());
});
afterAll(teardownDatabase);

describe('validateCompany', () => {
  it('finds nothing wrong in a generated company', async () => {
    const report = await validateCompany(acme.companyId);
    expect(report.errors).toEqual([]);
    expect(report.warnings).toEqual([]);
    expect(row(report, 'companies')).toEqual({ module: 'companies', docs: 1, errors: 0, warnings: 0 });
    expect(row(report, 'workorders').docs).toBe(acme.counts.workOrders);
    expect(row(report, 'users').docs).toBe(acme.counts.users);
    expect(row(report, 'checkinouts')).toMatchObject({ docs: 0, errors: 0 });
  });

  it('reports what a careless raw writer gets wrong', async () => {
    const { companyId } = acme;
    const plantId = (await getModule('plants').Model.findOne({ companyId }).lean())._id;
    const now = new Date();
    await raw('workorders').insertOne({
      companyId,
      plantId,
      name: 'Bad priority',
      priority: 'Urgent',
      workOrderId: 'WO-999', // ahead of the plant's WorkOrder counter
      workstatus: 'Open', // typo: SARA never reads it
      createdAt: now,
      updatedAt: now,
    });
    await raw('checkinouts').insertOne({ companyId, plantId, shiftName: 'A', duration: '8h' });
    await raw('assets').insertOne({ companyId, name: 'No plant', createdAt: now, updatedAt: now });
    await raw('assets').insertOne({ name: 'Belongs nowhere', createdAt: now, updatedAt: now });
    // Company-wide (no plant) is fine for a KPI.
    await raw('kpis').insertOne({
      companyId,
      title: 'Plant OEE',
      viz: 'number',
      createdAt: now,
      updatedAt: now,
    });

    const report = await validateCompany(companyId);
    const problems = report.errors.map((e) => `${e.module}.${e.path}`);
    expect(problems.sort()).toEqual(
      [
        'assets.companyId',
        'assets.plantId',
        'checkinouts.checkInTime',
        'checkinouts.duration',
        'checkinouts.userId',
        'workorders.priority',
        'workorders.workOrderId',
      ].sort(),
    );
    expect(report.errors.find((e) => e.path === 'workOrderId').message).toMatch(/at \d+ but WO-999 exists/);
    expect(report.errors.find((e) => e.path === 'companyId').message).toMatch(/^1 document/);
    expect(report.warnings).toMatchObject([{ module: 'workorders', path: 'workstatus' }]);
    expect(row(report, 'workorders')).toMatchObject({ errors: 2, warnings: 1 });
    expect(row(report, 'checkinouts')).toMatchObject({ docs: 1, errors: 3 });
  });
});
