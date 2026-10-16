import { Router } from 'express';
import { z } from 'zod';
import { attachDetections } from '../ai/anomaly/scoring.js';
import { requireSuperAdmin } from '../auth/middleware.js';
import { env } from '../config/env.js';
import {
  activeEventFilter,
  isActiveEvent,
  ONLINE_WINDOW_MS,
  SimActivity,
  SimControl,
  SimEvent,
  SimInstance,
  SimState,
} from '../db/models/Sim.js';
import { badRequest, conflict, parseOrThrow } from '../lib/errors.js';
import { isObjectIdString } from '../lib/ids.js';
import { getModule } from '../modules/registry.js';
import { simulatedCompany } from '../sim/simulatedCompany.js';
import { FIELD_NAME } from '../telemetry/catalog.js';
import { dbNow } from '../telemetry/dbClock.js';

/**
 * Superadmin control plane of the simulator (docs/simulator-v2.md §6). Nothing talks to the simulator
 * directly: this writes `simcontrol` and `simevents`, the simulator reads them every 3 s.
 */
export const adminSimRouter = Router();
adminSimRouter.use(requireSuperAdmin);

const Model = (name) => getModule(name).Model;
const MINUTE = 60_000;
const COUNTED = ['users', 'assets', 'workorders', 'jobcards', 'requests'];
const ROLE_ORDER = ['owner', 'admin', 'technician', 'view'];

const objectId = z.string().refine(isObjectIdString, 'Not a valid id');
const blankToUndefined = (v) => (v === '' ? undefined : v);

const schemas = {
  control: z
    .object({
      running: z.boolean().optional(),
      telemetryTickMs: z.number().int().min(1000).max(60_000).optional(),
      humanActivity: z.boolean().optional(),
      humanSpeed: z.number().min(1).max(120).optional(),
      respondToAnomalies: z.boolean().optional(),
    })
    .strict()
    .refine((body) => Object.keys(body).length > 0, 'Nothing to change'),
  backfill: z.object({ days: z.number().int().min(1).max(30) }),
  inject: z.object({
    assetId: objectId,
    scenario: z.string().trim().min(1).max(64),
    severity: z.enum(['low', 'medium', 'high']),
    rampMin: z.number().min(1).max(240),
    holdMin: z.number().min(0).max(1440),
    field: z.string().regex(FIELD_NAME, 'Not a valid field name').optional(),
  }),
  clear: z
    .object({ eventId: objectId.optional(), all: z.boolean().optional() })
    .refine((body) => Boolean(body.eventId || body.all), 'Say which injection to clear, or clear all'),
  list: z.object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
    before: z.preprocess(blankToUndefined, z.coerce.date().optional()),
  }),
};

/** The control document, or its defaults when the simulator has not created it yet. */
const loadControl = async () => (await SimControl.findById('default').lean()) ?? new SimControl().toObject();

/** Every simulator that ever reported, newest heartbeat first. */
const loadInstances = async () => {
  const now = await dbNow();
  const docs = await SimInstance.find().sort({ lastSeenAt: -1 }).lean();
  return docs.map((doc) => ({
    ...doc,
    id: doc._id,
    online: Boolean(doc.lastSeenAt) && now - new Date(doc.lastSeenAt).getTime() < ONLINE_WINDOW_MS,
  }));
};

const assetNames = async (ids) => {
  const assets = await Model('assets')
    .find({ _id: { $in: ids } })
    .select('name')
    .lean();
  return new Map(assets.map((a) => [String(a._id), a.name]));
};

/** Injection docs as the UI shows them: with `id`, the machine name and whether it still acts. */
const eventViews = async (events) => {
  const names = await assetNames(events.map((e) => e.assetId));
  const now = await dbNow();
  return events.map((e) => ({
    ...e,
    id: String(e._id),
    assetName: names.get(String(e.assetId)) ?? null,
    active: isActiveEvent(e, now),
  }));
};

const describeCompany = async (company) => {
  const [state, ...counts] = await Promise.all([
    SimState.findById(company._id).select('seededAt').lean(),
    ...COUNTED.map((name) => Model(name).countDocuments({ companyId: company._id, deleted: { $ne: true } })),
  ]);
  return {
    id: String(company._id),
    name: company.name,
    domain: company.domain ?? null,
    seededAt: state?.seededAt ?? null,
    counts: Object.fromEntries(COUNTED.map((name, i) => [name, counts[i]])),
  };
};

/** Upserts the control document; a new one names the simulated company like the simulator would. */
const saveControl = async (filter, $set) => {
  const company = await simulatedCompany();
  return SimControl.findOneAndUpdate(
    { _id: 'default', ...filter },
    { $set, $setOnInsert: { companyId: company?._id ?? null } },
    { new: true, upsert: true },
  ).lean();
};

adminSimRouter.get('/status', async (_req, res) => {
  const [serverTime, control, instances, company] = await Promise.all([
    dbNow(),
    loadControl(),
    loadInstances(),
    simulatedCompany(),
  ]);
  const active = company
    ? await SimEvent.find({ companyId: company._id, ...activeEventFilter(serverTime) })
        .sort({ startedAt: -1 })
        .lean()
    : [];
  res.json({
    serverTime, // MongoDB's clock, which every simulator time follows
    control,
    instances,
    company: company && (await describeCompany(company)),
    scenarios: instances.find((i) => i.online)?.scenarios ?? [],
    injections: await eventViews(active),
  });
});

adminSimRouter.patch('/control', async (req, res) => {
  const patch = parseOrThrow(schemas.control, req.body, 'simulation settings');
  res.json({ control: await saveControl({}, { ...patch, updatedBy: req.user._id }) });
});

adminSimRouter.post('/backfill', async (req, res) => {
  const { days } = parseOrThrow(schemas.backfill, req.body, 'backfill');
  const backfill = {
    status: 'requested',
    days,
    requestedAt: new Date(await dbNow()),
    requestedBy: req.user._id,
    progress: 0,
  };
  try {
    // Matches only when no backfill is waiting or running; otherwise the upsert hits the existing _id.
    const control = await saveControl(
      { 'backfill.status': { $nin: ['requested', 'running'] } },
      { backfill, updatedBy: req.user._id },
    );
    res.json({ control });
  } catch (err) {
    if (err.code === 11000) throw conflict('A backfill is already waiting or running');
    throw err;
  }
});

adminSimRouter.post('/inject', async (req, res) => {
  const body = parseOrThrow(schemas.inject, req.body, 'injection');
  const [company, instances] = await Promise.all([simulatedCompany(), loadInstances()]);
  const asset = company
    ? await Model('assets')
        .findOne({ _id: body.assetId, companyId: company._id, deleted: { $ne: true } })
        .select('name typeOfAsset')
        .lean()
    : null;
  if (!asset) throw badRequest('That machine is not in the simulated company');
  const simulator = instances.find((i) => i.online);
  if (!simulator) throw conflict('No simulator is online. Start it, then try again.');
  const scenario = (simulator.scenarios ?? []).find((s) => s.id === body.scenario);
  if (!scenario) throw badRequest(`The simulator does not offer the "${body.scenario}" scenario`);
  if (scenario.appliesTo?.length && !scenario.appliesTo.includes(asset.typeOfAsset)) {
    throw badRequest(`${scenario.label ?? scenario.id} does not apply to a ${asset.typeOfAsset}`);
  }

  const startedAt = new Date(await dbNow());
  const event = await SimEvent.create({
    ...body,
    companyId: company._id,
    affects: scenario.affects ?? [],
    startedAt,
    endsAt: new Date(startedAt.getTime() + (body.rampMin + body.holdMin) * MINUTE),
    createdBy: req.user._id,
  });
  const [view] = await eventViews([event.toObject()]);
  res.status(201).json({ event: view });
});

adminSimRouter.post('/clear', async (req, res) => {
  const body = parseOrThrow(schemas.clear, req.body, 'clear request');
  const company = await simulatedCompany();
  if (!company) return res.json({ cleared: 0 });
  const now = await dbNow();
  const { modifiedCount } = await SimEvent.updateMany(
    { companyId: company._id, ...activeEventFilter(now), ...(body.all ? {} : { _id: body.eventId }) },
    { $set: { clearedAt: new Date(now), clearedReason: 'superadmin', clearedBy: req.user._id } },
  );
  res.json({ cleared: modifiedCount });
});

adminSimRouter.get('/events', async (req, res) => {
  const { limit } = parseOrThrow(schemas.list, req.query, 'filter');
  const company = await simulatedCompany();
  const events = company
    ? await SimEvent.find({ companyId: company._id }).sort({ startedAt: -1, _id: -1 }).limit(limit).lean()
    : [];
  res.json({ events: await attachDetections(await eventViews(events)) });
});

adminSimRouter.get('/activity', async (req, res) => {
  const { limit, before } = parseOrThrow(schemas.list, req.query, 'filter');
  const company = await simulatedCompany();
  const activity = company
    ? await SimActivity.find({ companyId: company._id, ...(before ? { at: { $lt: before } } : {}) })
        .sort({ at: -1, _id: -1 })
        .limit(limit)
        .lean()
    : [];
  res.json({ activity: activity.map((a) => ({ ...a, id: String(a._id) })) });
});

adminSimRouter.get('/credentials', async (_req, res) => {
  const company = await simulatedCompany();
  const [users, plants] = company
    ? await Promise.all([
        Model('users')
          .find({ companyId: company._id, deleted: { $ne: true } })
          .select('email firstName lastName role userTitle department shiftId')
          .lean(),
        Model('plants').find({ companyId: company._id }).select('shifts').lean(),
      ])
    : [[], []];
  const shiftName = new Map(plants.flatMap((p) => (p.shifts ?? []).map((s) => [String(s._id), s.shiftName])));
  const rank = (role) => (ROLE_ORDER.includes(role) ? ROLE_ORDER.indexOf(role) : ROLE_ORDER.length);
  users.sort(
    (a, b) => rank(a.role) - rank(b.role) || a.email.localeCompare(b.email, 'en', { numeric: true }),
  );
  res.json({
    users: users.map((u) => ({
      email: u.email,
      name: [u.firstName, u.lastName].filter(Boolean).join(' '),
      role: u.role,
      title: u.userTitle ?? null,
      department: u.department ?? null,
      shift: shiftName.get(String(u.shiftId)) ?? null,
    })),
    password: env.SIM_DEFAULT_PASSWORD,
  });
});

adminSimRouter.get('/assets', async (_req, res) => {
  const company = await simulatedCompany();
  const [assets, plants] = company
    ? await Promise.all([
        Model('assets')
          .find({ companyId: company._id, deleted: { $ne: true } })
          .select(
            'name assetTag typeOfAsset assetStatus plantId isProductionAsset isEnergyAsset isSensorIntegration',
          )
          .sort({ name: 1 })
          .lean(),
        Model('plants').find({ companyId: company._id }).select('name').lean(),
      ])
    : [[], []];
  const plantName = new Map(plants.map((p) => [String(p._id), p.name]));
  res.json({
    assets: assets.map((a) => ({
      id: String(a._id),
      name: a.name,
      tag: a.assetTag ?? null,
      type: a.typeOfAsset,
      status: a.assetStatus ?? null,
      plantName: plantName.get(String(a.plantId)) ?? null,
      isProductionAsset: Boolean(a.isProductionAsset),
      isEnergyAsset: Boolean(a.isEnergyAsset),
      isSensorIntegration: Boolean(a.isSensorIntegration),
    })),
  });
});
