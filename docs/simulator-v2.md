# SARA simulator v2 — the plant "digital twin" (binding contract)

Replaces `docs/simulator-protocol.md` (device keys + HTTP ingest are removed). Requirements from the user:

1. The simulator has the **MongoDB URL** and the **InfluxDB URL** (writes both directly).
2. On its very first run it creates **one company** with **20 assets** and data for **every module**.
3. It **automates people's work**: completing work orders, running job cards, requests, PMs, stock, attendance…
4. It **streams telemetry for all 20 machines** of different types (IMM, press, CNC, utilities…).
5. First run creates **1 owner, 3 admins and 20+ technicians** across the Maintenance and Production departments,
   so maintenance and production planning have real people and data.
6. **Superadmin anomaly triggers** (per asset, per anomaly type) change the generated data accordingly.
7. The simulation works for **that one company only**; seeding happens **once** (never duplicated on restart).
8. `.env.example` documents every setting.
9. It behaves **like real humans**: shift-bound, with realistic delays, durations, comments, pauses and mistakes.

```
sara-simulator (Pi / laptop)                         SARA server (Express)              Browser
  seed (once) ─────────────┐                           │                                  ▲
  machines → line protocol ├──▶ InfluxDB bucket=<companyId>                                │
  machine state (status, downtime, job counters) ──┐   │ live poller (3 s): Influx + Mongo ─┤ /api/live SSE
  people (WOs, job cards, requests, PMs, stock, …) ├──▶ MongoDB (same database) ◀──────────┤ REST
  control loop (3 s) ◀── simcontrol / simevents ───┘   │ superadmin writes control + injections
              └──▶ siminstances heartbeat, simactivity log, parameterspecs
```

## 1. Shared collections (schemas live in `sara/server/src/db/models/Sim.js`; the simulator writes raw docs)

| collection | writer | shape |
|---|---|---|
| `simstate` | simulator | `{ _id: <companyId ObjectId>, slug, seedVersion: 1\|2, seededAt, lastTelemetryAt, historyDays, backfillDays }` — **idempotency marker**: if it exists for the configured slug, seeding is skipped (later seed steps run once while `seedVersion` is lower, see §3) |
| `simcontrol` | SARA superadmin (simulator reads every 3 s; creates it with defaults if missing) | `{ _id: 'default', companyId, running: true, telemetryTickMs: 5000, humanActivity: true, humanSpeed: 1, respondToAnomalies: false, backfill: { status: 'idle'\|'requested'\|'running'\|'done'\|'error', days, requestedAt, requestedBy, startedAt, finishedAt, progress, error, note }, updatedAt, updatedBy }` |
| `siminstances` | simulator (every 3 s) | `{ _id: <SIM_INSTANCE>, name, hostname, platform, version, companyId, startedAt, lastSeenAt, stats: { uptimeSec, running, tickMs, humanSpeed, pointsWritten, pointsPerSec, bufferSize, droppedPoints, influxErrors, mongoErrors, cpuTempC, lastError, backfill: { active, progress }, people: { onShift, busy, actionsToday } }, statuses: { <assetId>: status }, injections: [{ id, assetId, scenario, phase, progress }], scenarios: [catalogue], profiles: { <type>: [spec] } }` — online = `lastSeenAt` within 15 s |
| `simevents` | SARA creates (ground truth); simulator updates progress | `{ companyId, assetId, scenario, severity: low\|medium\|high, rampMin, holdMin, field?, affects: [field], startedAt, endsAt, clearedAt, clearedReason: 'superadmin'\|'repair'\|'expired', clearedBy, phase: 'ramp'\|'hold'\|'fade'\|'done', progress, createdBy }` — **active** = no `clearedAt` and `now < endsAt + 2 min fade`, except a `sudden_breakdown`, which stays active until its repair work order completes (the simulator then clears it with `clearedReason: 'repair'`, `clearedBy: <WO code>`); the simulator never reads ground truth for anything but applying it |
| `simactivity` | simulator (TTL 14 d) | `{ companyId, at, actor: { userId, name, role, title }, action, summary, target: { module, id, code }, details }` — one doc per simulated human action; `summary` is a plain sentence ("Ramesh Kumar started WO-112 · Hydraulic oil leak (IMM 3)") |
| `parameterspecs` | simulator upserts at start | `{ assetType, measurement, field, unit, valueType, normalMin, normalMax }` (unique assetType+measurement+field) |

InfluxDB: bucket = company id (24-hex), created by the simulator if missing; measurements `energy`,
`machineParams`, `sensorData`, `shotCountDetails`, `timelineData`, `qualityEvents`; tags `companyId`, `assetId`,
`status`; numbers always floats; points written with `POST /api/v2/write?org=&bucket=&precision=ms`
(gzip line protocol, ≤ 5 000 lines per request, retry with backoff on network/5xx/429, 50 000-point ring
buffer dropping oldest non-`timelineData` first). Field names per type are unchanged from v1 (see
`sara-simulator/README.md` and `sara/server/src/telemetry/catalog.js` `KEY_FIELDS`).

## 2. Simulator modules (`sara-simulator/src/`)

Dependencies: `mongodb` (official driver), `luxon`, `bcryptjs`. Node ≥ 22, ESM, no other packages.

| module | owns |
|---|---|
| `config.js` | env parsing/validation (see §5), frozen config object |
| `db.js` | `connect()` → `{ client, db }`, `col(name)`, `oid(seed)` re-export, graceful close |
| `ids.js` | `oid(seed)` (sha1 → ObjectId, **same algorithm as SARA**), `prng(seed)` |
| `shifts.js` | port of `sara/server/src/lib/shifts.js` (`shiftWindows`, `shiftAt`, `isWorkingTime`, `workingIntervals`) |
| `influx.js` | `createInfluxWriter({ url, token, org, bucket })` → `{ write(points), flush(), stats(), close() }` + `ensureBucket()` |
| `seed/` | `ensureSeeded(db, cfg)` → `{ companyId, created: boolean }`; blueprint + generators (see §3) |
| `world.js` | loads the company world from Mongo every 30 s: plants (+ shift windows next 48 h), assets, in-progress/open job cards with tools, open maintenance WOs per asset, users (by role/shift) — the "config" v1 received by command |
| `machine.js`, `profiles.js`, `scenarios.js` | v1 physics, profiles and scenario catalogue (kept); status now also follows the world (see §4) |
| `state/` | **machine-derived Mongo state** (port of `sara/server/src/telemetry/stateTracker.js`): asset `assetStatus/assetStatusSince/isActiveMaintenance`, `downtimes` (open on Stopped; OFF only inside a shift; OFF clipped at the shift end; Stopped↔OFF states; close on Running/Idle/Maintenance; requiresVerification), job card counters (`totalShotCount`, `operations.0.progress.partsOut/partsRejected`), `tools.shotCount`, `partcounts` per shift, `rejections` from quality events; backfill mode = downtime history only |
| `people/` | the human simulation (see §4): scheduler, personas, domain helpers |
| `domain/` | write helpers that mirror SARA's business rules exactly: `counters.js` (`nextCode(companyId, plantId, type, prefix)` atomic `$inc` on `counters`), `workOrders.js` (create, assign, status transitions + stamping identical to `sara/server/src/modules/actions/workOrders.js`, comments, spare part consumption FIFO with `sparepartstransactions` "used" rows and lot decrement), `requests.js` (request + auto WO like `actions/requests.js`), `jobCards.js` (start, progress, complete with `completionMetrics`), `stock.js` (reorder/receipt), `notify.js` (notification docs like SARA's `notifyUsers`), `activity.js` (simactivity) |
| `control.js` | every 3 s: read `simcontrol` + active `simevents`; apply running/tick/humanActivity/humanSpeed; start requested backfills; write `siminstances` heartbeat; update injection progress/phase; clear injections on repair |
| `backfill.js` | telemetry history at 1-minute resolution (noise scaled by √(cadence/60 s)) for `BACKFILL_DAYS` on first run, gap backfill on restart (≤ `GAP_BACKFILL_MAX_HOURS`), superadmin-requested backfills (only for periods **without** data: from `max(now−days, lastTelemetryAt)`) |
| `index.js` | orchestration: config → connect → ensureSeeded → specs → ensureBucket → backfill (first run / gap) → start loops (machines 1 s, state, people 15 s, world 30 s, control 3 s); SIGINT/SIGTERM: stop loops, set every machine OFF (timeline point + asset status) so nothing looks live, flush, close |

All Mongo writes set `updatedAt` (and `createdAt` on insert) and the exact field names of SARA's registry
(`sara/server/src/modules/defs/*.js`). Every created document carries `companyId` and, where the module is
plant-scoped, `plantId`. SARA's `pnpm validate-db` must report **zero** schema errors for the company.

## 3. Seed (first run, then versioned steps)

Deterministic ids `oid(`${slug}:${key}`)` and PRNG seeded by the slug. Company: `COMPANY_NAME`,
`COMPANY_DOMAIN`, industry "Automotive components", `isSimulated: true`, features production + energy on,
preferences Asia/Kolkata (`TIME_ZONE`), INR. **One plant** `PLANT_NAME` (code from name) with shifts A 06:00–14:00
(tea 09:00–09:15, lunch 11:30–12:00), B 14:00–22:00 (tea 17:00–17:15, dinner 19:30–20:00), C 22:00–06:00 (tea
01:00–01:15, meal 02:00–02:30), Monday–Saturday, holidays, energy tariffs (₹7.8 → ₹8.4 from 2026-07-01),
emission factor 0.71.

**People** (password `SIM_USER_PASSWORD`, bcrypt 10 rounds, emails `<key>@<domain>`; `shiftId` = plant shift
`_id`; technicians get permission presets as in `sara/server/src/sim/blueprint.js`):

| role | count | keys (title, department, shift) |
|---|---|---|
| owner | 1 | `owner_1` (Managing Director, company-wide) |
| admin | 3 | `plant_manager_1` (Plant Manager, Production), `maintenance_manager_1` (Maintenance Manager, Maintenance), `production_manager_1` (Production Manager, Production) — all shift A |
| technician (Maintenance) | 11 | `maintenance_technician_1..8` (skills: mechanical ×3, electrical ×2, hydraulics ×1, utilities ×1, instrumentation ×1; shifts A,A,A,B,B,B,C,C), `tool_setter_1` (Tool Setter, A), `store_keeper_1` (Store Keeper, A), `maintenance_planner_1` (Maintenance Planner, A) |
| technician (Production) | 12 | `production_supervisor_1..2` (A, B), `production_technician_1..8` (Machine Operator, shifts A,A,A,B,B,B,C,C), `quality_inspector_1..2` (A, B) |
| view | 1 | `viewer_1` (Management Viewer) |

**20 assets** (all in the plant; production machines also `isEnergyAsset`):

| tags | type | flags |
|---|---|---|
| IMM-01..06 "IMM 1".."IMM 6" | Injection Moulding Machine | production, energy |
| PRS-01..04 "Press 1".."Press 4" | Power Press | production, energy |
| CNC-01..04 "CNC 1".."CNC 4" | CNC Machine | production, energy |
| CMP-01..02 "Compressor 1..2" | Compressor | energy, sensors |
| CHL-01 "Chiller 1" | Chiller | energy, sensors |
| FUR-01..02 "Furnace 1..2" | Furnace | energy, sensors |
| EM-MAIN "Main Incomer" | Energy Meter | energy |

Plus every module: ~12 moulds/dies/fixtures (3 Housing-A moulds on different IMMs so planning can split work),
3 customers, 5 vendors (incl. a duplicate "ABC Tools"), 4 suppliers, 14 spare parts with lots (4 below
minimum), 4 consumables, 4 teams, cost settings, a PM for every machine (some due within 7 days) and 4
calibrations, 3 checklists, `HISTORY_DAYS` (60) of closed/completed work orders with consumption and labour,
requests linked to breakdown WOs, 4 open production plans with completed + in-progress + planned job cards
(at least one machine left free for zero-impact maintenance), notifications, and `ATTENDANCE_DAYS` (14) of
check-ins/breaks. Counters set to the highest numbers used. Telemetry history: `BACKFILL_DAYS` (7).

**Seed versions.** `simstate.seedVersion` records which seed steps ran; the company is never reseeded. Step 1
(above) writes `seedVersion: 1`. Step 2 (`src/seed/extras.js`, `seedVersion: 2`) runs on every start while
`seedVersion < 2` (on a fresh seed right after step 1), upserts by deterministic id with `$setOnInsert` (an
existing or user-edited doc is never overwritten, a second run writes nothing), then sets `seedVersion: 2`:
- 5 **tags** (Safety, Energy saving, Kaizen, Customer complaint, Shutdown job);
- **bin tracking on** (`features.binTrackingEnabled`), `binStations` Quality inspection / Packing / Dispatch
  (only if empty); 6 **bins** `RF-B001..006` (in production on IMM 1, at inspection, at packing, dispatched,
  empty in store, broken) with scan history; 4 **binsessions** (one per filled bin, stages at_machine →
  dispatched) and 3 **stationpools** (open, drained, closed) on JC-11/12/13/15;
- 3 **workflowrules** `RULE-1..3` (IMM 1 oil > 55 °C for 10 min → WO + notify, Compressor 1 discharge
  > 7.8 bar → notify, Press 2 vibration > 6 mm/s → WO) and the `WorkflowRule` counter at 3;
- 3 **scheduledreports** (daily production, weekly maintenance, monthly master) with `nextRunAt` in the
  company zone;
- 2 example **costalerts** (Compressor 2 energy > ₹3,000/day, plant maintenance > ₹1,00,000/week).

Holidays stay on the plant (`plants.holidays`, edited on the Plants page and read by `lib/shifts.js`): there
is no separate holidays module, so there is one source of truth.

## 4. Behaviour

### Machines
Status order of precedence: `Maintenance` while a maintenance WO on the asset is In Progress (machine paused,
low power); `Stopped` while a breakdown is active (random stop, `sudden_breakdown` injection, or a stop that
escalated to a breakdown WO that is not yet completed); `OFF` outside shifts (utilities start 30 min early);
`Running` when a job card is In Progress on it (utilities: v1 rules); otherwise `Idle`. Random minor stops
(Running→Stopped ≈0.3 %/min, 5–40 min); 10 % of stops become **breakdowns** that last until the repair WO is
completed. Telemetry cadence as v1. Shot counts and quality events only while Running with a job.

### People (tick 15 s real time; durations divided by `humanSpeed`)
Everyone acts only during their shift, outside breaks, after checking in. Delays and durations are lognormal
around the medians below. Every action writes Mongo docs exactly as SARA would, a `simactivity` entry, and the
notifications SARA would send.

| persona | behaviour |
|---|---|
| everyone | check in at shift start + 0–15 min (5 % absent days), breaks per shift (`userbreaktimes`), check out at shift end + 0–20 min (`checkinouts` with duration); `users.status` busy while working |
| maintenance manager / planner | every 10 min assign unassigned open WOs to an on-shift, available technician with a matching skill (Electrical→electrical, Hydraulic→hydraulics, Utilities assets→utilities, Calibration→instrumentation, else mechanical); generate PM/calibration WOs when `nextGenerationDate` ≤ now (template, `scheduleType 'Time Based'`, `pmId`/`calibrationId`, due = now + dueDuration) and advance the next date by the cycle; close Completed WOs after ~2 h with rating 3–5; close requests whose WO is done. Off-shift, the senior technician on shift self-assigns. |
| maintenance technician | picks the next assigned Open/Re Open WO (priority, due date; never before `plannedStart`); response delay High 10 min / Medium 45 min / Low 3 h; In Progress → asset `Maintenance` (unless Stopped by breakdown); work duration Breakdown 90 min, Preventive = estimatedDurationMin, Electrical 60, Hydraulic 75, Mechanical 70, Inspection 30, Cleaning 40, Calibration 45; ticks checklist tasks over the duration; 50 % of repairs consume 1–2 parts assigned to the asset — if out of stock → On Hold "Waiting for <part> from stores", resumes when stock arrives; 8 % other holds ("Waiting for production to release the machine", 30–120 min); completes with a realistic resolution comment; the asset leaves Maintenance/Stopped; a WO with `anomalyId` (or a breakdown WO raised for an injected breakdown) **clears the matching active injection** (`clearedReason: 'repair'`). |
| production supervisor | at shift start + 10 min and every 30 min: start the next Open job card planned for each free production machine (`startDate` ≤ now + 1 h) or, if none and a production plan still needs parts, create one (JC-n) for an eligible idle tool+machine; complete job cards at target (`completionMetrics`); update plan status (Pending→In Progress→Completed); verify downtimes needing verification (reason from the breakdown WO or a realistic reason). |
| machine operator | when their machine has been Stopped ≥ 8 min with no open breakdown request → raise a request (MR-n, realistic text by machine type) which auto-creates a High breakdown WO like SARA; ~1 %/h small requests ("guard sensor loose"). |
| quality inspector | hourly per running production machine: manual rejection (origin `cmms`) with count around the machine's current reject rate. |
| store keeper | daily 10:00: parts below minimum → "PO raised" activity + notification to the maintenance manager; receipt after the supplier lead time (÷3 when a WO is waiting) as an `add` transaction on the lot. |
| managers (respondToAnomalies) | only if enabled: acknowledge new AI anomalies after 10–30 min and open an inspection WO linked by `anomalyId` for critical ones (off by default so the demo user does it). |

## 5. `sara-simulator/.env`

`MONGO_URI`, `INFLUX_URL`, `INFLUX_TOKEN`, `INFLUX_ORG`, `COMPANY_NAME`, `COMPANY_SLUG` (fixed ids derive from
it), `COMPANY_DOMAIN`, `PLANT_NAME`, `TIME_ZONE`, `SIM_USER_PASSWORD`, `SIM_INSTANCE`, `TICK_MS`,
`HISTORY_DAYS`, `ATTENDANCE_DAYS`, `BACKFILL_DAYS`, `GAP_BACKFILL_MAX_HOURS`, `HUMAN_ACTIVITY`, `HUMAN_SPEED`,
`RESPOND_TO_ANOMALIES`, `SEED`, `LOG_LEVEL`, `BUFFER_MAX`. Runtime values in `simcontrol` (set from the
superadmin page) override `TICK_MS`, `HUMAN_ACTIVITY`, `HUMAN_SPEED`, `RESPOND_TO_ANOMALIES` and running.

## 6. SARA side

- `server/src/db/models/Sim.js`: `SimControl`, `SimInstance` (`siminstances`), `SimEvent` (+ `endsAt`, `clearedReason`,
  `clearedBy`, `affects`, phases ramp/hold/fade/done), `SimActivity` (TTL 14 d), `SimState`, `ParameterSpec`.
- Removed: device keys, `/api/sim/*`, `/api/ingest`, `server/src/sim/devices.js`, `server/src/telemetry/ingestRoutes.js`,
  `server/src/telemetry/stateTracker.js` (moved into the simulator) and their tests.
- `server/src/telemetry/livePoller.js`: for each company with `/api/live` subscribers, every 3 s query Influx
  latest values (last 2 min, per field with its own time) and Mongo changes (asset status/since, new
  notifications, new downtimes, max `updatedAt` of workorders/jobcards/requests/anomalies/productionplans) and
  publish `telemetry { assetId, status, values: { field: value }, times: { field: ms } }`, `status { assetId, status, since }`,
  `notification`, `downtime`, `record { module }` with audience `{ plantId }`; stops when nobody listens.
  `GET /api/telemetry/latest` uses its cache when warm.
- `/api/live`: re-checks the session every 60 s and closes when it expired; record events honour the plant rule.
- Superadmin API `/api/admin/sim` (superAdmin only): `GET /status` → `{ control, instances: [{ …, online }],
  company: { id, name, domain, seededAt, counts: { users, assets, workorders, jobcards, requests } } | null, scenarios,
  injections }`; `PATCH /control` `{ running?, telemetryTickMs (1000–60000)?, humanActivity?, humanSpeed (1–120)?,
  respondToAnomalies? }`; `POST /backfill` `{ days 1–30 }`; `POST /inject` `{ assetId, scenario, severity, rampMin
  1–240, holdMin 0–1440, field? }` (asset must belong to the simulated company, scenario must be in the
  catalogue and apply to the asset type) → `201 { event }`; `POST /clear` `{ eventId? , all? }` (only active ones);
  `GET /events?limit=50`; `GET /activity?limit=50&before=`; `GET /credentials` → `{ users: [{ email, name, role,
  title, department, shift }], password: env.SIM_DEFAULT_PASSWORD }`; `GET /assets`.
- `pnpm seed` creates only the platform tenant + superadmin (`--demo` keeps the old generated test accounts).
  `pnpm validate-db [--company <id>]` validates every document of a company against the registry schemas.
- Registry gains `checkinouts` (Attendance) and `userbreaktimes` (Breaks): `checkinouts { userId→users!, plantId, shiftName, checkInTime!, checkOutTime, duration "HH:MM:SS" }`,
  `userbreaktimes { userId→users!, checkInOutId→checkinouts, plantId, breakType, startTime!, endTime, duration "HH:MM:SS" }`.
- Superadmin → Simulation tab: instance status, company card + credentials dialog (formula-safe CSV), controls
  (running, tick, human activity, speed 1×/2×/5×/10×/30×/60×, respond to anomalies, backfill), anomaly lab
  (asset → scenario → severity/ramp/hold → inject; active injections with phase/progress/clear; history with
  cleared reason, e.g. "Fixed by WO-123"), live activity feed. No device registration and no account wizard.

## 7. Simulator internal API (binding for the parallel packages)

All functions are async unless noted; `db` is a `mongodb` `Db`; times are JS `Date`s from `clock.now()`.

```js
// config.js (core)
export const loadConfig = (env = process.env) => cfg; // frozen:
// { mongoUri, influx: { url, token, org }, company: { name, slug, domain, plantName, timeZone }, userPassword,
//   instance, tickMs, historyDays, attendanceDays, backfillDays, gapBackfillMaxHours, humanActivity, humanSpeed,
//   respondToAnomalies, seed, logLevel, bufferMax }   — throws a clear Error listing every invalid variable

// clock.js (core) — Pi has no RTC: offset from MongoDB's clock (db.command({ hello: 1 }).localTime)
export const clock = { now: () => Date /* sync */, nowMs: () => number /* sync */, sync: async (db) => offsetMs };

// db.js (core)
export const connect = async (uri) => ({ client, db });
export const col = (db, name) => db.collection(name); // sync

// world.js (core) — reloaded every 30 s; `worldRef.current` always holds the latest
export const loadWorld = async (db, companyId, { now }) => ({
  company,                 // companies doc (timeZone = preferences.timeZone)
  plant, windows,          // the plant doc; shiftWindows(plant, now−24h, now+48h, tz) from shifts.js
  assets, assetsById,      // non-deleted assets; Map<string, doc>
  jobs,                    // Map<assetIdString, { jobCard, tool, partsPerShot, cycleTime, partName, target }> (jobStatus 'In Progress')
  openJobs,                // job cards jobStatus 'Open' sorted by startDate
  maintenance,             // Map<assetIdString, workOrder> WOs 'In Progress' on the asset
  users, usersByKey,       // non-deleted users; Map<emailLocalPart, doc> e.g. 'maintenance_technician_1'
  loadedAt,
});

// influx.js (core)
export const createInfluxWriter = ({ url, token, org, bucket, bufferMax, log }) =>
  ({ write: (points /* {m,a,t,s,f} */) => void /* sync enqueue */, flush: async () => void, stats: () => ({ … }), close: async () => void });
export const ensureBucket = async ({ url, token, org, bucket }) => void;

// simulator.js (core) — the machines
export const createSimulator = ({ writer, state, clock, seed, tickMs, worldRef, log }) => ({
  start, stop /* sync */, setTick: (ms) => void,
  applyInjections: (active /* simevents docs */) => void,   // called by control every 3 s
  backfill: async (fromMs, toMs, onProgress) => ({ points }),
  statuses: () => ({ [assetId]: status }), injections: () => [{ id, assetId, scenario, phase, progress }],
  // in-process hooks used by people/
  setMaintenance: (assetId, on /* bool */) => void,          // technician starts/finishes work on the machine
  isBreakdown: (assetId) => boolean, release: (assetId) => void, // breakdown lasts until the repair WO completes
  statusOf: (assetId) => ({ status, since }),
  allOff: async (at) => void,                                 // shutdown: every machine OFF (timeline point + state)
});

// state/index.js (state) — machine-derived Mongo state; the simulator calls ingest() for every batch it writes
export const createStateWriter = ({ db, companyId, worldRef, clock, log }) => ({
  ingest: async (points, { backfill = false } = {}) => void,  // timelineData → assets + downtimes; shots → job/tool/partcounts; qualityEvents → rejections
  resetBackfill: () => void,
});

// domain/*.js (domain) — SARA business rules mirrored exactly (sara/server/src/modules/actions/*.js, records.js)
export class DomainError extends Error { /* code: 'TRANSITION' | 'OUT_OF_STOCK' | 'TASKS_OPEN' | 'NOT_FOUND' */ }
// counters.js
export const nextCode = async (db, { companyId, plantId = null, type, prefix }) => string;   // e.g. 'WO-142'
// activity.js / notify.js
export const logActivity = async (db, { companyId, at, actor, action, summary, target, details }) => void;
export const notify = async (db, { companyId, plantId, userIds, title, description, module, recordId, assetId, type = 'normal', priority = 'medium', at }) => void;
// workOrders.js
export const createWorkOrder = async (db, { companyId, plantId, actor, at, data, source = 'human' }) => wo; // data: name, description, asset, priority, category, people, groups, dueDate, plannedStart, plannedEnd, estimatedDurationMin, pmId, calibrationId, requestId, anomalyId, taskAndChecklist, spareParts, scheduleType
export const assignWorkOrder = async (db, wo, { actor, at, people }) => wo;
export const changeStatus = async (db, wo, { actor, at, workStatus, note, rating }) => wo;          // TRANSITIONS + stamping + spare consumption on Completed
export const completeTask = async (db, wo, { actor, at, topicIndex, taskIndex, remarks }) => wo;
export const addComment = async (db, wo, { actor, at, comment, type = 'manual' }) => wo;
// requests.js
export const raiseRequest = async (db, { companyId, plantId, actor, at, data /* name, description, type, asset */ }) => ({ request, workOrder });
export const closeRequest = async (db, request, { actor, at }) => request;
// jobCards.js
export const createJobCard = async (db, { companyId, plantId, actor, at, data }) => jobCard;
export const startJobCard = async (db, jobCard, { actor, at, assignedTo }) => jobCard;
export const completeJobCard = async (db, jobCard, { actor, at }) => jobCard;                        // completionMetrics from progress + downtimes in the window
export const refreshPlanStatus = async (db, planId, { at }) => plan;
// pm.js
export const generateDueMaintenance = async (db, { companyId, actor, at }) => [wo];                  // PMs + calibrations with nextGenerationDate ≤ at
// stock.js
export const partsBelowMinimum = async (db, companyId) => [{ part, stock, minimum, lot, supplier }];
export const receiveStock = async (db, { companyId, actor, at, part, lot, quantity, note }) => transaction;
// attendance.js
export const checkIn = async (db, { companyId, plantId, user, at, shiftName }) => checkInOut;
export const startBreak = async (db, { checkInOut, user, at, breakType }) => breakDoc;
export const endBreak = async (db, breakDoc, { at }) => breakDoc;
export const checkOut = async (db, checkInOut, { at }) => checkInOut;
// texts.js (sync) — realistic wording, pick(rng, …) helpers by asset type and category
export const TEXTS = { requestTitles, requestDescriptions, startNotes, progressNotes, holdReasons, resolutions, downtimeReasons };

// people/index.js (people)
export const createPeople = ({ db, companyId, worldRef, machines /* createSimulator api */, control, clock, cfg, log }) => ({
  start, stop /* sync */, tick: async (now) => void, setSpeed: (x) => void, setEnabled: (bool) => void,
  setRespondToAnomalies: (bool) => void, stats: () => ({ onShift, busy, actionsToday }),
});

// control.js (core)
export const createControl = ({ db, cfg, companyId, simulator, people, writer, clock, log }) => ({
  start, stop /* sync */,
  clearInjection: async (eventId, { reason = 'repair', by }) => void,   // people/ call this when a repair fixes an injected fault
  activeInjections: () => [simevent],
});

// seed/index.js (seed)
export const ensureSeeded = async (db, cfg, { now }) => ({ companyId, created /* false when simstate exists */, counts });
```
