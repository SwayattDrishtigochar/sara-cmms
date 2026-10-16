import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { getAiSettings } from '../src/ai/settings.js';
import { createApp } from '../src/app.js';
import { refreshInsights } from '../src/kpis/insights.js';
import { kpiTools } from '../src/kpis/tools.js';
import { subscribe } from '../src/lib/events.js';
import { records } from '../src/modules/records.js';
import { getModule } from '../src/modules/registry.js';
import { kpisRouter } from '../src/routes/kpis.js';
import { contextFor, NOW, PASSWORD, setupDatabase, teardownDatabase } from './helpers/db.js';

vi.mock('../src/telemetry/queries.js', async (importOriginal) => ({
  ...(await importOriginal()),
  // Every asset reads 4 kWh per hour for the 3 hours after the window start.
  seriesFor: async (_companyId, assetIds, fields, { start }) => {
    const t0 = new Date(start).getTime();
    return {
      series: assetIds.flatMap((assetId) =>
        fields.map((field) => ({
          assetId,
          field,
          measurement: 'energy',
          points: [1, 2, 3].map((h) => [t0 + h * 3_600_000, 4]),
        })),
      ),
    };
  },
}));

const tool = (name) => kpiTools.find((t) => t.name === name);
const io = { emit: () => {}, signal: undefined, results: new Map(), callId: 't' };
const Kpi = () => getModule('kpis').Model;
let acme;
let app;
const ctx = {};
const tokens = {};
let compressors;
let heatmap;

beforeAll(async () => {
  ({ acme } = await setupDatabase());
  ctx.owner = await contextFor('owner_1@acme.test');
  ctx.tech = await contextFor('maintenance_technician_1@acme.test');
  ctx.viewer = await contextFor('viewer_1@acme.test');
  ctx.beta = await contextFor('owner_1@beta.test');
  compressors = await getModule('assets')
    .Model.find({ companyId: acme.companyId, typeOfAsset: /compressor/i })
    .limit(2)
    .lean();
  if (!compressors.length)
    compressors = await getModule('assets').Model.find({ companyId: acme.companyId }).limit(2).lean();
  heatmap = {
    title: 'Compressor energy by hour',
    viz: 'heatmap',
    unit: 'kWh',
    timeRange: { text: 'last 7 days' },
    sources: [
      {
        key: 'energy',
        tool: 'energy_consumption',
        args: { assetIds: compressors.map((c) => String(c._id)), groupBy: 'hour' },
      },
    ],
    encoding: { source: 'energy', x: 'hour', value: 'kwh' },
  };
  app = createApp({ routers: [{ path: '/api', router: kpisRouter }] });
  for (const [who, email] of Object.entries({
    owner: 'owner_1@acme.test',
    viewer: 'viewer_1@acme.test',
    beta: 'owner_1@beta.test',
  })) {
    const res = await request(app).post('/api/auth/login').send({ email, password: PASSWORD });
    tokens[who] = `Bearer ${res.body.token}`;
  }
});
afterAll(teardownDatabase);

describe('create_kpi', () => {
  it('is only offered to roles that may create KPIs', () => {
    expect(tool('create_kpi').permission(ctx.owner)).toBe(true);
    expect(tool('create_kpi').permission(ctx.tech)).toBe(false);
    expect(tool('create_kpi').permission(ctx.viewer)).toBe(false);
    expect(tool('list_kpis').permission).toBeUndefined();
  });

  it('previews the live heatmap, then creates the KPI after confirmation', async () => {
    const args = tool('create_kpi').schema.parse(heatmap);
    const preview = await tool('create_kpi').preview(ctx.owner, args, io);
    expect(preview.type).toBe('confirm');
    expect(preview.payload).toMatchObject({
      tool: 'create_kpi',
      action: 'kpi',
      module: 'kpis',
      moduleLabel: 'KPIs',
      label: 'Create KPI "Compressor energy by hour"',
    });
    const { result } = preview.payload;
    expect(result.viz).toBe('heatmap');
    expect(result.cells.length).toBe(3);
    expect(result.cells[0].value).toBe(4 * compressors.length);
    expect(result.xLabels.every((x) => /^\d{2}:00$/.test(x))).toBe(true);
    expect(await Kpi().countDocuments({ companyId: acme.companyId })).toBe(0);

    const out = await tool('create_kpi').run(ctx.owner, args, io);
    expect(out.forModel.created).toMatchObject({ title: heatmap.title, link: '/kpis' });
    expect(out.blocks[0]).toMatchObject({ type: 'kpi', payload: { id: out.forModel.created.id } });
    expect(out.blocks[0].payload.result.cells.length).toBe(3);
    const saved = await Kpi().findById(out.forModel.created.id).lean();
    expect(saved.sources[0].args).toEqual(heatmap.sources[0].args);
    expect(saved.timeRange).toEqual({ text: 'last 7 days' });
  });

  it('refuses a preview that cannot run, so the model can fix it', async () => {
    const bad = {
      ...heatmap,
      sources: [{ ...heatmap.sources[0], args: { assetIds: ['0123456789abcdef01234567'] } }],
    };
    await expect(tool('create_kpi').preview(ctx.owner, bad, io)).rejects.toThrow(/preview failed/);
    await expect(
      tool('create_kpi').preview(
        ctx.owner,
        { ...heatmap, sources: [{ key: 'f', tool: 'influx_flux', args: {} }] },
        io,
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('has no generic write path', async () => {
    await expect(
      records.create(ctx.owner, 'kpis', { title: 'x', viz: 'number', sources: [] }, { source: 'rest' }),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe('update_kpi and list_kpis', () => {
  it('lists, previews a diff and applies the change', async () => {
    const { forModel } = await tool('list_kpis').run(ctx.viewer, {}, io);
    expect(forModel.kpis).toHaveLength(1);
    const { id } = forModel.kpis[0];
    expect(forModel.kpis[0]).toMatchObject({
      viz: 'heatmap',
      sources: [{ key: 'energy', tool: 'energy_consumption' }],
    });

    const args = tool('update_kpi').schema.parse({ id, changes: { viz: 'bar', pinned: true } });
    const preview = await tool('update_kpi').preview(ctx.owner, args, io);
    expect(preview.payload.changes).toEqual([
      { field: 'viz', from: 'heatmap', to: 'bar' },
      { field: 'pinned', from: false, to: true },
    ]);
    expect(preview.payload.result.data.length).toBe(3);
    await tool('update_kpi').run(ctx.owner, args, io);
    expect(await Kpi().findById(id).lean()).toMatchObject({ viz: 'bar', pinned: true });

    await expect(tool('update_kpi').preview(ctx.beta, args, io)).rejects.toMatchObject({ status: 404 });
  });
});

describe('insights', () => {
  it('refreshes only insights older than the TTL, in one call, and publishes the change', async () => {
    const { kpiInsightTtlMin } = await getAiSettings();
    const second = await tool('create_kpi').run(
      ctx.owner,
      tool('create_kpi').schema.parse({
        title: 'Open work orders',
        viz: 'number',
        timeRange: { text: 'this month' },
        sources: [{ key: 'open', tool: 'mongo_count', args: { module: 'workorders' } }],
      }),
      io,
    );
    const fresh = new Date(NOW.getTime() - 60_000);
    const old = new Date(NOW.getTime() - (kpiInsightTtlMin + 5) * 60_000);
    await Kpi().updateMany(
      { companyId: acme.companyId },
      { $set: { insight: { text: 'old line', at: fresh } } },
    );
    await Kpi().updateOne({ _id: second.forModel.created.id }, { $set: { 'insight.at': old } });

    const { updatedAt } = await Kpi().findById(second.forModel.created.id).lean();
    const events = [];
    const off = subscribe((e) => e.type === 'record' && events.push(e.payload));
    const { refreshed } = await refreshInsights(acme.companyId, { now: NOW });
    off();
    expect(refreshed).toBe(1);
    expect(events).toEqual([{ module: 'kpis', id: second.forModel.created.id, change: 'insight' }]);
    const kpis = await Kpi().find({ companyId: acme.companyId }).lean();
    const updated = kpis.find((k) => String(k._id) === second.forModel.created.id);
    expect(updated.insight).toMatchObject({ mock: true, at: NOW });
    expect(updated.updatedAt).toEqual(updatedAt); // an insight is not a definition change
    expect(updated.insight.text).toMatch(/^Open work orders is \d+/);
    expect(kpis.filter((k) => k.insight.text === 'old line')).toHaveLength(1);

    expect((await refreshInsights(acme.companyId, { now: NOW })).refreshed).toBe(0);
  });
});

describe('routes', () => {
  it('runs a KPI in the caller ctx and hides it from other companies', async () => {
    const id = String((await Kpi().findOne({ companyId: acme.companyId, viz: 'bar' }).lean())._id);
    const res = await request(app).get(`/api/kpis/${id}/run`).set('authorization', tokens.viewer);
    expect(res.status).toBe(200);
    expect(res.body.result).toMatchObject({ id, viz: 'bar' });
    expect(res.body.result.error).toBeUndefined();
    expect((await request(app).get(`/api/kpis/${id}/run`).set('authorization', tokens.beta)).status).toBe(
      404,
    );
  });

  it('explains for owners/admins only and refreshes on request', async () => {
    const id = String((await Kpi().findOne({ companyId: acme.companyId, viz: 'bar' }).lean())._id);
    expect(
      (await request(app).post(`/api/kpis/${id}/explain`).set('authorization', tokens.viewer)).status,
    ).toBe(403);
    const res = await request(app).post(`/api/kpis/${id}/explain`).set('authorization', tokens.owner);
    expect(res.status).toBe(200);
    expect(res.body.insight).toMatchObject({ mock: true });
    expect(res.body.insight.text).toMatch(/Compressor energy by hour/);
    const refresh = await request(app).post('/api/kpis/insights/refresh').set('authorization', tokens.viewer);
    expect(refresh.status).toBe(200);
    expect(refresh.body.refreshed).toBeGreaterThanOrEqual(0); // the real clock: NOW-stamped lines may be stale
    const again = await request(app).post('/api/kpis/insights/refresh').set('authorization', tokens.viewer);
    expect(again.body).toEqual({ refreshed: 0 });
  });
});
