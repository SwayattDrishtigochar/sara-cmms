// Pure helpers of the Planner's editable plans (no React): the edited shapes the check routes take,
// adjustment patches, dirty tracking and the verdict/objective words.
import { shiftBands } from './ganttLayout.js';

export const VERDICT_LABEL = { doable: 'Doable', adjust: 'Needs adjustment', not_doable: 'Not doable' };
export const OBJECTIVE_LABEL = {
  protect_production: 'Protect production',
  balanced: 'Balanced',
  fix_fast: 'Fix fast',
};

/** 'good' | 'warn' | 'critical' for a verdict. */
export const verdictTone = (verdict) =>
  verdict === 'doable' ? 'good' : verdict === 'not_doable' ? 'critical' : 'warn';

/** Objective of the 0–100 slider: < 34 protect production, < 67 balanced, else fix fast. */
export const objectiveOf = (value) =>
  value < 34 ? 'protect_production' : value < 67 ? 'balanced' : 'fix_fast';

/** Slider position of an objective (the middle of its band). */
export const sliderOf = (objective) =>
  ({ protect_production: 0, balanced: 50, fix_fast: 100 })[objective] ?? 0;

// Mirror of the server's people.js skill maps, so the technician list can tag who "fits" a task.
const CATEGORY_SKILLS = {
  Electrical: ['electrical', 'plc', 'drives'],
  Hydraulic: ['hydraulics', 'pneumatics'],
  Mechanical: ['mechanical'],
  Preventive: ['mechanical', 'lubrication'],
  Calibration: ['calibration', 'instrumentation'],
  Breakdown: ['mechanical', 'electrical'],
  Safety: ['electrical', 'mechanical'],
};
const ASSET_SKILLS = {
  Compressor: ['utilities', 'pneumatics'],
  Chiller: ['utilities', 'refrigeration'],
  Furnace: ['utilities', 'electrical'],
  'Energy Meter': ['electrical', 'instrumentation'],
};
const OPERATOR_SKILL = {
  'Injection Moulding Machine': 'moulding',
  'Power Press': 'press',
  'CNC Machine': 'cnc',
};
/** The operator skill a machine type wants (`[]` for unknown types). */
export const operatorSkills = (typeOfAsset) => [OPERATOR_SKILL[typeOfAsset]].filter(Boolean);

/** Skills a task wants: category skills ∪ asset-type skills (lowercase, unique). */
export const skillsForTask = ({ category, assetType } = {}) => [
  ...new Set([...(CATEGORY_SKILLS[category] ?? []), ...(ASSET_SKILLS[assetType] ?? [])]),
];

const iso = (v) => (v == null || v === '' ? v : new Date(v).toISOString());
const idOf = (v) =>
  v && typeof v === 'object' ? String(v._id ?? v.id ?? v.userId ?? '') : v == null ? v : String(v);
const splitSource = (source) =>
  source?.diff ? { proposal: source, check: null } : { proposal: source?.proposal, check: source };

/**
 * The editable production plan from a check result (with its `proposal`) or a proposal: keys are the
 * proposal's `diff.jobCards[].key`; operators keep `{ userId, shiftName, start, end }`.
 */
export const toEditedProduction = (source) => {
  const { proposal: p, check } = splitSource(source);
  const input = { ...(p?.input ?? {}), ...(p?.input?.edited ?? {}) };
  const cards = check?.jobCards ?? p?.diff?.jobCards ?? [];
  return {
    ...(p?._id ? { proposalId: String(p._id) } : {}),
    partName: input.partName ?? '',
    quantity: Number(input.quantity ?? 0),
    dueDate: iso(
      p?.input?.edited?.dueDate ??
        check?.feasibility?.dueDate ??
        input.dueDate ??
        p?.feasibility?.dueDate ??
        null,
    ),
    ...(input.plantId ? { plantId: idOf(input.plantId) } : {}),
    ...(input.customerId ? { customerId: idOf(input.customerId) } : {}),
    jobCards: cards.map((c, i) => ({
      key: c.key ?? `op-${i + 1}`,
      assetId: idOf(c.assetId) ?? '',
      toolId: idOf(c.toolId) ?? '',
      target: Number(c.target ?? 0),
      start: iso(c.start),
      end: iso(c.end),
      operators: (c.operators ?? []).map((o) => ({
        userId: idOf(o.userId ?? o.user),
        ...(o.shiftName ? { shiftName: o.shiftName } : {}),
        ...(o.start ? { start: iso(o.start) } : {}),
        ...(o.end ? { end: iso(o.end) } : {}),
      })),
    })),
  };
};

/** The editable maintenance plan: rows by key of `diff.tasks` / `check.tasks`; assets are not editable. */
export const toEditedMaintenance = (source) => {
  const { proposal: p, check } = splitSource(source);
  const edited = p?.input?.edited ?? {};
  const tasks = check?.tasks ?? p?.diff?.tasks ?? [];
  return {
    proposalId: p?._id ? String(p._id) : '',
    name: edited.name ?? p?.title ?? p?.input?.name ?? '',
    objective: edited.objective ?? p?.input?.objective ?? 'protect_production',
    tasks: tasks.map((t) => ({
      key: t.key,
      start: iso(t.start),
      end: iso(t.end),
      durationMin: Number(t.durationMin ?? 0),
      technicianId: t.technician?.userId ? idOf(t.technician.userId) : (t.technicianId ?? null),
    })),
  };
};

const defined = (obj) => Object.fromEntries(Object.entries(obj ?? {}).filter(([, v]) => v !== undefined));
const mergeRows = (rows = [], patches = []) => {
  const out = rows.map((r) => {
    const patch = patches.find((p) => p.key === r.key);
    return patch ? { ...r, ...defined(patch) } : r;
  });
  for (const p of patches) if (!rows.some((r) => r.key === p.key)) out.push(defined(p));
  return out;
};

/** The plan with one row patched (rows are matched by `key`; an unknown key appends). */
export const setCard = (edited, key, patch) => ({
  ...edited,
  jobCards: mergeRows(edited.jobCards, [{ ...patch, key }]),
});
export const setTask = (edited, key, patch) => ({
  ...edited,
  tasks: mergeRows(edited.tasks, [{ ...patch, key }]),
});

/** The plan with an adjustment's `patch` merged (dueDate, quantity, jobCards/tasks by key). */
export const applyAdjustment = (edited, adjustment) => {
  const patch = adjustment?.patch ?? {};
  return {
    ...edited,
    ...(patch.dueDate ? { dueDate: iso(patch.dueDate) } : {}),
    ...(patch.quantity != null ? { quantity: Number(patch.quantity) } : {}),
    ...(patch.name != null ? { name: patch.name } : {}),
    ...(patch.objective ? { objective: patch.objective } : {}),
    ...(patch.jobCards ? { jobCards: mergeRows(edited.jobCards, patch.jobCards) } : {}),
    ...(patch.tasks ? { tasks: mergeRows(edited.tasks, patch.tasks) } : {}),
  };
};

const stable = (v) =>
  Array.isArray(v)
    ? `[${v.map(stable).join(',')}]`
    : v && typeof v === 'object'
      ? `{${Object.keys(v)
          .sort()
          .filter((k) => v[k] !== undefined)
          .map((k) => `${k}:${stable(v[k])}`)
          .join(',')}}`
      : JSON.stringify(v ?? null);

/** True when the plan differs from the one last checked (deep, key-order independent). */
export const isDirty = (edited, lastChecked) => stable(edited) !== stable(lastChecked);

/** Shift segments of a window (`shifts` as the Gantt payload gives them); one segment without shifts. */
export const segmentsOf = (shifts, { start, end }, timeZone) => {
  if (!start || !end) return [];
  const bands = shiftBands(shifts ?? [], { start, end }, timeZone).map((b) => ({
    name: b.name,
    start: new Date(b.start).toISOString(),
    end: new Date(b.end).toISOString(),
  }));
  return bands.length ? bands : [{ name: null, start: iso(start), end: iso(end) }];
};

const overlaps = (a, b) => Date.parse(a.start) < Date.parse(b.end) && Date.parse(a.end) > Date.parse(b.start);

/** The operator booked on a segment (by its window, else by shift name), or null. */
export const operatorOf = (operators = [], segment) =>
  operators.find((o) => (o.start && o.end ? overlaps(o, segment) : o.shiftName === segment.name)) ?? null;

/** Operators with `userId` on `segment` (null clears it); other segments keep theirs. */
export const withOperator = (operators = [], segment, userId) => [
  ...operators.filter((o) => o !== operatorOf(operators, segment)),
  ...(userId
    ? [{ userId, shiftName: segment.name ?? undefined, start: segment.start, end: segment.end }]
    : []),
];

/**
 * The check-shaped view of a Planner result: the real `check` when the route returned one, else the
 * same fields read off the stored proposal (lists, deep links).
 */
export const checkOf = ({ proposal: p = {}, plan, check } = {}) =>
  check ?? {
    verdict: p.feasibility?.verdict ?? (p.feasibility?.feasible === false ? 'adjust' : 'doable'),
    feasibility: p.feasibility ?? {},
    issues: p.issues ?? [],
    adjustments: p.adjustments ?? [],
    jobCards: p.diff?.jobCards ?? [],
    tasks: p.diff?.tasks ?? [],
    metrics: p.metrics ?? null,
    risks: p.risks ?? [],
    plan: plan ?? null,
    explanation: p.explanation ?? null,
  };
