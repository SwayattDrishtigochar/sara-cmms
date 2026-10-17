import { z } from 'zod';
import { scopeFilter } from '../../modules/records.js';
import { assetRef, compact, labelsFor, readableModule, rowsResult, timeWindow } from './common.js';

/** Health tools (phase 4 §2): the AI health score written by the anomaly watch, plus anomaly records. */

const ACTIVE = ['open', 'acknowledged'];

const anomalyRow = (a, assetLabel) => ({
  code: a.anomalyCode,
  id: String(a._id),
  asset: assetLabel ?? null,
  type: a.type,
  severity: a.severity,
  state: a.state,
  summary: a.summary ?? null,
  parameters: (a.parameters ?? []).map(
    (p) =>
      `${p.field}: ${p.observed ?? '?'}${p.unit ?? ''} (expected ${p.expected ?? '?'}${p.deviation ? `, ${p.deviation}` : ''})`,
  ),
  likelyCauses: a.likelyCauses ?? [],
  recommendedActions: a.recommendedActions ?? [],
  confidence: a.confidence ?? null,
  urgencyHours: a.urgencyHours ?? null,
  detectedAt: a.detectedAt?.toISOString?.() ?? null,
  resolvedAt: a.resolvedAt?.toISOString?.() ?? null,
  workOrderId: a.workOrderId ? String(a.workOrderId) : null,
});

export const healthTools = [
  {
    name: 'machine_health',
    group: 'health',
    description:
      'AI health score (0–100) and summary of one asset, with its open anomalies (deviating parameters, likely causes, recommended actions) and the last 10 resolved ones. Example: { assetId }.',
    schema: z.object({ assetId: z.string().min(1).describe('An id, a code (IMM-01) or a name (IMM 1)') }),
    run: async (ctx, { assetId }) => {
      const asset = await assetRef(ctx, assetId);
      let open = [];
      let recent = [];
      if (ctx.modules.includes('anomalies')) {
        const mod = readableModule(ctx, 'anomalies');
        const base = { ...scopeFilter(ctx, mod), assetId: asset._id };
        [open, recent] = await Promise.all([
          mod.Model.find({ ...base, state: { $in: ACTIVE } })
            .sort({ detectedAt: -1 })
            .lean(),
          mod.Model.find({ ...base, state: { $in: ['resolved', 'false_positive'] } })
            .sort({ resolvedAt: -1, detectedAt: -1 })
            .limit(10)
            .lean(),
        ]);
      }
      const result = {
        asset: {
          id: String(asset._id),
          name: asset.name,
          type: asset.typeOfAsset,
          status: asset.assetStatus,
          healthScore: asset.healthScore ?? null,
          healthSummary: asset.healthSummary ?? null,
          healthUpdatedAt: asset.healthUpdatedAt?.toISOString?.() ?? null,
        },
        openAnomalies: open.map((a) => anomalyRow(a, asset.name)),
        recentResolved: recent.map((a) => anomalyRow(a, asset.name)),
      };
      return {
        forModel: compact(result),
        summary: `${asset.name}: health ${asset.healthScore ?? '—'}/100, ${open.length} open anomal${open.length === 1 ? 'y' : 'ies'}`,
        rowCount: open.length,
        data: { rows: [...result.openAnomalies, ...result.recentResolved] },
      };
    },
  },
  {
    name: 'list_anomalies',
    group: 'health',
    permission: (ctx) => ctx.modules.includes('anomalies'),
    description:
      'Anomalies the AI detected, newest first. state: active (default: open + acknowledged), open, acknowledged, resolved, false_positive, all. start/stop narrow to when they were detected (a phrase such as "last 3 days" is fine). Example: { state: "active", severity: "critical" }.',
    schema: z.object({
      state: z
        .enum(['active', 'open', 'acknowledged', 'resolved', 'false_positive', 'all'])
        .default('active'),
      severity: z.enum(['info', 'warning', 'critical']).optional(),
      assetId: z.string().optional().describe('An id, a code or a name; omit for every asset'),
      limit: z.int().min(1).max(100).default(20),
      start: z.string().max(60).optional().describe('Detected from here: ISO, a date or a phrase'),
      stop: z.string().max(60).optional(),
    }),
    run: async (ctx, { state, severity, assetId, limit, start, stop }, io) => {
      const mod = readableModule(ctx, 'anomalies');
      const where = { ...scopeFilter(ctx, mod) };
      const window = start || stop ? timeWindow({ start, stop }, { ctx, io }) : null;
      if (window) where.detectedAt = { $gte: window.start, $lt: window.stop };
      if (state === 'active') where.state = { $in: ACTIVE };
      else if (state !== 'all') where.state = state;
      if (severity) where.severity = severity;
      if (assetId && !/^(all|\*)$/i.test(assetId)) where.assetId = (await assetRef(ctx, assetId))._id;
      const docs = await mod.Model.find(where).sort({ detectedAt: -1 }).limit(limit).lean();
      const labels = await labelsFor(
        ctx,
        'assets',
        docs.map((d) => d.assetId),
      );
      const rows = docs.map((a) => anomalyRow(a, labels.get(String(a.assetId))));
      return rowsResult({
        rows,
        what: 'anomalies',
        extra: {
          state,
          ...(window ? { start: window.start.toISOString(), stop: window.stop.toISOString() } : {}),
        },
      });
    },
  },
];
