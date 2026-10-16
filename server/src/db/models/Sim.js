import mongoose from 'mongoose';

const { ObjectId, Mixed } = mongoose.Schema.Types;

/**
 * Simulator v2 shared collections (docs/simulator-v2.md §1). The simulator writes them with the raw
 * MongoDB driver; SARA's superadmin writes `simcontrol` and creates `simevents`. Platform-level: the
 * AI never reads them.
 */

/** A simulator counts as online while its heartbeat is newer than this. */
export const ONLINE_WINDOW_MS = 15_000;
/** After it ends (or is cleared) an injection fades out over this long. */
export const FADE_MS = 2 * 60_000;

/** Idempotency marker, one per simulated company (`_id` = company id): present = seeded, never seed again. */
const simStateSchema = new mongoose.Schema(
  {
    _id: { type: ObjectId, required: true },
    slug: String,
    seedVersion: { type: Number, default: 1 },
    seededAt: Date,
    lastTelemetryAt: Date,
    historyDays: Number,
    backfillDays: Number,
  },
  { collection: 'simstate', versionKey: false },
);

/** Runtime switches set by the superadmin; the simulator reads them every 3 s (and creates the doc if missing). */
const simControlSchema = new mongoose.Schema(
  {
    _id: { type: String, default: 'default' },
    companyId: { type: ObjectId, ref: 'Company', default: null },
    running: { type: Boolean, default: true },
    telemetryTickMs: { type: Number, default: 5000 },
    humanActivity: { type: Boolean, default: true },
    humanSpeed: { type: Number, default: 1 },
    respondToAnomalies: { type: Boolean, default: false },
    backfill: {
      status: { type: String, enum: ['idle', 'requested', 'running', 'done', 'error'], default: 'idle' },
      days: Number,
      requestedAt: Date,
      requestedBy: { type: ObjectId, ref: 'User' },
      startedAt: Date,
      finishedAt: Date,
      progress: { type: Number, default: 0 },
      error: String,
      note: String, // what the simulator filled, in words
    },
    updatedBy: { type: ObjectId, ref: 'User', default: null },
  },
  {
    collection: 'simcontrol',
    timestamps: { createdAt: false, updatedAt: true },
    minimize: false,
    versionKey: false,
  },
);

/** One running simulator (`_id` = its SIM_INSTANCE), rewritten every 3 s. */
const simInstanceSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    name: String,
    hostname: String,
    platform: String,
    version: String,
    companyId: { type: ObjectId, ref: 'Company', default: null },
    startedAt: Date,
    lastSeenAt: Date,
    // { uptimeSec, running, tickMs, humanSpeed, pointsWritten, pointsPerSec, bufferSize, droppedPoints,
    //   influxErrors, mongoErrors, cpuTempC, lastError, backfill: { active, progress }, people: { onShift, busy, actionsToday } }
    stats: { type: Mixed, default: {} },
    statuses: { type: Mixed, default: {} }, // { <assetId>: status }
    injections: { type: Mixed, default: [] }, // [{ id, assetId, scenario, phase, progress }]
    scenarios: { type: Mixed, default: [] }, // catalogue [{ id, label, description, appliesTo, affects }]
    profiles: { type: Mixed, default: {} }, // { <assetType>: [{ measurement, field, unit, type, normalMin, normalMax }] }
  },
  { collection: 'siminstances', minimize: false, versionKey: false },
);

/**
 * Injected anomalies: SARA creates them (ground truth), the simulator applies them and writes phase/progress.
 * Active = no `clearedAt` and now < endsAt + FADE_MS, or an unrepaired breakdown (see isActiveEvent).
 */
const simEventSchema = new mongoose.Schema(
  {
    companyId: { type: ObjectId, required: true },
    assetId: { type: ObjectId, required: true },
    scenario: { type: String, required: true },
    severity: { type: String, enum: ['low', 'medium', 'high'], default: 'medium' },
    rampMin: { type: Number, required: true },
    holdMin: { type: Number, required: true },
    field: String,
    affects: { type: [String], default: [] },
    startedAt: { type: Date, required: true },
    endsAt: { type: Date, required: true },
    clearedAt: { type: Date, default: null },
    clearedReason: { type: String, enum: ['superadmin', 'repair', 'expired', null], default: null },
    clearedBy: { type: Mixed, default: null }, // the superadmin's user id, or what the repair recorded (its work order)
    phase: { type: String, enum: ['ramp', 'hold', 'fade', 'done'], default: 'ramp' },
    progress: { type: Number, default: 0 },
    createdBy: { type: ObjectId, ref: 'User' },
  },
  { timestamps: true, collection: 'simevents', versionKey: false },
);
simEventSchema.index({ companyId: 1, startedAt: -1 });

/** One document per simulated human action, kept 14 days. */
const simActivitySchema = new mongoose.Schema(
  {
    companyId: { type: ObjectId, required: true },
    at: { type: Date, required: true },
    actor: { userId: { type: ObjectId, ref: 'User' }, name: String, role: String, title: String },
    action: { type: String, required: true },
    summary: { type: String, required: true },
    target: { module: String, id: Mixed, code: String },
    details: { type: Mixed, default: {} },
  },
  { collection: 'simactivity', minimize: false, versionKey: false },
);
simActivitySchema.index({ at: 1 }, { expireAfterSeconds: 14 * 86_400 });
simActivitySchema.index({ companyId: 1, at: -1 });

/** Normal band per asset type and field, advertised by the simulator (or set by an OEM manual). */
const parameterSpecSchema = new mongoose.Schema(
  {
    assetType: { type: String, required: true },
    measurement: { type: String, required: true },
    field: { type: String, required: true },
    unit: String,
    valueType: { type: String, enum: ['number', 'string', 'boolean'], default: 'number' },
    normalMin: Number,
    normalMax: Number,
  },
  { timestamps: true, collection: 'parameterspecs' },
);
parameterSpecSchema.index({ assetType: 1, measurement: 1, field: 1 }, { unique: true });

const model = (name, schema) => mongoose.models[name] ?? mongoose.model(name, schema);

export const SimState = model('SimState', simStateSchema);
export const SimControl = model('SimControl', simControlSchema);
export const SimInstance = model('SimInstance', simInstanceSchema);
export const SimEvent = model('SimEvent', simEventSchema);
export const SimActivity = model('SimActivity', simActivitySchema);
export const ParameterSpec = model('ParameterSpec', parameterSpecSchema);

/** The machine stays Stopped until its repair work order completes, so the simulator keeps it past the fade. */
const STAYS_UNTIL_REPAIRED = 'sudden_breakdown';

/** True while an uncleared injection still acts on a machine at `now`. */
export const isActiveEvent = (event, now = Date.now()) =>
  !event.clearedAt &&
  (new Date(event.endsAt).getTime() + FADE_MS > now || event.scenario === STAYS_UNTIL_REPAIRED);

/** Query filter matching `isActiveEvent`. */
export const activeEventFilter = (now = Date.now()) => ({
  clearedAt: null,
  $or: [{ endsAt: { $gt: new Date(now - FADE_MS) } }, { scenario: STAYS_UNTIL_REPAIRED }],
});
