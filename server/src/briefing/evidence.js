import { DateTime } from 'luxon';
import { asObjectId, money, plantOf, round, zoneOf } from '../agent/tools/common.js';
import { costSummary } from '../costs/engine.js';
import { periodRange } from '../costs/periods.js';
import { logger } from '../lib/logger.js';
import { shiftAt } from '../lib/shifts.js';
import { can } from '../modules/permissions.js';
import { scopeFilter } from '../modules/records.js';
import { getModule } from '../modules/registry.js';

/**
 * The Command Center evidence pack (phase 5 §3.10): every number of the briefing, computed in the viewer's
 * scope (tenant + plant lock). Each section carries a ready UI block; a section is null when the viewer's
 * company or role has no such module.
 */

const DAY = 86_400_000;
const OPEN_JOBS = ['Open', 'In Progress', 'On Hold'];
const CLOSED_WO = ['Completed', 'Closed'];
const ACTIVE_ANOMALY = ['open', 'acknowledged'];
const SEVERITY_RANK = { critical: 0, warning: 1, info: 2 };

const readable = (ctx, name) => ctx.modules.includes(name) && can(ctx, getModule(name), 'read');
const scoped = (ctx, name, extra = {}) => {
  const mod = getModule(name);
  return { mod, where: { ...extra, ...scopeFilter(ctx, mod) } };
};
/** Asset id → plain name ("IMM 1"), same company only. */
const assetNames = async (ctx, ids) => {
  const wanted = [...new Set(ids.filter(Boolean).map(String))].map(asObjectId).filter(Boolean);
  if (!wanted.length) return new Map();
  const rows = await getModule('assets')
    .Model.find({ _id: { $in: wanted }, companyId: ctx.companyId })
    .select('name')
    .lean();
  return new Map(rows.map((r) => [String(r._id), r.name]));
};
const pct = (part, whole) => (whole ? round((part / whole) * 100, 1) : null);
const mean = (list) => (list.length ? list.reduce((s, v) => s + v, 0) / list.length : null);
const iso = (date) => (date ? new Date(date).toISOString() : null);
const kpis = (title, items) => ({ type: 'kpis', payload: { title, items } });
const table = (title, columns, rows) => ({ type: 'table', payload: { title, columns, rows } });

/** Today's shifts: a row's `date` is its shift start, so last night's shift counts when it ran past midnight. */
const production = async (ctx, { dayStart, now }) => {
  const { mod, where } = scoped(ctx, 'partcounts', { date: { $gte: new Date(dayStart - DAY), $lte: now } });
  const rows = await mod.Model.find(where).select('assetId plantId date produced totalTarget').lean();
  const zone = zoneOf(ctx);
  const overlapsToday = (r) => {
    if (r.date >= dayStart) return true;
    const plant = plantOf(ctx, r.plantId);
    return Boolean(plant) && shiftAt(plant, r.date, zone)?.end > dayStart;
  };
  const sums = new Map();
  for (const r of rows.filter(overlapsToday)) {
    const g = sums.get(String(r.assetId)) ?? { _id: r.assetId, produced: 0, target: 0 };
    g.produced += r.produced ?? 0;
    g.target += r.totalTarget ?? 0;
    sums.set(String(r.assetId), g);
  }
  const groups = [...sums.values()].sort((x, y) => y.produced - x.produced);
  const produced = groups.reduce((s, g) => s + g.produced, 0);
  const planned = groups.reduce((s, g) => s + g.target, 0);
  const top = groups.slice(0, 5);
  const labels = await assetNames(
    ctx,
    top.map((g) => g._id),
  );
  const byAsset = top.map((g) => ({
    asset: labels.get(String(g._id)) ?? 'Unknown machine',
    assetId: String(g._id),
    produced: g.produced,
    target: g.target,
  }));
  const block = byAsset.length
    ? {
        type: 'chart',
        payload: {
          title: 'Production today vs target',
          type: 'bar',
          xKey: 'asset',
          series: [
            { key: 'produced', label: 'Produced', unit: 'pcs' },
            { key: 'target', label: 'Target', unit: 'pcs' },
          ],
          data: byAsset.map(({ asset, produced: p, target }) => ({ asset, produced: p, target })),
        },
      }
    : kpis('Production today', [
        { label: 'Produced', value: produced, unit: 'pcs' },
        { label: 'Planned', value: planned, unit: 'pcs' },
      ]);
  return { produced, planned, pct: pct(produced, planned), byAsset, block };
};

const oee = async (ctx, { dayStart, now }) => {
  const { mod, where } = scoped(ctx, 'jobcards', {
    actualEnd: { $gte: new Date(now - 7 * DAY), $lte: now },
    'completionMetrics.oee.oee': { $type: 'number' },
  });
  const jobs = await mod.Model.find(where).select('actualEnd completionMetrics.oee').lean();
  const avg = (list, key) => round(mean(list.map((j) => j.completionMetrics.oee[key] ?? 0)), 3);
  const today = jobs.filter((j) => j.actualEnd >= dayStart);
  const value = avg(jobs, 'oee');
  const asPct = (v) => (v == null ? null : round(v * 100, 1));
  return {
    oee: value,
    availability: avg(jobs, 'availability'),
    performance: avg(jobs, 'performance'),
    quality: avg(jobs, 'quality'),
    today: avg(today, 'oee'),
    jobs: jobs.length,
    basis: 'job cards completed in the last 7 days',
    block: kpis('OEE, last 7 days', [
      {
        label: 'OEE',
        value: asPct(value),
        unit: '%',
        tone: value == null ? 'neutral' : value >= 0.85 ? 'good' : value >= 0.65 ? 'warning' : 'bad',
      },
      { label: 'Availability', value: asPct(avg(jobs, 'availability')), unit: '%' },
      { label: 'Performance', value: asPct(avg(jobs, 'performance')), unit: '%' },
      { label: 'Quality', value: asPct(avg(jobs, 'quality')), unit: '%' },
    ]),
  };
};

const downtime = async (ctx, { dayStart, now }) => {
  const { mod, where } = scoped(ctx, 'downtimes', {
    startedAt: { $lt: now },
    $or: [{ endedAt: null }, { endedAt: { $gt: dayStart } }],
  });
  const stops = await mod.Model.find(where).select('assetId startedAt endedAt reason').lean();
  const byAsset = new Map();
  let total = 0;
  let count = 0;
  for (const d of stops) {
    const ms = Math.min(+(d.endedAt ?? now), +now) - Math.max(+d.startedAt, +dayStart);
    if (ms <= 0) continue;
    count += 1;
    total += ms;
    const key = String(d.assetId);
    const row = byAsset.get(key) ?? { assetId: key, ms: 0, reasons: new Map() };
    row.ms += ms;
    for (const r of d.reason ?? []) row.reasons.set(r, (row.reasons.get(r) ?? 0) + 1);
    byAsset.set(key, row);
  }
  const worst = [...byAsset.values()].sort((a, b) => b.ms - a.ms).slice(0, 3);
  const labels = await assetNames(
    ctx,
    worst.map((r) => r.assetId),
  );
  const top = worst.map((r) => ({
    asset: labels.get(r.assetId) ?? 'Unknown machine',
    assetId: r.assetId,
    minutes: round(r.ms / 60_000, 1),
    reason: [...r.reasons].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
  }));
  const totalMinutes = round(total / 60_000, 1);
  return {
    totalMinutes,
    count,
    top,
    block: top.length
      ? table(
          `Downtime today: ${Math.round(totalMinutes)} min`,
          [
            { key: 'asset', label: 'Machine' },
            { key: 'minutes', label: 'Minutes', unit: 'min' },
            { key: 'reason', label: 'Main reason' },
          ],
          top.map(({ asset, minutes, reason }) => ({ asset, minutes, reason: reason ?? 'No reason given' })),
        )
      : kpis('Downtime today', [{ label: 'Downtime', value: 0, unit: 'min', tone: 'good' }]),
  };
};

const anomalies = async (ctx) => {
  const { mod, where } = scoped(ctx, 'anomalies', { state: { $in: ACTIVE_ANOMALY } });
  const open = await mod.Model.find(where)
    .select('anomalyCode assetId type severity summary detectedAt')
    .sort({ detectedAt: -1 })
    .limit(200)
    .lean();
  open.sort((a, b) => (SEVERITY_RANK[a.severity] ?? 3) - (SEVERITY_RANK[b.severity] ?? 3));
  const first = open.slice(0, 5);
  const labels = await assetNames(
    ctx,
    first.map((a) => a.assetId),
  );
  const items = first.map((a) => ({
    id: String(a._id),
    code: a.anomalyCode,
    asset: labels.get(String(a.assetId)) ?? 'Unknown machine',
    assetId: String(a.assetId),
    type: a.type,
    severity: a.severity,
    summary: a.summary ?? null,
  }));
  const critical = open.filter((a) => a.severity === 'critical').length;
  return {
    open: open.length,
    critical,
    items,
    block: items.length
      ? table(
          `Anomalies: ${open.length} open`,
          [
            { key: 'asset', label: 'Machine' },
            { key: 'severity', label: 'Severity' },
            { key: 'summary', label: 'Summary' },
          ],
          items.map(({ asset, severity, summary }) => ({ asset, severity, summary })),
        )
      : kpis('Anomalies', [{ label: 'Open anomalies', value: 0, tone: 'good' }]),
  };
};

const maintenance = async (ctx, { dayEnd, now }) => {
  const soon = new Date(+now + 7 * DAY);
  const wo = scoped(ctx, 'workorders', { workStatus: { $nin: CLOSED_WO } });
  const [openWorkOrders, dueWos] = await Promise.all([
    wo.mod.Model.countDocuments(wo.where),
    wo.mod.Model.find({ ...wo.where, dueDate: { $lt: soon } })
      .select('workOrderId name asset dueDate')
      .lean(),
  ]);
  const tasks = dueWos.map((w) => ({
    kind: 'workorder',
    id: String(w._id),
    code: w.workOrderId,
    name: w.name,
    assetId: w.asset ? String(w.asset) : null,
    due: w.dueDate,
  }));
  for (const [name, kind] of [
    ['preventivemaintenances', 'pm'],
    ['calibrations', 'calibration'],
  ]) {
    if (!readable(ctx, name)) continue;
    const { mod, where } = scoped(ctx, name, { isActive: { $ne: false }, nextGenerationDate: { $lt: soon } });
    const docs = await mod.Model.find(where)
      .select(`${mod.codeField} name assetAllocation nextGenerationDate`)
      .lean();
    for (const d of docs) {
      tasks.push({
        kind,
        id: String(d._id),
        code: d[mod.codeField],
        name: d.name,
        assetId: d.assetAllocation ? String(d.assetAllocation) : null,
        due: d.nextGenerationDate,
      });
    }
  }
  tasks.sort((a, b) => a.due - b.due);
  const overdue = tasks.filter((t) => t.due < now).length;
  const dueToday = tasks.filter((t) => t.due >= now && t.due < dayEnd).length;
  const first = tasks.slice(0, 5);
  const labels = await assetNames(
    ctx,
    first.map((t) => t.assetId),
  );
  const dueSoon = first.map((t) => ({
    ...t,
    asset: t.assetId ? (labels.get(t.assetId) ?? null) : null,
    due: iso(t.due),
  }));
  return {
    overdue,
    dueToday,
    openWorkOrders,
    dueSoon,
    block: kpis('Maintenance', [
      { label: 'Overdue', value: overdue, tone: overdue ? 'bad' : 'good' },
      { label: 'Due today', value: dueToday },
      { label: 'Open work orders', value: openWorkOrders },
    ]),
  };
};

const costs = async (ctx, { now }) => {
  const range = periodRange('month', zoneOf(ctx), now);
  const summary = await costSummary(ctx, { start: range.start, stop: range.stop, groupBy: 'component', now });
  const { total, energy, maintenance: maint, downtime: down } = summary.totals;
  return {
    total,
    energy,
    maintenance: maint,
    downtime: down,
    currency: summary.currency,
    period: range.label,
    notes: summary.notes,
    block: kpis(`Costs, ${range.label} to date`, [
      { label: 'Total', value: money(ctx, total) ?? '—' },
      { label: 'Energy', value: money(ctx, energy) ?? '—' },
      { label: 'Maintenance', value: money(ctx, maint) ?? '—' },
      { label: 'Downtime', value: money(ctx, down) ?? '—' },
    ]),
  };
};

const plan = async (ctx, { now }) => {
  const { mod, where } = scoped(ctx, 'jobcards', { jobStatus: { $in: OPEN_JOBS } });
  const cards = await mod.Model.find(where)
    .select('jobCardId asset jobStatus endDate productionPlanId')
    .sort({ endDate: 1 })
    .limit(500)
    .lean();
  const planIds = [
    ...new Set(
      cards
        .map((c) => c.productionPlanId)
        .filter(Boolean)
        .map(String),
    ),
  ];
  const plans = readable(ctx, 'productionplans')
    ? await getModule('productionplans')
        .Model.find({ _id: { $in: planIds }, companyId: ctx.companyId })
        .select('dueDate')
        .lean()
    : [];
  const dueOf = new Map(plans.map((p) => [String(p._id), p.dueDate]));
  const lateCards = cards.filter((c) => {
    const due = dueOf.get(String(c.productionPlanId));
    return c.endDate && ((due && c.endDate > due) || c.endDate < now);
  });
  const first = lateCards.slice(0, 5);
  const labels = await assetNames(
    ctx,
    first.map((c) => c.asset),
  );
  const late = first.map((c) => ({
    code: c.jobCardId,
    asset: labels.get(String(c.asset)) ?? 'Unknown machine',
    endDate: iso(c.endDate),
    dueDate: iso(dueOf.get(String(c.productionPlanId))),
  }));
  const activeJobCards = cards.filter((c) => c.jobStatus === 'In Progress').length;
  return {
    activeJobCards,
    lateCount: lateCards.length,
    late,
    block: late.length
      ? table(
          `${lateCards.length} job card${lateCards.length === 1 ? '' : 's'} behind plan`,
          [
            { key: 'code', label: 'Job card' },
            { key: 'asset', label: 'Machine' },
            { key: 'endDate', label: 'Planned end' },
            { key: 'dueDate', label: 'Plan due' },
          ],
          late,
        )
      : kpis('Plan', [
          { label: 'Running job cards', value: activeJobCards },
          { label: 'Behind plan', value: 0, tone: 'good' },
        ]),
  };
};

/** Section → [modules it needs, builder]. */
const SECTIONS = {
  production: [['partcounts'], production],
  oee: [['jobcards'], oee],
  downtime: [['downtimes'], downtime],
  anomalies: [['anomalies'], anomalies],
  maintenance: [['workorders'], maintenance],
  costs: [[], costs],
  plan: [['jobcards'], plan],
};

/**
 * Today so far (company zone) in the viewer's scope. A failing section is logged and left null so the
 * Command Center still shows the rest.
 * @returns {Promise<{ production, oee, downtime, anomalies, maintenance, costs, plan }>}
 */
export const buildEvidence = async (ctx, { now = new Date() } = {}) => {
  const day = DateTime.fromJSDate(now, { zone: zoneOf(ctx) }).startOf('day');
  const span = { now, dayStart: day.toJSDate(), dayEnd: day.plus({ days: 1 }).toJSDate() };
  const entries = await Promise.all(
    Object.entries(SECTIONS).map(async ([key, [modules, build]]) => {
      if (!modules.every((m) => readable(ctx, m))) return [key, null];
      try {
        return [key, await build(ctx, span)];
      } catch (err) {
        logger.warn({ err, section: key, companyId: String(ctx.companyId) }, 'briefing evidence failed');
        return [key, null];
      }
    }),
  );
  return Object.fromEntries(entries);
};
