import { z } from 'zod';
import { notFound } from '../../lib/errors.js';
import { plantAudience, publish } from '../../lib/events.js';
import { PRIORITIES } from '../../modules/defs/maintenance.js';
import { getModule } from '../../modules/registry.js';
import { KEY_FIELDS } from '../../telemetry/catalog.js';
import { seriesFor } from '../../telemetry/queries.js';
import { generate } from '../gemini.js';
import { baselineFor, baselineKey } from './baselines.js';
import { fieldLabel } from './features.js';

/**
 * Root-cause investigation of one anomaly: a deterministic evidence pack (recent series, baselines,
 * maintenance history, spare parts, similar anomalies) and one structured Gemini call.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MAX_FIELDS = 6;
const Model = (name) => getModule(name).Model;

const investigationSchema = z.object({
  summary: z.string().describe('Two or three plain sentences for the maintenance team'),
  rootCause: z.string(),
  confidence: z.number().min(0).max(1),
  recommendedActions: z.array(z.string()),
  suggestedWorkOrder: z.object({
    name: z.string(),
    description: z.string(),
    priority: z.enum(PRIORITIES),
    category: z
      .string()
      .describe(
        'Breakdown, Preventive, Electrical, Mechanical, Hydraulic, Inspection, Calibration, Cleaning or Safety',
      ),
    estimatedDurationMin: z.number().min(0),
  }),
  urgencyHours: z.number().min(0),
  markdown: z.string().describe('The full write-up in Markdown: findings, evidence, root cause, actions'),
});
export const INVESTIGATION_SCHEMA = (() => {
  const { $schema: _, ...schema } = z.toJSONSchema(investigationSchema, {
    io: 'input',
    unrepresentable: 'any',
  });
  return schema;
})();

const SYSTEM_PROMPT = `You are SARA's maintenance engineer. Investigate one machine anomaly from the evidence pack: the flagged parameters and their last two hours, what is normal for this machine, its maintenance history, spare parts on hand and similar past anomalies.
Reason physically and name the most likely root cause with your confidence. Recommend concrete actions a technician can do today, in order. Suggest one work order (name, description, priority, category, estimated duration in minutes) that fixes the cause, and mention spare parts by name when they are needed and whether they are in stock.
Write for busy people: plain language, no jargon that is not in the evidence, no made-up numbers.`;

const round = (v) => (v == null ? null : Number(Number(v).toFixed(3)));

/** Mean per 5-minute bucket: enough shape for the prompt without 120 points per field. */
const downsample = (points, bucketMs = 5 * 60_000) => {
  const buckets = new Map();
  for (const [t, v] of points) {
    const b = Math.floor(t / bucketMs) * bucketMs;
    const acc = buckets.get(b) ?? { sum: 0, n: 0 };
    acc.sum += v;
    acc.n += 1;
    buckets.set(b, acc);
  }
  return [...buckets].map(([t, { sum, n }]) => [new Date(t).toISOString().slice(11, 16), round(sum / n)]);
};

const stockOf = async (companyId, partIds) => {
  const lots = await Model('sparepartinventories').aggregate([
    { $match: { companyId, sparePartId: { $in: partIds }, deleted: { $ne: true } } },
    { $group: { _id: '$sparePartId', stock: { $sum: '$stockQuantity' } } },
  ]);
  return new Map(lots.map((l) => [String(l._id), l.stock]));
};

/** Everything deterministic the model gets to see. */
export const buildEvidence = async (companyId, anomaly, { now = new Date() } = {}) => {
  const asset = await Model('assets').findOne({ _id: anomaly.assetId, companyId }).lean();
  if (!asset) throw notFound('The anomaly’s asset no longer exists');
  const assetId = String(asset._id);
  const fields = [...new Set((anomaly.parameters ?? []).map((p) => p.field))].slice(0, MAX_FIELDS);
  if (!fields.length) fields.push(...(KEY_FIELDS[asset.typeOfAsset] ?? []).slice(0, 3));
  const [series, baselines, workOrders, pms, parts, similar] = await Promise.all([
    fields.length
      ? seriesFor(companyId, [assetId], fields, { start: new Date(now - 2 * HOUR), stop: now, every: '1m' })
      : { series: [] },
    baselineFor(companyId),
    Model('workorders')
      .find({ companyId, asset: asset._id, deleted: { $ne: true } })
      .sort({ createdAt: -1 })
      .limit(5)
      .select('workOrderId name category workStatus priority createdAt trackProcess.completedAt')
      .lean(),
    Model('preventivemaintenances')
      .find({ companyId, assetAllocation: asset._id, deleted: { $ne: true } })
      .select('name lastMaintenanceDate nextGenerationDate')
      .lean(),
    Model('spareparts')
      .find({ companyId, assignedAsset: asset._id, deleted: { $ne: true } })
      .select('name partNumber minimumQuantity criticality')
      .lean(),
    Model('anomalies')
      .find({
        companyId,
        _id: { $ne: anomaly._id },
        detectedAt: { $gte: new Date(now - 30 * DAY) },
        $or: [{ assetId: asset._id }, { type: anomaly.type }],
        deleted: { $ne: true },
      })
      .sort({ detectedAt: -1 })
      .limit(8)
      .select('anomalyCode assetId type severity state detectedAt summary workOrderId')
      .lean(),
  ]);
  // A work order made from an anomaly links back through its anomalyId, not always via workOrderId.
  const linked = similar.length
    ? new Set(
        (
          await Model('workorders').distinct('anomalyId', {
            companyId,
            anomalyId: { $in: similar.map((s) => s._id) },
            deleted: { $ne: true },
          })
        ).map(String),
      )
    : new Set();
  const stock = parts.length
    ? await stockOf(
        companyId,
        parts.map((p) => p._id),
      )
    : new Map();
  const status = asset.assetStatus ?? 'OFF';
  return {
    anomaly: {
      code: anomaly.anomalyCode,
      type: anomaly.type,
      severity: anomaly.severity,
      detectedAt: anomaly.detectedAt,
      summary: anomaly.summary,
      explanation: anomaly.explanation,
      parameters: (anomaly.parameters ?? []).map((p) => ({ ...p, label: fieldLabel(p.field) })),
    },
    asset: {
      name: asset.name,
      tag: asset.assetTag ?? null,
      type: asset.typeOfAsset,
      status,
      criticality: asset.criticality,
      manufacturer: asset.manufacturer ?? null,
      model: asset.modelOfAsset ?? null,
      installationDate: asset.installationDate ?? null,
      healthScore: asset.healthScore ?? null,
    },
    fields,
    series: series.series.map((s) => ({ field: s.field, measurement: s.measurement, points: s.points })),
    baselines: fields.map((field) => {
      const row =
        baselines.get(baselineKey(assetId, field, status)) ??
        baselines.get(baselineKey(assetId, field, 'Running'));
      return row
        ? {
            field,
            status: row.status,
            mean: round(row.mean),
            std: round(row.std),
            p5: round(row.p5),
            p95: round(row.p95),
          }
        : { field, status, mean: null };
    }),
    workOrders: workOrders.map((w) => ({
      code: w.workOrderId,
      name: w.name,
      category: w.category,
      status: w.workStatus,
      priority: w.priority,
      createdAt: w.createdAt,
      completedAt: w.trackProcess?.completedAt ?? null,
    })),
    preventiveMaintenance: pms.map((p) => ({
      name: p.name,
      last: p.lastMaintenanceDate ?? null,
      next: p.nextGenerationDate ?? null,
    })),
    spareParts: parts.map((p) => ({
      name: p.name,
      partNumber: p.partNumber ?? null,
      inStock: stock.get(String(p._id)) ?? 0,
      minimum: p.minimumQuantity ?? 0,
    })),
    similarAnomalies: similar.map((s) => ({
      code: s.anomalyCode,
      sameAsset: String(s.assetId) === assetId,
      type: s.type,
      severity: s.severity,
      state: s.state,
      detectedAt: s.detectedAt,
      summary: s.summary,
      hadWorkOrder: Boolean(s.workOrderId) || linked.has(String(s._id)),
    })),
  };
};

/** Runs one investigation, stores it on the anomaly and returns it. */
export const investigateAnomaly = async (companyId, anomalyId) => {
  const anomaly = await Model('anomalies')
    .findOne({ _id: anomalyId, companyId, deleted: { $ne: true } })
    .lean();
  if (!anomaly) throw notFound('Anomaly not found');
  const now = new Date();
  const evidence = await buildEvidence(companyId, anomaly, { now });
  const forPrompt = {
    ...evidence,
    series: evidence.series.map((s) => ({ ...s, points: downsample(s.points) })),
  };
  const answer = await generate({
    tier: 'background',
    purpose: 'investigation',
    companyId,
    system: SYSTEM_PROMPT,
    contents: `Evidence pack (series points are [time UTC, 5-minute mean]):\n${JSON.stringify(forPrompt)}`,
    schema: INVESTIGATION_SCHEMA,
    mockInput: evidence,
  });
  const investigation = {
    ...(answer.json ?? {}),
    model: answer.model,
    mock: Boolean(answer.mock),
    at: now,
    evidence: { fields: evidence.fields, series: evidence.series },
  };
  await Model('anomalies').updateOne({ _id: anomaly._id }, { $set: { investigation } });
  const updated = await Model('anomalies').findById(anomaly._id).lean();
  publish(companyId, 'anomaly', { anomaly: updated, change: 'investigated' }, plantAudience(updated.plantId));
  return investigation;
};
