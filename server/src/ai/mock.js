import { createHash } from 'node:crypto';
import { demoStep } from './mockChat.js';
import { PHASE5_BUILDERS } from './mockPhase5.js';

/**
 * Deterministic stand-in for Gemini (AI_MOCK=true or no API key): realistic output for every purpose,
 * anomaly decisions derived from the feature table, and a scriptable streaming chat model for tests.
 */

const unit = (seed) =>
  Number.parseInt(createHash('sha1').update(String(seed)).digest('hex').slice(0, 8), 16) / 0xffffffff;
const between = (seed, min, max) => min + unit(seed) * (max - min);
const round = (n, digits = 1) => Number(Number(n ?? 0).toFixed(digits));
const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
const label = (type) =>
  String(type)
    .replace(/_/g, ' ')
    .replace(/^./, (c) => c.toUpperCase());

const tokensFor = (input, output) => {
  const prompt = Math.ceil(JSON.stringify(input ?? '').length / 4);
  const candidates = Math.ceil(String(output).length / 4);
  return { prompt, thoughts: 0, candidates, total: prompt + candidates };
};
const sdkUsage = ({ prompt, thoughts, candidates, total }) => ({
  promptTokenCount: prompt,
  thoughtsTokenCount: thoughts,
  candidatesTokenCount: candidates,
  totalTokenCount: total,
});

/** The last user text in a contents list (or the string itself). */
const textOf = (contents) => {
  if (typeof contents === 'string') return contents;
  if (!Array.isArray(contents)) return '';
  for (let i = contents.length - 1; i >= 0; i--) {
    const c = contents[i];
    if (c?.role !== 'user') continue;
    const text = (c.parts ?? [])
      .map((p) => p.text)
      .filter(Boolean)
      .join(' ');
    if (text) return text;
  }
  return '';
};

/** What a maintenance engineer would say per anomaly type (defs/maintenance.js ANOMALY_TYPES). */
const KB = {
  vibration_high: {
    causes: ['Bearing wear', 'Misalignment or loose mounting', 'Unbalanced rotating parts'],
    actions: [
      'Check bearing temperature and noise at the next stop',
      'Measure the vibration spectrum at the bearing housings',
      'Plan a bearing inspection at the next changeover',
    ],
    category: 'Mechanical',
    minutes: 120,
  },
  temperature_high: {
    causes: ['Reduced cooling or blocked airflow', 'Lubricant breakdown', 'Running above rated load'],
    actions: [
      'Check cooling flow, filters and fans',
      'Verify lubricant level and condition',
      'Reduce load until the temperature settles',
    ],
    category: 'Mechanical',
    minutes: 90,
  },
  temperature_low: {
    causes: ['Heater or thermocouple fault', 'Setpoint changed', 'Cold material or ambient'],
    actions: ['Check the heater circuit and thermocouple', 'Compare the setpoint with the setup sheet'],
    category: 'Electrical',
    minutes: 60,
  },
  pressure_low: {
    causes: ['Leak in the line or seals', 'Pump or compressor wear', 'Relief valve not closing fully'],
    actions: [
      'Walk the line for leaks',
      'Check the relief valve and seals',
      'Compare pump output with its rated curve',
    ],
    category: 'Hydraulic',
    minutes: 90,
  },
  pressure_high: {
    causes: ['Blocked outlet or filter', 'Valve stuck closed', 'Setpoint drift'],
    actions: ['Check filters and the outlet path', 'Verify valve operation and the setpoint'],
    category: 'Hydraulic',
    minutes: 60,
  },
  current_high: {
    causes: ['Mechanical overload', 'Worn drive parts adding friction', 'Phase imbalance'],
    actions: [
      'Check for mechanical binding',
      'Measure the three phase currents',
      'Inspect belts, couplings and bearings',
    ],
    category: 'Electrical',
    minutes: 90,
  },
  current_imbalance: {
    causes: [
      'Loose or burnt terminal on one phase',
      'Winding fault in the motor',
      'Uneven single-phase loads',
    ],
    actions: [
      'Measure the three phase currents and voltages',
      'Check terminals and contactors for heat marks',
      'Megger-test the motor windings at the next stop',
    ],
    category: 'Electrical',
    minutes: 90,
  },
  power_high: {
    causes: ['Higher load than planned', 'Mechanical drag', 'Heaters on longer than needed'],
    actions: [
      'Compare the load with the job card',
      'Check for drag in the drive train',
      'Review heater timings',
    ],
    category: 'Electrical',
    minutes: 60,
  },
  idle_power_high: {
    causes: [
      'Auxiliaries left running while idle',
      'Heaters holding setpoint with no production',
      'Compressed air leaks',
    ],
    actions: [
      'Switch off auxiliaries during idle',
      'Review idle setpoints with production',
      'Audit compressed air leaks around the machine',
    ],
    category: 'Electrical',
    minutes: 60,
  },
  sensor_flatline: {
    causes: ['Sensor or cable fault', 'PLC tag frozen', 'Gateway stopped forwarding this field'],
    actions: [
      'Check the sensor wiring and power',
      'Restart the gateway or verify the tag mapping',
      'Compare with a handheld reading',
    ],
    category: 'Calibration',
    minutes: 45,
  },
  cycle_time_drift: {
    causes: ['Slower mould or tool movement', 'Operator interventions', 'Material or temperature changes'],
    actions: [
      'Compare cycle phases with the set values',
      'Check hydraulics and clamp timing',
      'Review the material lot and temperatures',
    ],
    category: 'Inspection',
    minutes: 60,
  },
  quality_degradation: {
    causes: ['Tool or mould wear', 'Process parameters drifting', 'Material lot variation'],
    actions: [
      'Inspect the tool and the first-off part',
      'Check parameters against the setup sheet',
      'Hold the batch until the cause is found',
    ],
    category: 'Inspection',
    minutes: 90,
  },
  other: {
    causes: ['Process drift', 'Sensor calibration'],
    actions: ['Inspect the machine at the next stop', 'Compare readings with a reference instrument'],
    category: 'Inspection',
    minutes: 60,
  },
};

/** Current and power read high only above their baseline; below it they are no fault type of their own. */
const typeFor = (f) => {
  const name = f.field;
  const low = (f.z ?? 0) < 0;
  if (/vibration/i.test(name)) return 'vibration_high';
  if (/temp/i.test(name)) return low ? 'temperature_low' : 'temperature_high';
  if (/pressure/i.test(name)) return low ? 'pressure_low' : 'pressure_high';
  if (/current|load/i.test(name)) return low ? 'other' : 'current_high';
  if (/cycle/i.test(name)) return 'cycle_time_drift';
  if (/power/i.test(name)) return low ? 'other' : 'power_high';
  return 'other';
};

const nameOf = (f) => f.label ?? f.field;
const sigma = (z) => `${z > 0 ? '+' : ''}${round(z)}σ`;
// z comes from the 10-minute mean, so the numbers quote the mean, never the last reading.
const parameter = (f, deviation = sigma(f.z ?? 0)) => ({
  field: f.field,
  observed: round(f.mean ?? f.last, 2),
  expected: round(f.baseline?.mean ?? f.mean, 2),
  deviation,
});
const unitText = (f) => (f.unit ? ` ${f.unit}` : '');
// The raw difference next to σ keeps the number physical: "+2.5 °C (+1.1σ)" reads honestly.
const sentence = (f, name) => {
  const delta = round((f.mean ?? f.last) - (f.baseline?.mean ?? 0), 2);
  return (
    `${nameOf(f)} on ${name} averages ${round(f.mean ?? f.last, 2)}${unitText(f)} over the last ${f.n ?? 10} min, ${sigma(f.z)} ` +
    `(${delta > 0 ? '+' : ''}${delta}${unitText(f)}) from its ${f.baseline?.source ?? 'spec'} baseline of ${round(f.baseline?.mean, 2)}`
  );
};
const anomaly = (type, severity, confidence, parameters, explanation, urgencyHours) => ({
  type,
  severity,
  confidence,
  parameters,
  explanation,
  likelyCauses: KB[type].causes,
  recommendedActions: KB[type].actions,
  urgencyHours,
});

const SETTLE_MS = 60 * 60_000; // about 3 thermal time constants of the simulated machines
const isEnergy = (f) => f.measurement === 'energy';
const isPhase = (f) => /PH-\d/.test(f.field);

/** One asset's verdict from its deterministic features: |z| ≥ 3, flatline, idle power ≥ 2×, rejects. */
const judgeAsset = (asset) => {
  const name = asset.name ?? asset.tag ?? asset.assetId;
  const fields = asset.fields ?? [];
  const labelOf = new Map([...fields.map((f) => [f.field, nameOf(f)]), ['rejectionRate', 'Rejection rate']]);
  const anomalies = [];
  // As the real prompt asks: a temperature drifting back towards its baseline within an hour of a
  // status change is cooling down or warming up (thermal lag), not a fault.
  const since = Date.parse(asset.statusSince ?? '');
  const settling = (f) => /temp/i.test(f.field) && Date.now() - since < SETTLE_MS && f.z * f.slopePerHour < 0;
  const calm = asset.transition ? [] : fields.filter((f) => !settling(f));
  // Not right after a status change: power takes a few minutes to spin down when a machine goes Idle.
  const power =
    fields.find((f) => /power total/i.test(f.field)) ?? fields.find((f) => /power/i.test(f.field));
  const idlePower =
    !asset.transition && asset.flags?.includes('idle_power') && asset.idlePowerRatio >= 2 && power;
  // One energy leak moves every energy reading: it is one idle-power finding, not one per field.
  const deviating = calm.filter((f) => f.z != null && Math.abs(f.z) >= 3 && !(idlePower && isEnergy(f)));
  // Mild deviations are only "watch": act on |z| ≥ 5, or on two fields deviating together.
  const strong = deviating.length >= 2 ? deviating : deviating.filter((f) => Math.abs(f.z) >= 5);
  const phases = strong.filter((f) => isEnergy(f) && isPhase(f));
  const imbalance = phases.some((f) => f.z > 0) && phases.some((f) => f.z < 0);
  const byType = new Map();
  for (const f of strong) {
    const type = imbalance && isEnergy(f) ? 'current_imbalance' : typeFor(f);
    byType.set(type, [...(byType.get(type) ?? []), f]);
  }
  for (const [type, group] of byType) {
    const worst = Math.max(...group.map((f) => Math.abs(f.z)));
    const trend = group.some((f) => f.slopePerHour > 0)
      ? 'The trend is rising.'
      : 'The level has been steady over the window.';
    anomalies.push(
      anomaly(
        type,
        worst >= 5 ? 'critical' : 'warning',
        round(clamp(0.55 + worst / 20, 0.55, 0.95), 2),
        group.map((f) => parameter(f)),
        `${group.map((f) => sentence(f, name)).join('; ')}. ${trend}`,
        worst >= 5 ? 4 : 24,
      ),
    );
  }
  for (const f of fields.filter((f) => f.flatline)) {
    anomalies.push(
      anomaly(
        'sensor_flatline',
        'warning',
        0.8,
        [parameter(f, 'flat for the whole window')],
        `${nameOf(f)} on ${name} has not moved while the machine is running; it normally varies by ±${round(
          f.baseline?.std,
          2,
        )}.`,
        48,
      ),
    );
  }
  if (idlePower) {
    const ratio = round(asset.idlePowerRatio);
    const status = asset.status ?? 'idle';
    const others = fields
      .filter((f) => f !== power && isEnergy(f) && f.z != null && Math.abs(f.z) >= 3)
      .sort((a, b) => Math.abs(b.z) - Math.abs(a.z))
      .slice(0, 2);
    anomalies.push(
      anomaly(
        'idle_power_high',
        ratio >= 3 ? 'critical' : 'warning',
        0.75,
        [parameter(power, `${ratio}× the ${status} baseline`), ...others.map((f) => parameter(f))],
        `${name} draws ${round(power.mean ?? power.last)} kW while ${status}, ${ratio}× its usual level for that state.`,
        24,
      ),
    );
  }
  const rr = asset.rejectionRate;
  if (asset.flags?.includes('rejects') && rr) {
    anomalies.push(
      anomaly(
        'quality_degradation',
        'warning',
        0.7,
        [
          {
            field: 'rejectionRate',
            observed: round(rr.recentPct),
            expected: round(rr.baselinePct),
            deviation: `${round(rr.recentPct - (rr.baselinePct ?? 0))} pts`,
          },
        ],
        `${name} rejected ${rr.rejected ?? '?'} of ${rr.parts ?? '?'} parts (${round(rr.recentPct)}%) in the last ${round(
          rr.windowHours ?? 1,
        )} h against ${round(rr.baselinePct)}% over the week before.`,
        12,
      ),
    );
  }
  // One 2σ field out of ~25 is noise: watch needs a band breach, |z| ≥ 3, or two fields at |z| ≥ 2.5.
  const watching = calm.filter((f) => f.band || (f.z != null && Math.abs(f.z) >= 2.5));
  const watch = watching.length >= 2 || watching.some((f) => f.band || Math.abs(f.z) >= 3);
  const state = anomalies.length ? 'anomalous' : watch ? 'watch' : 'normal';
  const worstZ = Math.max(0, ...strong.map((f) => Math.abs(f.z)));
  const healthScore = {
    anomalous: Math.round(clamp(100 - 12 * Math.max(worstZ, 3), 15, 55)),
    watch: Math.round(between(`${asset.assetId}:watch`, 70, 84)),
    normal: Math.round(between(`${asset.assetId}:ok`, 90, 99)),
  }[state];
  const summary = {
    anomalous: anomalies
      .map((a) => `${label(a.type)} (${a.parameters.map((p) => labelOf.get(p.field) ?? p.field).join(', ')})`)
      .join('; '),
    watch: `${watching
      .map((f) => `${nameOf(f)} ${f.z != null ? sigma(f.z) : f.band}`)
      .join(', ')} — worth watching, nothing to act on yet.`,
    normal: asset.transition
      ? 'Just changed state; readings are settling.'
      : 'All parameters within their usual range.',
  }[state];
  return { assetId: asset.assetId, healthScore, state, summary, anomalies };
};

const anomalyMock = (input) => {
  const assets = Array.isArray(input) ? input : (input?.assets ?? input?.features ?? []);
  return { assets: assets.map(judgeAsset) };
};

const INTENTS = [
  ['smalltalk', /^\s*(hi|hello|hey|thanks|thank you|good (morning|evening))\b/],
  ['write', /\b(create|add|update|change|set|close|delete|remove|assign|complete|mark|raise)\b/],
  ['diagnosis', /\b(why|cause|diagnos|wrong|fail|anomal|health|vibrat)\b/],
  ['timeseries', /\b(trend|over time|chart|plot|last \d+ (hours?|minutes?)|temperature|power|energy|kwh)\b/],
  ['planning', /\b(plan|schedule|when should|capacity)\b/],
  ['report', /\b(report|summar|brief|overview)\b/],
  ['analytics', /\b(how many|count|total|average|compare|top|most|per|by)\b/],
  ['lookup', /\b(show|list|find|which|who|what|where|status|open)\b/],
];
const GROUPS = {
  analytics: ['maintenance', 'production'],
  timeseries: ['telemetry'],
  diagnosis: ['telemetry', 'health'],
  write: ['write'],
  report: ['maintenance', 'production', 'telemetry'],
  planning: ['maintenance', 'production'],
};
const COMPLEXITY = {
  diagnosis: 'high',
  report: 'high',
  planning: 'high',
  analytics: 'medium',
  timeseries: 'medium',
  write: 'medium',
};

const routerMock = (_input, text) => {
  const t = text.toLowerCase();
  const intent = INTENTS.find(([, re]) => re.test(t))?.[0] ?? 'unclear';
  const complexity = COMPLEXITY[intent] ?? 'low';
  return {
    intent,
    complexity,
    needsInflux: intent === 'timeseries' || intent === 'diagnosis',
    isFollowUp: t.length < 60 && /\b(it|that|those|them|same|again|also)\b/.test(t),
    suggestedTier: { high: 'deep', medium: 'balanced', low: 'fast' }[complexity],
    groups: GROUPS[intent] ?? [],
    confident: intent !== 'unclear',
  };
};

const titleMock = (_input, text) => ({
  title: (text.trim().split(/\s+/).slice(0, 6).join(' ') || 'New conversation')
    .replace(/[?.!,]+$/, '')
    .replace(/^./, (c) => c.toUpperCase())
    .slice(0, 60),
});

const summaryMock = (_input, text) => ({
  summary: `The user asked about ${(text || 'their plant').slice(0, 120)}; SARA answered from the modules in scope and no action is pending.`,
});

const investigationMock = (input = {}) => {
  const a = input.anomaly ?? {};
  const asset = input.asset?.name ?? a.assetName ?? 'the machine';
  const type = KB[a.type] ? a.type : 'other';
  const p = a.parameters?.[0];
  const kb = KB[type];
  const detail = p
    ? `: ${p.label ?? p.field} at ${p.observed} against an expected ${p.expected} (${p.deviation})`
    : '';
  const summary = `${label(type)} on ${asset}${detail}.`;
  const actions = kb.actions.map((x) => `- ${x}`).join('\n');
  return {
    summary,
    rootCause: kb.causes[0],
    confidence: 0.7,
    recommendedActions: kb.actions,
    suggestedWorkOrder: {
      name: `${label(type)} – ${asset}`,
      description: `${summary} ${kb.actions.join('. ')}.`,
      priority: a.severity === 'critical' ? 'High' : 'Medium',
      category: kb.category,
      estimatedDurationMin: kb.minutes,
    },
    urgencyHours: a.severity === 'critical' ? 4 : 24,
    markdown: `## What happened\n${summary}\n\n## Likely root cause\n${kb.causes[0]}\n\n## Recommended actions\n${actions}`,
  };
};

const kpiMock = (input = {}) => ({
  headline: `${input.name ?? input.kpi ?? 'The KPI'} is ${
    input.value != null ? `at ${input.value}${input.unit ?? ''}` : 'on track'
  }`,
  summary: 'Steady over the period with one dip tied to unplanned downtime on the busiest machine.',
  insights: [
    'Most of the variance comes from one machine, not the whole line',
    'Shift B runs about 4% below shift A on this measure',
    'The last week improved after the preventive round',
  ],
  recommendations: [
    'Review the top downtime reason on the weakest machine',
    'Share the shift A setup checklist with shift B',
  ],
});

const costMock = (input = {}) => ({
  summary: 'Spend is tracking the budget; one line item needs attention.',
  alerts: [
    {
      title: 'Energy cost above plan',
      severity: 'warning',
      amount: round(input.amount ?? 18400),
      explanation: 'Night-shift idle consumption on the compressors is 22% above the baseline.',
      action: 'Switch compressors to the low-load setpoint when the line is idle.',
    },
  ],
});

const briefingMock = (input = {}) => {
  const name = input.company?.name ?? input.companyName ?? 'the plant';
  return {
    headline: `${name}: steady shift, two items to watch`,
    highlights: [
      'Availability 86% across the plant, best on the CNC cell',
      '3 work orders closed, 2 new, none overdue',
      'Energy use 4% below last week',
    ],
    risks: ['Vibration trending up on one press', 'Spare stock for hydraulic seals below minimum'],
    actions: ['Inspect the press bearings at the next changeover', 'Raise a purchase request for the seals'],
    markdown: `## Morning briefing\n**${name}** had a steady shift.\n\n- Availability 86%\n- 3 work orders closed, 2 new\n\n### Watch\n- Vibration rising on one press\n- Hydraulic seal stock below minimum`,
  };
};

const planningMock = (input = {}) => ({
  summary: 'Maintenance fits in the planned idle windows; production is not pushed.',
  plan: [
    {
      title: 'Bearing inspection',
      start: input.start ?? '2026-10-16T02:00:00.000Z',
      end: input.end ?? '2026-10-16T04:00:00.000Z',
      assetId: input.assetId ?? null,
      reason: 'Lowest load window of the week with the technician available',
    },
  ],
  rationale: 'The idle window after shift C avoids the two active job cards and needs no overtime.',
  conflicts: [],
});

const defaultReply = (text) =>
  `I am running in mock mode (no Gemini key), so I cannot look that up for real. ${
    text ? `You asked: "${text.slice(0, 120)}". ` : ''
  }Set GEMINI_API_KEY to get live answers.`;

const BUILDERS = {
  router: routerMock,
  title: titleMock,
  summary: summaryMock,
  anomaly: anomalyMock,
  investigation: investigationMock,
  kpi: kpiMock,
  cost: costMock,
  briefing: briefingMock,
  planning: planningMock,
  test: () => 'Hello from SARA. This is the built-in mock model, so no Gemini call was made.',
  chat: (_input, text) => defaultReply(text),
};

const schemaType = (schema) => {
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  return type ?? (schema.properties ? 'object' : schema.items ? 'array' : undefined);
};

/** Shapes `value` to a JSON schema (fills required keys, clamps enums and numbers) so mock output always validates. */
const conform = (value, schema, seed = 'x') => {
  if (!schema || typeof schema !== 'object') return value;
  if (schema.enum) return schema.enum.includes(value) ? value : schema.enum[0];
  const options = schema.anyOf ?? schema.oneOf;
  if (options) {
    const kind = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    return conform(value, options.find((o) => schemaType(o) === kind) ?? options[0], seed);
  }
  switch (schemaType(schema)) {
    case 'object': {
      const src = value != null && typeof value === 'object' && !Array.isArray(value) ? value : {};
      if (!schema.properties) return src;
      const out = {};
      for (const [key, sub] of Object.entries(schema.properties)) {
        if (key in src) out[key] = conform(src[key], sub, `${seed}.${key}`);
        else if (schema.required?.includes(key)) out[key] = conform(undefined, sub, `${seed}.${key}`);
      }
      if (schema.additionalProperties) {
        for (const [key, v] of Object.entries(src)) if (!(key in out)) out[key] = v;
      }
      return out;
    }
    case 'array': {
      const items = Array.isArray(value) ? value : value == null ? [] : [value];
      const out = items.map((v, i) => conform(v, schema.items, `${seed}[${i}]`));
      while (out.length < (schema.minItems ?? 0)) {
        out.push(conform(undefined, schema.items, `${seed}[${out.length}]`));
      }
      return schema.maxItems != null ? out.slice(0, schema.maxItems) : out;
    }
    case 'integer':
    case 'number': {
      let n = typeof value === 'number' && Number.isFinite(value) ? value : (schema.minimum ?? 0);
      if (schema.minimum != null) n = Math.max(n, schema.minimum);
      if (schema.maximum != null) n = Math.min(n, schema.maximum);
      return schemaType(schema) === 'integer' ? Math.round(n) : n;
    }
    case 'boolean':
      return typeof value === 'boolean' ? value : false;
    case 'string': {
      const s =
        typeof value === 'string' ? value : value == null ? `Mock ${seed.split('.').pop()}` : String(value);
      return schema.maxLength != null ? s.slice(0, schema.maxLength) : s;
    }
    case 'null':
      return null;
    default:
      return value ?? null;
  }
};

/** Deterministic output for one non-streaming call; with a `schema`, `json` is shaped to it. */
export const mockGenerate = ({ purpose, mockInput, schema, contents }) => {
  const text = typeof mockInput === 'string' ? mockInput : (mockInput?.text ?? textOf(contents));
  const build =
    PHASE5_BUILDERS[mockInput?.kind] ?? BUILDERS[purpose] ?? (() => ({ answer: defaultReply(text) }));
  const value = build(mockInput, String(text ?? ''));
  if (schema) {
    const json = conform(value, schema, purpose);
    const out = JSON.stringify(json);
    return { text: out, json, usage: tokensFor(mockInput ?? contents, out) };
  }
  const out = typeof value === 'string' ? value : JSON.stringify(value);
  return { text: out, json: undefined, usage: tokensFor(mockInput ?? contents, out) };
};

/**
 * Chat scripts for tests: `{ match: RegExp | (text) => boolean, steps }`; a step is one model turn
 * `{ thought?, text?, calls?: [{ name, args }] }` or `({ text, responses, turn, tools }) => step`.
 */
export const mockScripts = [];

const DEFAULT_TOOLS = [
  [/work ?orders?/, 'work_orders_summary'],
  [/anomal|health/, 'list_anomalies'],
  [/spare|stock|inventory/, 'spare_parts_below_minimum'],
];

/** Without a script: call one fitting offered tool, then answer from its result; otherwise a plain reply. */
const defaultSteps = (text, tools = []) => {
  const names = new Set(tools.flatMap((t) => (t.functionDeclarations ?? []).map((d) => d.name)));
  const t = text.toLowerCase();
  const tool = DEFAULT_TOOLS.find(([re, name]) => re.test(t) && names.has(name))?.[1];
  if (!tool) return [{ text: defaultReply(text) }];
  return [
    {
      thought: `The question is about ${tool.replaceAll('_', ' ')}, so I will call that tool first.`,
      calls: [{ name: tool, args: {} }],
    },
    ({ responses }) => ({
      text: `Here is what I found (mock): ${JSON.stringify(responses[0]?.response ?? {}).slice(0, 300)}`,
    }),
  ];
};

const scriptOf = (text) =>
  mockScripts.find((s) => (typeof s.match === 'function' ? s.match(text) : s.match.test(text)));
export const scriptFor = (text, tools) => scriptOf(text)?.steps ?? defaultSteps(text, tools);

const chunkOf = (parts, extra = {}) => ({
  candidates: [
    {
      content: { role: 'model', parts },
      index: 0,
      ...(extra.finishReason ? { finishReason: extra.finishReason } : {}),
    },
  ],
  ...(extra.usageMetadata ? { usageMetadata: extra.usageMetadata } : {}),
  modelVersion: 'mock',
  get text() {
    const text = parts
      .filter((p) => p.text && !p.thought)
      .map((p) => p.text)
      .join('');
    return text || undefined;
  },
  get functionCalls() {
    const calls = parts.filter((p) => p.functionCall).map((p) => p.functionCall);
    return calls.length ? calls : undefined;
  },
});

/** Streams one model turn like the SDK: a thought part, function calls, then text in a few chunks; the last chunk carries usage. */
export async function* mockStream({ contents, tools = [], mockInput, system }) {
  const list = Array.isArray(contents)
    ? contents
    : [{ role: 'user', parts: [{ text: String(contents ?? '') }] }];
  const isUserText = (c) => c?.role === 'user' && (c.parts ?? []).some((p) => p.text);
  let userIndex = list.length - 1;
  while (userIndex >= 0 && !isUserText(list[userIndex])) userIndex--;
  const text = typeof mockInput?.text === 'string' ? mockInput.text : textOf(list);
  const turn = list.slice(userIndex + 1).filter((c) => c.role === 'model').length;
  const responses = (list.at(-1)?.parts ?? [])
    .filter((p) => p.functionResponse)
    .map((p) => p.functionResponse);
  // Test scripts first, then the demo flows (mockChat.js, off in tests), then the one-tool default.
  const demo = scriptOf(text) ? null : demoStep({ text, history: list.slice(userIndex + 1), system });
  const raw = demo ?? scriptFor(text, tools)[turn] ?? { text: 'That is everything I found.' };
  const step = typeof raw === 'function' ? raw({ text, responses, turn, tools }) : raw;
  const chunks = [];
  if (step.thought) chunks.push([{ text: step.thought, thought: true }]);
  if (step.calls?.length) {
    chunks.push(
      step.calls.map((c, i) => ({
        functionCall: { name: c.name, args: c.args ?? {} },
        ...(i === 0 ? { thoughtSignature: 'mock-signature' } : {}),
      })),
    );
  }
  if (step.text) {
    const words = step.text.split(/(?<=\s)/);
    const size = Math.ceil(words.length / 3);
    for (let i = 0; i < words.length; i += size) chunks.push([{ text: words.slice(i, i + size).join('') }]);
  }
  if (!chunks.length) chunks.push([{ text: '' }]);
  const usageMetadata = sdkUsage(tokensFor(list, step.text ?? ''));
  for (const [i, parts] of chunks.entries()) {
    yield chunkOf(parts, i === chunks.length - 1 ? { finishReason: 'STOP', usageMetadata } : {});
  }
}
