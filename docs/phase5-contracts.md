# Phase 5–6 contracts — planning, costs, KPIs, Command Center

Builds on phases 2–4 (`docs/phase2-contracts.md` … `docs/phase4-contracts.md`) and the approved plan (F1, F2,
"Proposals and apply", F5, F6 + F9, Planner/Costs/KPI pages, Verification). Same conventions: ESM JavaScript,
arrow functions, zod 4, `lib/errors.js`, no new npm dependencies, Biome (`pnpm lint`), tests with
`SARA_TEST_DB=<package> npx vitest run --maxWorkers=2 <files>` (server) and `pnpm --filter client test` (client).
Never edit the AI layer or the shared files (§10 lists what the integrator changes). Never call Gemini for
real: tests run with `AI_MOCK=true` (test/helpers/setup.js), and `ai/mockPhase5.js` answers every call below.

**Already done by the architect (do not redo):** the data model (§2: `modules/defs/ai.js`, `db/models/AiText.js`,
registration in `defs/index.js`) and the mock answers (`ai/mockPhase5.js`, used by `ai/mock.js` through
`mockInput.kind`).

## 1. Packages and file ownership

Every new file belongs to exactly one package. A package may **import** (never edit) another package's files
using the exports pinned here.

| Package | Owns (create) |
|---|---|
| `C:planning-core` | `server/src/planning/{intervals,capacity,production,proposals,explain,tools}.js`, `server/src/routes/planning.js`, `server/test/planning-{capacity,production,apply}.test.js` |
| `C:planning-maint` | `server/src/planning/maintenance.js`, `server/src/planning/maintenanceTool.js` (tool `plan_maintenance`), `server/src/routes/planningMaintenance.js`, `server/test/planning-maintenance.test.js` |
| `C:planner-client` | `client/src/planner/**` (`PlannerPage.jsx`, `Gantt.jsx`, `ganttLayout.js`, `PlanBlock.jsx`, `AiPlanPanel.jsx`, `PlansList.jsx`, `usePlanning.js`, `ganttLayout.test.js`, `planner.test.jsx`) |
| `C:costs-server` | `server/src/costs/{tariffs,periods,engine,alerts,watch,overview,tools}.js`, `server/src/routes/costs.js`, `server/test/costs-{engine,alerts}.test.js` |
| `C:kpi-server` | `server/src/kpis/{expr,runner,normalize,insights,tools}.js`, `server/src/routes/kpis.js`, `server/test/kpi-{expr,runner,tools}.test.js` |
| `C:kpi-client` | `client/src/viz/**` (`Viz.jsx`, `vizData.js`, `Heatmap.jsx`, `Gauge.jsx`, `viz.test.jsx`), `client/src/kpis/**` (`KpisPage.jsx`, `KpiCard.jsx`, `KpiPreviewBlock.jsx`, `useKpis.js`, `kpis.test.jsx`) |
| `C:costs-client` | `client/src/costs/**` (`CostsPage.jsx`, `useCosts.js`, `CostOverviewCard.jsx`, `CostBreakdown.jsx`, `CostAlertsList.jsx`, `costs.test.jsx`) |
| `C:command-center` | `server/src/briefing/{evidence,briefing}.js`, `server/src/routes/briefing.js`, `server/test/briefing.test.js`, `client/src/home/**` (`CommandCenter.jsx`, `BriefingCard.jsx`, `LiveFloor.jsx`, `KpiStrip.jsx`, `AlertsFeed.jsx`, `MaintenanceDue.jsx`, `useBriefing.js`, `home.test.jsx`) |

Tool files live in the feature folders (agent/** is frozen); the integrator spreads them into the registry.
Server code may import read-only helpers: `agent/tools/common.js` (`compact`, `rowsResult`, `fmtDate`, `money`,
`round`, `zoneOf`, `plantOf`, `labelsFor`, `findByIdOrCode`, `readableModule`, `linkTo`, `timeWindow`),
`agent/tools/resolve.js` (`resolveTimeRange`), `agent/tools/registry.js` (`getTool`, `groupEnabled`),
`agent/declarations.js` (`toJsonSchema`), `ai/gemini.js` (`generate`, `AiUnavailableError`, `isMock`),
`ai/settings.js` (`getAiSettings`), `routes/ai.js` (`aiUnavailable`), `lib/*`, `modules/*`, `telemetry/*`,
`context/buildUserContext.js` (`systemContext`). Client code may import `ui/*`, `lib/*`, `api/client.js`,
`live/liveStore.js`, `machines/HealthRing.jsx`, `machines/telemetry.js`, `blocks/{ChartBlock,DataTable,KpiBlock}.jsx`,
`anomalies/useAnomalies.js`, `assistant/{useAssistant.js,AskSara.jsx}`, `modules/useModules.js`, `auth/useAuth.js`.

## 2. Data model (implemented)

### New registry modules — `server/src/modules/defs/ai.js`

Registered last in `defs/index.js` (`...ai`). Exports `KPI_VIZ`, `COST_METRICS`, `PROPOSAL_STATUSES`.

**`planproposals`** (`PlanProposal`, group AI, icon `CalendarRange`) — tenantField `companyId`, `plantScoped`,
`softDelete: false`, `agentWritable: false`, permissionKey none (read: every role; write: engine only),
`counter { type: 'PlanProposal', prefix: 'PLN-', field: 'proposalCode' }`, codeField `proposalCode`, titleField
`title`, index `{ companyId, status, createdAt: -1 }`, hooks `beforeCreate`/`beforeUpdate` throw 403 — the generic
routes can never write it. **Every field is readOnly**; `planning/proposals.js` writes the Model directly and takes
the code with `nextSeq({ companyId, plantId, type: 'PlanProposal' })` (`db/models/Counter.js`).

| field | type |
|---|---|
| `proposalCode` | string `PLN-n` |
| `kind` | enum `production\|maintenance` (required) |
| `title` | string, e.g. `5,000 × Housing-A by 25-10-2026`, `Bearing inspection – Press 1` |
| `status` | enum `draft\|applying\|applied\|discarded\|stale\|expired\|failed`, default `draft` |
| `scheduleVersion` | number (hidden) — `companies.scheduleVersion` when planned |
| `expiresAt` | date — created + 12 h |
| `input` | mixed (hidden) — the planner input, re-run on "plan changed" |
| `horizon` | `{ start, end }` |
| `productionPlanId` → productionplans, `anomalyId` → anomalies, `assetIds` → assets[] | refs |
| `ops` | array (hidden, no row ids) `{ seq!, op!: create\|update, module!, id, label, data: mixed, before: mixed }` |
| `diff` | mixed (hidden) — `{ bars: GanttBar[], delays: Delay[] }` of the recommended/only option (§3.4) |
| `options` | mixed (hidden) — maintenance only: `MaintenanceOption[]` (§3.3) |
| `recommendedOption` | string — `zero_impact\|insert\|move\|defer` (maintenance) |
| `feasibility` | `{ feasible, dueDate, projectedFinish, slackHours, shortfall, maxDelayHours, notes }` |
| `risks` | array `{ kind: pm_due\|anomaly\|tool_life\|no_capacity\|late\|deferred\|other, severity: info\|warning\|critical, text ≤300, assetId }` |
| `alternatives` | array `{ kind: extra_shift\|other_mould\|partial_delivery\|non_running_day\|defer, text ≤300, projectedFinish, extraParts }` |
| `explanation` | `{ text, model, at, mock }` — AI text (§4), REST-created proposals only |
| `appliedOption`, `appliedOps` (hidden, default 0), `appliedAt`, `appliedBy` → users, `result` (mixed, hidden), `error` (text) | apply bookkeeping |

**`costalerts`** (`CostAlert`, group Costs, icon `BellRing`) — `plantScoped`, `inheritPlantFrom: ['assetId']`,
softDelete (default true), `agentWritable` (default true), permissionKey none (owner/admin write; technician/viewer
read), titleField `name`, hooks: scope check (`scope: 'asset'` needs `assetId`, `'plant'` needs `plantId`, else 400).

| field | type |
|---|---|
| `name` | string! ≤120 |
| `metric` | enum! `energy\|spares\|consumables\|labour\|downtime\|maintenance\|total` (maintenance = spares + consumables + labour) |
| `scope` | enum `company\|plant\|asset`, default `asset` |
| `assetId` | ref assets |
| `period` | enum `day\|week\|month`, default `day` |
| `comparator` | enum `gt\|gte\|lt\|lte`, default `gt` |
| `threshold` | number! ≥0, ₹ — for the whole period |
| `enabled` | boolean, default true |
| `recipients` | refs users — empty: owners + admins of the alert's plant (all admins when no plant) |
| `notes` | text |
| `lastValue`, `lastEvaluatedAt`, `lastTriggeredAt`, `lastPeriodKey` (hidden) | readOnly |
| `history` | readOnly array (≤60, no row ids) `{ periodKey, value, threshold, triggeredAt, explanation, model, notificationId }` |

agentNotes (in the module digest the model sees) already tell the model to create alerts with
`create_record { module: "costalerts", items: [{ name, metric, scope, assetId, period, comparator, threshold }] }`
after resolving the asset, that thresholds are per period, and to pause with `update_record { enabled: false }`.

**`kpis`** (`Kpi`, group AI, icon `Gauge`) — `plantScoped` (plantId = creator's plant lock, or null = company-wide),
softDelete, `agentWritable: false`, permissionKey none (owner/admin create/update/delete; everyone reads), titleField
`title`, sort `-updatedAt`, hooks: create/update only with `opts.source === 'kpi'` (the KPI tools) — the generic
DELETE `/api/m/kpis/:id` still works (KPI page Delete).

| field | type |
|---|---|
| `title` | string! ≤120 |
| `description` | text ≤1000 |
| `viz` | enum! `number gauge line area bar stackedBar combo pie scatter radar funnel treemap heatmap timeline table` |
| `unit` | string ≤20 |
| `target` | number |
| `thresholds` | `{ warn, critical, direction: higher_is_better\|lower_is_better (default higher) }` |
| `timeRange` | `{ text!: string ≤120, default "last 7 days" }` — never start/stop |
| `sources` | array ≤4 (no row ids) `{ key!: /^[a-z][A-Za-z0-9_]{0,19}$/, tool!: string, args: mixed, pick: string ≤120 }` (create_kpi enforces ≥1) |
| `formula` | string ≤300 (§3.8) |
| `encoding` | `{ source, x, y, value, label, start, end, series: [{ key!, label, unit, axis: left\|right, type: line\|bar\|area }] ≤6, sort: none\|asc\|desc, limit 1–1000 }` |
| `pinned` | boolean, default false — Command Center KPI strip |
| `insight` | readOnly `{ text, model, at, mock }` |

### Plain model — `server/src/db/models/AiText.js`

`AiText` (`ai_texts`): `{ companyId!, kind!: briefing|cost_overview, key!, json! (the validated AI answer),
evidence (mixed), model, mock, at! }`, unique `{ companyId, kind, key }`, TTL 30 days on `at` (autoIndex creates the
indexes). Keys: briefing `"<scope>|<YYYY-MM-DD>"`, cost overview `"<scope>|<periodKey>"` where scope =
`plant:<plantLock>` or `all`. Upsert on `{ companyId, kind, key }`.

### Existing fields the engines use (nothing added)

- `jobcards.startDate`/`endDate` **are** the planned window (no plannedStart/plannedEnd on job cards — deviation
  from the prompt, they would duplicate). `operations[0].progress.partsOut` = good parts so far; `completionMetrics.oee`.
- `workorders.plannedStart`, `plannedEnd`, `estimatedDurationMin`, `anomalyId`, `pmId`, `calibrationId` (exist).
- `tools.setupTimeMin` (default 45), `idealCycleTimeSec`, `mouldParts[].partPerShot`, `assets[]`, `status`.
- `preventivemaintenances`/`calibrations`: `estimatedDurationMin` (default 60), `nextGenerationDate`, `trigger.cycle`.
- `assets.downtimeCostPerHour`, `costsettings.{laborRatePerHour, defaultDowntimeCostPerHour, monthlyMaintenanceBudget, monthlyEnergyBudget}`.
- `companies.scheduleVersion` (readOnly, default 0). `records.js` bumps it on every create/update/delete of a
  module with `planned: true` (jobcards, workorders, productionplans).
- **Idempotent apply** (already in `registry.js`/`records.js`): `planned` modules get hidden readOnly
  `proposalId` (string) + `proposalSeq` (number) and the unique partial index
  `{ proposalId: 1, proposalSeq: 1 }, { unique: true, partialFilterExpression: { proposalId: { $type: 'string' } } }`;
  `records.create(ctx, module, data, { stamp: { proposalId, seq } })` returns the existing doc on replay.

## 3. Engines

Shared types (server: `Date`; JSON over the wire: ISO strings):
`Interval = { start, end }`. Times are UTC instants; day/shift logic uses the company zone (`zoneOf(ctx)`).

### 3.1 Capacity calendar — `planning/intervals.js` (pure) + `planning/capacity.js`

```js
// intervals.js — pure, unit-tested; inputs sorted or not, outputs sorted, merged, non-empty
export const mergeIntervals = (list) => Interval[];
export const subtractIntervals = (base, cuts) => Interval[];
export const intersectIntervals = (a, b) => Interval[];
export const totalSeconds = (list) => number;
/** Walks `free` from `from` and consumes `seconds` of it; null when the list runs out. */
export const advanceWorking = (free, from, seconds) => ({ end: Date, segments: Interval[] }) | null;

// capacity.js
/** Working time of a plant: lib/shifts.workingIntervals (shifts − breaks, overnight-break rule, running days, holidays). */
export const plantWorking = (plant, start, end, zone, { includeNonRunningDays = false } = {}) => Interval[];
/** Mean of availability × performance of the asset's job cards completed in the last 14 days (actualEnd), else 0.85. */
export const efficiencyOf = async (ctx, assetIds, now = new Date()) => Map<assetId, { efficiency, source: 'history'|'default' }>;
/**
 * @param ctx viewer ctx (records.scopeFilter on every read)
 * @param {{ plantId?, assetIds?: string[], start: Date, end: Date, includeNonRunningDays?: boolean, now?: Date }} opts
 */
export const buildCalendar = async (ctx, opts) => Calendar;
/** Calendar → GanttData (§3.4) for the Planner, the Command Center and the plan block. */
export const calendarToGantt = (ctx, calendar) => GanttData;
```

`Calendar = { start, end, timeZone, plantId, now, shifts: [{ name, start, end }], machines: [Machine], tools: [ToolCal] }`

- `Machine = { assetId, name, assetTag, typeOfAsset, status, healthScore, plantId, efficiency, efficiencySource,
  openAnomalies: [{ id, code, type, severity, summary, detectedAt, urgencyHours }], working: Interval[],
  bookings: [Booking], free: Interval[] }` — machines = assets with `isProductionAsset` of the plant(s) (for
  maintenance: every asset with a task). `free = working − bookings`.
- `Booking = { kind: 'jobcard'|'workorder', id, code, label, start, end, toolId?, status, productionPlanId?, dueDate? }`:
  job cards with `jobStatus ∈ {Open, In Progress, On Hold}` and `endDate > start` (an In Progress card past its
  `endDate` books until `now + remaining`, remaining = ⌈(target − partsOut)/perShot⌉ × cycle ÷ efficiency); work
  orders not Completed/Closed **with** `plannedStart`+`plannedEnd`. `dueDate` = the linked production plan's.
- `ToolCal = { toolId, toolNumber, name, status, assets: assetId[], cycleSec, setupMin, parts: [{ id, partName, perShot, weight }],
  shotCount, maxShotLife, busy: [Interval & { assetId, jobCardId }], free: Interval[] }` — a tool runs on one machine
  at a time; `busy` = its job card bookings on any machine.
- Overnight shift + 02:00 break are already correct in `lib/shifts.js` (break before shift start ⇒ next day; the
  shift's start date decides running day/holiday) — reuse it, don't re-implement.
  `includeNonRunningDays`: same shift pattern on every weekday and holiday
  (`{ ...plant, runningSchedule: WEEKDAYS, holidays: [] }`).

### 3.2 Production planner — `planning/production.js`

```js
/** @param {{ partName, quantity, dueDate: Date, productionPlanId?, plantId?, toolIds?: string[], start?: Date, rejectionPct?: number }} input */
export const planProduction = (calendar, input, { now, rejectionRate }) => ProductionPlan;   // pure
export const proposeProduction = async (ctx, input) => proposal;  // loads data, buildCalendar(start=now, end=dueDate+14d), planProduction, createProposal
```

1. **Tools:** `ToolCal` with `status 'In Service'` whose `parts` contain `partName` (case-insensitive exact), narrowed
   by `toolIds`. None → 400 `No mould makes "<part>"` with `details.parts` (distinct part names).
2. **Rejection rate r:** `input.rejectionPct/100`, else Σ rejectedCount ÷ (Σ good + Σ rejected) for that part over the
   last 30 days (rejections + job card progress), else 0.02; clamp 0–0.5.
3. **Rate** of tool t on machine m (good parts per working second) = perShot ÷ cycleSec × efficiency(m) × (1 − r).
4. **Slot** of (t, m): `free_tm = intersect(m.free, t.free)` from `max(now ceil 15 min, input.start)`. Setup =
   `t.setupMin` of working time at the slot start unless the last job card on m ending ≤ slot start used t (mould
   already mounted). Capacity `C_tm` = rate × working seconds of `free_tm` after setup until `dueDate`.
5. **Machine per tool (one mould per machine):** tools in order of their best `C_tm` (desc); each takes the machine
   with the largest `C_tm` not yet taken by this plan; machines with an open **critical** anomaly only when the tool
   has no other machine. `ponytail:` greedy heuristic; upgrade path CP-SAT.
6. **Split (water-filling to equal utilisation):** if Σ C_t ≥ Q: q_t = Q × C_t ÷ Σ C (rounded up to perShot; the
   largest absorbs rounding); a share below max(1 h of that tool's output, 5 % of Q) is dropped and re-split (unless
   it is the only tool). If Σ C_t < Q: q_t = C_t and the remaining Q − Σ C goes to the tool that finishes it
   earliest past the due date.
7. **Job card window:** `startDate` = slot start, `endDate` = `advanceWorking(free_tm, start, setupSec +
   ⌈q_t ÷ (1 − r) ÷ perShot⌉ × cycleSec ÷ efficiency).end`.
8. **Feasibility:** `projectedFinish = max(endDate)`, `feasible = projectedFinish ≤ dueDate`, `slackHours =
   (dueDate − projectedFinish)/3600 s` (negative when late), `shortfall = max(0, Q − Σ min(q_t, C_t))`.
9. **Risks:** PM/calibration `nextGenerationDate` inside a chosen machine's job window → `pm_due` (warning, text
   `PM-4 (Monthly PM – IMM 4) is due on IMM 4 on 25-10-2026`); open anomaly on a chosen machine → `anomaly` (its
   severity); `shotCount + shots > maxShotLife` → `tool_life`; infeasible → `late` (critical).
10. **Alternatives** (only when infeasible, each with numbers): `extra_shift` (re-run with includeNonRunningDays →
    projectedFinish), `other_mould` (part tools skipped: not In Service / no free machine), `partial_delivery`
    (`extraParts` = parts done by the due date).
11. **Ops:** without `productionPlanId`: seq 0 `create productionplans { partName, quantity, dueDate, priority:
    'Medium', status: 'Planned', plantId }`; with it: seq 0 `update productionplans { status: 'Planned' }`. Then per
    tool `create jobcards { jobName: "<part> – <customer name | stock>", asset, tool, productionPlanId: "$op:0" | id,
    partName, target: q_t, idealCycleTime: cycleSec, rejectionPercentage: round(r × 100, 1), startDate, endDate,
    mouldParts: [{ partNameId, partName, assignedPartPerShot, partWeightKg }], operations: [{ operationName:
    Moulding|Pressing|Machining (by asset type), assetId: asset, cycleTime: cycleSec }] }` (jobStatus default Open).
12. **Diff:** existing bookings are not in `diff`; `diff.bars` = one ghost bar per new job card (`change: 'new'`,
    plus a `kind: 'setup'` ghost bar for the changeover), `diff.delays = []`.

`ProductionPlan = { title, jobCards: [{ assetId, asset, toolId, tool, target, setupMin, start, end, shots }], feasibility, risks, alternatives, ops, diff, rejectionRate }`.

### 3.3 Maintenance planner — `planning/maintenance.js`

```js
/** @param {{ assetId?, anomalyId?, workOrderId?, horizonDays = 7, allowNonRunningDays = false, plantId? }} input */
export const maintenanceTasks = async (ctx, input, now) => Task[];
export const planMaintenance = (calendar, tasks, { now, staff }) => { tasks: [{ task, options: MaintenanceOption[], recommended }] };  // pure
export const rescheduleForward = (machine, block, { now }) => { moves: [{ jobCardId, from: Interval, to: Interval }], delays: Delay[] };  // pure
export const proposeMaintenance = async (ctx, input) => proposal;
```

`Task = { kind: 'anomaly'|'pm'|'calibration'|'workorder', refId, code, assetId, title, durationMin, deadline, priority, category, workOrderId? }`
- anomaly: duration = `investigation.suggestedWorkOrder.estimatedDurationMin ?? 90`, deadline = `detectedAt +
  urgencyHours` (≥ now + 1 h), priority critical→High, warning→Medium, info→Low, title =
  `suggestedWorkOrder.name ?? "<Type label> – <asset>"`, category `suggestedWorkOrder.category ?? 'Inspection'`,
  `workOrderId` = `anomaly.workOrderId` (then the WO is updated, not created).
- pm/calibration: active, `nextGenerationDate ≤ now + horizon`; duration `estimatedDurationMin`; deadline =
  `nextGenerationDate` (past → now + 24 h); no WO yet.
- workorder: open (not Completed/Closed), no planned window; duration `estimatedDurationMin ?? CATEGORY_MIN[category]`
  with `CATEGORY_MIN = { Breakdown: 90, Preventive: 60, Electrical: 60, Hydraulic: 75, Mechanical: 70, Inspection: 30,
  Cleaning: 40, Calibration: 45 }`, default 60 (the simulator's table); deadline `dueDate ?? now + 72 h`.
- Only `assetId` → every task of that asset; nothing → every task of the plant (Planner "Find maintenance windows").
  Order: deadline asc, then priority High > Medium > Low.

`staff` = Maintenance-department technicians/admins of the plant by `shiftId`; a window counts only inside a shift
with ≥ 1 of them. Per task, `MaintenanceOption = { id, label, start, end, lateHours (Σ hours past plan due dates),
delayHours (Σ job card end shifts), maintenanceLateHours (start − deadline, ≥ 0), delays: Delay[], risk, ops, diff }`:
1. `zero_impact`: earliest window ⊂ working (or non-running time when allowed) with no booking on the machine,
   `start ≥ now`, `end ≤ deadline`. Found → it is the only option.
2. `insert`: block at the earliest staffed working time with `end ≤ deadline` (else the earliest). `rescheduleForward`:
   job cards on the machine ordered by start; the one overlapping the block keeps its working duration and ends
   later; each later card starts at max(its start, previous end) keeping its working duration. `Delay = { jobCardId,
   code, rowId: assetId, hours, late: newEnd > plan dueDate, dueDate }`.
3. `move`: the card overlapping the block ends at the block start (`target` = partsOut + parts made until then,
   ≥ 1) and a new card for the remaining parts goes to the tool's other eligible machine with the earliest finish
   (setup counted, tool free from the block start). Skipped when the tool has no other machine.
4. `defer`: the first zero-impact window after the deadline; `risk` = `Runs <h> h after the AI deadline (urgency <n> h)`.
5. **Recommended** = min by (lateHours, delayHours, maintenanceLateHours); `defer` only when every other option
   makes a plan late and the task is not critical.

Ops of an option: `create workorders { name: title, description, asset, priority, category, dueDate: deadline,
plannedStart, plannedEnd, estimatedDurationMin, anomalyId?, pmId?, calibrationId? }` (or `update workorders
{ plannedStart, plannedEnd, estimatedDurationMin }` when the task has a WO); for a PM/calibration also `update
preventivemaintenances|calibrations { nextGenerationDate: + one cycle }` so the simulator does not generate a second
WO; plus `update jobcards { startDate?, endDate?, target? }` / `create jobcards` from steps 2–3. Every option's
`diff.bars`: the maintenance ghost bar (`kind: 'maintenance'`, `change: 'new'`) + moved cards (`change: 'moved'|
'extended'`, `from`). Proposal: `kind: 'maintenance'`, `options` = all options, `ops`/`diff` = recommended's,
`feasibility = { feasible: lateHours === 0, maxDelayHours, notes }`. Several tasks → one proposal, options per task
are combined by taking each task's recommended option (ops concatenated, seq renumbered); `options` lists the first
task's options only. `ponytail:` single-task option choice; per-task choice when users ask for it.

### 3.4 Proposals — `planning/proposals.js`

```js
export const createProposal = async (ctx, fields) => proposal;  // Model.create with companyId, plantId, createdBy/updatedBy = ctx.userId, proposalCode via nextSeq; dry-runs every op (records.* dryRun, "$op:N" refs removed) → 400 on the first failing op; status draft; scheduleVersion = company's now
export const getProposal = async (ctx, idOrCode) => proposal;   // records scope (tenant + plant rule); 404
export const listProposals = async (ctx, { status, kind, limit = 20 }) => ({ items });
export const applyProposal = async (ctx, idOrCode, { option } = {}) => ({ proposal, created: Ref[], updated: Ref[] });  // Ref = { module, id, label, link }
export const discardProposal = async (ctx, idOrCode) => proposal;  // draft|stale|failed → discarded
export const toPlanBlock = (ctx, proposal, calendar) => PlanBlockPayload;
```

Apply:
1. `applied` → return the stored `result` (double confirm). `discarded|expired` → 410. `draft` past `expiresAt` →
   set `expired`, 410.
2. Pre-check `can(ctx, module, create|update)` for every op → 403 before any write.
3. Only from `draft`: `companies.scheduleVersion !== proposal.scheduleVersion` → set `stale`, re-run the planner with
   `proposal.input` (new proposal) and throw `new AppError(409, 'PLAN_CHANGED', 'The schedule changed since this plan
   was made. Here is an updated plan.', { proposalId, proposalCode })`.
4. Claim: `findOneAndUpdate({ _id, status: { $in: ['draft', 'applying', 'failed'] } }, { $set: { status:
   'applying', appliedOption } })`; resuming (`applying`/`failed`) with another option → 409 CONFLICT. The chosen
   option's ops replace `ops` for maintenance.
5. Replay **all** ops in seq order: `"$op:N"` (exact string value, any depth) → id created by seq N; `create` →
   `records.create(ctx, module, data, { source: 'rest', stamp: { proposalId: String(proposal._id), seq } })`;
   `update` → `records.update(ctx, module, id, data, { source: 'rest' })` (set-to-value, so replays are harmless).
   `$set appliedOps: seq + 1` after each.
6. Error → `status 'failed'`, `error`, rethrow (the user can retry; stamps make it resume). Done → `applied`,
   `appliedAt`, `appliedBy`, `result`; production: `$set` the plan's readOnly `feasibility` directly.
7. Publish `record { module: 'planproposals', id, change }` (§6) after every status change.

Our own ops bump `scheduleVersion`, so the check runs only from `draft`. Simulator writes (job card progress, its own
job cards) do not bump it.

```
GanttData = { range: { start, end }, timeZone,
  rows: [{ id: assetId, label: 'IMM 5', sub?: 'IMM-05 · 85 %', status?, health? }],
  bars: [GanttBar], shifts: [{ name, start, end }],
  markers: [{ id, rowId, at, kind: 'anomaly', severity, label, href }] }
GanttBar = { id, rowId, start, end, label, kind: 'jobcard'|'maintenance'|'setup', status?, code?, href?,
  ghost?: true, change?: 'new'|'moved'|'extended', from?: { start, end }, late?: true, conflict?: true, tooltip? }
Delay = { jobCardId, code, rowId, hours, late, dueDate? }
PlanBlockPayload = GanttData & { title, proposal?: { id, code, kind, status, title }, feasibility?, delays?: Delay[],
  options?: [{ id, label, lateHours, delayHours, maintenanceLateHours, recommended, risk? }], risks?, alternatives? }
```
Caps: ≤ 20 rows, ≤ 300 bars. `href`: `/m/jobcards/<id>`, `/m/workorders/<id>`. Ghost bars carry `ghost: true`;
the current bookings are plain bars.

### 3.5 Cost engine — `costs/tariffs.js`, `costs/periods.js`, `costs/engine.js`

```js
export const tariffOn = (plant, dayStartMs) => number | null;   // not deleted, addedDate ≤ day < changedDate (open-ended), latest addedDate wins (same rule as energy_consumption)
export const periodRange = (period /* day|week|month */, zone, now = new Date(), { previous = false } = {}) => ({ start, stop, key, label });
// key 'day:2026-10-16' | 'week:2026-W42' (ISO week, Monday) | 'month:2026-10'; stop = now (or the period end when previous)
export const COMPONENTS = ['energy', 'spares', 'consumables', 'labour', 'downtime'];
/**
 * @param {{ start, stop, groupBy?: 'asset'|'plant'|'category'|'day'|'component', components?, plantId?, assetIds? }} opts
 * @param {{ energySeries?: typeof seriesFor }} deps  tests pass a stub (no Influx in tests)
 */
export const costSummary = async (ctx, opts, { energySeries = seriesFor } = {}) => CostSummary;
```

| component | formula (range [start, stop), viewer scope) | asset / category |
|---|---|---|
| energy | Σ 15-min `ENERGY CONSUMPTION` (`seriesFor … every '15m', fn 'sum'`, stamp − 1 s → local day) × `tariffOn(plant, local day)`; energy assets except `typeOfAsset 'Energy Meter'` (the incomer double counts) | asset; `Energy` |
| spares | `sparepartstransactions` type `used`, `createdAt` in range: quantity × unitCost | the WO's asset (`reason.workOrderId`), else `Unassigned`; WO category |
| consumables | WOs with `trackProcess.completedAt` in range: Σ `consumablesAndTools.quantity × consumable.price` | WO asset; WO category |
| labour | same WOs: `hmsToSeconds(durations.timeInProgress)/3600 × max(1, people.length) × laborRatePerHour` (costsettings, default 350) | WO asset; WO category |
| downtime | downtimes with `[startedAt, endedAt ?? now]` clipped to the range, hours × (`asset.downtimeCostPerHour ?? defaultDowntimeCostPerHour`) | asset; `Downtime` |

`CostSummary = { start, stop, timeZone, currency: { name, symbol }, groupBy, components, totals: { energy, spares,
consumables, labour, downtime, maintenance, total, kwh, downtimeHours, labourHours }, rows: [{ key, label, energy,
spares, consumables, labour, downtime, maintenance, total }], notes: string[] }` — money rounded to 2 dp, components
not requested omitted (null), rows sorted by total desc (`day`: by key asc). Influx down → energy null + note
`Energy unavailable (telemetry offline)`; a day without tariff → its energy cost null + note. Currency from
`ctx.company.currency` (the UI formats; the server never formats money in data).

### 3.6 Cost alerts — `costs/alerts.js` + `costs/watch.js`

```js
export const evaluateAlert = async (ctx, alert, { now = new Date(), fire = true } = {}) => ({ value, periodKey, breached, fired });
export const checkAlerts = async (companyId, { now, alertId } = {}) => ({ evaluated, fired });  // systemContext(companyId)
export const startCostWatch = () => stopFn;   // setInterval re-reading settings.costWatch { enabled, intervalMin }; companies with enabled alerts; one company at a time; never overlapping
```

- Value = `costSummary` total of `metric` for the scope (asset → `assetIds: [assetId]`, plant → `plantId`, company
  → all) over `periodRange(period)` = period-to-date. `gt|gte`: compare period-to-date; `lt|lte`: compare the
  **previous complete** period (`previous: true`, its key) so a day doesn't "fire" at 00:15.
- Always `$set lastValue, lastEvaluatedAt`. Breached and `lastPeriodKey !== periodKey` → fire once: explanation
  (§4, fallback text on AiUnavailableError), `$push history { $each: [row], $slice: -60 }`, `lastTriggeredAt`,
  `lastPeriodKey`; `notifyUsers(records, ctx, { userIds, title: 'Cost alert: <name>', description: explanation,
  module: 'costalerts', recordId, assetId, plantId, type: 'alert', priority: 'high' })` (the live poller turns it
  into a `notification` event → toast); publish `record { module: 'costalerts', id, change: 'triggered' }`.

### 3.7 KPI runner — `kpis/runner.js` + `kpis/normalize.js`

```js
export const KPI_SOURCE_TOOLS = new Set(['work_orders_summary', 'spare_parts_below_minimum', 'upcoming_maintenance',
  'job_card_progress', 'rejection_summary', 'downtime_summary', 'attendance_summary', 'telemetry_latest',
  'telemetry_series', 'telemetry_status_timeline', 'telemetry_shot_counts', 'energy_consumption', 'machine_health',
  'list_anomalies', 'mongo_find', 'mongo_count', 'mongo_aggregate', 'cost_summary']);
export const validateKpi = (ctx, def) => def;            // 400 with issues: tool allowed, exists, permitted (tool.permission, groupEnabled), args parse after time injection, keys unique, formula identifiers ⊂ keys, encoding.source ∈ keys
export const runKpi = async (ctx, def, { now, signal } = {}) => KpiResult;   // never throws for a failing source: result.error
export const normalize = (def, sourceValues, range) => KpiResult;            // pure (normalize.js)
```

- Runs in the **viewer's** `ctx` (tenancy, plant lock, permissions come from the tools themselves).
- `range = resolveTimeRange({ text: def.timeRange.text }, ctx, now)` on every run. Args: string values exactly
  `"$start"`/`"$stop"` (any depth, e.g. in mongo filters) → `range.start`/`range.stop`; tools whose schema has
  top-level `start`/`stop` get them injected when absent. Stored args never hold start/stop (create/update_kpi strip
  them). Then `getTool(name).schema.safeParse(args)` — zod re-validation every run.
- Each source: `tool.run(ctx, args, { emit: () => {}, signal, results: new Map(), callId: 'kpi_<key>' })`, 15 s
  timeout, sources in parallel. Source value = `getPath({ forModel, data }, pick ?? 'data.rows')`, falling back to
  `forModel.rows`.
- Mapping (rows sorted/limited by `encoding.sort/limit` first), source = `encoding.source ?? sources[0].key`:
  number/gauge value = formula ?? scalar source value ?? Σ `row[encoding.value]` ?? rows.length; series charts:
  x = `row[encoding.x]`, series = `encoding.series ?? [{ key: encoding.value ?? first numeric column }]`;
  pie/funnel/treemap: label `row[encoding.label ?? encoding.x]`, value `row[encoding.value]`; heatmap: x/y =
  `row[encoding.x]`/`row[encoding.y]`, and when `y` is absent and x looks like `YYYY-MM-DD HH:00`
  (energy_consumption groupBy hour) → y = date, x = hour; timeline: lanes by `row[encoding.label ?? 'asset']`, runs
  `row[encoding.start ?? 'start']`→`row[encoding.end ?? 'end']`, status `row[encoding.value ?? 'status']`; table:
  `data.columns` or the first row's keys.

```
KpiResult = { id?, viz, title, unit, target?, thresholds?, timeRange: { start, stop, label, timeZone }, ranAt,
  error?: string, warnings: string[],
  stats: { count, sum, min, max, mean, first, last, changePct, top: [{ label, value }] },   // primary numeric series
  // number | gauge
  value?: number|null, tone?: 'good'|'warn'|'critical'|'neutral', min?: number, max?: number,
  // line | area | bar | stackedBar | combo | scatter | radar
  xKey?: 'x', xType?: 'time'|'category'|'number', series?: [{ key, label, unit?, axis: 'left'|'right', type? }],
  data?: [{ x, [seriesKey]: number|null }],
  // pie | funnel | treemap
  slices?: [{ label, value }],
  // heatmap
  xLabels?: string[], yLabels?: string[], cells?: [{ x, y, value }], cellMin?: number, cellMax?: number,
  // timeline
  lanes?: [{ label, runs: [{ start, end, status, label? }] }],
  // table
  columns?: [{ key, label, unit? }], rows?: object[] }
```
`tone` from thresholds (direction aware) or target (≥ target good). Gauge `max` = thresholds/target × 1.25, or 100
when unit is `%`. Caps: 2000 data points, 400 heatmap cells, 1000 table rows.

### 3.8 Formula — `kpis/expr.js` (pure, safe, no eval/Function)

```
expr    := term (('+' | '-') term)*
term    := unary (('*' | '/' | '%') unary)*
unary   := '-' unary | primary
primary := NUMBER | KEY | FUNC '(' arg (',' arg)* ')' | '(' expr ')'
arg     := expr | KEY '.' FIELD
FUNC    := sum | avg | min | max | count | first | last | round | abs
```
`KEY` = a source key (its scalar value; a rows value used bare → error); `KEY.FIELD` only inside
`sum/avg/min/max/first/last` (column of a rows source); `count(KEY)` = rows length; `round(x, dp)`. Division by
zero or a missing number → `null`. ≤ 300 chars, ≤ 64 tokens, depth ≤ 10. Exports:
`parseExpr(text) → ast` (throws `badRequest('Formula error at <pos>: …')`), `evalExpr(ast, scope) → number|null`,
`identifiersOf(ast) → string[]`, `evaluate(text, scope)`. Example: `sum(energy.kwh) / sum(shots.shots)` (kWh per shot).

### 3.9 KPI insights — `kpis/insights.js`

```js
export const refreshInsights = async (companyId, { kpiIds, force = false } = {}) => ({ refreshed });
```
KPIs whose `insight.at` is older than `settings.kpiInsightTtlMin` (or `force`/`kpiIds`) are run in an insight ctx =
`{ ...systemContext(companyId), plantLock: kpi.plantId ?? null }` (so the shared text only holds data every viewer
of that KPI can see), then **one** call for all of them (§4, ≤ 20 per call). Store `insight` via Model `$set`, publish
`record { module: 'kpis', id, change: 'insight' }`. Per-company in-flight dedupe (Map of promises).

### 3.10 Briefing — `briefing/evidence.js` + `briefing/briefing.js`

```js
export const buildEvidence = async (ctx, { now = new Date() } = {}) => Evidence;   // viewer ctx, today so far in the company zone
export const getBriefing = async (ctx, { refresh = false, now } = {}) => ({ briefing, evidence, model, at, mock, stale, aiError? });
```
`Evidence = { production, oee, downtime, anomalies, maintenance, costs, plan }`, each `{ …numbers, block }` where
`block` is a ready UI block (`{ type: 'kpis'|'table'|'chart', payload }`, phase-4 shapes):
- `production { produced, planned, pct, byAsset: [{ asset, assetId, produced, target }] ≤5 }` — partcounts today.
- `oee { oee, availability, performance, quality, basis: 'job cards completed in the last 7 days' }`.
- `downtime { totalMinutes, count, top: [{ asset, assetId, minutes, reason }] ≤3 }` — today.
- `anomalies { open, critical, items: [{ id, code, asset, assetId, type, severity, summary }] ≤5 }` — by severity.
- `maintenance { overdue, dueToday, openWorkOrders, dueSoon: [{ kind: pm|calibration|workorder, id, code, name, asset, assetId, due }] ≤5 }`.
- `costs { total, energy, maintenance, downtime, currency }` — month to date (`costSummary`).
- `plan { activeJobCards, late: [{ code, asset, endDate, dueDate }] ≤5 }`.
Cache in `AiText` (key §2), regenerate when older than `settings.briefingTtlHours` or `refresh`; per-key in-flight
dedupe; guardrails: action `link` must start with `/` else null, `evidence` keys filtered to present ones.

## 4. AI calls

All `generate({ tier: 'background', purpose, companyId, system, contents: JSON.stringify(input), schema:
toJsonSchema(zodSchema), mockInput: { kind, ...input } })`; `input` is exactly the mock input below (the mock
answers from it). Chat tools never call `generate` — in chat the chat model explains from `forModel`.

| call (`kind`) | purpose | when | cache | fallback on AiUnavailableError |
|---|---|---|---|---|
| `plan_explanation` | planning | REST `POST /planning/production` and `/explain` | `proposal.explanation` | deterministic one-liner from feasibility; UI chip "AI explanation unavailable" |
| `maintenance_recommendation` | planning | REST `POST /planning/maintenance` and `/explain` | `proposal.explanation` (+ may set `recommendedOption`) | deterministic recommendation, text "Least delay: <label>" |
| `cost_overview` | cost | `GET /costs/overview` when stale, `POST /costs/overview/refresh` | `AiText cost_overview`, TTL `briefingTtlHours` | totals + deterministic drivers, last text marked stale, `aiError` |
| `cost_alert` | cost | costWatch on a breach | `history[].explanation` | `<Metric> on <scope> reached ₹X <period>, past the ₹Y limit.` |
| `kpi_insights` | kpi | `POST /kpis/insights/refresh`, `/kpis/:id/explain` | `kpi.insight`, TTL `kpiInsightTtlMin` | keep the old insight (UI shows its age); none → no line |
| `briefing` | briefing | `GET /briefing` when stale, `POST /briefing/refresh` | `AiText briefing`, TTL `briefingTtlHours` | evidence blocks + headline "Today so far", last narrative marked stale, `aiError` |

Inputs (`mockInput` minus `kind`) and response schemas (zod; the mock already returns these shapes):
```js
// plan_explanation  input { proposal: { kind, title, feasibility, risks: [{ text }], alternatives, jobCards: [{ asset, tool, target, setupMin, start, end }] } }
z.object({ summary: z.string().max(400), bullets: z.array(z.string().max(200)).min(1).max(4) })
// maintenance_recommendation  input { task: { title, kind, assetName, deadline, durationMin, severity }, options: [{ id, label, lateHours, delayHours, maintenanceLateHours, risk }], recommended }
z.object({ recommendedOption: z.enum(['zero_impact', 'insert', 'move', 'defer']), summary: z.string().max(400), reasons: z.array(z.string().max(200)).min(1).max(3) })
//   guardrail: the pick must be one of `options` and not 'defer' when a non-defer option has lateHours 0; else keep the deterministic one
// cost_overview  input { period: { key, label }, currency, totals, previous: { total, …components }, topDrivers: [{ key, label, component, amount, deltaPct }] ≤5, budgets: { maintenance, energy } }
z.object({ headline: z.string().max(160), summary: z.string().max(600), drivers: z.array(z.object({ key: z.string(), explanation: z.string().max(300), action: z.string().max(200) })).max(5) })
// cost_alert  input { alert: { name, metric, scope, scopeLabel, period, comparator, threshold }, value, currency, breakdown: [{ label, amount }] ≤5, previousPeriods: number[] ≤6 }
z.object({ explanation: z.string().max(400) })   // 2 sentences: cause, then fix
// kpi_insights  input { items: [{ id, kpi: { title, viz, unit, target, thresholds, timeRangeLabel }, stats }] ≤20 }
z.object({ insights: z.array(z.object({ id: z.string(), text: z.string().max(200) })).max(20) })   // ids not in the input are dropped
// briefing  input { company: { name, currency }, scope: { label }, at, evidence: { production, oee, downtime, anomalies, maintenance, costs, plan } (numbers only, no blocks) }
z.object({ headline: z.string().max(120), narrative: z.string().max(900),
  actions: z.array(z.object({ title: z.string().max(100), why: z.string().max(200), link: z.string().max(200).nullable(), ask: z.string().max(300).nullable() })).length(3),
  evidence: z.array(z.enum(['production', 'oee', 'downtime', 'anomalies', 'maintenance', 'costs'])).min(1).max(4) })
```
`ask` = a question the UI sends to the assistant (`useAssistant.getState().open({ text: ask, send: true })`).
Background calls are refused once the daily reserve is reached (`budget.js`) — that is an AiUnavailableError too.

## 5. Agent tools (phase-4 §2 shape)

Tools never write records directly except through `records.*`; planners write only proposals. Groups (integrator
adds them, §10): `planning`, `cost`, `kpi`. Permissions use `can(ctx, getModule(m), action)` (`modules/permissions.js`).

| tool (file) | group | schema (zod) | permission | result |
|---|---|---|---|---|
| `capacity_calendar` (`planning/tools.js`) | planning | `{ plantId?: string, assetIds?: string[] ≤20, start?: string, stop?: string }` (default now → +7 d) | any role | forModel `{ start, stop, machines: [{ asset, assetId, efficiency, freeHours, bookedHours, bookings: [{ code, label, start, end }] ≤10, freeWindows: [{ start, end, hours }] ≤10 (≥30 min) }] }`; summary `Capacity of 6 machines · 412 h free`; blocks `[plan]` (GanttData, no proposal) |
| `plan_production` (`planning/tools.js`) | planning | `{ part: string ≤120, quantity: int 1–10 000 000, dueDate: string ≤40 (ISO, or text resolveTimeRange understands → its stop = end of that day), productionPlan?: string (id or PP-code), plantId?, toolIds?: string[] ≤5, start?: string }` | `can(jobcards,'create')` and productionEnabled | creates a draft proposal; forModel `{ proposalId, code, feasible, dueDate, projectedFinish, slackHours, shortfall, jobCards: [{ asset, tool, target, start, end, setupMin }], risks: [text], alternatives: [text], next: 'Call apply_plan { proposalId } so the user can confirm' }`; summary `PLN-3 · 3 job cards · on time (61 h slack)`; blocks `[plan]` |
| `plan_maintenance` (`planning/maintenanceTool.js`) | planning | `{ asset?: string, anomaly?: string (id or ANM-code), workOrder?: string (id or WO-code), horizonDays?: int 1–30 = 7, allowNonRunningDays?: boolean = false }` | `can(workorders,'create')` | draft proposal; forModel `{ proposalId, code, task: { title, deadline, durationMin }, options: [{ id, label, start, end, lateHours, delayHours, delays: [{ code, hours, late }], risk }], recommended, next }`; summary `PLN-4 · 3 options · recommended move`; blocks `[plan]` |
| `apply_plan` (`planning/tools.js`) | planning | `{ proposalId: string (id or PLN-code), option?: enum zero_impact\|insert\|move\|defer }` | role ≠ view (records enforce the rest) | **requiresConfirmation**; preview = scope/expiry/permission/version checks (stale → re-plans and throws the 409 `PLAN_CHANGED` AppError, so the model gets `{ error, details: { proposalId, proposalCode } }` and offers the new plan) → confirm payload below; run = `applyProposal` → forModel `{ applied: true, code, created: [{ module, id, label, link }], updated: [...] }`, summary `Applied PLN-3: 4 created, 1 updated` |
| `cost_summary` (`costs/tools.js`) | cost | `{ start: string, stop: string, groupBy?: enum asset\|plant\|category\|day\|component = asset, components?: enum(COMPONENTS)[] , plantId?: string, assetIds?: string[] ≤20 }` | any role | `rowsResult` (rows = CostSummary.rows, ≤50 to the model) + forModel `{ start, stop, currency, totals (numbers + money(ctx) strings), notes }`; blocks `[chart stackedBar by component]` when > 1 row |
| `create_kpi` (`kpis/tools.js`) | kpi | `{ title, description?, viz: enum(KPI_VIZ), unit?, target?, thresholds?, timeRange: { text }, sources: [{ key, tool, args: record, pick? }] 1–4, formula?, encoding?, pinned? }` | `can(kpis,'create')` | **requiresConfirmation**; preview = `validateKpi` + `runKpi` in ctx; run = `records.create(ctx, 'kpis', def, { source: 'kpi' })` → forModel `{ created: { id, title, link: '/kpis' } }`, blocks `[kpi]` |
| `update_kpi` (`kpis/tools.js`) | kpi | `{ id: string, changes: <partial create_kpi> }` | `can(kpis,'update')` | **requiresConfirmation**; preview runs the merged KPI + diff; run = `records.update(…, { source: 'kpi' })`; blocks `[kpi]` |
| `list_kpis` (`kpis/tools.js`) | kpi | `{}` | any role | forModel `{ kpis: [{ id, title, viz, unit, timeRange, sources: [{ key, tool }], pinned }] }` |

Descriptions must carry one example call each, like phase 4. `create_kpi` description: list the allowed source
tools, say `start`/`stop` are injected from `timeRange` (use `"$start"`/`"$stop"` inside mongo filters), give the
heatmap example `{ title: "Compressor energy by hour", viz: "heatmap", unit: "kWh", timeRange: { text: "last 7 days" },
sources: [{ key: "energy", tool: "energy_consumption", args: { assetIds: ["<id>", "<id>"], groupBy: "hour" } }],
encoding: { source: "energy", x: "hour", value: "kwh" } }`. Cost alerts and cost settings are written with the
generic `create_record`/`update_record` (agentNotes in §2; costsettings: "one record per company; update it").

Confirm payloads (the loop adds `actionId, expiresAt, status`):
```
apply_plan  → { tool: 'apply_plan', action: 'plan', module: 'planproposals', moduleLabel: 'Plan Proposals',
                label: 'Apply PLN-3: 3 job cards on IMM 5, IMM 3, IMM 1', proposal: { id, code, kind, title, status },
                option, ops: [{ seq, op, module, label, summary }], plan: PlanBlockPayload }
create_kpi  → { tool: 'create_kpi', action: 'kpi', module: 'kpis', moduleLabel: 'KPIs', label: 'Create KPI "…"', kpi: <def>, result: KpiResult }
update_kpi  → { tool: 'update_kpi', action: 'kpi', module: 'kpis', moduleLabel: 'KPIs', label: 'Update KPI "…"', kpi: <merged def>, changes: [{ field, from, to }], result: KpiResult }
```
New blocks: `plan` → `PlanBlockPayload` (§3.4); `kpi` → `{ id?, kpi: <def>, result: KpiResult }`.

## 6. Routes

Routers carry full paths and mount at `/api` (signed in). Roles: owner/admin full; technician by `can()`; viewer
read-only; plant lock everywhere (all reads through `records`/scopeFilter, all engines get `req.ctx`). Errors are
phase-2 JSON `{ error: { code, message, details? } }`; AI endpoints map AiUnavailableError with `aiUnavailable(err)`.

| Route | Who | Request → response |
|---|---|---|
| `GET /api/planning/calendar?start&end&plantId&assetIds=a,b` | any | → `{ gantt: GanttData, machines: [{ assetId, efficiency, efficiencySource, freeHours, bookedHours }] }` (default today 00:00 → +7 d, ≤ 31 d) |
| `POST /api/planning/production` | jobcards create + productionEnabled | `{ partName, quantity, dueDate (ISO), productionPlanId?, toolIds?, start?, plantId? }` → `{ proposal, plan: PlanBlockPayload }` (explanation filled, AI failure → `explanation` null + `aiError`) |
| `GET /api/planning/proposals?status&kind&limit` | any | → `{ items: [proposal without ops] }` newest first |
| `GET /api/planning/proposals/:id` | any | → `{ proposal, plan: PlanBlockPayload }` (id or PLN-code) |
| `POST /api/planning/proposals/:id/apply` | per op `can()` | `{ option? }` → `{ proposal, created, updated }`; 409 `PLAN_CHANGED { proposalId, proposalCode }`, 409 `CONFLICT`, 410 `GONE`, 403 |
| `POST /api/planning/proposals/:id/discard` | owner/admin or creator | → `{ proposal }` |
| `POST /api/planning/proposals/:id/explain` | role ≠ view | → `{ explanation }` (429/503 on AI failure) |
| `GET /api/planning/parts` | any | → `{ parts: [{ partName, tools: [{ id, toolNumber, assets: [label] }] }] }` (Planner form) |
| `POST /api/planning/maintenance` (planningMaintenance.js) | workorders create | `{ assetId?, anomalyId?, workOrderId?, horizonDays?, allowNonRunningDays? }` → `{ proposal, plan: PlanBlockPayload }` |
| `GET /api/costs/summary?start&stop&text&groupBy&components=a,b&plantId&assetId` | any | `text` → resolveTimeRange; → `CostSummary` |
| `GET /api/costs/overview?period=day\|week\|month` | any | → `{ summary: CostSummary, previous: { totals }, ai: { headline, summary, drivers } \| null, model, at, mock, stale, aiError? }` |
| `POST /api/costs/overview/refresh` | owner/admin | `{ period }` → same as GET |
| `POST /api/costs/alerts/:id/check` | owner/admin | → `{ value, periodKey, breached, fired }` (evaluate now, fires once per period) |
| `GET /api/kpis/:id/run` | can read the KPI | → `{ result: KpiResult }` (viewer ctx) |
| `POST /api/kpis/:id/explain` | owner/admin | → `{ insight }` (force, single KPI) |
| `POST /api/kpis/insights/refresh` | any | → `{ refreshed }` (TTL bound; the KPI page calls it once on mount) |
| `GET /api/briefing` | any | → `{ briefing: { headline, narrative, actions, evidence }, evidence: Evidence, model, at, mock, stale, aiError? }` |
| `POST /api/briefing/refresh` | owner/admin | → same |

KPI list, cost alert list/toggle and KPI delete use the generic routes: `GET /api/m/kpis`, `GET /api/m/costalerts`,
`PATCH /api/m/costalerts/:id { enabled }`, `DELETE /api/m/kpis/:id`. There is **no** KPI create route.

Live events (`lib/events.publish`, audience `plantAudience(doc.plantId)`): only the existing types.
- `record { module: 'planproposals', id, change: 'created'|'applied'|'discarded'|'stale'|'expired'|'failed' }`
- `record { module: 'kpis', id, change: 'insight' }`; `record { module: 'costalerts', id, change: 'triggered' }`
- records.js already publishes `record { module: 'jobcards'|'workorders'|'productionplans'|'kpis'|'costalerts', id, change }` on apply/CRUD.
- `notification` (cost alert, via `notifyUsers` + the live poller).
`useRecordSync` invalidates `['m', module]`, so module-backed queries use keys starting with `['m', '<module>']`.

## 7. Client

Hooks (TanStack Query 5, `api()` from `api/client.js`, keys exact):
- `usePlanning.js`: `useCalendar({ start, end, plantId })` `['planning', 'calendar', params]`; `useProposals(params)`
  `['m', 'planproposals', 'list', params]`; `useProposal(id)` `['m', 'planproposals', id]`; `useProposeProduction()`,
  `useProposeMaintenance()`, `useApplyProposal(id)`, `useDiscardProposal(id)`, `useExplainProposal(id)` mutations
  (success → invalidate `['planning']` and `['m', 'planproposals']`); `useParts()` `['planning', 'parts']`. The page
  subscribes `useLiveEvent('record', d => ['jobcards', 'workorders', 'planproposals'].includes(d.module) &&
  qc.invalidateQueries({ queryKey: ['planning'] }))`.
- `useCosts.js`: `useCostSummary(params)` `['costs', 'summary', params]`; `useCostOverview(period)`
  `['costs', 'overview', period]`; `useRefreshOverview()`; `useCostAlerts()` = `useRecords('costalerts', …)`;
  `useCheckAlert()`.
- `useKpis.js`: `useKpis()` = `useRecords('kpis', { limit: 100, sort: '-updatedAt' })` (`['m', 'kpis', …]`);
  `useKpiRun(id)` `['kpis', 'run', id]` (staleTime 60 s); `useExplainKpi(id)`; `useRefreshInsights()` (once on page
  mount); delete via `useDeleteRecord('kpis')`.
- `useBriefing.js`: `useBriefing()` `['briefing', plantId]`; `useRefreshBriefing()`.

Components (props exact):
- `planner/ganttLayout.js` (pure): `timeScale(range, width) → { x(t) px, t(px) ms }`; `layoutGantt({ rows, bars,
  range, width, rowHeight = 36, barHeight = 22, now }) → { height, rows: [{ id, y, h }], bars: [{ ...bar, x, w, y, h,
  lane, segments: [{ x, w }] }], nowX }` — clip to range, w ≥ 2 px, overlapping plain bars stack in lanes (row grows),
  a job card bar crossed by a maintenance bar of the same row is drawn as `segments` around it (split), a ghost bar
  with `from` also yields an outline at `from`; `ticks(range, timeZone, width) → [{ x, label, major }]` (hours ≤ 2 d,
  else days).
- `planner/Gantt.jsx` `<Gantt data={GanttData} compact? now? selectedId? onBarClick?(bar) className />` — row labels
  (asset + status pill + HealthRing size 20) unless compact, shift bands, now-line, anomaly markers (pulse dot),
  ghost bars dashed teal (`.ai-edge` palette), late/conflict red ring, tooltips (code, label, time in company format),
  keyboard focusable bars. Reused by the Command Center mini Gantt (`compact`).
- `planner/PlanBlock.jsx` exports `PlanBlock({ payload })` (chat `plan` block: Gantt compact + feasibility badge +
  delay chips + options + "Open in Planner" link `/planner?proposal=<id>`) and `PlanPreview({ payload })` (ConfirmCard
  body for `action: 'plan'`: same Gantt + ops list).
- `planner/PlannerPage.jsx` (`/planner`; query `?maintenance=<assetId>&anomaly=<anomalyId>` → runs
  `useProposeMaintenance` once on mount; `?proposal=<id>` → selects it): header (plant, range 1/3/7/14 days), Gantt
  of `useCalendar` + the selected proposal's ghost bars, `AiPlanPanel` ("Auto-plan production" form: part select from
  `useParts`, quantity, `<input type="date">` due date → propose; "Find maintenance windows" → propose maintenance
  `{}`; "Ask SARA" → `useAssistant.getState().open({ text: 'Plan ' })`), proposal view (title, feasibility badge,
  explanation with `AiProvenance`, option radio cards with lateness, delay chips `JC-14 +2.0 h` (late → critical),
  risks, alternatives, Confirm (apply with option; `PLAN_CHANGED` → toast "Plan changed — showing the updated plan"
  and select `details.proposalId`) / Discard), `PlansList` (code, kind icon, title, status badge, feasibility badge
  "On time"/"Short 1,200 pcs"/"Late 6 h", relative time).
- `viz/Viz.jsx` `<Viz result={KpiResult} height={220} compact={false} className />` — one component, all 15 types:
  recharts for line/area/bar/stackedBar/combo (dual axis)/pie/scatter/radar/funnel/treemap, SVG `Gauge`, `Heatmap`
  (hour × day, sequential scale, accessible cell titles), timeline via `StatusTimelineBar` lanes, number (big tabular
  value, unit, target, tone), table via `DataTable`; `result.error` → inline error state; empty data → "No data in
  <label>". `viz/vizData.js` pure helpers (tone colours, heatmap scale, tick formats). Load the `dataviz` skill;
  colours from `seriesColor()`.
- `kpis/KpisPage.jsx` (`/kpis`, "KPI Builder"): prompt bar ("Ask SARA to build a KPI…" → `open({ text, send: true })`);
  empty state with an info panel ("KPIs are generated by the SARA assistant. Describe what to track; SARA picks the
  data, chart and time range, shows a live preview, and adds the card here after you confirm.") and prompt chips:
  `Build a heatmap of compressor energy by hour`, `OEE of the IMM machines this week as a gauge with target 85%`,
  `Downtime minutes by machine this month`, `Maintenance cost by asset this month`, `kWh per shot on IMM 4 over the last 7 days`;
  grid of `KpiCard`.
- `kpis/KpiCard.jsx` `<KpiCard kpi canEdit />`: title, unit, pin star, `Viz` from `useKpiRun`, insight line +
  `AiProvenance` (Regenerate = Explain); menu Refresh (refetch run), Explain, Change via chat (`open({ text: 'Change
  the KPI "<title>": ', context: { page: 'kpis', recordRef: { module: 'kpis', id } } })`), Delete (Dialog confirm);
  Explain/Delete only when `session.can.kpis.update/delete`.
- `kpis/KpiPreviewBlock.jsx` exports `KpiPreviewBlock({ payload })` (chat `kpi` block) and `KpiPreview({ payload })`
  (ConfirmCard body for `action: 'kpi'`: Viz of `payload.result` + definition summary + changes table).
- `costs/CostsPage.jsx` (`/costs`): period tabs Today/This week/This month/Custom (two date inputs → summary);
  `CostOverviewCard` (`Card ai`, headline, summary, drivers with actions, AiProvenance + Refresh for owner/admin,
  unavailable state); totals `KpiBlock`; `CostBreakdown` (by asset stacked bar by component, by category pie, by day
  stacked area — `ChartBlock`); top drivers table; `CostAlertsList` (name, metric, period, threshold vs lastValue bar,
  enabled `Switch` → PATCH, last triggered, history expand, "Check now" for owner/admin, chip "Ask SARA to add an alert"
  → `open({ text: 'Alert me if ' })`).
- `home/CommandCenter.jsx` (`/`): `BriefingCard` (`Card ai`, headline, narrative, 3 actions — link → navigate, ask →
  assistant, evidence blocks via `ChartBlock`/`KpiBlock`/`DataTable`, AiProvenance + Refresh), `LiveFloor` (machine
  tiles: `useLiveAsset` status + key field, `HealthRing`, anomaly badge from `useOpenAnomalies`), `KpiStrip` (pinned
  KPIs first, else 4 most recent, `Viz compact`), `AlertsFeed` (latest notifications + open anomalies, newest first,
  `useLiveEvent('notification')` refresh), mini Gantt (`useCalendar` today 00:00 → +24 h, `<Gantt compact />`),
  `MaintenanceDue` (from `briefing.evidence.maintenance.dueSoon` + overdue count, "Plan" → `/planner?maintenance=<assetId>`).

Reuse: `ui/core.jsx` (Card `ai`, CardHeader, Badge, StatusPill, Skeleton, EmptyState, PageHeader, AiProvenance),
`ui/overlay.jsx` (Dialog, Sheet, Menu, Tabs, Tooltip), `ui/form.jsx` (Input, Select, Switch, Field), `ui/charts.jsx`
(`seriesColor`, `statusStyle`, `StatusTimelineBar`, `Sparkline`), `lib/format.js` (`formatDate/Time/DateTime/Relative/
Number/Money/Duration`, `cn`), `live/liveStore.js` (`useLiveEvent`, `useLiveAsset`), `blocks/ChartBlock.jsx`.
Responsive to 360 px, keyboard accessible, `prefers-reduced-motion` respected.

## 8. Tests each package ships

| Package | Must cover |
|---|---|
| C:planning-core | capacity: overnight shift C 22:00–06:00 with the 02:00–02:30 break on the next day, holidays and Sunday excluded, bookings subtracted, efficiency default 0.85; planner: due date met (slack) or shortfall + alternatives, one mould per machine, setup counted only on a mould change, split across 3 Housing-A moulds; apply: idempotent double apply (same ids, no duplicates), stale version → 409 PLAN_CHANGED with a new proposal, resume after a failed op, company B can't read/apply A's proposal |
| C:planning-maint | zero-impact window found before the deadline; insert → later job cards shift with delays (+late flag vs plan due date); move → remainder on the other machine; defer risk; recommendation order; PM option advances `nextGenerationDate` |
| C:planner-client | `ganttLayout`: positions, clipping, lanes, split around maintenance, ghost `from` outline, ticks; page renders a proposal and confirms |
| C:costs-server | daily tariffs across the 1 Jul 2026 change (7.8 → 8.4 ₹/kWh) with the 15-min window stamp − 1 s; labour `'02:35:48'` × 2 people × ₹350 = ₹1,817.67; downtime clipping; groupBy; alerts fire once per period, `lt` uses the previous period, history capped, notification created |
| C:kpi-server | `expr.js` grammar, errors, division by zero; runner tenancy (A's KPI run by a B user returns B data; plant lock), allow-list, zod re-validation, `$start/$stop` injection and re-resolution, normalisation per viz; create_kpi preview + confirm through the mock loop |
| C:kpi-client | `Viz` renders each of the 15 types from a fixture `KpiResult`; KPI page empty state + chips + card actions |
| C:costs-client | page renders summary/overview/alerts, toggle calls PATCH, AI-unavailable state |
| C:command-center | evidence pack numbers, cache TTL + refresh, AI-unavailable fallback (stale text), plant-locked key; Command Center renders all six sections |

Server tests use `test/helpers/db.js` (`setupDatabase()` seeds Acme with the same Housing-A moulds T-101/T-102/T-103,
`NOW = 2026-10-15T06:30Z`); pass `now` explicitly into engines. Influx is not available in tests: pass
`costSummary(ctx, opts, { energySeries: async () => ({ series }) })`, and `vi.mock('../src/telemetry/queries.js')`
where a tool reads telemetry (KPI runner tests).

## 9. Demo cases on the seeded data (live DB 2026-10-16, company Acme Components `3d7e0d1dc28cd6339ff2e876`, plant Pune, IST)

Facts: shifts A 06–14 (breaks 09:00–09:15, 11:30–12:00), B 14–22 (17:00–17:15, 19:30–20:00), C 22–06 (01:00–01:15,
02:00–02:30); running Mon–Sat (Sun 18 Oct is off); holidays 2 Oct, 8–9 Nov, 25 Dec; tariffs ₹7.8 → ₹8.4/kWh from
1 Jul 2026; costsettings labour ₹350/h, downtime ₹3000/h, budgets maintenance ₹3.5 L, energy ₹20 L; every asset has
`downtimeCostPerHour` (except Main Incomer). Users: `owner_1@swayatt.com` (owner), plant-locked admins
`maintenance_manager_1@…`, `plant_manager_1@…`, `production_manager_1@…`, `viewer_1@swayatt.com` (view). Maintenance
technicians on shifts A, B and C.

1. **Plan maintenance from an anomaly.** Press 1 (`4e79406f8c242ed4cca4392f`) runs JC-14 (Bracket-C, T-301, until
   17-10 16:49 IST); ANM-7 (quality_degradation, warning, urgency 8 h) is open on it and PM-7 (90 min) is due 17-10
   08:30 IST. `/planner?maintenance=4e79…&anomaly=<ANM-7 id>` (or after injecting `bearing_wear`) → no zero-impact
   window before the deadline → options insert (JC-14 extended ≈ duration) / move (rest of JC-14 to Press 2 with
   T-301, +30 min setup) / defer; PP-6 (Bracket-C, due 23-10) stays on time → Confirm → WO created with the planned
   window, JC-14 updated (+ new JC on Press 2 for move), Gantt refreshes from `record` events.
2. **"Plan 5000 parts of Housing-A due 25 Oct".** Moulds T-101 (2-cav, 32 s, setup 45; IMM 1/IMM 2), T-102 (2-cav,
   30 s; IMM 3/IMM 4), T-103 (4-cav, 38 s, setup 60; IMM 4/IMM 5). Bookings: T-101 busy on IMM 1 (JC-12, JC-17 until
   21-10 02:56 IST), T-102 on IMM 3 (JC-15 until 17-10 23:34), T-103 on IMM 4 (JC-18 until 17-10 07:30), IMM 2 has
   JC-13 (Cap-B), IMM 5/IMM 6 free; IMM 4 has ANM-5 critical. Expected with today's data: PP-n created + 3 job cards —
   T-103 → IMM 5 (60 min changeover, from 17-10 07:30), T-102 → IMM 3 (from 17-10 23:34, no changeover), T-101 → IMM 1
   (from 21-10 02:56) — feasible with slack; risks PM-1 (IMM 1, 18-10) and ANM-2/ANM-4 (IMM 1/IMM 3). Confirm →
   job cards visible on the Planner; the simulated supervisor starts them (`startDate ≤ now + 1 h`). The data moves
   while the simulator runs — never hard-code these ids or numbers in tests.
3. **"Alert me if Compressor 2 energy cost > ₹3000/day".** `resolve` → Compressor 2 (`03a56e9660c9f712e225dd36`,
   CMP-02) → `create_record costalerts { metric: energy, scope: asset, assetId, period: day, comparator: gt,
   threshold: 3000 }` → Confirm; costWatch (15 min) or "Check now" evaluates; a breach → notification toast + history.
4. **"Build a heatmap of compressor energy by hour".** `create_kpi` with `energy_consumption { assetIds: [CMP-01
   ad2abc6e2c4caa05a822a63a, CMP-02 03a56e96…], groupBy: 'hour' }`, `timeRange: last 7 days`, `encoding { x: 'hour',
   value: 'kwh' }` → Confirm card with the live heatmap → KPI page card + insight after `insights/refresh`.
5. **"maintenance cost by asset this month".** `resolve_time_range { text: 'this month' }` → `cost_summary { groupBy:
   'asset', components: ['spares', 'consumables', 'labour'] }` → table + stacked bar (11 `used` spare transactions,
   23 completed WOs with `timeInProgress`, consumables priced).

### Seed gaps (for the later idempotent seed step; do not edit the simulator)

1. **Influx is empty for Acme from SARA's side**: `discoverFields`/`seriesFor` over 7 days return nothing for
   Compressor 2 (and IMM 4) at the configured `INFLUX_URL`. Energy cost, the heatmap KPI, the compressor alert and
   the briefing's energy number are all 0 until the simulator backfills 7 days of `energy` (`ENERGY CONSUMPTION` per
   15 min) into the bucket SARA reads. Compressor 2 must average > ~360 kWh/day (₹3000 ÷ ₹8.4) on at least one
   day for demo 3 to fire.
2. Efficiency history: only 3 job cards completed in the last 14 days (JC-9/10/11) → most machines use the 0.85
   default. Optional: 1–2 more completed job cards per IMM in the last 14 days.
3. WO-101 (IMM 3) and 2 more WOs lack `estimatedDurationMin` (category default applies — fine).
4. No `costalerts`, `kpis`, `planproposals` documents — created at runtime (fine). Optional seed: 2 pinned KPIs so the
   Command Center KPI strip is not empty on first login.
5. `partcounts` exist (103) but only for past shifts; the briefing's "production vs plan today" needs today's rows
   (the simulator writes them live while running).

## 10. Integrator checklist (shared files only the integrator edits)

- **`server/src/index.js`**: import and mount (`{ path: '/api', router }`) `planningRouter` (`routes/planning.js`),
  `planningMaintenanceRouter` (`routes/planningMaintenance.js`), `costsRouter` (`routes/costs.js`), `kpisRouter`
  (`routes/kpis.js`), `briefingRouter` (`routes/briefing.js`); `const stopCostWatch = startCostWatch()`
  (`costs/watch.js`) after listen, `stopCostWatch()` in shutdown. `server/src/app.js` unchanged.
- **`agent/tools/load.js` GROUP_HELP** add:
  `planning: 'machine capacity calendar, production planning by part, quantity and due date, maintenance windows with push options, applying a plan (always confirmed by the user)'`,
  `cost: 'cost summaries: energy, spare parts, consumables, labour and downtime by asset, plant, category or day'`,
  `kpi: 'create, change and list KPI cards on the KPI Builder page (always confirmed by the user)'`.
- **`agent/tools/registry.js`** import + spread into `list`: `...planningTools` (`planning/tools.js`),
  `...maintenancePlanningTools` (`planning/maintenanceTool.js`), `...costTools` (`costs/tools.js`), `...kpiTools`
  (`kpis/tools.js`). No `GROUP_FEATURE` entry (tools gate themselves).
- **`agent/router.js` GROUP_HINTS** add `planning: /\b(plan|schedule|capacity|gantt|maintenance window|slot|due (by|on)|deliver|when can)\b/`,
  `cost: /\b(cost|costs|spend|spent|₹|rupees|budget|expensive|tariff|alert me)\b/`,
  `kpi: /\b(kpis?|dashboard|heatmap|gauge|metric card|build a (chart|graph|card))\b/`, and add `alert me` to the
  `write` hint so cost alerts load the write tools. The mock router (`ai/mock.js` GROUPS) can stay.
- **System prompt** (optional, one line): "Plans: call plan_production / plan_maintenance, then apply_plan; never create
  planned job cards or WOs with create_record. KPIs: create_kpi / update_kpi only."
- **`client/src/routes.jsx`**: index → `<CommandCenter />` (superAdmin still redirected to `/superadmin`);
  `{ path: 'planner', element: <PlannerPage /> }`, `{ path: 'costs', element: <CostsPage /> }`,
  `{ path: 'kpis', element: <KpisPage /> }`.
- **`client/src/layout/nav.js` PRIMARY_NAV order**: Command Center (`/`, `LayoutDashboard`, exact match so it is not
  active everywhere), Machines, Anomalies, Planner (`/planner`, `CalendarRange`), Costs (`/costs`, `IndianRupee`),
  KPI Builder (`/kpis`, `Gauge`), Chat; then the Modules groups and Superadmin (Sidebar unchanged otherwise).
- **`client/src/blocks/BlockRenderer.jsx`**: `case 'plan': <PlanBlock payload={payload} />` (`planner/PlanBlock.jsx`),
  `case 'kpi': <KpiPreviewBlock payload={payload} />` (`kpis/KpiPreviewBlock.jsx`).
- **`client/src/chat/ConfirmCard.jsx` Preview**: `case 'plan': <PlanPreview payload={payload} />`, `case 'kpi':
  <KpiPreview payload={payload} />`.
- **Deep links**: Anomalies `AnomalyDetail` "Plan maintenance" (enable, drop the tooltip) →
  `navigate(\`/planner?maintenance=${assetIdOf(anomaly)}&anomaly=${anomaly._id}\`)`; Machine 360
  (`machines/MachinePage.jsx`) header button "Plan maintenance" → `/planner?maintenance=<assetId>`.
- **Mock chat scripts / eval** for the five demo questions (scripts call `plan_production` → `apply_plan`,
  `plan_maintenance` → `apply_plan`, `create_record costalerts`, `create_kpi`, `cost_summary`).
- **Seed step** for the gaps in §9 (simulator integrator, idempotent).
