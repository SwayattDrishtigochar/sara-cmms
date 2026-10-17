# Phase 7 contracts — automatic production & maintenance plans, related records, auto work orders, de-sim

Builds on `docs/phase5-contracts.md` (planning engines, proposals, Planner) and `docs/phase3-contracts.md` §2 (anomaly
watch). Same conventions: ESM, arrow functions, zod 4, `lib/errors.js`, Biome, **no new npm dependencies in SARA**
(the simulator may add the dev dependencies listed in §1), server tests `SARA_TEST_DB=<package label> npx vitest run
--maxWorkers=2 <files>` (remote Mongo: labels never `sara`, `cmms_*`, `admin`, `local`, `config`, `test`), client tests
`pnpm --filter client test`. `AI_MOCK=true` everywhere: zero real Gemini calls. Never start servers on 5080/5173; never
restart the running simulator (pid 8008). The PC clock runs ~55 s ahead of the remote clocks: pass `now` explicitly.

**Already done by the architect (do not redo):** the data model of §2 (defs, registry `children`, proposal fields) and the
mock answers `plan_feasibility` / `maintenance_plan_summary` in `ai/mockPhase5.js`.

## 1. Packages and file ownership

Every new/changed file belongs to exactly one package. Import (never edit) other packages' files only through the
exports pinned here; a file that may not exist yet when you test is `vi.mock`ed (server) or lazily imported where this
doc says so.

| Package | Owns |
|---|---|
| `P7:plan-production` | `server/src/planning/production.js` (modify), `planning/productionCheck.js`, `planning/productionOperators.js`, `planning/explain.js` (production branch only, §4), `planning/tools.js` (modify: `plan_production`, new `check_plan`), `routes/planning.js` (modify), `server/test/planning-production.test.js` (extend), `test/planning-operators.test.js`, `test/planning-check.test.js` |
| `P7:plan-maintenance` | `server/src/planning/people.js`, `planning/maintenancePlan.js`, `planning/maintenancePlanCheck.js`, `planning/maintenanceTool.js` (modify), `planning/proposals.js` (modify: §3.5 only), `routes/planningMaintenance.js` (modify), `server/test/planning-people.test.js`, `test/planning-maintenance-plan.test.js`, `test/planning-maintenance-check.test.js` |
| `P7:planner-client` | `client/src/planner/**` (rewrite; `AiPlanPanel.jsx` is deleted), `client/src/planner/planner.test.jsx`, `planner/planEdits.test.js`, `planner/ganttLayout.test.js` (keep) |
| `P7:related-records` | `server/src/modules/related.js`, `server/src/routes/modules.js` (modify), `server/test/related.test.js`, `client/src/modules/{RelatedRecords.jsx,PlanChain.jsx,extras.jsx,useRelated.js}`, `client/src/modules/RecordPage.jsx` (modify), `client/src/modules/RecordForm.jsx` (modify: `defaults` prop), `client/src/modules/related.test.jsx` |
| `P7:anomaly-autowo` | `server/src/ai/anomaly/watch.js` (modify, incl. its de-sim line), `ai/anomaly/autoWorkOrder.js`, `server/src/ai/settings.js` (modify), `server/test/ai-anomaly-autowo.test.js`, `client/src/superadmin/AiTab.jsx` (autoWorkOrder fields only), `client/src/anomalies/parts.jsx` (add `AutoWorkOrderBadge`), `client/src/anomalies/AnomalyDetail.jsx` + `AnomaliesPage.jsx` (badge insertion only), `client/src/anomalies/aiTab.test.jsx` + `anomalies.test.jsx` (extend) |
| `P7:sim-ui` | `sara-simulator/**` only: `src/ui/{server.js,auth.js,api.js,scoring.js,static.js}`, `src/config.js` (modify), `src/index.js` (modify: start/stop the UI server), `ui/**` (Vite + React app, prebuilt `ui/dist` committed), `package.json` (scripts + devDependencies), `Dockerfile`, `deploy/**`, `README.md`, `.env.example`, `test/ui-server.test.js`, `test/ui-simUtils.test.js`, `test/config.test.js` (extend) |
| `P7:sara-desim` | deletes `server/src/routes/adminSim.js`, `db/models/Sim.js`, `sim/{accountGenerator,blueprint,simulatedCompany}.js`, `ai/anomaly/scoring.js`, `server/test/adminSim.test.js`, `client/src/superadmin/{SimulationTab,StatusStrip,ControlsCard,CompanyCard,CredentialsDialog,AnomalyLab,InjectionHistory,ActivityFeed,useSim,simUtils,simulation.test}.*`; creates `server/src/platform/platform.js` (moved from `sim/platform.js`), `server/src/db/models/ParameterSpec.js`, `server/src/routes/adminPlatform.js`, `server/test/helpers/fixtures.js` + `test/helpers/fixtureData.js`, `server/test/desim.test.js`, `server/test/adminPlatform.test.js`, `client/src/superadmin/{PlatformTab.jsx,platform.test.jsx}`; modifies the files listed in §10.2 (imports/comments/env/docs) |

Shared files only the **integrator** edits: `server/src/index.js`, `server/src/app.js`, `server/src/agent/tools/{registry,load}.js`,
`server/src/agent/{router,systemPrompt}.js`, `client/src/routes.jsx`, `client/src/layout/**`, `client/src/blocks/**`,
`client/src/chat/**`, plus the two dispatch lines of §3.5 (explain.js `maintenance_plan` branch).

Split files: `defs/*.js` — done by the architect (§2), nobody else edits them except `P7:sara-desim` removing the single
`isSimulated` line in `defs/org.js`. `planning/explain.js` — `P7:plan-production` rewrites `explainProduction` (§4);
the integrator adds the `maintenance_plan` dispatch. `planning/proposals.js` — only `P7:plan-maintenance` (§3.5).
`ai/anomaly/watch.js` — only `P7:anomaly-autowo` (it also removes `isSimulated` there). `client/src/superadmin/AiTab.jsx` —
`P7:anomaly-autowo` inserts its three controls right after the `ai-anomaly-investigate` `<Switch>` (same `div`);
`P7:sara-desim` only changes `SuperAdminPage.jsx` tabs. `client/src/anomalies/**` — `P7:anomaly-autowo` only.

Allowed read-only imports (as phase 5) plus: `planning/people.js` exports (§3.1), `planning/intervals.js`,
`planning/capacity.js` (`buildCalendar`, `calendarToGantt`, `hoursOf`), `planning/maintenance.js` (`maintenanceTasks`,
`planMaintenance`, `rescheduleForward`, `CATEGORY_MIN`), `planning/proposals.js` (`createProposal`, `getProposal`,
`applyProposal`, `checkApply`, `toPlanBlock`, `planBlockFor`), `lib/shifts.js` (`shiftWindows`, `workingIntervals`),
`modules/registry.js` (`getModule`, `labelOf`, `moduleMeta`), `modules/records.js`, `modules/permissions.js` (`can`,
`assertCan`), `modules/actions/notify.js` (`notifyUsers`), `lib/events.js` (`publish`, `plantAudience`).

## 2. Data model (implemented by the architect)

- **Registry option `children`** (`registry.js`): `children: [{ module, field, label?, order? }]` on a module def;
  validated at build (child module exists, `field` is a `ref`/`refs` of the child pointing at this module, else a startup
  error); `moduleMeta(mod).children = [{ module, field, label, order }]` (sorted). Declared: assets → workorders.asset,
  jobcards.asset, anomalies.assetId, preventivemaintenances.assetAllocation, calibrations.assetAllocation;
  productionplans → jobcards.productionPlanId; maintenanceplans → workorders.maintenancePlanId; anomalies →
  workorders.anomalyId; tools → jobcards.tool; customers → productionplans.customer; users → workorders.people,
  jobcards.assignedTo (array fields filter with `{ people: userId }`).
- **`maintenanceplans`** (`defs/maintenance.js`, `MaintenancePlan`, group Maintenance, icon `CalendarCheck`,
  permissionKey `work-order`, plantScoped, **planned** (schedule-version bump + `proposalId`/`proposalSeq` stamps),
  counter `MP-n` in `planCode`, titleField `name`, list `planCode name scope objective status createdAt`):
  `name!`, `scope` enum `plant|assets` (default plant), `assetIds` refs assets, `horizon { start, end }`, `objective` enum
  `protect_production|balanced|fix_fast` (default protect_production), `status` enum
  `draft|proposed|planned|in_progress|completed|cancelled` (default draft), readOnly `metrics { tasks, zeroImpactTasks,
  productionHoursLost, naiveProductionHoursLost, productionImpactCost, downtimeCostAvoided }`, readOnly `aiSummary
  { text, model, at, mock }`, readOnly `proposal` → planproposals, `notes`. Exports `AI_TEXT`,
  `MAINTENANCE_PLAN_STATUSES`, `MAINTENANCE_OBJECTIVES`.
- **`workorders.maintenancePlanId`** → maintenanceplans (writable). Assignees stay `workorders.people` (refs users).
- **`anomalies.autoWorkOrderAt`** (date, readOnly, label "Work order opened automatically") and hidden readOnly
  **`scansSeen`** (number, default 0): consecutive scans that reported the anomaly; `workOrderId` existed.
- **`productionplans`**: `status` enum now `Draft|Pending|Planned|In Progress|Completed|Cancelled` (default Pending; the
  telemetry source keeps writing Pending/Planned/In Progress/Completed), `feasibility` gains `verdict` enum
  `doable|adjust|not_doable`, `dueDate`, `issues [{ kind, severity: warning|critical, text ≤300 }]`; new readOnly
  `aiSummary` (AI_TEXT) and `proposal` → planproposals. Exports `PLAN_STATUSES`, `VERDICTS`.
- **`jobcards`**: `assignedTo` (refs users, label Operators) = the operators; new `operatorPlan [{ user!→users,
  shiftName, start, end }]` (no row ids) = who runs which shift of the window.
- **`planproposals`**: `kind` enum `production|maintenance|maintenance_plan`; `maintenancePlanId` → maintenanceplans;
  `feasibility.verdict`; hidden mixed `issues`, `adjustments`, `metrics` (shapes in §3.4/§3.6).
- Nothing new is required on existing collections (validate-db stays clean). Readonly fields are written by the engines
  through `Model.updateOne` after `records.create` (apply, §3.5).

## 3. Engines

Shared types: `Interval = { start, end }` (Date on the server, ISO over the wire); day/shift logic in `zoneOf(ctx)`.

### 3.1 People availability — `planning/people.js` (P7:plan-maintenance; P7:plan-production `vi.mock`s it)

```js
export const OPERATOR_SKILL = { 'Injection Moulding Machine': 'moulding', 'Power Press': 'press', 'CNC Machine': 'cnc' };
export const CATEGORY_SKILLS = { Electrical: ['electrical', 'plc', 'drives'], Hydraulic: ['hydraulics', 'pneumatics'],
  Mechanical: ['mechanical'], Preventive: ['mechanical', 'lubrication'], Calibration: ['calibration', 'instrumentation'],
  Breakdown: ['mechanical', 'electrical'], Safety: ['electrical', 'mechanical'], Inspection: [], Cleaning: [], Alert: [], 'Project Based': [] };
export const ASSET_SKILLS = { Compressor: ['utilities', 'pneumatics'], Chiller: ['utilities', 'refrigeration'], Furnace: ['utilities', 'electrical'], 'Energy Meter': ['electrical', 'instrumentation'] };
/** CATEGORY_SKILLS[category] ∪ ASSET_SKILLS[assetType], lowercase, unique. */
export const skillsForTask = ({ category, assetType }) => string[];
/** Shift windows of the plant clipped to `interval`, in order: [{ shiftId, shiftName, start, end }] (lib/shifts.shiftWindows; breaks stay inside a segment). */
export const shiftSegments = (plant, interval, zone) => Segment[];
/**
 * People of a department with their shift time, bookings and load inside `window` (records scope: tenant + plant lock).
 * @param {{ department: 'Maintenance'|'Production', plantId?, window: Interval, roles?: string[] = ['technician','admin'],
 *           excludeBookings?: [{ module: 'jobcards'|'workorders', id }] }} opts  excludeBookings = the plan being edited
 */
export const loadPeople = async (ctx, opts) => Person[];
// Person = { userId, name, title, role, department, skills: string[] (lowercased), shiftId, shiftName, plantId,
//   onShift: Interval[]  (the user's whole shift windows within `window`: a break does not take anyone off shift;
//     no shiftId → the plant's shifts), working: Interval[] (the same minus breaks: the maintenance planner's staffed time),
//   (integrator, phase 7: only people with a skill of the department's trade — operator skills for Production,
//     CATEGORY_SKILLS/ASSET_SKILLS for Maintenance — are loaded; nobody with such a skill → everyone of the department),
//   bookings: [{ kind: 'jobcard'|'workorder', id, code, start, end }], loadHours }
// bookings = job cards (jobStatus Open|In Progress|On Hold, assignedTo ∋ user, overlapping; operatorPlan rows of that user
//   when present, else the whole startDate–endDate) + work orders (workStatus ∉ Completed|Closed, people ∋ user,
//   plannedStart/plannedEnd overlapping).
export const freeFor = (person, interval) => boolean;        // pure: interval ⊂ merge(onShift) and overlaps no booking
export const rank = (people, interval, { skills = [] } = {}) => RankedPerson[];  // pure: free people, skillMatch (any skill ∈ person.skills) first, then loadHours asc, then name; RankedPerson = Person & { skillMatch: boolean }
export const pickPerson = (people, interval, { skills = [], exclude = new Set() } = {}) => RankedPerson | null;  // rank()[0] not in exclude
export const bookPerson = (person, { kind, id, code, start, end }) => void;   // pure mutate: push booking, loadHours += hours
/** GET /api/planning/people: everyone of the department with `free` for the whole window. */
export const availableUsers = async (ctx, { department, skills, window, plantId }) =>
  [{ userId, name, title, role, shiftId, shift: shiftName, skills, skillMatch, free, loadHours, busy: [{ kind, code, start, end }] ≤5 }];
```
`exclude` holds userIds. Sorting is deterministic (tests compare arrays).

### 3.2 Production plan with operators — `planning/production.js` + `productionOperators.js` (P7:plan-production)

`proposeProduction(ctx, input, { now })` keeps its signature and callers (tool, PLAN_CHANGED replan) and now:
1. Plans as in phase 5 (`planProduction`).
2. Loads `plant` (plantOf(ctx, plan.plantId)), `people = loadPeople(ctx, { department: 'Production', plantId, window: { start: now, end: horizonEnd } })` and assigns operators:
   ```js
   // productionOperators.js (pure)
   /** @returns Map<key, { operators: Operator[], issues: Issue[] }>; Operator = { userId, name, shiftId, shiftName, start, end } */
   export const assignOperators = (jobCards /* [{ key, assetId, start, end }] */, { people, plant, zone, machinesById }) => Map;
   ```
   per card, per `shiftSegments(plant, { start, end }, zone)`: `pickPerson(people, segment, { skills: [OPERATOR_SKILL[machine.typeOfAsset]].filter(Boolean) })`,
   then `bookPerson(pick, { kind: 'jobcard', id: key, code: key, ...segment })`; none free → issue `operator_missing`
   (warning) `No Production operator is free for IMM 3 in shift C on 18-10-2026`. `people` is a working copy (structuredClone).
3. Job card ops gain `assignedTo: [unique userIds]` and `operatorPlan: [{ user, shiftName, start, end }]`; `diff.jobCards[i]`
   gains `key: 'op-<seq>'`, `operators: Operator[]`, `shots`, `finishAt` (= end).
4. Feasibility becomes v7 (§3.4): `verdict` + `issues` + `adjustments`; `late` → issue `late` (critical) with adjustments
   `extend_due` (patch `dueDate` = projectedFinish rounded up to the next hour) and `reduce_quantity` (patch `quantity` =
   doneByDue) → verdict `adjust`; phase-5 `alternatives`/`risks` stay as they were.
5. Proposal fields: `feasibility` (v7), `issues`, `adjustments`, `diff.jobCards` (with operators), `input` unchanged.
   `explanation` comes from `plan_feasibility` (§4) through `explainProposal`.

### 3.3 Production check — `planning/productionCheck.js`

```js
/** The user-edited plan. Keys are the proposal's `diff.jobCards[].key`; a new row gets key 'new-<n>'. */
EditedProductionPlan = { proposalId?: string, partName, quantity, dueDate: ISO, plantId?, customerId?,
  jobCards: [{ key, assetId, toolId, target, start: ISO, end: ISO, operators: [{ userId, shiftName?, start?: ISO, end?: ISO }] }] }
export const checkProductionPlan = async (ctx, edited, { now = new Date() } = {}) => CheckResult;
CheckResult = { verdict, feasibility: Feasibility, issues: Issue[], adjustments: Adjustment[],
  jobCards: [{ key, assetId, asset, toolId, tool, target, start, end, finishAt, setupMin, shots, operators: Operator[], issues: number[] /* indexes */ }],
  risks: Risk[], plan: PlanBlockPayload /* ghost bars of the edited cards; conflicting bars carry conflict: true */,
  explanation: { text, model, at, mock } | null, aiError?, proposal?: proposal /* when proposalId */ }
```
Checks (calendar = `buildCalendar(ctx, { plantId, assetIds: edited machines ∪ capable machines of the part's tools, start: now, end: max(card ends, dueDate) + 14 d, now })`; `people = loadPeople(Production, excludeBookings: cards already applied by this proposal — none for drafts)`):

| issue kind | severity | when | adjustment(s) |
|---|---|---|---|
| `tool_incapable` | critical | tool's `parts` has no `partName` | none |
| `machine_incapable` | critical | `tool.assets ∌ assetId` | `move_machine` → first capable machine free from `start` |
| `machine_overlap` | critical | card overlaps a booking or another edited card on the machine | `move_start` → first free slot ≥ start (end = finishAt from there); `move_machine` |
| `tool_overlap` | critical | tool busy on another machine then (bookings or edited cards) | `move_start` |
| `outside_working` | critical | `start` not inside the machine's working intervals | `move_start` → next working minute |
| `too_short` | critical | `end < finishAt − 15 min` (finishAt = advanceWorking(free, start, setup + shots × cycle ÷ efficiency)) | `move_end` → finishAt |
| `late` | critical | max(end) > dueDate | `extend_due`, `reduce_quantity` |
| `short` | critical | Σ target < quantity | `fill_quantity` → largest card target += gap |
| `over_quantity` | warning | Σ target > quantity × 1.02 | `reduce_quantity` (cards trimmed proportionally) |
| `operator_missing` | warning | a shift segment has no operator | `assign_operator` → pickPerson, when someone is free |
| `operator_busy` / `operator_off_shift` | warning | operator not `freeFor` the segment / segment ∉ onShift | `swap_operator` → pickPerson |
| `anomaly` | warning | open critical anomaly on the machine | `move_machine` when another capable machine is free |

```js
Issue = { kind, severity: 'warning'|'critical', text ≤300, jobCard?: key, assetId?, userId? }
Adjustment = { id: 'adj-<n>', kind, label ≤200, patch: { jobCards?: [{ key, assetId?, start?, end?, target?, operators? }], dueDate?, quantity? }, resolves: number[] }
Feasibility = { feasible, verdict, dueDate, projectedFinish, slackHours, shortfall, notes, issues, adjustments }
```
`verdict` (same rule everywhere): `doable` ⇔ `issues.length === 0` (risks are not issues); `not_doable` ⇔ some critical
issue has no adjustment whose `resolves` includes it; else `adjust`. Setup counts only when the mould on the machine's last
card before `start` differs. `end` is kept as edited when `finishAt ≤ end`.
With `proposalId` (draft|failed, kind production, scope checked): rebuild `ops` (§3.2 shapes, seq 0 plan op then cards) and
`diff` from the edited cards, `$set { title, ops, diff, feasibility, risks, issues, adjustments, 'input.edited': edited }`
(Model, never records.*), then `explanation` via `plan_feasibility` (AI failure → `explanation: null, aiError`, stored
explanation untouched). Apply refuses a proposal whose stored `feasibility.verdict === 'not_doable'` with 409
`PLAN_NOT_DOABLE` unless `{ force: true }`.

### 3.4 Maintenance plan — `planning/maintenancePlan.js` (P7:plan-maintenance)

```js
/** @param {{ scope: 'plant'|'assets', assetIds?: string[], plantId?, start?: Date, horizonDays?: 1–30 = 7,
 *   objective?: 'protect_production'|'balanced'|'fix_fast' = 'protect_production', allowNonRunningDays?: false, anomalyId?, name? }} input */
export const maintenancePlanTasks = async (ctx, input, now) => Task[];        // phase-5 Task[] (maintenanceTasks per asset for scope 'assets', per plant otherwise; anomalyId's task first; ≤ 20 by deadline)
export const OBJECTIVE_WEIGHT = { protect_production: 0, balanced: 0.5, fix_fast: 1 };
export const URGENCY = { High: 1, Medium: 0.25, Low: 0.1 };
export const impactOf = (machine, interval, costPerHour) => ({ hours, cost });   // pure: Σ overlap of interval with the machine's jobcard bookings (hours) × costPerHour
export const scoreOption = (option, task, { weight, costPerHour, now }) => number;
//  impactCost = (option.delayHours + 2 × option.lateHours) × costPerHour; urgencyCost = max(0, hours(option.start − now)) × costPerHour × URGENCY[task.priority]
//  score = (1 − weight) × impactCost + weight × urgencyCost; ties → phase-5 recommend() order
export const chooseOption = (task, options, scoring) => MaintenanceOption | null;
export const naiveSchedule = (calendar, tasks, { now, staff }) => ({ productionHoursLost, productionImpactCost });  // ASAP: each task at the earliest staffed working time ≥ now (sequential per machine, bookings ignored), impactOf() summed
export const buildMaintenancePlan = async (ctx, input, { now = new Date() } = {}) => MaintenancePlanV7;
export const proposeMaintenancePlan = async (ctx, input, { now } = {}) => proposal;   // kind 'maintenance_plan'
export const explainMaintenancePlan = async (ctx, proposal) => ({ explanation });     // §4 maintenance_plan_summary → stored by explainProposal
MaintenancePlanV7 = { name, scope, assetIds, horizon, objective, plantId, tasks: PlannedTask[], metrics, verdict, issues, adjustments, risks, ops, diff }
PlannedTask = { key: 't-<n>', kind, refId, code, workOrderId?, assetId, asset, assetType, title, category, priority, durationMin, deadline,
  start, end, optionId, impactHours, impactCost, zeroImpact, late /* start > deadline */, technician: { userId, name, shiftName } | null, delays: Delay[] }
metrics = { tasks, zeroImpactTasks, productionHoursLost, naiveProductionHoursLost, productionImpactCost, naiveProductionImpactCost, downtimeCostAvoided: max(0, naive − plan), currency: symbol }
```
Build: tasks → calendar as `planMaintenanceProposal` does (task assets + their tools' machines, `start = input.start ?? now`,
`end = max(last deadline + 7 d, start + horizonDays)`), `staff` windows, then `planMaintenance(calendar, tasks, { now, staff,
choose: (task, options) => chooseOption(task, options, { weight: OBJECTIVE_WEIGHT[objective], costPerHour: costOf(task.assetId), now }) })`
with `costOf = asset.downtimeCostPerHour ?? costsettings.defaultDowntimeCostPerHour ?? 2500`. Technicians: `people =
loadPeople(ctx, { department: 'Maintenance', plantId, window: { start, end } })`; per task in plan order
`pickPerson(people, { start, end }, { skills: skillsForTask({ category, assetType }) })` + `bookPerson(kind 'workorder', id key)`;
none → issue `technician_missing` (warning) + adjustment `move_start` to the next staff window ≥ end where the machine is
free of bookings and someone with the skills is free (search ≤ horizon end). Default `name`: `Maintenance plan –
<plant> <dd-MM>–<dd-MM>` or `Maintenance plan – <asset names ≤3>`.

Ops: seq 0 `create maintenanceplans { name, scope, assetIds, horizon: { start, end }, objective, status: 'planned', plantId }`;
then each task's chosen option ops (phase 5 §3.3) with the work-order op's data merged with `{ maintenancePlanId: '$op:0',
people: technician ? [technician.userId] : [], plannedStart, plannedEnd, estimatedDurationMin }` (`update` for an existing WO),
PM/calibration `nextGenerationDate` updates and job-card moves unchanged; seqs renumbered in order. Proposal: `kind:
'maintenance_plan'`, `title: name`, `input` (stored, re-run by replan), `horizon`, `plantId`, `assetIds` (task assets), `ops`,
`diff: { bars, delays, tasks: PlannedTask[] }`, `options: []`, `recommendedOption: null`, `feasibility: { feasible: verdict !==
'not_doable', verdict, dueDate: earliest deadline, projectedFinish: max end, slackHours, shortfall: 0, maxDelayHours, notes }`,
`risks` (phase-5 `late`/`deferred` + `technician_missing` as `other`), `issues`, `adjustments`, `metrics`.

### 3.5 Maintenance check — `planning/maintenancePlanCheck.js`; proposals.js edits

```js
EditedMaintenancePlan = { proposalId: string, name?, objective?, tasks: [{ key, start: ISO, end: ISO, durationMin?, technicianId: string|null }] }  // rows by key of diff.tasks; assets are not editable
export const checkMaintenancePlan = async (ctx, edited, { now } = {}) => CheckResult & { tasks: PlannedTask[] & { issues: number[] }, metrics, impactDelta: { hours, cost } /* edited − stored */ };
```
| issue kind | severity | when | adjustment |
|---|---|---|---|
| `jobcard_overlap` | warning | block overlaps a job card on the machine (impact hours/cost in the text) | `move_start` → earliest zero-impact window before the deadline (if any) |
| `asset_overlap` | critical | overlaps another task of the plan or a planned WO on the machine | `move_start` |
| `outside_working` | critical | block ∉ staffed working time (non-running days only when allowed) | `move_start` → next staffed window |
| `too_short` | critical | working time in [start, end) < durationMin | `move_end` |
| `past_deadline` | warning (critical for a critical anomaly) | start > deadline | `move_start` → latest zero-impact window before the deadline, else none |
| `technician_missing` / `technician_busy` / `technician_off_shift` | warning | none / not `freeFor` / block ∉ onShift | `assign_technician` / `swap_technician` → pickPerson |
| `skills_mismatch` | warning | technician lacks every skill of `skillsForTask` while a skilled person is free | `swap_technician` |

Delays of pushed job cards are recomputed with `rescheduleForward` for the edited block; `metrics` recomputed; with the proposal:
`$set { title, ops, diff (bars, delays, tasks), feasibility, risks, issues, adjustments, metrics, 'input.edited': edited }` then
`maintenance_plan_summary` explanation. **`proposals.js` edits (P7:plan-maintenance):** (a) `replan`: `kind === 'maintenance_plan'`
→ `(await import('./maintenancePlan.js')).proposeMaintenancePlan(ctx, p.input)`; (b) apply: `planOp = ops.find(o => o.op ===
'create' && ['productionplans', 'maintenanceplans'].includes(o.module))`; production → `$set { feasibility: p.feasibility,
aiSummary: p.explanation ?? null, proposal: p._id }` on the plan and `productionPlanId` on the proposal; maintenance_plan → `$set
{ metrics: p.metrics, aiSummary, proposal: p._id }` and `maintenancePlanId`; (c) `applyProposal(ctx, idOrCode, { option, force, now })` throws 409 `PLAN_NOT_DOABLE`
(`AppError(409, 'PLAN_NOT_DOABLE', 'The last check found the plan not doable; adjust it or force', { verdict })`) when
`p.feasibility?.verdict === 'not_doable' && !opts.force`; (d) `toPlanBlock` adds `verdict: proposal.feasibility?.verdict ?? null`,
`jobCards: proposal.diff?.jobCards ?? []`, `tasks: proposal.diff?.tasks ?? []`, `metrics: proposal.metrics ?? null`,
`issues: proposal.issues ?? []`.

### 3.6 Auto work order — `ai/anomaly/autoWorkOrder.js` + `watch.js` (P7:anomaly-autowo)

```js
export const DEFAULT_AUTO_WO = { enabled: true, afterScans: 2, minSeverity: 'warning' };   // ai/settings.js DEFAULT_AI.anomaly.autoWorkOrder; patch schema: enabled boolean, afterScans int 1–10, minSeverity enum warning|critical
export const CATEGORY_OF = { vibration_high: 'Mechanical', temperature_high: 'Mechanical', temperature_low: 'Mechanical', pressure_low: 'Hydraulic', pressure_high: 'Hydraulic',
  current_high: 'Electrical', current_imbalance: 'Electrical', power_high: 'Electrical', idle_power_high: 'Electrical', cycle_time_drift: 'Inspection',
  quality_degradation: 'Inspection', sensor_flatline: 'Calibration', sudden_stop: 'Breakdown', efficiency_drop: 'Inspection', other: 'Inspection' };
export const PRIORITY_OF = { critical: 'High', warning: 'Medium', info: 'Low' };
/** Pure. anomaly = the stored doc after this scan's stamp (scansSeen updated). */
export const shouldOpenWorkOrder = (anomaly, decisionState, settings) => boolean;
//  enabled && !anomaly.workOrderId && !anomaly.autoWorkOrderAt && state ∈ open|acknowledged && decisionState === 'anomalous'
//  && rank(severity) ≥ rank(minSeverity) && (severity === 'critical' ? scansSeen ≥ 1 : scansSeen ≥ afterScans)
/** Idempotent: claims with findOneAndUpdate({ _id, workOrderId: null, autoWorkOrderAt: null }, { $set: { autoWorkOrderAt: now } }); null when already claimed. */
export const openWorkOrderFor = async (ctx /* systemContext */, anomaly, { feature, now, settings }) => ({ workOrder, technician, notified }) | null;
```
Work order: `records.create(ctx, 'workorders', { name: '<Type label> on <asset> – auto', description: SARA's insight
(`anomaly.explanation` + flagged parameters `field observed vs expected (deviation)` + recommended actions), asset, priority:
PRIORITY_OF[severity], category: CATEGORY_OF[type], estimatedDurationMin: CATEGORY_MIN[category], dueDate: now + urgencyHours
(≥ 1 h), anomalyId, people: technician ? [technician.userId] : [] }, { source: 'system' })` — technician = `pickPerson(await
loadPeople(ctx, { department: 'Maintenance', plantId, window: { start: now, end: now + 8 h } }), { start: now, end: now +
estimatedDurationMin }, { skills: skillsForTask({ category, assetType }) })` with `people.js` loaded lazily (`await import`);
then `$set anomalies.workOrderId`; notification (`notifyUsers`, priority high, type alert, module workorders, recordId wo,
title `Work order WO-n opened for <asset>`, description = anomaly summary) to owners/admins of department Maintenance +
the plant's maintenance managers (admins) + the technician; live events `anomaly { anomaly, change: 'work_order' }` and the
poller's `notification`; `publish record { module: 'workorders', id, change: 'created' }` comes from records.create.
watch.js: `upsertAnomaly` stamps `scansSeen: 1` on create/reopen and `$inc: { scansSeen: 1 }` on an update;
`countCleanScans` resets `scansSeen: 0` with each clean scan; after `alert()`/update it calls `shouldOpenWorkOrder` →
`openWorkOrderFor` (stats `workOrders += 1`); errors are logged, never fail the scan. `watchedCompanies` = companies that
have telemetry assets (no `isSimulated`); comments reworded (no "simulat…").

### 3.7 Related records — `modules/related.js` (P7:related-records)

```js
export const relatedCounts = async (ctx, module, id) => ({ parent: { module, id }, children: [{ module, field, label, order, count, can: { read, create } }] });  // records.get(parent) first (404/403), children ∩ ctx.modules ∩ can read
export const relatedList = async (ctx, module, id, child, { page, limit = 25, sort, q }) => ({ child: { module, field, label }, items, total, page, limit });  // records.list(ctx, child, { filter: { [field]: id }, page, limit, sort, q }); 404 when child is not a declared child
```

## 4. AI calls

Both through `generate({ tier: 'background', purpose: 'planning', companyId, system, contents: JSON.stringify(input),
schema: toJsonSchema(zod), mockInput: { kind, ...input } })`; `input` exactly as below (the mock reads it). Chat tools never
call `generate`.

| kind | when | cache | fallback on AiUnavailableError |
|---|---|---|---|
| `plan_feasibility` | `POST /planning/production` (replaces `plan_explanation` for production proposals; `explainProduction` in explain.js rewritten by P7:plan-production), `POST /planning/production/check`, `/proposals/:id/explain` | `proposal.explanation` | `explanation: null` + `aiError`; UI shows the deterministic line `<Doable|Needs adjustment|Not doable>: <feasibility.notes>` with chip "AI explanation unavailable" |
| `maintenance_plan_summary` | `POST /planning/maintenance/plan`, `/maintenance/check`, `/explain` for kind maintenance_plan | `proposal.explanation` | same, line `<verdict>: <metrics.tasks> tasks, <productionHoursLost> h of production moved` |

```js
// plan_feasibility  input { plan: { title, partName, quantity, dueDate: ISO, verdict, finishAt: ISO, slackHours, shortfall,
//   jobCards: [{ key, asset, tool, target, start, end, setupMin, operators: [name], shifts: number }] ≤10,
//   issues: [{ kind, severity, text }] ≤10, adjustments: [{ id, kind, label }] ≤5, risks: [text] ≤5 } }
z.object({ summary: z.string().max(400), bullets: z.array(z.string().max(200)).min(1).max(4), adjust: z.array(z.string().max(200)).max(3) })
//   summary starts with "Doable:" | "Needs adjustment:" | "Not doable:" (the mock does; the real prompt asks for it); the engine's verdict is the truth — the UI badge never reads the text
// maintenance_plan_summary  input { plan: { name, scope, assetNames: [..] ≤10, horizon: { start, end }, objective, currency: { symbol },
//   metrics, tasks: [{ key, title, asset, kind, category, start, end, durationMin, technician: name|null, impactHours, impactCost, zeroImpact, late }] ≤20,
//   verdict, issues ≤10, adjustments ≤5 } }
z.object({ summary: z.string().max(400), bullets: z.array(z.string().max(200)).min(1).max(4), watch: z.array(z.string().max(200)).max(3) })
```
Stored text = `summary + '\n• ' + bullets.join('\n• ')` (+ `\nAdjust: …` lines for `adjust`/`watch`), as phase 5's `bulletText`.
`explainProposal` dispatch: `maintenance` → phase-5 recommendation (unchanged); `production` → `plan_feasibility`;
`maintenance_plan` → `(await import('./maintenancePlan.js')).explainMaintenancePlan` (integrator adds this lazy branch).

## 5. Agent tools (group `planning`)

| tool (file) | schema | result |
|---|---|---|
| `plan_production` (`planning/tools.js`, P7:plan-production) | unchanged | forModel adds `verdict`, `jobCards[].operators: [name]`, `jobCards[].key`, `issues: [text]`, `adjustments: [{ id, label }]`; summary `PLN-3 · 3 job cards · doable (61 h slack)` / `… needs adjustment` |
| `check_plan` (`planning/tools.js`, P7:plan-production) | `{ proposalId: string ≤60 (id or PLN-code), edits: { dueDate?: string ≤40, quantity?: int, jobCards?: [{ key!, assetId?, start?, end?, target?: int, operatorIds?: [id] ≤6 }] ≤10, tasks?: [{ key!, start?, end?, technicianId?: id\|null }] ≤20 } }` | merges `edits` into the proposal's stored plan (production: `diff.jobCards`; maintenance_plan: `diff.tasks`, via lazy `import('./maintenancePlanCheck.js')`), runs the check; forModel `{ proposalId, code, verdict, issues: [text], adjustments: [{ id, kind, label }], jobCards?/tasks? (as plan_*), next: verdict === 'not_doable' ? 'Apply an adjustment with check_plan again' : 'Call apply_plan { proposalId } so the user can confirm' }`; summary `PLN-3 · needs adjustment · 2 issues`; blocks `[plan]`. Permission: `can(jobcards,'update')` or `can(workorders,'update')` by kind |
| `plan_maintenance` (`planning/maintenanceTool.js`, P7:plan-maintenance) | adds `scope?: enum plant\|assets`, `assetIds?: [id] ≤20`, `objective?: enum`, `start?: string ≤40`, `name?: string ≤120` | with `scope`/`assetIds`/`objective` → `proposeMaintenancePlan`; forModel `{ proposalId, code, kind: 'maintenance_plan', name, verdict, metrics, tasks: [{ key, title, asset, start, end, technician, impactHours, zeroImpact, late }] ≤20, issues: [text], next }`; summary `PLN-5 · 6 tasks · 4 zero-impact · ₹21,150 avoided`; otherwise the phase-5 single-task behaviour |
| `apply_plan` | adds `force?: boolean` | unchanged; confirm card label for maintenance_plan: `Apply PLN-5: 6 work orders, 5 technicians`; `PLAN_NOT_DOABLE` → `{ error, details: { verdict } }` |

Descriptions carry one example each (`check_plan`: `{ proposalId: "PLN-3", edits: { jobCards: [{ key: "op-2", assetId: "<IMM 5 id>" }] } }`).

## 6. Routes (mounted at `/api`, signed in; errors `{ error: { code, message, details? } }`)

| Route | Who | Request → response |
|---|---|---|
| `POST /api/planning/production` | jobcards create + productionEnabled | body as phase 5 + `customerId?` → `{ proposal, plan: PlanBlockPayload, check: CheckResult }` (explanation via plan_feasibility; AI failure → `aiError`) |
| `POST /api/planning/production/check` | same | `EditedProductionPlan` (zod: keys ≤ 20 chars, ≤ 10 cards, ≤ 6 operators/card, ISO dates) → `CheckResult` (`proposal` included when `proposalId`); 404 unknown proposal, 409 `CONFLICT` when the proposal is not draft/failed |
| `GET /api/planning/people?department=Maintenance\|Production&from=ISO&to=ISO&skills=a,b&plantId=` | any | → `{ people: availableUsers(...) }`; `to − from ≤ 31 d`, default from = now, to = now + 8 h |
| `POST /api/planning/maintenance/plan` | workorders create | `{ scope, assetIds?, plantId?, start?, horizonDays?, objective?, allowNonRunningDays?, anomalyId?, name? }` → `{ proposal, plan, check }`; 400 `Nothing to plan…` as phase 5 |
| `POST /api/planning/maintenance/check` | workorders create | `EditedMaintenancePlan` → `CheckResult` (with `tasks`, `metrics`, `impactDelta`) |
| `POST /api/planning/proposals/:id/apply` | per op | `{ option?, force? }` → as phase 5; 409 `PLAN_NOT_DOABLE { verdict }` |
| `GET /api/planning/proposals?kind=production\|maintenance\|maintenance_plan` (comma list) | any | as phase 5 (`kind` may be a comma list) |
| `POST /api/planning/maintenance` | unchanged (single task) | |
| `GET /api/m/:module/:id/related` | read of parent | → `relatedCounts` |
| `GET /api/m/:module/:id/related/:child?page&limit&sort&q` | read of parent + child | → `relatedList`; 404 when `child` is not declared |
| `PUT /api/admin/ai` | superAdmin | accepts `{ anomaly: { autoWorkOrder: { enabled?, afterScans?, minSeverity? } } }` |
| `GET /api/admin/platform/companies` (`routes/adminPlatform.js`) | superAdmin | → `{ companies: [{ id, name, plants, users, assets, createdAt }] }` (non-platform companies, newest first) |

**Simulator control panel API** (`sara-simulator/src/ui/server.js`, node:http, `SIM_UI_HOST` default `0.0.0.0`, `SIM_UI_PORT`
default 5090, `0` = off; needs `SIM_UI_PASSWORD` ≥ 8 chars, else the panel stays off with one warning line). JSON only; errors
`{ error: { code: 'BAD_REQUEST'|'UNAUTHORIZED'|'NOT_FOUND'|'CONFLICT', message, details? } }`. Auth: `POST /api/login { password }`
→ `{ ok: true, expiresAt }` + `Set-Cookie: sim_ui=<token>; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200`; token =
`<expiresMs>.<hex hmac-sha256(SIM_UI_PASSWORD, expiresMs)>` (timing-safe compare; 10 attempts/min per IP → 429);
`POST /api/logout`; `GET /api/me` → `{ ok, instance, company: { id, name } }`. Everything else under `/api/*` needs the cookie (or
`Authorization: Bearer <token>`) → 401. Times are the simulator's `clock.now()`.

| Route | Request → response |
|---|---|
| `GET /api/status` | → `{ serverTime, control: simcontrol doc (defaults when missing), instances: [{ ...siminstances doc, id, online }], company: { id, name, domain, seededAt, counts: { users, assets, workorders, jobcards, requests } }, scenarios: SCENARIOS catalogue (local), injections: [active simevents + { id, assetName, active: true }] }` |
| `PATCH /api/control` | `{ running?, telemetryTickMs 1000–60000?, humanActivity?, humanSpeed 1–120?, respondToAnomalies? }` (≥ 1 key) → `{ control }` |
| `POST /api/backfill` | `{ days 1–30 }` → `{ control }`; 409 when one is requested/running |
| `POST /api/inject` | `{ assetId, scenario, severity: low\|medium\|high, rampMin 1–240, holdMin 0–1440, field? }` → `201 { event }`; 400 unknown asset/scenario/type mismatch |
| `POST /api/clear/:id` and `POST /api/clear { all: true }` | → `{ cleared }` (active only; `clearedReason: 'superadmin'`, `clearedBy: 'control-panel'`) |
| `GET /api/events?limit=50` | → `{ events: [{ ...simevent, id, assetName, active, detection: { anomalyId, code, detectedAt, latencySec, matchedFields } \| null }] }` (`src/ui/scoring.js`: port of SARA's `attachDetections`, raw driver on `anomalies` of the same database; 30-min grace; alias `rejectionRate → rejectedCount`) |
| `GET /api/activity?limit=50&before=ISO` | → `{ activity: [{ ...simactivity, id }] }` |
| `GET /api/credentials` | → `{ users: [{ email, name, role, title, department, shift }] (owner, admin, technician, view order), password: cfg.userPassword }` |
| `GET /api/assets` | → `{ assets: [{ id, name, tag, type, status, plantName, isProductionAsset, isEnergyAsset, isSensorIntegration }] }` |
| `GET /` and non-`/api` paths | `ui/dist` static files (SPA fallback to `index.html`); without a build: `503` text `Control panel UI not built: npm run build:ui` (the API still works) |

## 7. Client

### 7.1 Planner (P7:planner-client) — `/planner?tab=production|maintenance&proposal=<id>&maintenance=<assetId>&anomaly=<id>`

Hooks (`planner/usePlanning.js`; keys exact; every mutation success invalidates `['planning']` and `['m', 'planproposals']`):
`useCalendar`, `useParts`, `useProposals({ kind })` (`['m','planproposals','list', params]`), `useProposal(id)`,
`useApplyProposal(id)` (body `{ option?, force? }`), `useDiscardProposal`, `useExplainProposal` (as phase 5);
`usePeople(params)` `['planning', 'people', params]` (staleTime 30 s; `enabled` when `from`/`to` present);
`useProposeProduction()` → `{ proposal, plan, check }`; `useCheckProduction()` POST `/planning/production/check`;
`useProposeMaintenancePlan()` POST `/planning/maintenance/plan`; `useCheckMaintenance()` POST `/planning/maintenance/check`;
`useProductionPlans()` = `useRecords('productionplans', { limit: 20, sort: '-createdAt' })`; `useMaintenancePlans()` =
`useRecords('maintenanceplans', { limit: 20, sort: '-createdAt' })`. The page keeps `useLiveEvent('record', …)` for
`jobcards|workorders|productionplans|maintenanceplans|planproposals` → invalidate `['planning']`.

`planner/planEdits.js` (pure, tested): `toEditedProduction(check | proposal) → EditedProductionPlan`,
`toEditedMaintenance(...) → EditedMaintenancePlan`, `applyAdjustment(edited, adjustment) → edited'` (merges `patch` by key),
`setCard(edited, key, patch)`, `setTask(edited, key, patch)`, `isDirty(edited, lastChecked)`, `objectiveOf(sliderValue 0–100)`
→ `<34 protect_production | <67 balanced | fix_fast`, `verdictTone(verdict) → 'good'|'warn'|'critical'`.

Components (props exact):
- `PlannerPage` — PageHeader (plant, Zoom), `Tabs` Production | Maintenance (tab from `?tab`, or `maintenance` when
  `?maintenance`/`?anomaly` is present), each tab = form + result + lists. Mobile: single column, tables become stacked cards
  below `md`; sticky action bar at the bottom.
- `ProductionPlanForm({ plantId, onPlanned(result) })` — part `Select` from `useParts` with the capable machines listed under
  it (`T-101 · IMM 1, IMM 2 …`), quantity, due date (`<input type="date">`, default +7 d), plant (unless locked), customer
  (optional `RefSelect` customers) → "Plan with SARA" (`useProposeProduction`, pending state "SARA is planning…").
- `ProductionPlanResult({ result: { proposal, plan, check }, onResult })` — holds `edited` state (from `toEditedProduction`)
  and renders `PlanHeader`, `JobCardTable`, `Gantt`, `VerdictCard`, actions **Check plan** (`useCheckProduction` with
  `proposalId`; result replaces `check`), **Create plan** (`useApplyProposal`; disabled while `isDirty` since the last check or
  `verdict === 'not_doable'`; `PLAN_CHANGED` → toast "Plan changed — showing the updated plan" + select `details.proposalId`;
  `PLAN_NOT_DOABLE` → toast; success → `navigate('/m/productionplans/<created plan id>')` where the id is the `created` ref with
  `module === 'productionplans'`), **Discard**.
- `PlanHeader({ code, title, verdict, feasibility, explanation, aiError, status, metrics?, onExplain })` — code preview
  (`PLN-n` + "becomes PP-n/MP-n on create"), `VerdictBadge`, feasibility line, AI summary with `AiProvenance` (Regenerate =
  explain), status badge.
- `JobCardTable({ edited, check, parts, plantLocked, onChange(key, patch), onAdd(), onRemove(key) })` — per row: machine
  `Select` limited to the tool's capable machines (from `useParts().tools[].assets`), start/end `<input type="datetime-local">`
  (company zone), target `Input`, mould (read-only tool label), one `PersonSelect` per shift segment of the window, issue
  chips (from `check.jobCards[].issues`), recomputed `finishAt` hint when it differs from `end`.
- `PersonSelect({ department, window: { from, to }, skills?, value, onChange, exclude?: userIds })` — `usePeople`; free people
  first (skill-matched tagged "fits"), busy ones disabled with `busy: JC-14`, off-shift ones under a divider; mobile friendly
  native `Select`.
- `VerdictCard({ check, onApply(adjustment) })` — badge Doable / Needs adjustment / Not doable, issues (severity icon + text,
  linked to the row via `jobCard`/task key highlight), adjustments with **Apply suggestion** (`applyAdjustment` → the parent
  re-checks automatically), and the AI text when present.
- `MaintenancePlanForm({ assets, deepLink, onPlanned })` — scope radio (Whole plant | Selected assets → chip multi-select of
  `useRecords('assets', { limit: 200, sort: 'name' })`), horizon start date + days (1–30, default 7), objective slider 0–100
  with the labels "Protect production" ↔ "Fix fast" (`objectiveOf`), "Allow Sundays and holidays" switch, name (optional) →
  "Plan with SARA". `deepLink = { assetId, anomalyId? }` pre-selects scope `assets` with that asset and runs once on mount
  (`anomalyId` passed through).
- `MaintenancePlanResult({ result, onResult })` — `PlanHeader` (+ metrics tiles: production impact `h` and `₹`, downtime cost
  avoided, zero-impact tasks of n), `TaskTable`, `Gantt` (job cards plain, maintenance ghost blocks, moved cards dashed),
  `VerdictCard`, actions as production (Create → `/m/maintenanceplans/<id>`).
- `TaskTable({ edited, check, onChange(key, patch) })` — per row: task (title, kind badge, code link), asset, start/end
  datetime-local, duration (min), `PersonSelect` (Maintenance, skills from the row), impact chip (`No impact` / `1.5 h · ₹6,750`),
  deadline with a late flag, issue chips.
- `PlansList({ kind, selectedId, onSelect })` (proposals, as phase 5, `KindIcon` for maintenance_plan = `CalendarCheck`) and
  `PlanRecordsList({ module: 'productionplans'|'maintenanceplans' })` — code, title, status `Badge`, feasibility/metrics
  line, link to the record page.
- `Gantt`, `ganttLayout.js` as phase 5 (bars with `conflict: true` get the red ring; a bar's `tooltip` may list operators).
- `PlanBlock({ payload })` / `PlanPreview({ payload })` — add the verdict badge, an operators line per job card
  (`payload.jobCards[].operators`), a tasks list with technicians (`payload.tasks`), metrics tiles for maintenance plans.

### 7.2 Related records (P7:related-records)

`modules/useRelated.js`: `useRelatedCounts(module, id)` key `['m', module, 'related', id]`; `useRelated(module, id, child,
params)` key `['m', child, 'related', { parent: module, id, ...params }]` (so `useRecordSync`'s `['m', child]` invalidation
refreshes it). `RelatedRecords({ meta, record })` — rendered by `RecordPage` under the Details column when
`meta.children.length`; `Tabs` per child (`label · count`), each a table of the child module's `list` columns (`FieldValue`,
`createdAt` column as the list page), row click → `/m/<child>/<id>`, pagination (25), "Add <singular>" (when
`can.create`) opens a `Sheet` with `RecordForm meta={childMeta} defaults={{ [field]: record._id }}` (`RecordForm` gains
`defaults` merged into `initial` for a create; refs fields render the parent label). Mobile: tabs scroll horizontally.
`modules/extras.jsx`: `RECORD_EXTRAS = { productionplans: ProductionPlanChain, maintenanceplans: MaintenancePlanChain }`
rendered by `RecordPage` above `RelatedRecords`. `modules/PlanChain.jsx`: `ProductionPlanChain({ record })` — job cards via
`useRelated(..., 'jobcards', { limit: 100, sort: 'startDate' })`, compact `Gantt` (rows = machines, bars = job cards with
`href`, status), the chain per machine `JC-19 → JC-22 → …` (arrows, start/end, target, operators) and totals (Σ target vs
`quantity`, Σ partsOut, feasibility verdict badge, `aiSummary` with `AiProvenance`); `MaintenancePlanChain({ record })` —
work orders on a compact Gantt + metrics tiles + technician per WO. Empty state "No job cards yet — plan it in the Planner"
with a link `/planner?tab=production`.

### 7.3 AiTab fields (P7:anomaly-autowo)

In `AiTab.jsx`, directly after the `ai-anomaly-investigate` `<Switch>` (same `div`): `<Switch id="ai-anomaly-autowo"
label="Open a work order automatically" checked={draft.anomaly?.autoWorkOrder?.enabled} onChange={(v) => setGroup('anomaly',
'autoWorkOrder', { ...draft.anomaly?.autoWorkOrder, enabled: v })} />`, `<Field label="After consecutive scans">` number
1–10 (`afterScans`), `<Field label="Minimum severity">` `Select` warning|critical (`minSeverity`). Saved by the existing
Save (PUT `/admin/ai`). The AiTab test fixture gains `anomaly.autoWorkOrder`.

### 7.4 Anomalies badge (P7:anomaly-autowo)

`parts.jsx` `AutoWorkOrderBadge({ anomaly, className })` → `null` unless `anomaly.autoWorkOrderAt && anomaly.workOrderId`;
renders `Badge` (tone ai) "WO-n opened automatically" as a `Link` to `/m/workorders/<id>` (`refLabel(anomaly.workOrderId)`
gives the code when populated). Inserted in `AnomaliesPage.jsx` row (after `<StateBadge>`) and in `AnomalyDetail.jsx` next to
the existing "Work order" `Stat`.

### 7.5 Simulator control panel UI (P7:sim-ui) — `sara-simulator/ui/src/**`

`main.jsx`, `App.jsx` (login gate → `LoginPage` | panel: `StatusStrip`, `ControlsCard`, `CompanyCard` + `CredentialsDialog`,
`AnomalyLab`, `InjectionHistory` (detections), `ActivityFeed`), `api.js` (`api(path, { method, body })` with
`credentials: 'include'`, throws `{ message, code, details }`), `lib/usePoll.js` (`usePoll(fn, ms, { enabled })` → `{ data,
error, loading, refresh }`), `lib/toast.jsx` (tiny toaster), `simUtils.js` (copied, unchanged), `ui/{core,form,overlay}.jsx`
(copies of Button, Card, CardHeader, Badge, StatusPill, Skeleton, EmptyState, PageHeader, Input, Select, Switch, Field; `Dialog`
on native `<dialog>`; no radix), `index.css` (the token block of `sara/client/src/index.css`: same colours, radii, shadows).
No TanStack/sonner/radix: the ported components take `data` + `onAction` props instead of hooks (`StatusStrip({ status })`,
`ControlsCard({ control, instance, onPatch, onBackfill })`, `CompanyCard({ company, onCredentials })`,
`CredentialsDialog({ open, onClose, credentials })`, `AnomalyLab({ assets, scenarios, injections, onInject, onClear })`,
`InjectionHistory({ events })`, `ActivityFeed({ activity, paused, onPause })`). Same calm industrial look, responsive to 360 px.

## 8. Tests per package

| Package | Files → must cover |
|---|---|
| P7:plan-production | `planning-operators.test.js`: one operator per shift segment, never double-booked across cards (same person never on two overlapping segments), skill preference (moulding operator on an IMM), `operator_missing` when the shift has nobody; `planning-check.test.js` (people.js `vi.mock`ed with a fixture roster): a fresh plan is `doable`; moving a card onto a machine booked at that time → `machine_overlap` critical + `move_start` adjustment that, once applied, re-checks `doable`; editing `end` too early → `too_short` + `move_end`; late due → `adjust` with `extend_due`; `proposalId` check rewrites ops/diff and the explanation (mock) says "Needs adjustment:"; apply refuses `not_doable` (409) and accepts `force`; `planning-production.test.js` extended: ops carry `assignedTo` + `operatorPlan` |
| P7:plan-maintenance | `planning-people.test.js`: `shiftSegments` (overnight C shift, break inside), `loadPeople` bookings from job cards (operatorPlan) and WOs, `freeFor`, `rank` order, `availableUsers` tenancy (company B invisible); `planning-maintenance-plan.test.js`: tasks for scope plant/assets, zero-impact first with `protect_production`, `fix_fast` picks the earlier window with impact, downtime-cost objective picks the cheaper of two machines' windows (IMM 3 ₹5000/h vs IMM 5 ₹3800/h), technician on shift and skill-matched, never double-booked across the plan and existing WOs, metrics vs naive (`downtimeCostAvoided ≥ 0`), ops shape (plan op first, WOs reference `$op:0`), apply creates the maintenance plan + WOs with `maintenancePlanId`/`people`/windows and sets `metrics`/`aiSummary`/`proposal`, replan on stale; `planning-maintenance-check.test.js`: moving a task onto a job card → `jobcard_overlap` + `move_start` resolves it; technician busy → `swap_technician`; `impactDelta` |
| P7:planner-client | `planEdits.test.js` (pure helpers), `planner.test.jsx`: Production tab plans, edits a machine, checks (mocked API → not doable), applies the suggestion, creates → navigates to the plan record; Maintenance tab deep link pre-fills and runs; mobile layout renders stacked cards (`matchMedia` mock) |
| P7:related-records | `related.test.js`: counts and lists per child, tenancy (company B parent → 404; children filtered by feature flags/permissions), unknown child 404, `people` array filter; `related.test.jsx`: tabs with counts, Add pre-fills the parent ref, PlanChain renders the chain and totals |
| P7:anomaly-autowo | `ai-anomaly-autowo.test.js` (mock Gemini via `test/helpers/mockGemini.js` and a scripted decision): warning anomaly → no WO after scan 1, WO after scan 2 (code, category/priority/duration mapping, technician assigned, `anomalyId`, `autoWorkOrderAt`, notification to the technician + managers, live events), never a second WO (third scan, concurrent claim), critical → WO on first sight, `minSeverity: 'critical'` ignores warnings, clean scan resets `scansSeen`, settings patch validation; client `aiTab.test.jsx` saves the three fields; `anomalies.test.jsx` shows the badge |
| P7:sim-ui | `test/ui-server.test.js` (node:test, `sim_test_ui` on localhost, skipped when Mongo is down): 401 without cookie, login sets the cookie and `GET /api/status` has the shape, `PATCH /api/control` writes `simcontrol`, `POST /api/inject` validates asset/scenario, `GET /api/events` scores a detection from a fake `anomalies` doc, static 503 without a build; `test/ui-simUtils.test.js` (port of the pure part of `simulation.test.jsx`); `test/config.test.js`: `SIM_UI_PORT`/`SIM_UI_PASSWORD` validation |
| P7:sara-desim | `desim.test.js`: walks `server/src` and `client/src` (`.js/.jsx/.css/.md`, fs only) and fails listing every match of `/simul|isSimulated|simcontrol|simevents|siminstances|simactivity|simstate|demo-accounts|DEMO_MODE|accountGenerator|blueprint|\bfake\b|mock data/i` — no exceptions (`ai/mock.js` comments say "scripted responses", `gemini.js` "mock = scripted stand-in"); `adminPlatform.test.js`: superAdmin only, counts; `auth.test.js` without the demo-accounts cases; every existing test file still passes with `helpers/fixtures.js` (`seedCompany` keeps `generateAccount`'s behaviour: same moulds T-101/102/103, users, job cards, NOW) |

Server fixtures: `test/helpers/db.js` keeps `setupDatabase/teardownDatabase/contextFor/PASSWORD/NOW` and imports
`seedCompany` from `./fixtures.js` (ex-`generateAccount`) and `ensurePlatform/ensureIndexes` from `src/platform/platform.js`.

## 9. Demo cases (live Acme data on 2026-10-17; company `3d7e0d1dc28cd6339ff2e876`, plant Pune `9b2d4df95441fa8d50ff8085`, IST; the data moves while the telemetry source runs — never hard-code in tests)

Facts: shifts A 06–14 (`980cd26597725e5b457b96f5`), B 14–22 (`4bdc6099e0d41299d72bc105`), C 22–06 (`5bbb1a51f293f8c84aadc4f5`);
costsettings labour ₹350/h, downtime ₹3000/h; downtimeCostPerHour IMM 1/2 ₹4500, IMM 3/4 ₹5000, IMM 5 ₹3800, IMM 6 ₹4000,
Press 1 ₹3500, Press 2/3 ₹3000, Press 4 ₹2500, CNC 1/2 ₹3000, CNC 3 ₹2800, CNC 4 ₹3200, Compressors ₹2000, Chiller ₹1500,
Furnaces ₹2500. Moulds: Housing-A T-101 (2-cav, 32 s, setup 45; IMM 1/2), T-102 (2-cav, 30 s; IMM 3/4), T-103 (4-cav, 38 s,
setup 60; IMM 4/5); Cap-B T-201 (8-cav; IMM 1/2/3); Cover-C T-202 (IMM 5/6); Knob-G T-203 (IMM 6); Bracket-C T-301 (Press 1/2);
Clip-D T-302; Washer-H T-303; Gear Blank-E T-401 (CNC 1/2); Shaft-F T-402 (CNC 3/4); Flange-J T-403. Customers TAC Tata AutoComp
Systems, BSH Bosch India, MAH Mahindra & Mahindra. Production operators (Machine Operator): Sachin Pawar (A, moulding), Deepak
More (A, press), Lakshmi Reddy (A, cnc), Vijay Thakur (B, moulding), Sunita Kamble (B, press), Amit Verma (B, cnc), Ravi Prasad
(C, moulding+press), Santosh Mane (C, cnc); supervisors Manoj Shinde (A), Rahul Deshmukh (B). Maintenance technicians: Ramesh
Kumar (A, mechanical+pneumatics), Sandeep Yadav (A, mechanical+lubrication), Imran Qureshi (A, mechanical+welding), Suresh Patil
(B, electrical+plc), Anil Gaikwad (B, electrical+drives), Arjun Rao (B, hydraulics+pneumatics), Priya Nair (C,
utilities+refrigeration), Karthik Iyer (C, instrumentation+calibration), Mahesh Chavan (A, tool setter); managers Rajesh Joshi
(maintenance, admin A), Anita Deshpande, Neha Kulkarni; owner Vikram Mehta; viewer Kavita Bhatt.

1. **"Plan 5000 Housing-A due in 9 days"** (Production tab: part Housing-A, 5000, due 26-10): IMM 1 is booked by JC-12/JC-17/
   JC-21/24/28 until 21-10 16:18, IMM 3 by JC-15/20/23/27 until 19-10 21:22, IMM 4 by JC-18/26 until 19-10 08:31, IMM 5 by
   JC-19/22 until 17-10 23:36 → expected 3 job cards (T-103 → IMM 5 from ~18-10 00:00 after a 60-min changeover, T-102 → IMM 3
   from 19-10 21:22, T-101 → IMM 1 from 21-10 16:18) with operators per shift: Ravi Prasad (C), Sachin Pawar (A), Vijay Thakur
   (B) on the IMMs (Sunday 18-10 is not a running day) → verdict `doable`; Create → `PP-n` + job cards with `assignedTo` and
   `operatorPlan`; the record page shows the chain IMM 5 → IMM 3 → IMM 1.
2. **"Maintenance plan for the whole plant next 7 days"**: 12 open WOs, 11 already windowed (WO-90 … WO-114, the monthly PMs and
   calibrations generated by the telemetry source) and WO-116 (Safety, IMM 3, In Progress, no window) → the planner takes
   WO-116 and any PM/calibration due by 24-10 plus open anomalies; expected: technicians by skill (Suresh Patil/Anil Gaikwad for
   electrical, Arjun Rao for hydraulic, Ramesh/Sandeep/Imran for mechanical, Priya Nair for the utilities, Karthik Iyer for
   calibrations), zero-impact windows on idle machines (IMM 6, Press 3/4, CNC 2–4 are idle), impact numbers vs naive; if
   nothing is due → 400 "Nothing to plan" (inject an anomaly first, case 4).
3. **Edit a job card to an overbooked machine**: in case 1 move the T-102 card to IMM 4 (busy with JC-18/JC-26 until 19-10 08:31)
   at the same start → Check → `machine_overlap` (critical) → "Not doable" unless the suggested `move_start` (after JC-26) is
   applied → "Needs adjustment"/"Doable" after Apply suggestion.
4. **Inject `bearing_wear` from the simulator control panel** (scenario ids: bearing_wear, overheating, hydraulic_leak,
   energy_leak, phase_imbalance, cycle_time_drift, tool_wear, sensor_stuck, compressor_pressure_drop, sudden_breakdown) on a
   running IMM (IMM 2/IMM 4) with severity high, ramp 5 min → the watch flags vibration/current/temperature → `vibration_high`
   warning → after 2 consecutive scans (tick 60 s) a `WO-n` (Mechanical, Medium, 70 min) is opened automatically with a
   mechanical technician on shift, the Anomalies page shows "WO-n opened automatically", the control panel's injection row
   shows the detection latency.

## 10. Integrator checklist (shared files only the integrator edits) and order

**Order:** 1) `P7:sara-desim` deletions + moves land first (they change imports in many files); 2) `P7:plan-maintenance`
(people.js, proposals.js edits); 3) `P7:plan-production`, `P7:related-records`, `P7:anomaly-autowo` in any order; 4)
`P7:planner-client`; 5) `P7:sim-ui` is independent (other repo). Full suite: `SARA_TEST_DB=p7int npx vitest run
--maxWorkers=2` in `server`, `pnpm --filter client test`, `pnpm lint`, `pnpm validate-db --company 3d7e0d1dc28cd6339ff2e876`.

### 10.1 Shared-file edits
- `server/src/index.js`: drop `adminSimRouter` import + mount and the `superadminUsesDemoPassword` warning; `ensurePlatform`
  from `./platform/platform.js`; mount `{ path: '/api/admin/platform', router: adminPlatformRouter }` (`routes/adminPlatform.js`).
- `server/src/agent/systemPrompt.js`: `ParameterSpec` from `../db/models/ParameterSpec.js`; one line: "Plans: plan_production /
  plan_maintenance (scope + objective for a whole plan), check_plan after the user edits, then apply_plan."
- `agent/tools/registry.js`: nothing new to spread (`check_plan` lives in `planningTools`); `agent/tools/load.js` GROUP_HELP
  planning: "… production plans with operators per shift, maintenance plans for a plant or assets with technicians and
  production impact, checking an edited plan, applying a plan (always confirmed)". `agent/router.js` planning hint adds
  `maintenance plan|production plan|operators?|technicians?|doable`.
- `planning/explain.js` dispatch (one lazy branch, §4) — after `P7:plan-production` rewrote the production branch.
- `client/src/routes.jsx`: unchanged paths (`/planner`, `/m/:module/:id`); `client/src/layout/nav.js`: Planner stays; the
  Maintenance Plans module appears in the Maintenance group automatically (verify the Sidebar groups and the `CalendarCheck`
  icon in `lib/icons.js`).
- `client/src/blocks/BlockRenderer.jsx` `case 'plan'` and `client/src/chat/ConfirmCard.jsx` `case 'plan'`: unchanged
  imports (`PlanBlock`/`PlanPreview` now render operators, tasks, verdict); scripted chat flows in `server/src/ai/mockChat.js`
  (integrator): `plan_production` → `check_plan` → `apply_plan`, `plan_maintenance { scope: 'plant' }` → `apply_plan`.
- `docs/`: link this file from `docs/README` (if any); `simulator-v2.md` §6/§7 edits are `P7:sara-desim`'s.

### 10.2 `P7:sara-desim` import/comment sites (must all change; the desim test proves it)
Imports: `agent/systemPrompt.js` (integrator), `agent/tools/telemetry.js`, `ai/anomaly/baselines.js`, `routes/telemetry.js`,
tests `ai-anomaly-features.test.js`, `telemetryRoutes.test.js` (→ `db/models/ParameterSpec.js`); `routes/auth.js` (remove
`demo-accounts` + `superadminUsesDemoPassword`); `config/env.js` (`DEMO_MODE`, `SIM_DEFAULT_PASSWORD`, `SIM_DEFAULT_DOMAIN`
removed); `context/buildUserContext.js` (`isSimulated`); `defs/org.js` (`isSimulated` field); `scripts/seed.js` (platform +
superadmin only, `--reset` kept), `scripts/validate-db.js` (`--company <id>` required, or every non-platform company);
`test/helpers/db.js`, `test/auth.test.js`, `test/ai-anomaly-watch.test.js` (drop `attachDetections`). Comments/wording
("simulator" → "telemetry source"/"devices"; "simulated" → "scripted"/"generated"): `lib/shifts.js:4`, `modules/actions/notify.js:3`,
`modules/actions/workOrders.js:25`, `modules/defs/attendance.js:3`, `modules/fields.js:86`, `modules/validateCompany.js:13`,
`planning/maintenance.js:26`, `telemetry/catalog.js:3,57`, `telemetry/dbClock.js:19`, `telemetry/livePoller.js:7,21`,
`telemetry/queries.js:114`, `ai/gemini.js` (3), `ai/mock.js:220` ("the scripted machines"), `client/src/ui/charts.jsx` (1),
`client/src/auth/LoginPage.jsx` (delete `DemoAccounts`), `client/src/superadmin/SuperAdminPage.jsx` (tabs AI + Platform,
default `ai`). Config/docs: `.env.example` (DEMO_MODE and the Simulation block go; `SUPERADMIN_PASSWORD` note reworded),
`docker-compose.yml` (pass `SIM_USER_PASSWORD` to the simulator service directly, no `SIM_DEFAULT_PASSWORD`),
`docs/simulator-v2.md` §1 (schemas live in the simulator), §6 (SARA keeps only the live poller and `parameterspecs`; "the
control plane is the simulator's own UI on port 5090"), §7 unchanged, `docs/phase2-contracts.md`/`phase3-contracts.md`
mentions of the Simulation tab and `/api/admin/sim` (one-line notes "moved to the simulator in phase 7"), `README.md`.
`ensurePlatform/ensureIndexes/PLATFORM_COMPANY_ID` move to `src/platform/platform.js` (indexes: all modules + Counter +
Session + ParameterSpec).
