import { DateTime } from 'luxon';
import { asObjectId, plantName, round, zoneOf } from '../agent/tools/common.js';
import { influxEnabled } from '../config/influx.js';
import { AppError, badRequest } from '../lib/errors.js';
import { hmsToSeconds } from '../lib/format.js';
import { scopeFilter } from '../modules/records.js';
import { getModule } from '../modules/registry.js';
import { cachedSeries } from './energyCache.js';
import { tariffOn } from './tariffs.js';

/** Cost engine (phase 5 §3.5): every number of the Costs page, cost alerts, briefing and cost_summary. */

export const COMPONENTS = ['energy', 'spares', 'consumables', 'labour', 'downtime'];
export const GROUP_BYS = ['asset', 'plant', 'category', 'day', 'component'];
export const COMPONENT_LABELS = {
  energy: 'Energy',
  spares: 'Spare parts',
  consumables: 'Consumables',
  labour: 'Labour',
  downtime: 'Downtime',
};
const MAINTENANCE = ['spares', 'consumables', 'labour'];
const DEFAULT_LABOUR_RATE = 350;
const DEFAULT_DOWNTIME_RATE = 2500;
const HOUR = 3_600_000;
const MAX_SPAN = 92 * 24 * HOUR; // the telemetry query limit
const WINDOW = 15 * 60_000;

const Model = (name) => getModule(name).Model;
const toId = (value, what) => {
  const id = asObjectId(String(value));
  if (!id) throw badRequest(`${what} must be a 24-character id`);
  return id;
};
const toDate = (value, what) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw badRequest(`${what} must be a date`);
  return date;
};
const money = (n) => round(n, 2);

/**
 * Costs in [start, stop) in the viewer's scope (tenant + plant lock), grouped by asset, plant, category,
 * day (company zone) or component. Money is rounded to 2 dp; components not asked for are null.
 * @param {{ start, stop, groupBy?, components?: string[], plantId?, assetIds?: string[], now? }} opts
 * @param {{ energySeries?: typeof cachedSeries }} deps tests pass a stub (no Influx in tests)
 */
export const costSummary = async (ctx, opts, { energySeries = cachedSeries } = {}) => {
  const start = toDate(opts.start, 'start');
  const stop = toDate(opts.stop, 'stop');
  if (start >= stop) throw badRequest('The start must be before the stop');
  if (stop - start > MAX_SPAN) throw badRequest('Pick a range of 92 days or less');
  const groupBy = opts.groupBy ?? 'asset';
  if (!GROUP_BYS.includes(groupBy)) throw badRequest(`groupBy must be one of ${GROUP_BYS.join(', ')}`);
  const wanted = opts.components?.length ? opts.components : COMPONENTS;
  const unknown = wanted.filter((c) => !COMPONENTS.includes(c));
  if (unknown.length) throw badRequest(`Unknown cost component "${unknown[0]}"`, { components: COMPONENTS });
  const components = COMPONENTS.filter((c) => wanted.includes(c));
  const now = opts.now ? toDate(opts.now, 'now') : new Date();
  const zone = zoneOf(ctx);
  const plantId = opts.plantId ? toId(opts.plantId, 'plantId') : null;
  const assetIds = opts.assetIds?.length ? opts.assetIds.map((id) => toId(id, 'assetIds')) : null;
  // Rows without an asset or plant (a stock movement without a work order) only count company-wide.
  const constrained = Boolean(ctx.plantLock || plantId || assetIds);
  // $and keeps the plant lock even when another plantId is asked for. Deleted assets and the work orders
  // that attribute spare parts stay in, so history keeps its names; deleted work orders add no labour.
  const where = (module, extra = {}, { includeDeleted = false } = {}) => ({
    $and: [scopeFilter(ctx, getModule(module), { includeDeleted }), plantId ? { plantId } : {}, extra],
  });

  const [assets, settings] = await Promise.all([
    Model('assets')
      .find(where('assets', assetIds ? { _id: { $in: assetIds } } : {}, { includeDeleted: true }))
      .select('name plantId typeOfAsset isEnergyAsset downtimeCostPerHour deleted')
      .lean(),
    Model('costsettings').findOne({ companyId: ctx.companyId }).lean(),
  ]);
  const assetById = new Map(assets.map((a) => [String(a._id), a]));
  const entries = [];
  const totals = { kwh: 0, downtimeHours: 0, labourHours: 0 };
  const notes = [];
  let energyOff = false;
  const add = (component, amount, { assetId, plantId: plant, category, at }) =>
    entries.push({
      component,
      amount,
      assetId: assetId ? String(assetId) : null,
      plantId: plant ? String(plant) : null,
      category: category || 'Uncategorised',
      at: new Date(at).getTime(),
    });

  if (components.includes('energy')) {
    // The incomer meter measures the sum of the others: counting it would double the bill.
    const metered = assets.filter((a) => a.isEnergyAsset && !a.deleted && a.typeOfAsset !== 'Energy Meter');
    if (energySeries === cachedSeries && !influxEnabled) energyOff = 'Energy unavailable (telemetry offline)';
    else if (metered.length) {
      // A range reaching now ends at the next window boundary instead: the same energy (nothing is metered
      // after now), and every open-ended range of a 15-minute slot shares one cached query.
      const t0 = start.getTime();
      const slotEnd = Math.min(Math.max(Math.ceil(now / WINDOW) * WINDOW, t0 + 1), t0 + MAX_SPAN);
      const until = stop >= now ? new Date(slotEnd) : stop;
      try {
        const { series } = await energySeries(
          ctx.companyId,
          metered.map((a) => String(a._id)),
          ['ENERGY CONSUMPTION'],
          { start, stop: until, every: '15m', fn: 'sum' },
        );
        const noTariff = new Set();
        for (const s of series) {
          const asset = assetById.get(String(s.assetId));
          const plant = ctx.plants.find((p) => String(p._id) === String(asset?.plantId));
          for (const [t, kwh] of s.points) {
            if (typeof kwh !== 'number') continue;
            // A window is stamped with its end: 00:00 belongs to the day before.
            const at = t - 1000;
            const day = DateTime.fromMillis(at, { zone }).startOf('day');
            totals.kwh += kwh;
            const tariff = tariffOn(plant, day.toMillis());
            if (tariff == null) noTariff.add(day.toISODate());
            else
              add('energy', kwh * tariff, {
                assetId: s.assetId,
                plantId: asset?.plantId,
                category: 'Energy',
                at,
              });
          }
        }
        if (noTariff.size) {
          notes.push(`No energy tariff for ${[...noTariff].sort().join(', ')}; that energy has no cost here`);
        }
      } catch (err) {
        energyOff =
          err instanceof AppError && err.status < 500
            ? `Energy unavailable: ${err.message}`
            : 'Energy unavailable (telemetry offline)';
      }
    }
    if (energyOff) notes.push(energyOff);
  }

  const woTarget = (wo, at) => ({ assetId: wo?.asset, plantId: wo?.plantId, category: wo?.category, at });

  if (components.includes('spares')) {
    const txns = await Model('sparepartstransactions')
      .find({
        ...scopeFilter(ctx, getModule('sparepartstransactions')),
        type: 'used',
        createdAt: { $gte: start, $lt: stop },
      })
      .select('quantity unitCost reason createdAt')
      .lean();
    const woIds = [...new Set(txns.map((t) => t.reason?.workOrderId).filter(Boolean))];
    const wos = woIds.length
      ? await Model('workorders')
          .find(
            where(
              'workorders',
              { _id: { $in: woIds }, ...(assetIds ? { asset: { $in: assetIds } } : {}) },
              { includeDeleted: true },
            ),
          )
          .select('asset plantId category')
          .lean()
      : [];
    const woById = new Map(wos.map((w) => [String(w._id), w]));
    for (const t of txns) {
      const wo = woById.get(String(t.reason?.workOrderId));
      if (!wo && constrained) continue;
      add('spares', (t.quantity ?? 0) * (t.unitCost ?? 0), woTarget(wo, t.createdAt));
    }
  }

  if (components.includes('consumables') || components.includes('labour')) {
    const wos = await Model('workorders')
      .find(
        where('workorders', {
          'trackProcess.completedAt': { $gte: start, $lt: stop },
          ...(assetIds ? { asset: { $in: assetIds } } : {}),
        }),
      )
      .select('asset plantId category people consumablesAndTools durations trackProcess.completedAt')
      .lean();
    const consumableIds = [
      ...new Set(wos.flatMap((w) => (w.consumablesAndTools ?? []).map((c) => String(c.consumable)))),
    ];
    const consumables = getModule('consumables');
    const priceOf = new Map(
      consumableIds.length
        ? (
            await consumables.Model.find({
              [consumables.tenantField]: ctx.companyId,
              _id: { $in: consumableIds },
            })
              .select('price')
              .lean()
          ).map((c) => [String(c._id), c.price ?? 0])
        : [],
    );
    const rate = settings?.laborRatePerHour ?? DEFAULT_LABOUR_RATE;
    for (const wo of wos) {
      const target = woTarget(wo, wo.trackProcess.completedAt);
      if (components.includes('consumables')) {
        const cost = (wo.consumablesAndTools ?? []).reduce(
          (sum, c) => sum + (c.quantity ?? 0) * (priceOf.get(String(c.consumable)) ?? 0),
          0,
        );
        if (cost) add('consumables', cost, target);
      }
      if (components.includes('labour')) {
        const personHours =
          (hmsToSeconds(wo.durations?.timeInProgress) / 3600) * Math.max(1, wo.people?.length ?? 0);
        totals.labourHours += personHours;
        if (personHours) add('labour', personHours * rate, target);
      }
    }
  }

  if (components.includes('downtime')) {
    const stops = await Model('downtimes')
      .find(
        where('downtimes', {
          startedAt: { $lt: stop },
          $or: [{ endedAt: null }, { endedAt: { $gt: start } }],
          ...(assetIds ? { assetId: { $in: assetIds } } : {}),
        }),
      )
      .select('assetId plantId startedAt endedAt')
      .lean();
    const defaultRate = settings?.defaultDowntimeCostPerHour ?? DEFAULT_DOWNTIME_RATE;
    for (const d of stops) {
      const rate = assetById.get(String(d.assetId))?.downtimeCostPerHour ?? defaultRate;
      const end = Math.min((d.endedAt ?? now).getTime(), stop.getTime());
      // Split at local midnights so groupBy day puts each hour on its own day.
      for (let at = Math.max(d.startedAt.getTime(), start.getTime()); at < end; ) {
        const next = Math.min(
          end,
          DateTime.fromMillis(at, { zone }).startOf('day').plus({ days: 1 }).toMillis(),
        );
        const hours = (next - at) / HOUR;
        totals.downtimeHours += hours;
        add('downtime', hours * rate, { assetId: d.assetId, plantId: d.plantId, category: 'Downtime', at });
        at = next;
      }
    }
  }

  const keyOf = {
    asset: (e) => e.assetId ?? 'unassigned',
    plant: (e) => e.plantId ?? 'none',
    category: (e) => e.category,
    day: (e) => DateTime.fromMillis(e.at, { zone }).toISODate(),
    component: (e) => e.component,
  }[groupBy];
  const labelOf = {
    asset: (k) => (k === 'unassigned' ? 'Unassigned' : (assetById.get(k)?.name ?? 'Unknown asset')),
    plant: (k) => plantName(ctx, k) ?? 'No plant',
    category: (k) => k,
    day: (k) => k,
    component: (k) => COMPONENT_LABELS[k],
  }[groupBy];
  const blank = () => Object.fromEntries(COMPONENTS.map((c) => [c, 0]));
  const sums = blank();
  const groups = new Map();
  for (const e of entries) {
    const key = keyOf(e);
    if (!groups.has(key)) groups.set(key, blank());
    groups.get(key)[e.component] += e.amount;
    sums[e.component] += e.amount;
  }
  const finish = (raw) => {
    const out = {};
    for (const c of COMPONENTS)
      out[c] = components.includes(c) && !(c === 'energy' && energyOff) ? money(raw[c]) : null;
    const asked = MAINTENANCE.filter((c) => out[c] != null);
    out.maintenance = asked.length ? money(asked.reduce((s, c) => s + raw[c], 0)) : null;
    out.total = money(COMPONENTS.filter((c) => out[c] != null).reduce((s, c) => s + raw[c], 0));
    return out;
  };
  const rows = [...groups].map(([key, raw]) => ({ key, label: labelOf(key), ...finish(raw) }));
  rows.sort(groupBy === 'day' ? (a, b) => a.key.localeCompare(b.key) : (a, b) => b.total - a.total);

  return {
    start,
    stop,
    timeZone: zone,
    currency: ctx.company?.currency ?? { name: 'INR', symbol: '₹' },
    groupBy,
    components,
    totals: {
      ...finish(sums),
      kwh: components.includes('energy') && !energyOff ? round(totals.kwh, 2) : null,
      downtimeHours: components.includes('downtime') ? round(totals.downtimeHours, 2) : null,
      labourHours: components.includes('labour') ? round(totals.labourHours, 2) : null,
    },
    rows,
    notes,
  };
};
