import { getModule } from '../../modules/registry.js';

/**
 * Ground truth scoring for the superadmin: did the AI catch an injected fault? Adds `detection` to
 * each simulator injection: the first anomaly on the same asset detected after it started whose
 * parameters touch the fields the scenario affects. The AI itself never reads injections.
 */

/** An anomaly this long after an injection ended (or was cleared) no longer counts as catching it. */
const GRACE_MS = 30 * 60_000;
/** Derived figures an anomaly may cite, and the raw field a scenario names for them. */
const FIELD_ALIAS = { rejectionRate: 'rejectedCount' };

export const attachDetections = async (simEvents) => {
  if (!simEvents.length) return [];
  const anomalies = await getModule('anomalies')
    .Model.find({
      companyId: { $in: [...new Set(simEvents.map((e) => String(e.companyId)))] },
      assetId: { $in: [...new Set(simEvents.map((e) => String(e.assetId)))] },
      detectedAt: { $gte: new Date(Math.min(...simEvents.map((e) => new Date(e.startedAt).getTime()))) },
      deleted: { $ne: true },
    })
    .select('companyId assetId anomalyCode detectedAt parameters')
    .sort({ detectedAt: 1 })
    .lean();
  return simEvents.map((event) => {
    const startedAt = new Date(event.startedAt).getTime();
    const until = new Date(event.clearedAt ?? event.endsAt ?? Number.POSITIVE_INFINITY).getTime() + GRACE_MS;
    const affects = new Set([...(event.affects ?? []), ...(event.field ? [event.field] : [])]);
    const touched = (a) =>
      (a.parameters ?? [])
        .map((p) => p.field)
        .filter((f) => !affects.size || affects.has(f) || affects.has(FIELD_ALIAS[f]));
    const hit = anomalies.find(
      (a) =>
        String(a.companyId) === String(event.companyId) &&
        String(a.assetId) === String(event.assetId) &&
        a.detectedAt >= startedAt &&
        a.detectedAt <= until &&
        touched(a).length > 0,
    );
    return {
      ...event,
      detection: hit
        ? {
            anomalyId: String(hit._id),
            code: hit.anomalyCode,
            detectedAt: hit.detectedAt,
            latencySec: Math.round((new Date(hit.detectedAt).getTime() - startedAt) / 1000),
            matchedFields: [...new Set(touched(hit))],
          }
        : null,
    };
  });
};
