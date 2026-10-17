import { z } from 'zod';
import { AiMessage } from '../../db/models/AiMessage.js';
import { badRequest } from '../../lib/errors.js';
import { columnsOf } from './common.js';

/** Presentation tools (phase 4 §2): they emit UI blocks and never touch a database. */

const MAX_TABLE_ROWS = 1000;
const MAX_CHART_POINTS = 2000;
const cell = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const row = z.record(z.string(), z.any());
const column = z.object({
  key: z.string().min(1).max(80),
  label: z.string().max(80).optional(),
  unit: z.string().max(20).optional(),
});
export const CHART_TYPES = ['line', 'bar', 'area', 'stackedBar', 'combo', 'pie', 'scatter'];

/** The stored data of a tool call (or block) of an earlier turn of this conversation, or null. */
const storedData = async (io, ref) => {
  if (!io?.conversationId) return null;
  const message = await AiMessage.findOne({ conversationId: io.conversationId, 'parts.id': ref })
    .select('parts')
    .lean();
  // The tool_call part shares the id; the tool_result (or a block) carries the rows.
  const part = (message?.parts ?? []).find(
    (p) => p.id === ref && (p.type === 'tool_result' || p.type === 'block'),
  );
  if (!part) return null;
  if (part.type === 'tool_result') return part.data ?? null;
  if (part.type === 'block' && Array.isArray(part.payload?.rows)) return part.payload;
  return null;
};

/** Rows from a previous tool call (`sourceRef` = its call id, this turn or an earlier one) or inline. */
const rowsOf = async (args, io, key = 'rows') => {
  if (args.sourceRef) {
    const source = io?.results?.get(args.sourceRef);
    const data = source ? source.data : await storedData(io, args.sourceRef);
    if (!source && !data) {
      throw badRequest(
        `sourceRef "${args.sourceRef}" is not a tool call of this conversation; call the tool again or pass ${key} inline`,
      );
    }
    const rows = data?.rows ?? (Array.isArray(data) ? data : null);
    if (!Array.isArray(rows)) throw badRequest(`Tool call "${args.sourceRef}" returned no rows to render`);
    return { rows, columns: data?.columns };
  }
  const rows = args[key] ?? [];
  if (!rows.length) throw badRequest(`Pass ${key} inline or a sourceRef of an earlier tool call`);
  return { rows, columns: args.columns };
};

const fillColumns = (columns, rows) =>
  (columns?.length ? columns : columnsOf(rows)).map((c) => ({ ...c, label: c.label ?? c.key }));

export const presentTools = [
  {
    name: 'render_table',
    group: 'core',
    description:
      'Shows a table to the user. Pass sourceRef (the id of an earlier tool call, this turn or a previous one) to render its full rows, or rows inline. Example: { title: "Overdue work orders", sourceRef: "<call id>" }.',
    schema: z.object({
      title: z.string().max(120),
      columns: z.array(column).max(40).optional(),
      rows: z.array(row).max(MAX_TABLE_ROWS).optional(),
      sourceRef: z.string().max(80).optional(),
    }),
    run: async (_ctx, args, io) => {
      const { rows, columns } = await rowsOf(args, io);
      const payload = {
        title: args.title,
        columns: fillColumns(args.columns ?? columns, rows),
        rows: rows.slice(0, MAX_TABLE_ROWS),
      };
      return {
        forModel: {
          rendered: 'table',
          rows: payload.rows.length,
          columns: payload.columns.map((c) => c.key),
        },
        summary: `Table "${args.title}" (${payload.rows.length} rows)`,
        rowCount: payload.rows.length,
        blocks: [{ type: 'table', payload }],
      };
    },
  },
  {
    name: 'render_chart',
    group: 'core',
    description:
      'Shows a chart. type: line|bar|area|stackedBar|combo|pie|scatter. xKey is the x field of each data row, series lists the y fields (axis "right" for a second axis in combo charts). Pass data inline or sourceRef of an earlier tool call. Example: { title: "Downtime by asset", type: "bar", xKey: "asset", series: [{ key: "hours", label: "Hours", unit: "h" }], sourceRef: "<call id>" }.',
    schema: z.object({
      title: z.string().max(120),
      type: z.enum(CHART_TYPES),
      xKey: z.string().min(1).max(80),
      series: z
        .array(
          z.object({
            key: z.string().min(1).max(80),
            label: z.string().max(80).optional(),
            unit: z.string().max(20).optional(),
            axis: z.enum(['left', 'right']).optional(),
          }),
        )
        .min(1)
        .max(12),
      data: z.array(row).max(MAX_CHART_POINTS).optional(),
      sourceRef: z.string().max(80).optional(),
    }),
    run: async (_ctx, args, io) => {
      const { rows } = await rowsOf(args, io, 'data');
      const data = rows.slice(0, MAX_CHART_POINTS);
      const keys = new Set(Object.keys(data[0] ?? {}));
      const missing = [args.xKey, ...args.series.map((s) => s.key)].filter((k) => !keys.has(k));
      const payload = {
        title: args.title,
        type: args.type,
        xKey: args.xKey,
        series: args.series.map((s) => ({ ...s, label: s.label ?? s.key })),
        data,
      };
      return {
        forModel: {
          rendered: 'chart',
          points: data.length,
          ...(missing.length ? { warning: `Fields not in the data: ${missing.join(', ')}` } : {}),
        },
        summary: `Chart "${args.title}" (${data.length} points)`,
        rowCount: data.length,
        blocks: [{ type: 'chart', payload }],
      };
    },
  },
  {
    name: 'render_kpis',
    group: 'core',
    description:
      'Shows 1–8 headline numbers as KPI tiles. delta is the change versus a comparison period (number or "+12%"), tone colours the tile. Example: { items: [{ label: "Open work orders", value: 23, delta: "+4", tone: "bad" }] }.',
    schema: z.object({
      items: z
        .array(
          z.object({
            label: z.string().max(80),
            value: cell,
            unit: z.string().max(20).optional(),
            delta: z.union([z.number(), z.string().max(40)]).optional(),
            tone: z.enum(['good', 'bad', 'warning', 'neutral']).optional(),
          }),
        )
        .min(1)
        .max(8),
    }),
    run: async (_ctx, { items }) => ({
      forModel: { rendered: 'kpis', items: items.length },
      summary: `${items.length} KPI tile${items.length === 1 ? '' : 's'}`,
      rowCount: items.length,
      blocks: [{ type: 'kpis', payload: { items } }],
    }),
  },
  {
    name: 'export_csv',
    group: 'core',
    description:
      'Gives the user a CSV file to download. Pass sourceRef of an earlier tool call (its full rows are exported) or rows inline. Example: { name: "maintenance-q3.csv", sourceRef: "<call id>" }.',
    schema: z.object({
      name: z.string().min(1).max(80),
      columns: z.array(column).max(60).optional(),
      rows: z
        .array(row)
        .max(MAX_TABLE_ROWS * 5)
        .optional(),
      sourceRef: z.string().max(80).optional(),
    }),
    run: async (_ctx, args, io) => {
      const { rows, columns } = await rowsOf(args, io);
      const name = /\.csv$/i.test(args.name) ? args.name : `${args.name}.csv`;
      const cols = fillColumns(args.columns ?? columns, rows);
      return {
        forModel: { rendered: 'file', name, rows: rows.length },
        summary: `CSV ${name} (${rows.length} rows)`,
        rowCount: rows.length,
        // The loop fills payload.url once the block has an id; csv stays on the message for the export route.
        blocks: [{ type: 'file', payload: { name, rows: rows.length }, csv: { columns: cols, rows } }],
      };
    },
  },
];
