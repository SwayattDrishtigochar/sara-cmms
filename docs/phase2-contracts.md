# Phase 2 contracts — machine data slice

> **Partly superseded by `docs/simulator-v2.md` (2026-10-16).** Device keys, `/api/sim/*`, `/api/ingest`,
> `sim/devices.js`, `telemetry/ingestRoutes.js`, `telemetry/stateTracker.js` and `telemetry/assets.js` are gone:
> the simulator now writes MongoDB and InfluxDB directly (machine-derived state included), and
> `telemetry/livePoller.js` feeds `/api/live`. The device, tracker and ingest sections below are history only.

Shared interface for the parallel work packages. Build **exactly** these signatures and shapes; if a package
needs something not listed here, implement it inside your own files and report it as a deviation.

Existing code to reuse (read before writing): `server/src/modules/records.js` (tenancy-safe data service,
`records.get(ctx, 'assets', id)` = access check), `server/src/modules/registry.js` (`getModule(name).Model`),
`server/src/lib/events.js` (`publish`, `subscribe`), `server/src/lib/errors.js` (`badRequest`, `unauthorized`,
`forbidden`, `notFound`, `conflict`, `parseOrThrow`), `server/src/lib/shifts.js` (`shiftWindows`, `shiftAt`,
`isWorkingTime`, `workingIntervals`), `server/src/lib/sse.js` (`openSse`), `server/src/config/influx.js`
(`influxEnabled`, `bucketFor`, `queryRows`, `writePoints`, `ensureBucket`, `Point`, `pingInflux`),
`server/src/telemetry/catalog.js` (field vocabulary, `KEY_FIELDS`, `ENERGY_FIELDS`, `DOWN_STATES`,
`RUNNING_STATES`, `FIELD_NAME`, `ASSET_ID`, `MEASUREMENTS`), `server/src/db/models/Sim.js` (`SimDevice`,
`SimCommand`, `SimEvent`, `ParameterSpec`), `server/src/context/buildUserContext.js` (`systemContext`,
`resolveTimeZone`), `server/src/sim/accountGenerator.js` (`generateAccount`, `slugify`),
`server/src/sim/blueprint.js` (`PLANTS`). Wire protocol: removed in v2 (see `docs/simulator-v2.md`).

Conventions: ESM JavaScript, arrow functions, short JSDoc on exports, errors via `lib/errors.js`, zod for
request bodies, no new npm dependencies. Biome style: single quotes, semicolons, 2 spaces, width 110.
Tests: vitest in `server/test/`, run with `SARA_TEST_DB=<your_package> npx vitest run test/<your files>` so
parallel runs never share a database. Never start a server on port 5080 (one is already running); use
supertest against `createApp({ routers })`.

## Server modules

### `server/src/sim/devices.js` (package `devices`)

```js
export const ONLINE_WINDOW_MS = 15_000;
export const hashKey = (key) => /* sha256 hex */;
export const registerDevice = async ({ name }) => ({ device /* deviceView */, key /* plaintext, shown once */ });
export const authenticateDevice = async (req) => /* SimDevice lean doc; throws unauthorized() */;
export const deviceAuth = async (req, res, next) => { req.device = await authenticateDevice(req); next(); };
export const enqueueCommand = async (deviceId, type, payload = {}) => /* SimCommand lean doc */;
export const takeCommands = async (deviceId) => [{ id, type, payload }]; // queued + sent-but-unacked, oldest first; marks sent
export const ackCommands = async (deviceId, ids) => void;
export const buildConfig = async (companyId, { from = now, to = now + 48h } = {}) => /* protocol `config` payload */;
export const assignDevice = async (deviceId, companyId /* string|null */) => /* deviceView */; // enqueues config (and stop when unassigning)
export const deviceView = (device, companyName) => ({
  id, name, companyId, companyName, online, lastSeenAt, desiredRunning, tickMs, version, hostname, platform,
  stats, statuses /* {assetId: status} */, injections /* from heartbeat */, scenarios /* catalogue */,
});
```

- Device key: `crypto.randomBytes(24).toString('base64url')`; store only the SHA-256 hex; compare with
  `crypto.timingSafeEqual`. Headers `x-device-id`, `x-device-key`. Unknown id / bad key → `unauthorized('Unknown device or key')`.
- `buildConfig`: assets = non-deleted assets of the company with any of isProductionAsset/isEnergyAsset/
  isSensorIntegration; `job` from the asset's job card with `jobStatus: 'In Progress'` (tool name,
  `idealCycleTime` = jobcard.idealCycleTime ?? tool.idealCycleTimeSec, `partsPerShot` = Σ mouldParts.assignedPartPerShot
  (fallback tool.mouldParts[0].partPerShot, else 1), `partName`, `jobCardId` = code). Plants: `windows` from
  `shiftWindows(plant, from, to, timeZone)` mapped to ms. `company.timeZone` via `resolveTimeZone`.

### `server/src/routes/adminSim.js` (package `devices`)

> Moved to the simulator in phase 7: `/api/admin/sim` and this router no longer exist in SARA (`sara-simulator/src/ui/server.js`).

`export const adminSimRouter` — mounted at `/api/admin/sim` behind `authenticate` + `requireSuperAdmin`.

| Method & path | Body | Response |
|---|---|---|
| `GET /devices` | | `{ devices: [deviceView] }` |
| `POST /devices` | `{ name }` | `201 { device, key, env }` — env = `.env` snippet `SARA_URL=…\nDEVICE_ID=…\nDEVICE_KEY=…` (SARA_URL from request host) |
| `PATCH /devices/:id` | `{ name?, companyId?: string\|null }` | `{ device }` |
| `DELETE /devices/:id` | | `204` |
| `POST /devices/:id/start` | | `{ device }` — desiredRunning=true; enqueue `config` (if assigned) then `start`; 409 if unassigned |
| `POST /devices/:id/stop` | | `{ device }` |
| `POST /devices/:id/backfill` | `{ days: 1..30 }` | `{ device }` — enqueue `config` with windows from now−days, then `backfill` |
| `POST /devices/:id/tick` | `{ tickMs: 1000..60000 }` | `{ device }` — enqueue `set` |
| `POST /devices/:id/inject` | `{ assetId, scenario, severity: low\|medium\|high, rampMin: 1..240, holdMin: 0..1440, field? }` | `201 { event }` — asset must belong to the device's company; scenario must be in the device catalogue and apply to the asset type; creates `SimEvent`, enqueues `inject` with `injectionId` |
| `POST /devices/:id/clear` | `{ injectionId? , all? }` | `{ cleared: n }` — sets `clearedAt`, enqueues `clear` |
| `GET /accounts` | | `{ accounts: [{ id, name, domain, industry, createdAt, counts: { users, assets, plants }, devices: [{ id, name }] }] }` (companies with `isSimulated`) |
| `POST /accounts` | `{ name, domain?, plantNames: subset of Object.keys(PLANTS) (1–3), features?: { productionEnabled, energyEnabled } }` | `201 { account, credentials }` — slug from name (append `-2`, `-3` … if taken), `generateAccount({ password: env.SIM_DEFAULT_PASSWORD })`, then `ensureBucket(bucketFor(id))` when Influx is enabled |
| `GET /accounts/:id/users` | | `{ users: [{ email, name, role, title, plant }], password }` |
| `GET /accounts/:id/assets` | | `{ assets: [{ id, name, tag, type, plantName, isProductionAsset, isEnergyAsset, isSensorIntegration }] }` |
| `GET /events?companyId=&limit=50` | | `{ events: [SimEvent + { assetName }] }` newest first |

### `server/src/telemetry/assets.js` (package `tracker`)

```js
export const assetIndex = async (companyId) => Map<assetIdString, { _id, name, assetTag, typeOfAsset, plantId /* string|null */,
  isProductionAsset, isEnergyAsset, isSensorIntegration, downtimeSeconds, ratedPowerKw }>; // cached 60 s
export const plantIndex = async (companyId) => ({ timeZone, plants: Map<plantIdString, plantDoc> }); // cached 60 s
export const currentJob = async (companyId, assetId) => /* In Progress jobcard lean + tool {name,idealCycleTimeSec,mouldParts} | null */; // cached 60 s
export const invalidateCompany = (companyId) => void;
```

### `server/src/telemetry/stateTracker.js` (package `tracker`)

```js
export const ingestPoints = async (companyId, points /* validated protocol points {m,a,t,s,f} */, { backfill = false, deviceId } = {}) => void;
export const reconcileStatuses = async (companyId, statuses /* {assetId: status} */, at = new Date()) => void;
export const snapshot = (companyId) => [{ assetId, status, since, values /* {field: number|string} */, valuesAt, plantId }];
export const resetBackfill = (deviceId) => void;
```

Rules:
- Live state per asset (lazy-loaded from `assets.assetStatus/assetStatusSince` and any open downtime
  `{ assetId, endedAt: null }`). On a `timelineData` status change (live): update the asset
  (`assetStatus`, `assetStatusSince`) with a direct Model update, publish `status`.
- Downtime: opens on `Stopped` at any time, or on `OFF` only if `shiftAt(plant, t)` is non-null; a
  Stopped↔OFF change inside an open downtime appends to `states`; closes on Running/Idle/ON. When closing,
  `OFF` states are clipped to the end of the shift they started in. `totalDowntimeInSeconds` = Σ states;
  `requiresVerification` = total ≥ asset.downtimeSeconds (default 600). Write `downtimes` docs directly with
  `companyId`, `plantId`, `reasonText: ''`. Publish `downtime`.
- Backfill batches: per-device state, only downtime history (no asset status updates, no live events, no
  production counters). `resetBackfill(deviceId)` when a backfill starts (first backfill batch after live).
- Live `shotCountDetails`: per batch aggregate shots per asset → `currentJob` → parts = shots × partsPerShot;
  `jobcards` `$inc { totalShotCount: shots, 'operations.0.progress.partsOut': parts − rejects }`;
  `tools` `$inc { shotCount }`; `partcounts` upsert on `{ companyId, assetId, date: shift.start, shiftName }`
  `$inc { produced, shots }` (`$setOnInsert { plantId }`). Publish `production`.
- Live `qualityEvents`: create `rejections` (`origin: 'machine'`, `jobCardId`, `partName`, `rejectionReason`,
  `rejectedCount`) and `$inc 'operations.0.progress.partsRejected'`.
- Live numeric/string fields of other measurements update `values`; publish `telemetry` at most once per
  second per asset: `{ assetId, t, status, values }`.
- Event audience: `{ plantId }` of the asset (lib/events.js `publish(companyId, type, payload, { plantId })`).

### `server/src/telemetry/ingestRoutes.js` (package `ingest`)

`export const simRouter` — Express Router mounted at `/api` **before** the global JSON parser
(`{ path: '/api', router: simRouter, raw: true }`), so each route adds its own `express.json({ limit: '8mb' })`
(it inflates gzip). Routes: `POST /sim/hello`, `POST /sim/heartbeat`, `POST /ingest` — exactly per
the v1 wire protocol (removed), all behind `deviceAuth`.

- hello: zod-validate loosely; upsert `ParameterSpec` for every profile field (`assetType` = profile key);
  save version/hostname/platform/scenarios/lastSeenAt; if `desiredRunning` and assigned, enqueue `config`
  and `start` (a restarted Pi resumes). Respond `{ serverTime, device: { id, name, companyId, companyName } }`.
- heartbeat: save `lastSeenAt`, `stats`, `statuses`, `injections`; `ackCommands`; update `SimEvent.progress/phase`
  from `injections`; `reconcileStatuses` when assigned; re-enqueue `config` when assigned and `configSentAt`
  is older than 12 h (set `configSentAt` whenever a config command is enqueued); respond `{ serverTime, commands: takeCommands() }`.
- ingest: body `{ batchId (≤100 chars), backfill?, points (≤5000) }`; 409 `conflict('No account assigned')` when
  the device has no company; duplicate `batchId` (per-device LRU of 5 000) → `{ accepted: 0, rejected: [],
  duplicate: true, serverTime }`; validate each point (measurement in `MEASUREMENTS`, `a` in `assetIndex`,
  `t` within [now−31 d, now+60 s], field names `FIELD_NAME`, values finite number / string ≤200 / boolean,
  status `s` in STATUSES) → rejected `{ i, reason }`; build `Point(m).tag('companyId').tag('assetId').tag('status', s ?? 'unknown').timestamp(t)`
  numbers ALWAYS `floatField`; `await writePoints(bucketFor(companyId), points)`; only then remember the
  batchId and `await ingestPoints(companyId, accepted, { backfill, deviceId })`. Influx write failure → 503.
  Per-device rate limit `env.RATE_LIMIT_INGEST_PER_MIN` (express-rate-limit keyed by device id).

### `server/src/telemetry/queries.js` (package `queries`)

All Flux built with the client's `flux` tagged template (values escaped), bucket = `bucketFor(companyId)`,
every query filters `r.companyId == <companyId>`, asset ids must match `ASSET_ID` (else `badRequest`),
**always regroup** (`group(columns: [...])`) because the `status` tag splits series, never `range(start: -inf)`.

```js
export const pickWindow = (startMs, stopMs, maxPoints = 300) => /* one of 10s 30s 1m 5m 15m 30m 1h 3h 6h 12h 1d */;
export const parseRange = ({ range, start, stop }) => ({ start: Date, stop: Date }); // range in 15m|1h|6h|24h|7d|30d; default 24h
export const latestValues = async (companyId, assetIds, { lookback = '-7d' } = {}) =>
  Map<assetId, { [field]: { value, time /* ISO */, measurement } }>; // excludes timelineData
export const seriesFor = async (companyId, assetIds, fields, { start, stop, every, fn = 'mean' } = {}) =>
  ({ start, stop, every, series: [{ assetId, field, measurement, points: [[ms, value]] }] }); // numeric only (import "types", types.isType float/int), aggregateWindow createEmpty:false
export const statusTimeline = async (companyId, assetId, { start, stop }) =>
  ({ start, stop, runs: [{ status, start, end, seconds }], totals: { Running, Idle, Stopped, OFF }, availability /* running / (window − OFF outside? no: running / covered) */, coverageSec });
export const discoverFields = async (companyId, assetId, { lookback = '-2d' } = {}) => [{ measurement, field }];
```

`statusTimeline`: query `timelineData`/`assetStatus` from `start − 7 d` to `stop`; the last event before `start`
is the prior state; build runs clipped to `[start, min(stop, now)]`; `availability = Running+ON seconds ÷
(covered seconds − OFF seconds)` (OFF = not scheduled), 0 when nothing is scheduled.

### `server/src/routes/telemetry.js` (package `queries`)

`export const telemetryRouter` — mounted at `/api` behind `authenticate`. Every asset id is checked with
`records.get(req.ctx, 'assets', id)` (tenancy + plant lock).

| Route | Response |
|---|---|
| `GET /telemetry/fields?assetId=` | `{ fields: [{ measurement, field, unit, valueType, normalMin, normalMax, key }] }` — ParameterSpec rows for the asset type + `ENERGY_FIELDS` (non-furnace unless Furnace) when isEnergyAsset + `SHOT_FIELDS` when production + discovered fields not covered (unit null); `key` = in `KEY_FIELDS[type]` |
| `GET /telemetry/latest?assetIds=a,b` | `{ assets: [{ assetId, status, since, values: { [field]: { value, time, measurement } } }] }` — tracker snapshot merged over Influx latest; default = all company assets in scope (max 100) |
| `GET /telemetry/series?assetId=&fields=f1,f2&range=6h` (or `start`,`stop`) | `{ start, stop, every, series: [{ field, measurement, unit, points }] }` |
| `GET /telemetry/timeline?assetId=&range=24h` | statusTimeline result |
| `GET /live` | SSE: first `hello { serverTime, snapshot }`, then company events filtered by audience (`plantId` vs `ctx.plantLock`; `userIds` vs ctx.userId) |

## Client

- `client/src/api/sse.js` (package `ui-machines`): `export const streamSse = async (path, { method = 'GET', body, signal, onEvent }) => void` —
  fetch with Bearer token (`getToken()` from `api/client.js`), parse `event:`/`data:` frames (handles chunks
  split mid-frame, ignores `:` comments), `onEvent(type, data)`; throws `ApiError` on non-2xx. Reused by chat later.
- `client/src/live/liveStore.js` (package `ui-machines`): zustand store fed by one `/api/live` connection
  (auto-reconnect with backoff, started by `useLiveConnection()` mounted once in AppShell by the integrator):
  `assets: { [assetId]: { status, since, values, valuesAt, history: { [field]: [[ms, value]] } } }` keeping
  the last 15 minutes per numeric field; `useLiveAsset(assetId)`; `useLiveEvent(type, handler)` for other events.
- Pages (package `ui-machines`): `client/src/machines/MachinesPage.jsx` (`/machines`),
  `client/src/machines/MachinePage.jsx` (`/machines/:id`), components in `client/src/machines/` and
  `client/src/ui/charts.jsx` (Sparkline, TelemetryChart, StatusTimelineBar).
- Pages (package `ui-superadmin`; the Simulation tab moved to the simulator in phase 7, SARA keeps AI + Platform): `client/src/superadmin/SuperAdminPage.jsx` (`/superadmin`, Tabs with
  `Simulation` now; leave a clearly marked spot for the `AI` tab added in phase 3) and
  `client/src/superadmin/SimulationTab.jsx` (+ small components in the same folder). Data via TanStack
  Query on `/api/admin/sim/*`, polling every 3 s while visible.
- The integrator adds routes in `client/src/routes.jsx`, `PRIMARY_NAV` entries in `client/src/layout/nav.js`,
  mounts `useLiveConnection()` in `AppShell`, and changes the home redirect to `/machines`.
- UI kit to reuse: `client/src/ui/core.jsx` (Button, Card, CardHeader, Badge, StatusPill, Skeleton, EmptyState,
  PageHeader, AiProvenance, Avatar, Kbd, toneFor), `client/src/ui/form.jsx`, `client/src/ui/overlay.jsx`
  (Dialog, Sheet, Menu, Tabs, TabPanel, Tooltip), `client/src/lib/format.js` (formatters, `cn`),
  `client/src/api/client.js` (`api`, `toQuery`, `getToken`, `ApiError`), design tokens in `client/src/index.css`
  (status colours `running/idle/stopped/off/maint`, `ai`, `brand`, surfaces). Status is never colour alone.
