import { DateTime } from 'luxon';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { influxEnabled, queryRows } from '../../config/influx.js';
import { ParameterSpec } from '../../db/models/Sim.js';
import { badRequest } from '../../lib/errors.js';
import { shiftAt } from '../../lib/shifts.js';
import { records } from '../../modules/records.js';
import { ENERGY_FIELDS, KEY_FIELDS, SHOT_FIELDS } from '../../telemetry/catalog.js';
import {
  discoverFields,
  latestValues,
  pickWindow,
  seriesFor,
  statusTimeline,
} from '../../telemetry/queries.js';
import { validateRawFlux } from '../validators/flux.js';
import { compact, fmtDate, money, plantOf, round, rowsResult, timeWindow, zoneOf } from './common.js';

/** Telemetry tools (phase 4 §2): thin wrappers over telemetry/queries.js; series become stats + a chart. */

const WINDOWS = ['10s', '30s', '1m', '5m', '15m', '30m', '1h', '3h', '6h', '12h', '1d'];
const AGGREGATES = ['mean', 'median', 'sum', 'min', 'max', 'count', 'first', 'last'];
const AGGREGATE_OF = new Map(
  [...ENERGY_FIELDS, ...SHOT_FIELDS].filter((f) => f.aggregate).map((f) => [f.field, f.aggregate]),
);
const UNIT_OF = new Map([...ENERGY_FIELDS, ...SHOT_FIELDS].map((f) => [f.field, f.unit]));
const MAX_CHART_POINTS = 300;

const assetFor = (ctx, id) => records.get(ctx, 'assets', String(id), { populate: false });
const assetsFor = (ctx, ids) => Promise.all([...new Set(ids.map(String))].map((id) => assetFor(ctx, id)));
const iso = (ms) => new Date(ms).toISOString();
/** Chart label of a field key: oilTempPv → "Oil temp PV". */
export const fieldLabel = (field) =>
  String(field)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/\b(pv|sv|kwh|kw|rpm)\b/g, (w) => (w === 'kwh' ? 'kWh' : w === 'kw' ? 'kW' : w.toUpperCase()))
    .replace(/^./, (c) => c.toUpperCase());

/** Parameter specs of the asset type plus the fixed energy/shot fields its flags switch on. */
const knownFields = async (asset) => {
  const type = asset.typeOfAsset;
  const specs = await ParameterSpec.find({ assetType: type }).sort({ _id: 1 }).lean();
  const fields = specs.map((s) => ({
    measurement: s.measurement,
    field: s.field,
    unit: s.unit ?? null,
    valueType: s.valueType ?? 'number',
    normalMin: s.normalMin ?? null,
    normalMax: s.normalMax ?? null,
  }));
  const seen = new Set(fields.map((f) => `${f.measurement}/${f.field}`));
  const fixed = [
    ...(asset.isEnergyAsset
      ? ENERGY_FIELDS.filter((f) => !f.furnaceOnly || type === 'Furnace').map((f) => ({
          ...f,
          measurement: 'energy',
        }))
      : []),
    ...(asset.isProductionAsset ? SHOT_FIELDS.map((f) => ({ ...f, measurement: 'shotCountDetails' })) : []),
  ];
  for (const f of fixed) {
    if (seen.has(`${f.measurement}/${f.field}`)) continue;
    fields.push({
      measurement: f.measurement,
      field: f.field,
      unit: f.unit,
      valueType: 'number',
      normalMin: null,
      normalMax: null,
    });
  }
  const keys = KEY_FIELDS[type] ?? [];
  return fields.map((f) => ({ ...f, key: keys.includes(f.field) }));
};

const unitsFor = async (assets) => {
  const units = new Map(UNIT_OF);
  const specs = await ParameterSpec.find({
    assetType: { $in: [...new Set(assets.map((a) => a.typeOfAsset))] },
  }).lean();
  for (const s of specs) if (s.unit) units.set(s.field, s.unit);
  return units;
};

const stats = (points) => {
  const values = points.map((p) => p[1]).filter((v) => typeof v === 'number');
  if (!values.length) return { count: 0 };
  const sum = values.reduce((s, v) => s + v, 0);
  const first = values[0];
  const last = values.at(-1);
  const span = Math.max(Math.abs(first), 1e-9);
  const trend = last - first > 0.05 * span ? 'rising' : first - last > 0.05 * span ? 'falling' : 'flat';
  return {
    count: values.length,
    min: round(Math.min(...values), 3),
    max: round(Math.max(...values), 3),
    mean: round(sum / values.length, 3),
    first: round(first, 3),
    last: round(last, 3),
    firstAt: iso(points[0][0]),
    lastAt: iso(points.at(-1)[0]),
    trend,
  };
};

/** Tariff (₹/kWh) valid on a day from the plant's energyCostHistory, or null. */
const tariffOn = (plant, day) => {
  const dayMs = day.toMillis();
  const rows = (plant?.energyData?.energyCostHistory ?? []).filter(
    (r) =>
      !r.deleted &&
      new Date(r.addedDate).getTime() <= dayMs &&
      (!r.changedDate || new Date(r.changedDate).getTime() > dayMs),
  );
  if (!rows.length) return null;
  return rows.sort((a, b) => new Date(b.addedDate) - new Date(a.addedDate))[0].value ?? null;
};

const telemetryFields = {
  name: 'telemetry_fields',
  group: 'telemetry',
  description:
    'Measurements and fields an asset reports (name, unit, normal band, key fields), including energy and shot-count fields. Call it before telemetry_series to pick the right field name. Example: { assetId }.',
  schema: z.object({ assetId: z.string().min(1) }),
  run: async (ctx, { assetId }) => {
    const asset = await assetFor(ctx, assetId);
    const fields = await knownFields(asset);
    const discovered = await discoverFields(ctx.companyId, String(asset._id)).catch(() => []);
    const seen = new Set(fields.map((f) => `${f.measurement}/${f.field}`));
    for (const f of discovered) {
      if (f.measurement === 'timelineData' || seen.has(`${f.measurement}/${f.field}`)) continue;
      fields.push({ ...f, unit: null, valueType: null, normalMin: null, normalMax: null, key: false });
    }
    const info = {
      id: String(asset._id),
      name: asset.name,
      type: asset.typeOfAsset,
      status: asset.assetStatus,
      isEnergyAsset: asset.isEnergyAsset,
      isProductionAsset: asset.isProductionAsset,
      isSensorIntegration: asset.isSensorIntegration,
    };
    return rowsResult({ rows: fields, what: `fields of ${asset.name}`, extra: { asset: info } });
  },
};

const telemetryLatest = {
  name: 'telemetry_latest',
  group: 'telemetry',
  description:
    'Latest value of every field of up to 20 assets (status, time of reading, values). Example: { assetIds: ["…"] }.',
  schema: z.object({ assetIds: z.array(z.string().min(1)).min(1).max(20) }),
  run: async (ctx, { assetIds }) => {
    const assets = await assetsFor(ctx, assetIds);
    const latest = await latestValues(
      ctx.companyId,
      assets.map((a) => String(a._id)),
    );
    const rows = assets.map((asset) => {
      const values = latest.get(String(asset._id)) ?? {};
      const flat = Object.fromEntries(Object.entries(values).map(([field, v]) => [field, v.value]));
      const asOf =
        Object.values(values)
          .map((v) => v.time)
          .sort()
          .at(-1) ?? null;
      return {
        asset: asset.name,
        assetId: String(asset._id),
        type: asset.typeOfAsset,
        status: asset.assetStatus,
        statusSince: asset.assetStatusSince?.toISOString?.() ?? null,
        asOf,
        ...flat,
      };
    });
    return rowsResult({
      rows,
      what: 'assets with latest readings',
      extra: {
        note: influxEnabled ? undefined : 'InfluxDB is not configured; only stored status is available',
      },
    });
  },
};

const telemetrySeries = {
  name: 'telemetry_series',
  group: 'telemetry',
  description:
    'Time series of up to 6 fields for up to 5 assets between start and stop, downsampled. The model gets statistics (min/max/mean/first/last/trend); the full series is charted for the user automatically. Example: { assetIds: ["…"], fields: ["oilTempPv"], start, stop }.',
  schema: z.object({
    assetIds: z.array(z.string().min(1)).min(1).max(5),
    fields: z.array(z.string().min(1).max(64)).min(1).max(6),
    start: z.string(),
    stop: z.string(),
    every: z.enum(WINDOWS).optional().describe('Window size; default fits ~300 points'),
    fn: z
      .enum(AGGREGATES)
      .optional()
      .describe('Aggregate per window; default per field (sum for energy/shots, mean otherwise)'),
    title: z.string().max(120).optional(),
  }),
  run: async (ctx, { assetIds, fields, start, stop, every, fn, title }) => {
    const assets = await assetsFor(ctx, assetIds);
    const window = timeWindow({ start, stop }, { defaultDays: 1 });
    const ids = assets.map((a) => String(a._id));
    const step = every ?? pickWindow(window.start.getTime(), window.stop.getTime(), MAX_CHART_POINTS);
    const byFn = Map.groupBy(fields, (field) => fn ?? AGGREGATE_OF.get(field) ?? 'mean');
    const results = await Promise.all(
      [...byFn].map(([agg, names]) =>
        seriesFor(ctx.companyId, ids, names, {
          start: window.start,
          stop: window.stop,
          every: step,
          fn: agg,
        }),
      ),
    );
    const units = await unitsFor(assets);
    const nameOf = new Map(assets.map((a) => [String(a._id), a.name]));
    const series = results.flatMap((r) => r.series);
    const keyOf = (s) => (assets.length > 1 ? `${nameOf.get(s.assetId)} · ${s.field}` : s.field);
    const labelOf = (s) =>
      assets.length > 1 ? `${nameOf.get(s.assetId)} · ${fieldLabel(s.field)}` : fieldLabel(s.field);
    const byTime = new Map();
    for (const s of series) {
      for (const [t, v] of s.points) {
        const row = byTime.get(t) ?? { t: iso(t) };
        row[keyOf(s)] = typeof v === 'number' ? round(v, 3) : v;
        byTime.set(t, row);
      }
    }
    const data = [...byTime.entries()].sort((a, b) => a[0] - b[0]).map(([, row]) => row);
    const summary = series.map((s) => ({
      asset: nameOf.get(s.assetId),
      field: s.field,
      measurement: s.measurement,
      unit: units.get(s.field) ?? null,
      ...stats(s.points),
    }));
    const chartTitle =
      title ?? `${assets.map((a) => a.name).join(', ')} · ${fields.map(fieldLabel).join(', ').toLowerCase()}`;
    const blocks = data.length
      ? [
          {
            type: 'chart',
            payload: {
              title: chartTitle,
              type: 'line',
              xKey: 't',
              series: series.map((s) => ({
                key: keyOf(s),
                label: labelOf(s),
                unit: units.get(s.field) ?? undefined,
              })),
              data,
            },
          },
        ]
      : [];
    return {
      forModel: {
        start: window.start.toISOString(),
        stop: window.stop.toISOString(),
        every: step,
        series: summary,
        note: data.length
          ? 'The full series is already charted for the user; do not call render_chart for it'
          : 'No data in this range (asset may have been off or not reporting)',
      },
      summary: `${series.length} series, ${data.length} points`,
      rowCount: data.length,
      data: {
        rows: data,
        columns: [
          { key: 't', label: 'Time' },
          ...series.map((s) => ({ key: keyOf(s), label: labelOf(s), unit: units.get(s.field) ?? undefined })),
        ],
      },
      blocks,
    };
  },
};

const telemetryStatusTimeline = {
  name: 'telemetry_status_timeline',
  group: 'telemetry',
  description:
    'Status runs (Running, Idle, Stopped, OFF, ON, Maintenance) of one asset between start and stop with durations, totals and availability. Use it for "why was X stopped" questions together with downtimes and work orders. Example: { assetId, start, stop }.',
  schema: z.object({ assetId: z.string().min(1), start: z.string(), stop: z.string() }),
  run: async (ctx, { assetId, start, stop }) => {
    const asset = await assetFor(ctx, assetId);
    const window = timeWindow({ start, stop }, { defaultDays: 1 });
    const timeline = await statusTimeline(ctx.companyId, String(asset._id), {
      start: window.start,
      stop: window.stop,
    });
    const rows = timeline.runs.map((r) => ({
      status: r.status,
      start: r.start,
      end: r.end,
      minutes: round(r.seconds / 60, 1),
      startLabel: fmtDate(ctx, r.start, { time: true }),
    }));
    return rowsResult({
      rows,
      what: `status runs of ${asset.name}`,
      forModel: {
        asset: asset.name,
        availabilityPct: round(timeline.availability * 100, 1),
        totalsMinutes: Object.fromEntries(
          Object.entries(timeline.totals).map(([k, v]) => [k, round(v / 60, 1)]),
        ),
        runs: compact(rows),
      },
    });
  },
};

const bucketOf = (ctx, plant, ms, groupBy) => {
  const local = DateTime.fromMillis(ms - 1000, { zone: zoneOf(ctx) });
  if (groupBy === 'hour') return local.toFormat('yyyy-LL-dd HH:00');
  if (groupBy === 'day') return local.toISODate();
  const w = shiftAt(plant, local.toJSDate(), zoneOf(ctx));
  return w
    ? `${DateTime.fromJSDate(w.start, { zone: zoneOf(ctx) }).toISODate()} shift ${w.shiftName}`
    : `${local.toISODate()} outside shifts`;
};

const telemetryShotCounts = {
  name: 'telemetry_shot_counts',
  group: 'telemetry',
  description:
    'Shots produced by one machine between start and stop, bucketed by hour, day or shift. Example: { assetId, start, stop, groupBy: "shift" }.',
  schema: z.object({
    assetId: z.string().min(1),
    start: z.string(),
    stop: z.string(),
    groupBy: z.enum(['hour', 'day', 'shift']).default('hour'),
  }),
  run: async (ctx, { assetId, start, stop, groupBy }) => {
    const asset = await assetFor(ctx, assetId);
    const window = timeWindow({ start, stop }, { defaultDays: 1 });
    const { series } = await seriesFor(ctx.companyId, [String(asset._id)], ['shotsProduced'], {
      start: window.start,
      stop: window.stop,
      every: groupBy === 'hour' ? '1h' : '15m',
      fn: 'sum',
    });
    const plant = plantOf(ctx, asset.plantId);
    const buckets = new Map();
    for (const [t, v] of series[0]?.points ?? []) {
      const key = bucketOf(ctx, plant, t, groupBy);
      buckets.set(key, (buckets.get(key) ?? 0) + (v ?? 0));
    }
    const rows = [...buckets].map(([bucket, shots]) => ({ bucket, shots: Math.round(shots) }));
    const total = rows.reduce((s, r) => s + r.shots, 0);
    const blocks =
      rows.length > 1
        ? [
            {
              type: 'chart',
              payload: {
                title: `Shots — ${asset.name}`,
                type: 'bar',
                xKey: 'bucket',
                series: [{ key: 'shots', label: 'Shots', unit: 'shots' }],
                data: rows,
              },
            },
          ]
        : [];
    return rowsResult({
      rows,
      what: `${groupBy} buckets (${total} shots)`,
      extra: { asset: asset.name, totalShots: total },
      blocks,
    });
  },
};

const energyConsumption = {
  name: 'energy_consumption',
  group: 'telemetry',
  description:
    'Energy (kWh, sum of ENERGY CONSUMPTION) and cost at the plant tariff between start and stop for up to 20 assets, grouped by asset, day, hour or shift. Example: { assetIds: ["…"], start, stop, groupBy: "day" }.',
  schema: z.object({
    assetIds: z.array(z.string().min(1)).min(1).max(20),
    start: z.string(),
    stop: z.string(),
    groupBy: z.enum(['asset', 'day', 'hour', 'shift']).default('asset'),
  }),
  run: async (ctx, { assetIds, start, stop, groupBy }) => {
    const assets = await assetsFor(ctx, assetIds);
    const window = timeWindow({ start, stop }, { defaultDays: 1 });
    const { series } = await seriesFor(
      ctx.companyId,
      assets.map((a) => String(a._id)),
      ['ENERGY CONSUMPTION'],
      { start: window.start, stop: window.stop, every: '15m', fn: 'sum' },
    );
    const assetById = new Map(assets.map((a) => [String(a._id), a]));
    const buckets = new Map();
    const tariffs = new Set();
    for (const s of series) {
      const asset = assetById.get(s.assetId);
      const plant = plantOf(ctx, asset?.plantId);
      for (const [t, kwh] of s.points) {
        if (typeof kwh !== 'number') continue;
        const local = DateTime.fromMillis(t - 1000, { zone: zoneOf(ctx) });
        const tariff = tariffOn(plant, local.startOf('day'));
        if (tariff != null) tariffs.add(tariff);
        const key = groupBy === 'asset' ? (asset?.name ?? s.assetId) : bucketOf(ctx, plant, t, groupBy);
        const b = buckets.get(key) ?? { kwh: 0, cost: 0, costKnown: true };
        b.kwh += kwh;
        if (tariff == null) b.costKnown = false;
        else b.cost += kwh * tariff;
        buckets.set(key, b);
      }
    }
    const rows = [...buckets]
      .map(([key, b]) => ({
        [groupBy]: key,
        kwh: round(b.kwh, 2),
        cost: b.costKnown ? Math.round(b.cost) : null,
      }))
      .sort((a, b) =>
        groupBy === 'asset' ? b.kwh - a.kwh : String(a[groupBy]).localeCompare(String(b[groupBy])),
      );
    const totalKwh = round(
      rows.reduce((s, r) => s + r.kwh, 0),
      2,
    );
    const totalCost = rows.every((r) => r.cost != null) ? rows.reduce((s, r) => s + r.cost, 0) : null;
    const blocks =
      rows.length > 1
        ? [
            {
              type: 'chart',
              payload: {
                title: `Energy by ${groupBy}`,
                type: 'bar',
                xKey: groupBy,
                series: [{ key: 'kwh', label: 'kWh', unit: 'kWh' }],
                data: rows,
              },
            },
          ]
        : [];
    return rowsResult({
      rows,
      what: `${groupBy} buckets (${totalKwh} kWh)`,
      forModel: {
        start: window.start.toISOString(),
        stop: window.stop.toISOString(),
        groupBy,
        assets: assets.map((a) => a.name),
        totalKwh,
        totalCost: money(ctx, totalCost),
        tariffs: [...tariffs].map((t) => `${ctx.company?.currency?.symbol ?? '₹'}${t}/kWh`),
        rows: compact(rows),
        ...(rows.length ? {} : { note: 'No energy data in this range' }),
      },
      blocks,
    });
  },
};

const influxFlux = {
  name: 'influx_flux',
  group: 'telemetry',
  description:
    'Runs a read-only Flux query on the company bucket (must start with from(bucket: "<companyId>"), one range(), no writes). The company filter and a 5000-row limit are added. Use the other telemetry tools first; this is for shapes they cannot express.',
  schema: z.object({ flux: z.string().min(1).max(4000) }),
  run: async (ctx, { flux }) => {
    if (!influxEnabled) throw badRequest('InfluxDB is not configured');
    const query = validateRawFlux(flux, ctx);
    const rows = (await queryRows(query)).map(({ result: _r, table: _t, ...row }) => row);
    return rowsResult({ rows, what: 'rows' });
  },
};

export const telemetryTools = [
  telemetryFields,
  telemetryLatest,
  telemetrySeries,
  telemetryStatusTimeline,
  telemetryShotCounts,
  energyConsumption,
  ...(env.ENABLE_RAW_FLUX ? [influxFlux] : []),
];
