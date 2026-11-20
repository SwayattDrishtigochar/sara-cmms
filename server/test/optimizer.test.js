import { describe, expect, it } from 'vitest';
import { toJsonSchema } from '../src/agent/declarations.js';
import { mockGenerate } from '../src/ai/mock.js';
import { applyGuardrails, NOTHING_TO_GAIN, OPTIMIZER_SCHEMA } from '../src/optimizer/guardrails.js';

// Pure functions only: no database, InfluxDB or Gemini.
const param = (field, current, normalMin, normalMax) => ({
  field,
  label: field,
  unit: null,
  current,
  normalMin,
  normalMax,
});
const SCREW = param('screwSpeed', 110, 90, 130);
const ZONE3 = param('barrelTempZone3', 255, 240, 272);
const PRESSURE = param('injectionPressure', 950, 850, 1050);
const CLAMP = param('clampForce', 1800, 1700, 1900);
const HOLD = param('holdPressure', 600, 500, 700);
const OIL = param('oilTempPv', null, 35, 55); // no reading
const IMM = [SCREW, ZONE3, PRESSURE, CLAMP, HOLD, OIL];

const rec = (field, recommended, effectOnCycleTimePct = -2) => ({
  field,
  recommended,
  effectOnCycleTimePct,
  reason: 'reason',
  risk: 'risk',
});
const run = (recommendations, opts = {}) =>
  applyGuardrails(
    { headline: 'Faster screw', recommendations, notes: ['tip'] },
    { parameters: IMM, cycleTimeSec: 30, partsPerShot: 2, ...opts },
  );

describe('optimizer guardrails', () => {
  it('clamps a value into its band and keeps only that share of the effect', () => {
    const [r] = run([rec('screwSpeed', 150, -5)]).recommendations;
    expect(r).toMatchObject({
      field: 'screwSpeed',
      current: 110,
      recommended: 130,
      normalMin: 90,
      normalMax: 130,
      effectOnCycleTimePct: -2.5,
    });
  });

  it('drops unknown, unread, invalid, duplicate, tiny and reversed changes', () => {
    const out = run([
      rec('vibration', 3), // not a spec field
      rec('oilTempPv', 50), // no current reading
      rec('screwSpeed', 'fast'),
      rec('screwSpeed', 118),
      rec('screwSpeed', 120), // duplicate
      rec('barrelTempZone3', 255.1), // under 0.5 % of the band
    ]);
    expect(out.recommendations.map((r) => [r.field, r.recommended])).toEqual([['screwSpeed', 118]]);
    // Above the band, a request to go higher would come back as a cut: dropped, not flipped.
    const high = applyGuardrails(
      { recommendations: [rec('screwSpeed', 140)] },
      { parameters: [{ ...SCREW, current: 135 }] },
    );
    expect(high.recommendations).toEqual([]);
  });

  it('keeps at most 4 changes, clamps each effect to [-8, 0] and the total to -15 %', () => {
    const out = run([
      rec('screwSpeed', 120, -20),
      rec('barrelTempZone3', 260, 3),
      rec('injectionPressure', 1000, -8),
      rec('clampForce', 1850, -6),
      rec('holdPressure', 650, -4),
    ]);
    expect(out.recommendations.map((r) => r.effectOnCycleTimePct)).toEqual([-8, 0, -8, -6]);
    expect(out.predicted.cycleTimeChangePct).toBe(-15);
    expect(out.predicted.cycleTimeSec).toBe(25.5);
  });

  it('computes the predicted cycle time and parts in code', () => {
    const out = run([rec('screwSpeed', 118, -3), rec('barrelTempZone3', 259, -2)]);
    expect(out.headline).toBe('Faster screw');
    expect(out.notes).toEqual(['tip']);
    expect(out.current).toEqual({ cycleTimeSec: 30, partsPerHour: 240 });
    expect(out.predicted).toEqual({
      cycleTimeSec: 28.5,
      partsPerHour: 252.6,
      cycleTimeChangePct: -5,
      extraPartsPerShift: 101,
    });
  });

  it('says the machine is close to its best when nothing survives', () => {
    const out = run([rec('vibration', 2)]);
    expect(out.headline).toBe(NOTHING_TO_GAIN);
    expect(out.recommendations).toEqual([]);
    expect(out.predicted).toEqual({
      cycleTimeSec: 30,
      partsPerHour: 240,
      cycleTimeChangePct: 0,
      extraPartsPerShift: 0,
    });
    // A broken answer and no cycle time: no numbers to show.
    const empty = applyGuardrails('not json', { parameters: [SCREW] });
    expect(empty.headline).toBe(NOTHING_TO_GAIN);
    expect(empty.predicted).toEqual({
      cycleTimeSec: null,
      partsPerHour: null,
      cycleTimeChangePct: 0,
      extraPartsPerShift: null,
    });
  });
});

describe('optimizer mock', () => {
  const TYPES = {
    'Injection Moulding Machine': [SCREW, ZONE3, PRESSURE, CLAMP],
    'Power Press': [param('press_speed', 40, 30, 50), param('clutch_air_pressure', 5.5, 5, 6.2)],
    'CNC Machine': [param('spindleSpeed', 3500, 3000, 4000), param('axisLoadX', 30, 10, 60)],
  };

  it.each(Object.entries(TYPES))(
    'suggests changes for %s that survive the guardrails',
    (type, parameters) => {
      const input = {
        machine: { name: 'M-01', type, status: 'Running' },
        job: null,
        cycleTimeSec: 30,
        parameters,
      };
      const { json } = mockGenerate({
        purpose: 'optimizer',
        mockInput: input,
        schema: toJsonSchema(OPTIMIZER_SCHEMA),
      });
      expect(OPTIMIZER_SCHEMA.safeParse(json).success).toBe(true);
      const out = applyGuardrails(json, { parameters, cycleTimeSec: 30 });
      expect(out.recommendations.length).toBeGreaterThan(0);
      expect(out.recommendations).toHaveLength(json.recommendations.length);
      for (const r of out.recommendations) {
        expect(r.recommended).toBeGreaterThanOrEqual(r.normalMin);
        expect(r.recommended).toBeLessThanOrEqual(r.normalMax);
        expect(r.effectOnCycleTimePct).toBeLessThan(0);
        expect(r.reason && r.risk).toBeTruthy();
      }
      expect(out.headline).not.toBe(NOTHING_TO_GAIN);
      expect(out.predicted.cycleTimeSec).toBeLessThan(30);
      expect(out.predicted.extraPartsPerShift).toBeGreaterThan(0);
    },
  );
});
