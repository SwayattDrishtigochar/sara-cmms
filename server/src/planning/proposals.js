import mongoose from 'mongoose';
import { findByIdOrCode, linkTo } from '../agent/tools/common.js';
import { nextSeq } from '../db/models/Counter.js';
import { AppError, badRequest, conflict, forbidden, gone } from '../lib/errors.js';
import { plantAudience, publish } from '../lib/events.js';
import { assertCan } from '../modules/permissions.js';
import { records, scopeFilter } from '../modules/records.js';
import { getModule, labelOf } from '../modules/registry.js';
import { buildCalendar, calendarToGantt } from './capacity.js';

/**
 * Plan proposals (phase 5 §3.4): planners store ops + a Gantt diff as a draft; apply replays the ops through
 * records.js with proposalId + seq stamps, so a double confirm or a resumed apply never duplicates a record.
 */

const TTL_MS = 12 * 3_600_000;
const OP_REF = /^\$op:(\d+)$/;
const FULL_ACCESS = ['owner', 'admin', 'superAdmin', 'system'];
const Proposal = () => getModule('planproposals').Model;
const { ObjectId } = mongoose.Types;

/** Deep copy with every exact "$op:N" string replaced by `fn(N)`; undefined drops the key or item. */
const mapRefs = (value, fn) => {
  if (typeof value === 'string') {
    const m = OP_REF.exec(value);
    return m ? fn(Number(m[1])) : value;
  }
  if (value instanceof Date || value instanceof ObjectId) return value;
  if (Array.isArray(value)) return value.map((v) => mapRefs(v, fn)).filter((v) => v !== undefined);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .map(([k, v]) => [k, mapRefs(v, fn)])
        .filter(([, v]) => v !== undefined),
    );
  }
  return value;
};
const dropRefs = (value) => mapRefs(value, () => undefined);

const announce = (ctx, p, change) =>
  publish(
    ctx.companyId,
    'record',
    { module: 'planproposals', id: String(p._id), change },
    plantAudience(p.plantId),
  );

const setStatus = async (ctx, p, fields) => {
  const after = await Proposal().findOneAndUpdate({ _id: p._id }, { $set: fields }, { new: true }).lean();
  announce(ctx, after, fields.status);
  return after;
};

const companyVersion = async (ctx) =>
  (await getModule('companies').Model.findById(ctx.companyId).select('scheduleVersion').lean())
    ?.scheduleVersion ?? 0;

const planChanged = (details) =>
  new AppError(
    409,
    'PLAN_CHANGED',
    'The schedule changed since this plan was made. Here is an updated plan.',
    details,
  );

const refOf = (mod, doc) => ({
  module: mod.name,
  id: String(doc._id),
  label: labelOf(mod, doc),
  link: linkTo(mod.name, doc._id),
});

/** Stores a draft after dry-running every op (validation, refs, permissions) → 400/403 on the first failure. */
export const createProposal = async (ctx, fields) => {
  for (const op of fields.ops ?? []) {
    try {
      const data = dropRefs(op.data ?? {});
      if (op.op === 'create') await records.create(ctx, op.module, data, { source: 'rest', dryRun: true });
      else if (!OP_REF.test(String(op.id)))
        await records.update(ctx, op.module, op.id, data, { source: 'rest', dryRun: true });
    } catch (err) {
      if (err.status === 403) throw err;
      throw badRequest(
        `Step ${op.seq + 1} (${op.label ?? op.module}) would fail: ${err.message}`,
        err.details,
      );
    }
  }
  const plantId = ctx.plantLock ?? fields.plantId ?? null;
  const seq = await nextSeq({ companyId: ctx.companyId, plantId, type: 'PlanProposal' });
  const created = await Proposal().create({
    ...fields,
    companyId: ctx.companyId,
    plantId,
    proposalCode: `PLN-${seq}`,
    status: 'draft',
    scheduleVersion: await companyVersion(ctx),
    expiresAt: new Date(Date.now() + TTL_MS),
    createdBy: ctx.userId,
    updatedBy: ctx.userId,
  });
  const doc = created.toObject();
  announce(ctx, doc, 'created');
  return doc;
};

/** One proposal by id or PLN-code within the viewer's scope (tenant + plant rule); 404 otherwise. */
export const getProposal = (ctx, idOrCode) => findByIdOrCode(ctx, 'planproposals', String(idOrCode));

/** Newest first, without the heavy fields (ops, options, input, result). */
export const listProposals = async (ctx, { status, kind, limit = 20 } = {}) => {
  const mod = getModule('planproposals');
  assertCan(ctx, mod, 'read');
  const where = {
    ...(status ? { status: { $in: String(status).split(',') } } : {}),
    ...(kind ? { kind: String(kind) } : {}),
    ...scopeFilter(ctx, mod),
  };
  const items = await mod.Model.find(where)
    .select('-ops -options -input -result')
    .sort({ createdAt: -1 })
    .limit(Math.min(100, Math.max(1, Number(limit) || 20)))
    .lean();
  return { items };
};

/** The ops to replay: maintenance proposals take the chosen option's ops. */
const opsFor = (p, option) => {
  if (p.kind !== 'maintenance' || !p.options?.length) return { ops: p.ops ?? [], option: null };
  const id = option ?? p.appliedOption ?? p.recommendedOption;
  const chosen = p.options.find((o) => o.id === id);
  if (!chosen) {
    throw badRequest(`Option "${id}" is not part of ${p.proposalCode}`, {
      options: p.options.map((o) => o.id),
    });
  }
  return { ops: chosen.ops ?? [], option: id };
};

/** Re-runs the planner with the stored input (a new draft). */
const replan = async (ctx, p) => {
  if (p.kind === 'maintenance') {
    const { proposeMaintenance } = await import('./maintenance.js');
    return proposeMaintenance(ctx, p.input);
  }
  const { proposeProduction } = await import('./production.js');
  return proposeProduction(ctx, p.input);
};

/**
 * Apply steps 1–3 (also the apply_plan preview): state, expiry, permission and schedule-version checks.
 * Returns `{ proposal, applied: true }` for an applied proposal, else `{ proposal, ops, option }`.
 */
export const checkApply = async (ctx, idOrCode, { option, now = new Date() } = {}) => {
  const p = await getProposal(ctx, idOrCode);
  if (p.status === 'applied') return { proposal: p, applied: true };
  if (p.status === 'discarded' || p.status === 'expired')
    throw gone(`${p.proposalCode} was ${p.status}; make a new plan`);
  if (p.status === 'stale') throw planChanged(p.result?.replacedBy);
  if (p.status === 'draft' && p.expiresAt && now > new Date(p.expiresAt)) {
    await setStatus(ctx, p, { status: 'expired' });
    throw gone(`${p.proposalCode} expired; make a new plan`);
  }
  const { ops, option: chosen } = opsFor(p, option);
  for (const op of ops) assertCan(ctx, getModule(op.module), op.op);
  if (p.status !== 'draft' && option && p.appliedOption && option !== p.appliedOption) {
    throw conflict(`${p.proposalCode} is already being applied with the "${p.appliedOption}" option`);
  }
  // Our own ops bump scheduleVersion, so the version only means something while the proposal is a draft.
  if (p.status === 'draft' && (await companyVersion(ctx)) !== (p.scheduleVersion ?? 0)) {
    await setStatus(ctx, p, { status: 'stale' });
    const fresh = await replan(ctx, p);
    const replacedBy = { proposalId: String(fresh._id), proposalCode: fresh.proposalCode };
    await Proposal().updateOne({ _id: p._id }, { $set: { result: { replacedBy } } });
    throw planChanged(replacedBy);
  }
  return { proposal: p, ops, option: chosen };
};

/** Applies a draft (or resumes a failed/interrupted apply); a second confirm returns the stored result. */
export const applyProposal = async (ctx, idOrCode, { option, now } = {}) => {
  const checked = await checkApply(ctx, idOrCode, { option, now });
  if (checked.applied) return { proposal: checked.proposal, ...checked.proposal.result };
  const { proposal: p, ops, option: chosen } = checked;

  const claimed = await Proposal()
    .findOneAndUpdate(
      { _id: p._id, status: { $in: ['draft', 'applying', 'failed'] } },
      { $set: { status: 'applying', ...(chosen ? { appliedOption: chosen } : {}) } },
      { new: true },
    )
    .lean();
  if (!claimed) {
    const current = await Proposal().findById(p._id).lean();
    if (current?.status === 'applied') return { proposal: current, ...current.result };
    throw conflict(`${p.proposalCode} is ${current?.status ?? 'gone'}`);
  }

  const stamp = String(p._id);
  const ids = new Map();
  const created = [];
  const updated = [];
  try {
    for (const op of [...ops].sort((a, b) => a.seq - b.seq)) {
      const resolve = (value) =>
        mapRefs(value, (n) => {
          if (!ids.has(n)) throw badRequest(`Step ${op.seq + 1} needs step ${n + 1} first`);
          return ids.get(n);
        });
      const mod = getModule(op.module);
      if (op.op === 'create') {
        const doc = await records.create(ctx, op.module, resolve(op.data ?? {}), {
          source: 'rest',
          stamp: { proposalId: stamp, seq: op.seq },
        });
        ids.set(op.seq, String(doc._id));
        created.push(refOf(mod, doc));
      } else {
        const { after } = await records.update(ctx, op.module, resolve(op.id), resolve(op.data ?? {}), {
          source: 'rest',
        });
        ids.set(op.seq, String(after._id));
        updated.push(refOf(mod, after));
      }
      await Proposal().updateOne({ _id: p._id }, { $set: { appliedOps: op.seq + 1 } });
    }
  } catch (err) {
    await setStatus(ctx, p, { status: 'failed', error: String(err.message ?? err).slice(0, 1000) });
    throw err;
  }

  const result = { created, updated };
  const planOp = ops.find((o) => o.module === 'productionplans');
  const planId = planOp ? ids.get(planOp.seq) : null;
  if (p.kind === 'production' && planId && p.feasibility) {
    const { feasible, projectedFinish, slackHours, shortfall, notes } = p.feasibility;
    await getModule('productionplans').Model.updateOne(
      { _id: planId, companyId: ctx.companyId },
      { $set: { feasibility: { feasible, projectedFinish, slackHours, shortfall, notes } } },
    );
  }
  const proposal = await setStatus(ctx, p, {
    status: 'applied',
    appliedAt: new Date(),
    appliedBy: ctx.userId,
    result,
    error: null,
    ...(planId ? { productionPlanId: planId } : {}),
  });
  return { proposal, created, updated };
};

/** draft | stale | failed → discarded; owner/admin or the proposal's creator. */
export const discardProposal = async (ctx, idOrCode) => {
  const p = await getProposal(ctx, idOrCode);
  if (!FULL_ACCESS.includes(ctx.role) && String(p.createdBy) !== String(ctx.userId)) {
    throw forbidden('Only owners, admins or whoever made the plan can discard it');
  }
  if (!['draft', 'stale', 'failed'].includes(p.status))
    throw conflict(`${p.proposalCode} is ${p.status} and can't be discarded`);
  return setStatus(ctx, p, { status: 'discarded' });
};

/** Proposal + calendar → the `plan` block (current bookings plain, the proposal's changes as ghosts). */
export const toPlanBlock = (ctx, proposal, calendar) => {
  const gantt = calendarToGantt(ctx, calendar);
  const ghosts = (proposal.diff?.bars ?? []).map((b) => ({ ...b, ghost: true }));
  const ghostIds = new Set(ghosts.map((b) => b.id));
  const changedRows = new Set(ghosts.map((b) => b.rowId));
  const options = proposal.kind === 'maintenance' ? (proposal.options ?? []) : [];
  return {
    ...gantt,
    range: proposal.horizon?.start && proposal.horizon?.end ? proposal.horizon : gantt.range,
    rows: [
      ...gantt.rows.filter((r) => changedRows.has(r.id)),
      ...gantt.rows.filter((r) => !changedRows.has(r.id)),
    ],
    bars: [...ghosts, ...gantt.bars.filter((b) => !ghostIds.has(b.id))].slice(0, 300),
    title: proposal.title,
    proposal: {
      id: String(proposal._id),
      code: proposal.proposalCode,
      kind: proposal.kind,
      status: proposal.status,
      title: proposal.title,
    },
    feasibility: proposal.feasibility,
    delays: proposal.diff?.delays ?? [],
    ...(options.length
      ? {
          options: options.map((o) => ({
            id: o.id,
            label: o.label,
            lateHours: o.lateHours,
            delayHours: o.delayHours,
            maintenanceLateHours: o.maintenanceLateHours,
            recommended: o.id === proposal.recommendedOption,
            ...(o.risk ? { risk: o.risk } : {}),
          })),
        }
      : {}),
    risks: proposal.risks ?? [],
    alternatives: proposal.alternatives ?? [],
  };
};

/** Builds the proposal's calendar (its horizon and machines) and returns its plan block. */
export const planBlockFor = async (ctx, proposal) => {
  const start = proposal.horizon?.start ?? new Date();
  const end = proposal.horizon?.end ?? new Date(new Date(start).getTime() + 7 * 86_400_000);
  const calendar = await buildCalendar(ctx, {
    start,
    end,
    // Ghost bars can sit on machines without a task (the 'move' option's new card on the mould's other machine).
    assetIds: proposal.assetIds?.length
      ? [
          ...new Set([
            ...proposal.assetIds.map(String),
            ...(proposal.diff?.bars ?? []).map((b) => String(b.rowId)),
          ]),
        ]
      : [],
    plantId: proposal.plantId ?? null,
  });
  return toPlanBlock(ctx, proposal, calendar);
};
