import { z } from 'zod';
import { compact, money, rowsResult, timeWindow } from '../agent/tools/common.js';
import { COMPONENT_LABELS, COMPONENTS, costSummary, GROUP_BYS } from './engine.js';

/** Cost tools (phase 5 §5, group `cost`); the integrator spreads them into the registry. */

const MONEY_KEYS = ['energy', 'spares', 'consumables', 'labour', 'downtime', 'maintenance', 'total'];

/** Table columns: the group label and the asked money columns (no row keys, no empty components). */
const tableColumns = ({ groupBy, components, totals, currency }) => {
  const unit = currency.symbol;
  const parts = components.filter((c) => totals[c] != null);
  const maintenance = parts.filter((c) => ['spares', 'consumables', 'labour'].includes(c));
  return [
    { key: 'label', label: groupBy[0].toUpperCase() + groupBy.slice(1) },
    ...parts.map((c) => ({ key: c, label: COMPONENT_LABELS[c], unit })),
    ...(maintenance.length > 1 && maintenance.length < parts.length
      ? [{ key: 'maintenance', label: 'Maintenance', unit }]
      : []),
    ...(parts.length > 1 ? [{ key: 'total', label: 'Total', unit }] : []),
  ];
};

const costSummaryTool = {
  name: 'cost_summary',
  group: 'cost',
  description:
    'Costs between start and stop: energy (kWh × plant tariff), spare parts used, consumables, labour (work order time × people × labour rate) and machine downtime (hours × downtime rate), with maintenance = spares + consumables + labour. Group by asset, plant, category, day or component; filter by components, plant or assets (resolve them first). Example: { start, stop, groupBy: "asset", components: ["spares", "consumables", "labour"] }.',
  schema: z.object({
    start: z.string(),
    stop: z.string(),
    groupBy: z.enum(GROUP_BYS).default('asset'),
    components: z.array(z.enum(COMPONENTS)).max(COMPONENTS.length).optional(),
    plantId: z.string().optional(),
    assetIds: z.array(z.string().min(1)).max(20).optional(),
  }),
  run: async (ctx, { start, stop, groupBy, components, plantId, assetIds }, io) => {
    const window = timeWindow({ start, stop }, { ctx, io });
    const summary = await costSummary(ctx, { ...window, groupBy, components, plantId, assetIds });
    const totals = Object.fromEntries(
      Object.entries(summary.totals).map(([k, v]) => [
        k,
        MONEY_KEYS.includes(k) && v != null ? money(ctx, v) : v,
      ]),
    );
    const blocks =
      summary.rows.length > 1
        ? [
            {
              type: 'chart',
              payload: {
                title: `Cost by ${groupBy}`,
                type: 'stackedBar',
                xKey: 'label',
                series: summary.components
                  .filter((c) => summary.totals[c] != null)
                  .map((c) => ({ key: c, label: COMPONENT_LABELS[c], unit: summary.currency.symbol })),
                data: summary.rows,
              },
            },
          ]
        : [];
    return rowsResult({
      rows: summary.rows,
      columns: tableColumns(summary),
      what: `${groupBy} rows of cost`,
      forModel: {
        start: window.start.toISOString(),
        stop: window.stop.toISOString(),
        currency: summary.currency,
        totals: summary.totals,
        totalsText: totals,
        notes: summary.notes,
        rows: compact(summary.rows),
        note: summary.rows.length > 1 ? 'The breakdown is already charted for the user' : undefined,
      },
      blocks,
    });
  },
};

export const costTools = [costSummaryTool];
