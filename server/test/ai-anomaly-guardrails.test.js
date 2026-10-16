import { describe, expect, it, vi } from 'vitest';
import {
  MIN_HISTORY,
  noiseFloor,
  REL_FLOOR,
  resolveBaseline,
  UNIT_FLOOR,
  unitOf,
} from '../src/ai/anomaly/baselines.js';
import { fieldFeatures, rejectionCounts, rejectionRate, slopePerHour } from '../src/ai/anomaly/features.js';
import { applyGuardrails, observedMatches } from '../src/ai/anomaly/guardrails.js';
import {
  buildPrompt,
  dueAssets,
  evidenceOf,
  RESPONSE_SCHEMA,
  rejectionLine,
} from '../src/ai/anomaly/watch.js';

// Pure functions only: the Gemini plumbing is never called here.
vi.mock('../src/ai/gemini.js', () => ({ generate: vi.fn() }));
vi.mock('../src/ai/settings.js', () => ({ getAiSettings: vi.fn() }));

const MIN = 60_000;
const history = { mean: 48, std: 0.4, p5: 47.2, p95: 48.8, source: 'history' };
const rate = {
  windowStart: '2026-10-16T08:30:00.000Z',
  windowHours: 3.5,
  parts: 2000,
  rejected: 42,
  recentPct: 2.1,
  baselinePct: 1.8,
  baselineSource: 'history',
  z: 1,
  enoughParts: true,
};
const field = (name, over = {}) => ({
  measurement: 'machineParams',
  field: name,
  unit: '°C',
  last: 50,
  mean: 49,
  min: 48,
  max: 51,
  std: 0.5,
  slopePerHour: 1,
  n: 10,
  baseline: history,
  z: 2.5,
  band: null,
  spikes: 0,
  flatline: false,
  flags: [],
  ...over,
});
const feature = (over = {}) => ({
  assetId: 'a1',
  name: 'IMM 1',
  tag: 'IMM-01',
  type: 'Injection Moulding Machine',
  plantId: 'p1',
  status: 'Running',
  statusSince: new Date(Date.now() - 30 * MIN).toISOString(),
  inShift: true,
  job: { jobCardId: 'JC-12', toolName: 'Housing-A Mould #1' },
  transition: false,
  fields: [field('oilTempPv'), field('vibration', { unit: 'mm/s', last: 2.2, mean: 2.1 })],
  rejectionRate: rate,
  idlePowerRatio: null,
  flags: [],
  ...over,
});
const anomaly = (over = {}) => ({
  type: 'temperature_high',
  severity: 'warning',
  confidence: 0.8,
  parameters: [{ field: 'oilTempPv', observed: 50, expected: 48, deviation: '+5σ' }],
  explanation: 'Oil temperature is well above its baseline.',
  likelyCauses: ['Cooler fouled'],
  recommendedActions: ['Check the oil cooler'],
  urgencyHours: 12,
  ...over,
});
const decision = (over = {}) => ({
  assetId: 'a1',
  healthScore: 62,
  state: 'anomalous',
  summary: 'Oil running hot.',
  anomalies: [anomaly()],
  ...over,
});

describe('guardrails', () => {
  const features = [feature()];

  it('drops assets that were not in the input and repeated decisions', () => {
    const out = applyGuardrails(
      { assets: [decision({ assetId: 'ghost' }), decision(), decision()] },
      features,
    );
    expect(out.assets).toHaveLength(1);
    expect(out.assets[0].assetId).toBe('a1');
  });

  it('drops parameters of unknown fields or with an observed value off by more than 15 %', () => {
    const out = applyGuardrails(
      {
        assets: [
          decision({
            anomalies: [
              anomaly({
                parameters: [
                  { field: 'spindleLoad', observed: 50, expected: 48 }, // not on this asset
                  { field: 'oilTempPv', observed: 70, expected: 48 }, // 40 % off last and mean
                  { field: 'oilTempPv', observed: 56, expected: 48 }, // 12 % off the last value
                  { field: 'vibration', observed: 2.15, expected: 2.0 },
                ],
              }),
            ],
          }),
        ],
      },
      features,
    );
    const [a] = out.assets[0].anomalies;
    expect(a.parameters.map((p) => [p.field, p.observed])).toEqual([
      ['oilTempPv', 56],
      ['vibration', 2.15],
    ]);
    expect(a.parameters[0].unit).toBe('°C');
  });

  it('accepts the rejection rate as a citable figure', () => {
    const out = applyGuardrails(
      {
        assets: [
          decision({
            anomalies: [
              anomaly({
                type: 'quality_degradation',
                parameters: [{ field: 'rejectionRate', observed: 2.1, expected: 1.8, deviation: '+0.3 pts' }],
              }),
            ],
          }),
        ],
      },
      features,
    );
    expect(out.assets[0].anomalies[0].parameters).toEqual([
      { field: 'rejectionRate', unit: '%', observed: 2.1, expected: 1.8, deviation: '+0.3 pts' },
    ]);
    expect(
      applyGuardrails(
        {
          assets: [
            decision({ anomalies: [anomaly({ parameters: [{ field: 'rejectionRate', observed: 2.1 }] })] }),
          ],
        },
        [feature({ rejectionRate: null })],
      ).assets[0].anomalies,
    ).toEqual([]);
  });

  it('drops anomalies left without parameters and downgrades the state to watch', () => {
    const out = applyGuardrails(
      {
        assets: [
          decision({
            anomalies: [
              anomaly({ parameters: [{ field: 'nope', observed: 1 }] }),
              anomaly({ parameters: [] }),
            ],
          }),
        ],
      },
      features,
    );
    expect(out.assets[0].anomalies).toEqual([]);
    expect(out.assets[0].state).toBe('watch');
  });

  it('lifts normal to watch when anomalies remain', () => {
    const out = applyGuardrails({ assets: [decision({ state: 'normal' })] }, features);
    expect(out.assets[0].state).toBe('watch');
  });

  it('clamps scores, confidence and urgency, and maps unknown enums', () => {
    const out = applyGuardrails(
      {
        assets: [
          decision({
            healthScore: 140,
            state: 'broken',
            anomalies: [anomaly({ type: 'melting', severity: 'warning', confidence: 7, urgencyHours: -3 })],
          }),
          { assetId: 'a1', healthScore: -5 },
        ],
      },
      [feature(), feature({ assetId: 'a2' })],
    );
    const [asset] = out.assets;
    expect(asset.healthScore).toBe(100);
    expect(asset.state).toBe('watch'); // unknown state, with anomalies left
    expect(asset.anomalies[0]).toMatchObject({
      type: 'other',
      severity: 'warning',
      confidence: 1,
      urgencyHours: 0,
    });
    const low = applyGuardrails({ assets: [{ assetId: 'a2', healthScore: -5, state: 'normal' }] }, [
      feature({ assetId: 'a2' }),
    ]);
    expect(low.assets[0]).toMatchObject({ healthScore: 0, state: 'normal', anomalies: [] });
  });

  it('keeps info findings and unconfident untyped ones out of the anomalies (watch notes only)', () => {
    const out = applyGuardrails(
      {
        assets: [
          decision({
            anomalies: [
              anomaly({ severity: 'info' }),
              anomaly({ severity: 'fatal' }), // unknown → info
              anomaly({ type: 'other', confidence: 0.6 }),
            ],
          }),
        ],
      },
      features,
    );
    expect(out.assets[0]).toMatchObject({ state: 'watch', anomalies: [], summary: 'Oil running hot.' });
    const sure = applyGuardrails(
      { assets: [decision({ anomalies: [anomaly({ type: 'other', confidence: 0.85 })] })] },
      features,
    );
    expect(sure.assets[0]).toMatchObject({ state: 'anomalous', anomalies: [{ type: 'other' }] });
  });

  it('tolerates garbage', () => {
    expect(applyGuardrails(null, features)).toEqual({ assets: [] });
    expect(applyGuardrails({ assets: 'x' }, features)).toEqual({ assets: [] });
    expect(observedMatches(Number.NaN, field('x'))).toBe(false);
    expect(observedMatches(49.5, field('x', { last: 60, mean: 49 }))).toBe(true);
  });
});

describe('due assets', () => {
  const now = Date.now();
  const quiet = (assetId, reviewedMinAgo) => [assetId, now - reviewedMinAgo * MIN];
  const hot = (assetId, flags = ['z']) =>
    feature({
      assetId,
      flags,
      fields: [field('oilTempPv', { flags }), field('vibration', { unit: 'mm/s', last: 2.2, mean: 2.1 })],
    });
  const features = [
    hot('newly'), // oilTempPv:z fired since its last review
    hot('judged'), // the same evidence was judged a minute ago
    hot('restarted'), // flagged, but this process never reviewed it (a restart)
    { ...hot('healthy'), healthScore: 95 }, // the same after a restart, but last judged healthy: the flag is new
    hot('worse', ['z', 'band']),
    feature({ assetId: 'stale' }),
    feature({ assetId: 'fresh' }),
    feature({ assetId: 'never' }),
  ];
  const base = {
    lastReviewedAt: new Map(
      ['newly', 'judged', 'restarted', 'healthy', 'worse']
        .map((id) => quiet(id, 1))
        .concat([quiet('stale', 11), quiet('fresh', 4)]),
    ),
    lastEvidence: new Map([
      ['newly', new Set()],
      ['judged', new Set(['oilTempPv:z'])],
      ['worse', new Set(['oilTempPv:z'])],
    ]),
    quietIntervalMin: 10,
    now,
  };
  const ids = (list) => list.map((f) => f.assetId);

  it('reviews assets with new evidence and quiet ones on the interval, not the same evidence every tick', () => {
    expect(ids(dueAssets(features, base))).toEqual(['newly', 'healthy', 'worse', 'stale', 'never']);
    expect(evidenceOf(features[4])).toEqual(['oilTempPv:z', 'oilTempPv:band']);
    expect(evidenceOf(feature({ flags: ['rejects'] }))).toEqual(['rejects']);
  });

  it('reviews everything when forced or when alwaysAskAi is on', () => {
    expect(ids(dueAssets(features, { ...base, force: true }))).toHaveLength(8);
    expect(ids(dueAssets(features, { ...base, alwaysAskAi: true }))).toHaveLength(8);
  });
});

describe('feature maths', () => {
  const points = (values, step = MIN) => values.map((v, i) => [i * step, v]);

  it('computes a least-squares slope per hour', () => {
    expect(slopePerHour(points([10, 11, 12, 13, 14]))).toBeCloseTo(60, 6);
    expect(slopePerHour(points([5, 5, 5]))).toBe(0);
    expect(slopePerHour([[0, 1]])).toBe(0);
  });

  it('flags a high z and a value above the widened band', () => {
    const f = fieldFeatures({
      measurement: 'machineParams',
      field: 'oilTempPv',
      points: points([51, 51.5, 52, 52.5, 53]),
      baseline: history,
      status: 'Running',
      transition: false,
    });
    expect(f.z).toBeCloseTo(10, 0);
    expect(f.band).toBe('above');
    expect(f.slopePerHour).toBeCloseTo(30, 3);
    expect(f.spikes).toBe(5); // every minute sits more than 4σ out
    expect(f.flags).toEqual(['z', 'band', 'spikes']);
    expect(f.baseline).toMatchObject({ mean: 48, source: 'history' });
  });

  it('flags a frozen value while running, but not during a transition', () => {
    const frozen = {
      measurement: 'machineParams',
      field: 'vibration',
      points: points([2.2, 2.2, 2.2, 2.2, 2.2]),
      baseline: { mean: 2.2, std: 0.15, p5: 1.9, p95: 2.5, source: 'history' },
      status: 'Running',
    };
    expect(fieldFeatures({ ...frozen, transition: false })).toMatchObject({
      flatline: true,
      flags: ['flatline'],
    });
    expect(fieldFeatures({ ...frozen, transition: true }).flags).toEqual([]);
    expect(fieldFeatures({ ...frozen, status: 'Idle', transition: false }).flatline).toBe(false);
  });

  it('counts spikes beyond 4σ (one is a blip, two a pattern) and copes without a baseline', () => {
    const spiky = (values) =>
      fieldFeatures({
        measurement: 'machineParams',
        field: 'x',
        points: points(values),
        baseline: history,
        status: 'Running',
        transition: false,
      });
    expect(spiky([48, 48, 60, 48])).toMatchObject({ spikes: 1 });
    expect(spiky([48, 48, 60, 48]).flags).not.toContain('spikes');
    expect(spiky([48, 60, 60, 48]).flags).toContain('spikes');
    const bare = fieldFeatures({
      measurement: 'machineParams',
      field: 'x',
      points: points([1, 2]),
      baseline: null,
      status: 'Running',
      transition: false,
    });
    expect(bare).toMatchObject({
      z: null,
      band: null,
      spikes: 0,
      flatline: false,
      flags: [],
      baseline: null,
    });
  });

  it('floors a constant history spread and judges the band on the window mean', () => {
    const constant = new Map([['a1|POWER TOTAL|Idle', { mean: 1.76, std: 0, p5: 1.76, p95: 1.76, n: 500 }]]);
    const baseline = resolveBaseline(constant, new Map(), {
      assetId: 'a1',
      type: 'IMM',
      field: 'POWER TOTAL',
      status: 'Idle',
    });
    expect(baseline).toMatchObject({ std: 0.05, spread: 0 }); // the kW floor beats 2.5 % of 1.76
    const idle = fieldFeatures({
      measurement: 'energy',
      field: 'POWER TOTAL',
      points: points([1.76, 1.761, 1.759, 1.762]),
      baseline,
      status: 'Idle',
      transition: false,
    });
    expect(Math.abs(idle.z)).toBeLessThan(1); // was 99 with a zero spread
    expect(idle.flags).toEqual([]);
    const oneHot = fieldFeatures({
      measurement: 'machineParams',
      field: 'oilTempPv',
      points: points([48, 48.1, 47.9, 48, 49.6]), // only the last (partial) minute is out of band
      baseline: history,
      status: 'Running',
      transition: false,
    });
    expect(oneHot.band).toBeNull();
  });

  describe('noise floor', () => {
    const imm = 'Injection Moulding Machine';
    const specs = new Map([
      [`${imm}|vibration`, { normalMin: 0, normalMax: 4.5, unit: 'mm/s' }],
      ['Power Press|oilTempPv', { normalMin: 30, normalMax: 58, unit: '°C' }],
    ]);
    // A near-flat simulated week: the 1-minute means barely move.
    const flat = (mean, std) => ({ mean, std, p5: mean - 2 * std, p95: mean + 2 * std, n: 2900 });
    const judge = (type, field, status, row, values) =>
      fieldFeatures({
        measurement: 'machineParams',
        field,
        points: points(values),
        baseline: resolveBaseline(new Map([[`a1|${field}|${status}`, row]]), specs, {
          assetId: 'a1',
          type,
          field,
          status,
        }),
        status,
        transition: false,
      });

    it('reads a ~5 % move on a flat history as noise, with or without a spec', () => {
      const pf = judge(imm, 'POWER FACTOR TOTAL', 'Idle', flat(0.75, 0.004), Array(10).fill(0.7875));
      expect(Math.abs(pf.z)).toBeLessThan(3);
      expect(pf.flags).toEqual([]);
      // Press 2 oil after a run: 42.5 against an idle 40 °C used to read +17σ.
      const oil = judge('Power Press', 'oilTempPv', 'Idle', flat(40, 0.14), Array(10).fill(42.5));
      expect(oil.baseline.std).toBeCloseTo(28 / 12, 3);
      expect(Math.abs(oil.z)).toBeLessThan(3);
      expect(oil.flags).toEqual([]);
    });

    it('still flags a bearing-wear-size vibration jump', () => {
      // bearing_wear at medium severity: vibration × (1 + 1.8 p²); at p = 0.7 that is 2.2 → 4.1 mm/s.
      const f = judge(imm, 'vibration', 'Running', flat(2.2, 0.04), [3.9, 4, 4.1, 4.1, 4.2]);
      expect(f.z).toBeGreaterThan(3);
      expect(f.flags).toContain('z');
      expect(f.baseline.std).toBeCloseTo(4.5 / 12, 3);
    });

    it('keeps the measured spread for flatlines: a constant setpoint is not a frozen sensor', () => {
      const setpoint = judge('Furnace', 'SET TEMP', 'Running', flat(620, 0), Array(6).fill(620));
      expect(setpoint.flatline).toBe(false);
      expect(setpoint.flags).toEqual([]);
      const stuck = judge(imm, 'vibration', 'Running', flat(2.2, 0.04), Array(6).fill(2.2));
      expect(stuck.flags).toEqual(['flatline']);
    });

    it('takes the unit floor from the energy catalogue when no spec names one', () => {
      expect(noiseFloor(0, undefined, unitOf(undefined, 'POWER TOTAL'))).toBe(UNIT_FLOOR.kW);
      expect(noiseFloor(620, { normalMin: 600, normalMax: 640 }, '°C')).toBeCloseTo(40 / 12, 6);
      expect(noiseFloor(10, undefined, null)).toBeCloseTo(10 * REL_FLOOR, 6);
    });
  });

  it('resolves a baseline from history, else the spec band while running', () => {
    const row = (n) => ({ mean: 48, std: 0.4, p5: 47, p95: 49, n });
    const map = new Map([
      ['a1|oilTempPv|Running', row(MIN_HISTORY)],
      ['a1|oilTempPv|Idle', row(MIN_HISTORY - 1)],
    ]);
    const specs = new Map([['IMM|oilTempPv', { normalMin: 35, normalMax: 55 }]]);
    const q = (status, field = 'oilTempPv') =>
      resolveBaseline(map, specs, { assetId: 'a1', type: 'IMM', field, status });
    expect(q('Running')).toMatchObject({ mean: 48, n: MIN_HISTORY, source: 'history' });
    expect(q('Idle')).toBeNull(); // too little history and the spec describes a running machine
    expect(
      resolveBaseline(new Map(), specs, {
        assetId: 'a1',
        type: 'IMM',
        field: 'oilTempPv',
        status: 'Running',
      }),
    ).toEqual({
      mean: 45,
      std: 20 / 6,
      spread: 20 / 6,
      p5: 35,
      p95: 55,
      n: 0,
      source: 'spec',
    });
    expect(q('Running', 'vibration')).toBeNull();
  });
});

describe('prompt and schema', () => {
  it('writes one compact table per asset', () => {
    const [oil, vibration] = feature().fields;
    const text = buildPrompt([
      feature({
        flags: ['z'],
        idlePowerRatio: 1.9,
        fields: [{ ...oil, label: 'Oil temperature' }, vibration],
      }),
    ]);
    expect(text).toContain('## IMM 1 (IMM-01) — Injection Moulding Machine — assetId a1');
    expect(text).toContain('status Running for 30 min · in shift · job JC-12 (Housing-A Mould #1)');
    expect(text).toContain(
      'rejection rate 2.1 % (42 of 2000 parts in the last 3.5 h), reference 1.8 % (7 days), z +1',
    );
    expect(text).toContain('screens fired: z');
    expect(text).toContain('field | label | last |');
    expect(text).toContain(
      'oilTempPv (°C) | Oil temperature | 50 | 49 | 48±0.4 (history) | +2.5 | +1 | – | –',
    );
  });

  it('says when the rejection rate rests on too few parts or has no reference', () => {
    expect(
      rejectionLine({ ...rate, parts: 120, rejected: 6, recentPct: 5, enoughParts: false, z: null }),
    ).toBe(
      'rejection rate 5 % (6 of 120 parts in the last 3.5 h), reference 1.8 % (7 days), too few parts to judge',
    );
    expect(rejectionLine({ ...rate, baselinePct: null, baselineSource: null, z: null })).toBe(
      'rejection rate 2.1 % (42 of 2000 parts in the last 3.5 h), no reference rate',
    );
    expect(rejectionLine({ ...rate, baselineSource: 'fleet' })).toContain('(machines of this type, 7 days)');
  });
});

describe('rejection rate', () => {
  const now = new Date('2026-10-16T11:00:00Z');
  const at = (iso) => new Date(`2026-10-16T${iso}:00Z`);
  const row = (iso, produced, day = '2026-10-16') => ({ date: new Date(`${day}T${iso}:00Z`), produced });
  const rej = (iso, n) => ({ createdAt: at(iso), rejectedCount: n });

  it('counts the last hour (longer while it holds too few parts), spreading shift rows evenly', () => {
    const rows = [row('00:30', 3000), row('08:30', 1000), row('16:30', 2500, '2026-10-15')];
    const rejections = [rej('09:00', 10), rej('10:30', 15), rej('02:00', 60)];
    // 1000 parts over the 2.5 h of the current shift: 400 in the last hour, enough on their own.
    expect(rejectionCounts(rows, rejections, now)).toEqual({
      windowStart: '2026-10-16T10:00:00.000Z',
      windowHours: 1,
      parts: 400,
      rejected: 15,
      refParts: 6100,
      refRejected: 70,
    });
    // 30 min into the shift the hour also takes half an hour of the previous row (3000 parts over 8 h).
    const early = rejectionCounts(rows, rejections, new Date('2026-10-16T09:00:00Z'));
    expect(early).toMatchObject({ windowStart: '2026-10-16T08:00:00.000Z', windowHours: 1, parts: 1188 });
    // A slow machine: the window grows until it holds MIN_PARTS parts.
    const slow = rejectionCounts([row('08:00', 225)], [rej('10:30', 2)], now);
    expect(slow).toMatchObject({ windowHours: 3, parts: 225, rejected: 2, refParts: 0 });
    expect(rejectionCounts([row('08:30', 10, '2026-10-14')], [], now)).toBeNull(); // nothing for a day
    expect(rejectionCounts([], [], now)).toBeNull();
  });

  it('gives counts and a binomial z, with the type as reference when the asset has little history', () => {
    const counts = {
      windowStart: 'w',
      windowHours: 2.5,
      parts: 1000,
      rejected: 25,
      refParts: 5500,
      refRejected: 60,
    };
    const own = rejectionRate(counts, { parts: 90_000, rejected: 900 });
    expect(own).toMatchObject({
      recentPct: 2.5,
      baselinePct: 1.09,
      baselineSource: 'history',
      enoughParts: true,
    });
    expect(own.z).toBeCloseTo((25 - 1000 * (60 / 5500)) / Math.sqrt(1000 * (60 / 5500) * (1 - 60 / 5500)), 1);
    const young = rejectionRate(
      { ...counts, refParts: 300, refRejected: 30 },
      { parts: 90_000, rejected: 2700 },
    );
    expect(young).toMatchObject({ baselinePct: 3, baselineSource: 'fleet', z: -0.9 });
    expect(rejectionRate({ ...counts, parts: 150, rejected: 9 }, null)).toMatchObject({
      recentPct: 6,
      baselinePct: 1.09,
      z: null,
      enoughParts: false,
    });
    expect(rejectionRate({ ...counts, refParts: 0, refRejected: 0 }, undefined)).toMatchObject({
      baselinePct: null,
      baselineSource: null,
      z: null,
    });
    expect(rejectionRate(null)).toBeNull();
  });

  it('asks for the contract response shape', () => {
    expect(RESPONSE_SCHEMA.$schema).toBeUndefined();
    const asset = RESPONSE_SCHEMA.properties.assets.items;
    expect(Object.keys(asset.properties)).toEqual([
      'assetId',
      'healthScore',
      'state',
      'summary',
      'anomalies',
    ]);
    expect(asset.properties.state.enum).toEqual(['normal', 'watch', 'anomalous']);
    const anomalyProps = asset.properties.anomalies.items.properties;
    expect(anomalyProps.parameters.items.required).toEqual(['field', 'observed', 'expected', 'deviation']);
    expect(anomalyProps.severity.enum).toEqual(['info', 'warning', 'critical']);
  });
});
