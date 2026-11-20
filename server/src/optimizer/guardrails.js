import { z } from 'zod';

/**
 * Pure side of the production optimizer: the model's answer schema and the guardrails that make it safe to
 * show. Every number people see (band-clamped values, effects, predicted cycle and parts) is computed here.
 */

export const OPTIMIZER_SCHEMA = z.object({
  headline: z.string().max(160),
  recommendations: z
    .array(
      z.object({
        field: z.string(),
        recommended: z.number(),
        effectOnCycleTimePct: z
          .number()
          .describe('Estimated cycle time change from this one change, in %; negative = faster'),
        reason: z.string().max(240),
        risk: z.string().max(200),
      }),
    )
    .max(4),
  notes: z.array(z.string().max(200)).max(3),
});

export const SHIFT_HOURS = 8;
export const MAX_CHANGES = 4;
export const NOTHING_TO_GAIN = 'Already running close to its best settings';
/** A change smaller than this share of the normal band is noise, not a recommendation. */
const MIN_STEP = 0.005;
const EFFECT_RANGE = [-8, 0];
const TOTAL_RANGE = [-15, 0];

const clamp = (n, [min, max]) => Math.min(max, Math.max(min, n));
const round = (n, dp = 1) => Number(n.toFixed(dp));
const text = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

/** Display precision from the band width: 850–1050 bar → 979, 90–130 rpm → 117.6, 5–6.2 bar → 5.55. */
export const roundTo = (value, band) => round(value, band >= 50 ? 0 : band >= 5 ? 1 : 2);

/**
 * The model's answer (untrusted JSON) cut down to safe changes: known fields with a current value, no
 * duplicates, at most MAX_CHANGES, each value clamped into its normal band and each effect into [-8, 0] %
 * (a change the band cut back keeps only that share of its effect); the total is capped at -15 %.
 * @param parameters [{ field, label, unit, current, normalMin, normalMax }]
 */
export const applyGuardrails = (ai, { parameters, cycleTimeSec = null, partsPerShot = 1 }) => {
  const known = new Map(parameters.filter((p) => p.current != null).map((p) => [p.field, p]));
  const recommendations = [];
  for (const r of Array.isArray(ai?.recommendations) ? ai.recommendations : []) {
    if (recommendations.length >= MAX_CHANGES) break;
    const p = known.get(r?.field);
    const wanted = Number(r?.recommended);
    if (!p || !Number.isFinite(wanted) || recommendations.some((x) => x.field === p.field)) continue;
    const band = p.normalMax - p.normalMin;
    const recommended = roundTo(clamp(wanted, [p.normalMin, p.normalMax]), band);
    const share = (recommended - p.current) / (wanted - p.current);
    if (Math.abs(recommended - p.current) < MIN_STEP * band || !(share > 0)) continue;
    const effect = Number(r.effectOnCycleTimePct) || 0;
    recommendations.push({
      field: p.field,
      label: p.label ?? p.field,
      unit: p.unit ?? null,
      current: p.current,
      recommended,
      normalMin: p.normalMin,
      normalMax: p.normalMax,
      effectOnCycleTimePct: round(clamp(effect * Math.min(1, share), EFFECT_RANGE), 1),
      reason: text(r.reason, 240),
      risk: text(r.risk, 200),
    });
  }

  const total = round(
    clamp(
      recommendations.reduce((sum, r) => sum + r.effectOnCycleTimePct, 0),
      TOTAL_RANGE,
    ),
    1,
  );
  const cycle = cycleTimeSec > 0 ? round(cycleTimeSec, 1) : null;
  const predicted = cycle && round(cycle * (1 + total / 100), 1);
  const perHour = (sec) => (sec ? (3600 / sec) * partsPerShot : null);
  const perHourShown = (sec) => (sec ? round(perHour(sec), 1) : null);
  return {
    headline: recommendations.length
      ? text(ai?.headline, 160) || 'Suggested settings to shorten the cycle'
      : NOTHING_TO_GAIN,
    recommendations,
    notes: (Array.isArray(ai?.notes) ? ai.notes : [])
      .map((n) => text(n, 200))
      .filter(Boolean)
      .slice(0, 3),
    current: { cycleTimeSec: cycle, partsPerHour: perHourShown(cycle) },
    predicted: {
      cycleTimeSec: predicted,
      partsPerHour: perHourShown(predicted),
      cycleTimeChangePct: total,
      extraPartsPerShift: cycle ? Math.round((perHour(predicted) - perHour(cycle)) * SHIFT_HOURS) : null,
    },
  };
};
