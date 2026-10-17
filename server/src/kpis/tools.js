import { z } from 'zod';
import { findRef } from '../agent/tools/defaults.js';
import { getTool } from '../agent/tools/registry.js';
import { badRequest } from '../lib/errors.js';
import { KPI_VIZ } from '../modules/defs/ai.js';
import { OBJECT_ID_PATTERN } from '../modules/fields.js';
import { can } from '../modules/permissions.js';
import { records, scopeFilter } from '../modules/records.js';
import { getModule } from '../modules/registry.js';
import { KEY_PATTERN } from './expr.js';
import { KPI_SOURCE_TOOLS, runKpi, validateKpi } from './runner.js';

/**
 * KPI tools (docs/phase5-contracts.md §5, group `kpi`): create_kpi / update_kpi show a live preview and write
 * only after the user confirms (`records.*` with `source: 'kpi'`); list_kpis reads.
 */

const DEF_FIELDS = [
  'title',
  'description',
  'viz',
  'unit',
  'target',
  'thresholds',
  'timeRange',
  'sources',
  'formula',
  'encoding',
  'pinned',
];

const defShape = {
  title: z.string().min(1).max(120),
  description: z.string().max(1000).optional(),
  viz: z.enum(KPI_VIZ),
  unit: z.string().max(20).optional(),
  target: z.number().optional(),
  thresholds: z
    .object({
      warn: z.number().optional(),
      critical: z.number().optional(),
      direction: z.enum(['higher_is_better', 'lower_is_better']).optional(),
    })
    .optional(),
  timeRange: z.object({ text: z.string().min(1).max(120).describe('e.g. "last 7 days", "this month"') }),
  sources: z
    .array(
      z.object({
        key: z
          .string()
          .regex(KEY_PATTERN)
          .describe('Short camelCase name used in formula/encoding, e.g. energy'),
        tool: z.string().min(1).max(60).describe('One of the allowed read tools'),
        args: z.record(z.string(), z.any()).default({}),
        pick: z.string().max(120).optional().describe('Path into the result, default "data.rows"'),
      }),
    )
    .min(1)
    .max(4),
  formula: z.string().max(300).optional().describe('e.g. "sum(energy.kwh) / sum(parts.produced)"'),
  encoding: z
    .object({
      source: z.string().max(20).optional(),
      x: z.string().max(80).optional(),
      y: z.string().max(80).optional(),
      value: z.string().max(80).optional(),
      label: z.string().max(80).optional(),
      start: z.string().max(80).optional(),
      end: z.string().max(80).optional(),
      series: z
        .array(
          z.object({
            key: z.string().min(1).max(80),
            label: z.string().max(80).optional(),
            unit: z.string().max(20).optional(),
            axis: z.enum(['left', 'right']).optional(),
            type: z.enum(['line', 'bar', 'area']).optional(),
          }),
        )
        .max(6)
        .optional(),
      sort: z.enum(['none', 'asc', 'desc']).optional(),
      limit: z.int().min(1).max(1000).optional(),
    })
    .optional(),
  pinned: z.boolean().optional(),
};

const kpiModule = () => getModule('kpis');
const pickDef = (doc) => Object.fromEntries(DEF_FIELDS.filter((k) => doc[k] != null).map((k) => [k, doc[k]]));
const kpiBlock = (id, kpi, result) => ({ type: 'kpi', payload: { ...(id ? { id } : {}), kpi, result } });

const ASSET_KEYS = ['assetIds', 'assetId', 'asset', 'assets', 'machine'];
const assetFilter = (toolName) => (toolName === 'energy_consumption' ? { isEnergyAsset: true } : {});

/** Asset names, codes and "all" in source args → ids, so the stored KPI never depends on a name again. */
export const resolveSourceRefs = async (ctx, def) => {
  const sources = [];
  for (const source of def.sources ?? []) {
    const args = { ...(source.args ?? {}) };
    for (const key of ASSET_KEYS) {
      if (args[key] == null) continue;
      const ids = [];
      for (const ref of [].concat(args[key])) {
        const text = String(ref).trim();
        if (OBJECT_ID_PATTERN.test(text)) ids.push(text);
        else if (/^(all|\*|every|each)$/i.test(text)) {
          const mod = getModule('assets');
          const rows = await mod.Model.find({ ...assetFilter(source.tool), ...scopeFilter(ctx, mod) })
            .select('_id')
            .limit(20)
            .lean();
          ids.push(...rows.map((r) => String(r._id)));
        } else ids.push((await findRef(ctx, 'assets', text)).id);
      }
      const shape = getTool(source.tool)?.schema?.shape ?? {};
      const target = 'assetIds' in shape || !('assetId' in shape) ? 'assetIds' : 'assetId';
      delete args[key];
      args[target] = target === 'assetId' ? ids[0] : [...new Set(ids)];
    }
    sources.push({ ...source, args });
  }
  return { ...def, sources };
};

/** Validates and runs the definition; a preview that can't run is an error the model can fix. */
const previewRun = async (ctx, def, io) => {
  const kpi = validateKpi(ctx, await resolveSourceRefs(ctx, def));
  const result = await runKpi(ctx, kpi, { signal: io?.signal });
  if (result.error) throw badRequest(`The KPI preview failed: ${result.error}`);
  return { kpi, result };
};

const existingKpi = async (ctx, id) => records.get(ctx, 'kpis', id, { populate: false });
const diffOf = (before, after) =>
  DEF_FIELDS.filter((k) => JSON.stringify(before[k] ?? null) !== JSON.stringify(after[k] ?? null)).map(
    (field) => ({ field, from: before[field] ?? null, to: after[field] ?? null }),
  );

export const kpiTools = [
  {
    name: 'create_kpi',
    group: 'kpi',
    requiresConfirmation: true,
    permission: (ctx) => can(ctx, kpiModule(), 'create'),
    // A getter: runner.js may still be loading when the registry imports this file (import cycle).
    get description() {
      return `Creates a KPI card on the KPI Builder page from 1–4 read-tool sources. The user sees a live preview and must confirm. Allowed source tools: ${[...KPI_SOURCE_TOOLS].join(', ')}. Never pass start/stop: they are injected from timeRange on every run (inside mongo filters write "$start" / "$stop"); list_anomalies rows are cut to the time range too, so "anomalies last 3 days" works. Asset names, codes or "all" are fine in assetIds/assetId. energy_consumption takes groupBy asset|day|hour|shift (energy of one machine per day = assetIds: [name], groupBy: "day", viz line, encoding x: "day", y: "kwh"). Availability of one machine: telemetry_status_timeline { assetId } with pick "forModel.availabilityPct" and viz number; OEE exists only per finished job card (job_card_progress). formula combines sources (numbers, + - * / %, sum/avg/min/max/first/last(key.field), count(key), round(x, dp), abs). encoding maps columns: x, y, value, label, series. Example: { title: "Compressor energy by hour", viz: "heatmap", unit: "kWh", timeRange: { text: "last 7 days" }, sources: [{ key: "energy", tool: "energy_consumption", args: { assetIds: ["<id>", "<id>"], groupBy: "hour" } }], encoding: { source: "energy", x: "hour", value: "kwh" } }.`;
    },
    schema: z.object(defShape),
    preview: async (ctx, def, io) => {
      const { kpi, result } = await previewRun(ctx, def, io);
      return {
        type: 'confirm',
        payload: {
          tool: 'create_kpi',
          action: 'kpi',
          module: 'kpis',
          moduleLabel: 'KPIs',
          label: `Create KPI "${kpi.title}"`,
          kpi,
          result,
        },
      };
    },
    run: async (ctx, def, io) => {
      const kpi = validateKpi(ctx, await resolveSourceRefs(ctx, def));
      const doc = await records.create(ctx, 'kpis', kpi, { source: 'kpi' });
      const id = String(doc._id);
      const result = await runKpi(ctx, doc, { signal: io?.signal });
      return {
        forModel: { created: { id, title: doc.title, link: '/kpis' } },
        summary: `Created KPI "${doc.title}"`,
        rowCount: 1,
        data: { rows: [{ id, title: doc.title, link: '/kpis' }] },
        blocks: [kpiBlock(id, pickDef(doc), result)],
      };
    },
  },
  {
    name: 'update_kpi',
    group: 'kpi',
    requiresConfirmation: true,
    permission: (ctx) => can(ctx, kpiModule(), 'update'),
    description:
      'Changes a KPI card (id from list_kpis): only the fields in changes; sources, encoding and thresholds are replaced as a whole. The user sees the live preview and a diff and must confirm. Example: { id: "<id>", changes: { viz: "bar", timeRange: { text: "this month" } } }.',
    schema: z.object({ id: z.string().min(1).max(60), changes: z.object(defShape).partial() }),
    preview: async (ctx, { id, changes }, io) => {
      const before = pickDef(await existingKpi(ctx, id));
      const { kpi, result } = await previewRun(ctx, { ...before, ...changes }, io);
      const diff = diffOf(before, kpi);
      if (!diff.length) throw badRequest('Nothing changes in this KPI');
      return {
        type: 'confirm',
        payload: {
          tool: 'update_kpi',
          action: 'kpi',
          module: 'kpis',
          moduleLabel: 'KPIs',
          label: `Update KPI "${kpi.title}"`,
          kpi: { id, ...kpi },
          changes: diff,
          result,
        },
      };
    },
    run: async (ctx, { id, changes }, io) => {
      const before = pickDef(await existingKpi(ctx, id));
      const kpi = validateKpi(ctx, await resolveSourceRefs(ctx, { ...before, ...changes }));
      const patch = Object.fromEntries(diffOf(before, kpi).map(({ field }) => [field, kpi[field] ?? null]));
      const { after, changes: diff } = await records.update(ctx, 'kpis', id, patch, { source: 'kpi' });
      const result = await runKpi(ctx, after, { signal: io?.signal });
      return {
        forModel: { updated: { id, title: after.title, link: '/kpis', changed: diff.map((c) => c.field) } },
        summary: `Updated KPI "${after.title}"`,
        rowCount: 1,
        data: { rows: [{ id, title: after.title, link: '/kpis' }] },
        blocks: [kpiBlock(id, pickDef(after), result)],
      };
    },
  },
  {
    name: 'list_kpis',
    group: 'kpi',
    description: 'Lists the KPI cards of the KPI Builder page (ids for update_kpi). Example: {}.',
    schema: z.object({}),
    run: async (ctx) => {
      const { items } = await records.list(ctx, 'kpis', { limit: 100, sort: '-updatedAt', populate: false });
      const kpis = items.map((k) => ({
        id: String(k._id),
        title: k.title,
        viz: k.viz,
        unit: k.unit ?? null,
        timeRange: k.timeRange?.text ?? null,
        sources: (k.sources ?? []).map((s) => ({ key: s.key, tool: s.tool })),
        pinned: Boolean(k.pinned),
      }));
      return {
        forModel: { kpis },
        summary: `${kpis.length} KPIs`,
        rowCount: kpis.length,
        data: { rows: kpis },
      };
    },
  },
];
