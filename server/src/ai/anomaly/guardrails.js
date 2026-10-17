import { ANOMALY_TYPES } from '../../modules/defs/maintenance.js';

/**
 * Pure checks on Gemini's anomaly decisions before anything is written: the model may only talk
 * about assets and fields it was shown, with numbers that match the table.
 */

export const STATES = ['normal', 'watch', 'anomalous'];
export const SEVERITIES = ['info', 'warning', 'critical'];
/** How far `observed` may stray from the table's last value or 10-minute mean. */
export const OBSERVED_TOLERANCE = 0.15;
/** An anomaly the model cannot name a type for needs at least this confidence. */
export const OTHER_MIN_CONFIDENCE = 0.8;

const clamp = (value, min, max, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

const near = (observed, reference) =>
  reference != null &&
  Math.abs(observed - reference) <= OBSERVED_TOLERANCE * Math.max(Math.abs(reference), 1e-9);

/** True when the reported observation matches the field's last value or window mean within 15 %. */
export const observedMatches = (observed, field) =>
  Number.isFinite(observed) && (near(observed, field.last) || near(observed, field.mean));

const cleanText = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
/** Tag fields (likelyCauses, recommendedActions) take at most 120 characters per item. */
const cleanList = (value, max = 8) =>
  Array.isArray(value)
    ? value
        .map((v) => cleanText(v, 120))
        .filter(Boolean)
        .slice(0, max)
    : [];

/** "Vibration (mm/s)" → "vibration": the model may quote a field by key, label or with its unit. */
const fieldName = (name) =>
  String(name ?? '')
    .replace(/\s*\([^)]*\)\s*$/, '')
    .trim()
    .toLowerCase();

const cleanParameter = (param, fieldsByName, drop) => {
  const field = fieldsByName.get(fieldName(param?.field));
  if (!field) return drop('unknown_field', { field: param?.field });
  const observed = Number(param.observed);
  if (!observedMatches(observed, field)) {
    return drop('observed_mismatch', { field: field.field, observed, last: field.last, mean: field.mean });
  }
  const expected = Number(param.expected);
  return {
    field: field.field,
    unit: field.unit ?? undefined,
    observed,
    expected: Number.isFinite(expected) ? expected : (field.baseline?.mean ?? undefined),
    deviation: cleanText(param.deviation, 40) || undefined,
  };
};

const cleanAnomaly = (anomaly, fieldsByName, drop) => {
  const parameters = (Array.isArray(anomaly?.parameters) ? anomaly.parameters : [])
    .map((p) => cleanParameter(p, fieldsByName, drop))
    .filter(Boolean);
  if (!parameters.length) return drop('no_parameters');
  return {
    type: ANOMALY_TYPES.includes(anomaly.type) ? anomaly.type : 'other',
    severity: SEVERITIES.includes(anomaly.severity) ? anomaly.severity : 'info',
    confidence: clamp(anomaly.confidence, 0, 1, 0.5),
    parameters,
    explanation: cleanText(anomaly.explanation, 2000),
    likelyCauses: cleanList(anomaly.likelyCauses),
    recommendedActions: cleanList(anomaly.recommendedActions),
    urgencyHours: clamp(anomaly.urgencyHours, 0, 24 * 365, 24),
  };
};

/**
 * Calibration: an `info` finding is a watch note, not an anomaly (it stays in the asset's health
 * summary), and an untyped one (`other`) must be confident.
 */
const opensAnomaly = (a) =>
  a.severity === 'info'
    ? 'info_severity'
    : a.type === 'other' && a.confidence < OTHER_MIN_CONFIDENCE
      ? 'unconfident_other'
      : null;

/**
 * Filters a decision set against the features it was made from. Returns { assets, dropped }: only known
 * assets, grounded parameters, no empty, info-only or unconfident untyped anomalies, clamped scores and
 * a state consistent with the anomalies left (with anomalies at least `watch`, without at most `watch`).
 * `dropped` says what was refused and why (`unknown_asset`, `unknown_field`, `observed_mismatch`,
 * `no_parameters`, `info_severity`, `unconfident_other`), so a silent miss can be read back.
 */
export const applyGuardrails = (response, features) => {
  const known = new Map(features.map((f) => [f.assetId, f]));
  const seen = new Set();
  const assets = [];
  const dropped = [];
  for (const decision of Array.isArray(response?.assets) ? response.assets : []) {
    const feature = known.get(decision?.assetId);
    if (!feature || seen.has(feature.assetId)) {
      dropped.push({ assetId: String(decision?.assetId ?? ''), reason: 'unknown_asset' });
      continue;
    }
    seen.add(feature.assetId);
    const fieldsByName = new Map(
      feature.fields
        .flatMap((f) => [
          [fieldName(f.field), f],
          [fieldName(f.label), f],
        ])
        .filter(([name]) => name), // an unnamed parameter must not match an unlabelled field
    );
    // The rejection rate is a derived figure the model may cite like a field.
    if (feature.rejectionRate?.recentPct != null) {
      const { recentPct, baselinePct } = feature.rejectionRate;
      const rate = {
        field: 'rejectionRate',
        unit: '%',
        last: recentPct,
        mean: recentPct,
        baseline: { mean: baselinePct },
      };
      fieldsByName.set('rejectionrate', rate);
      fieldsByName.set('rejection rate', rate);
    }
    const anomalies = [];
    for (const raw of Array.isArray(decision.anomalies) ? decision.anomalies : []) {
      const drop = (reason, extra = {}) => {
        dropped.push({
          assetId: feature.assetId,
          type: raw?.type,
          severity: raw?.severity,
          reason,
          ...extra,
        });
        return null;
      };
      const a = cleanAnomaly(raw, fieldsByName, drop);
      if (!a) continue;
      const refused = opensAnomaly(a);
      if (refused) drop(refused, { confidence: a.confidence });
      else anomalies.push(a);
    }
    let state = STATES.includes(decision.state) ? decision.state : 'watch';
    if (anomalies.length && state === 'normal') state = 'watch';
    if (!anomalies.length && state === 'anomalous') state = 'watch';
    assets.push({
      assetId: feature.assetId,
      healthScore: Math.round(clamp(decision.healthScore, 0, 100, state === 'normal' ? 90 : 60)),
      state,
      summary: cleanText(decision.summary, 300),
      anomalies,
    });
  }
  return { assets, dropped };
};
