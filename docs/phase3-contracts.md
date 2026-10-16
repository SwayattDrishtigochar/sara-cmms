# Phase 3 contracts — AI layer and Gemini anomaly detection

Builds on phase 2 (`docs/phase2-contracts.md`). Same conventions: ESM JavaScript, arrow functions, zod,
`lib/errors.js`, no new npm dependencies, tests with `SARA_TEST_DB=<package> npx vitest run <files>`.

The user requirement this phase serves: **"the system must detect and show which parameter is wrong, and the
detection must be done by the Gemini AI agent"**, plus "most things done by AI" with the free-tier quota as
the main risk. Deterministic code computes statistics; **Gemini decides** whether something is anomalous,
which parameters, why, and what to do.

## 1. Gemini plumbing (`server/src/ai/`)

### `ai/settings.js` + `db/models/PlatformSettings.js`

Singleton document `{ _id: 'platform', ai: {...} }` (collection `platformsettings`), created from env on first
read, cached in memory, invalidated on save.

```js
export const DEFAULT_AI = {
  tiers: {
    router:     { model: env.GEMINI_MODEL_ROUTER,     thinkingLevel: null,      fallback: null },
    fast:       { model: env.GEMINI_MODEL_FAST,       thinkingLevel: 'low',     fallback: env.GEMINI_FALLBACK_FAST },
    balanced:   { model: env.GEMINI_MODEL_BALANCED,   thinkingLevel: 'medium',  fallback: env.GEMINI_FALLBACK_BALANCED },
    deep:       { model: env.GEMINI_MODEL_DEEP,       thinkingLevel: 'high',    fallback: env.GEMINI_FALLBACK_DEEP },
    background: { model: env.GEMINI_MODEL_BACKGROUND, thinkingLevel: 'low',     fallback: null }, // never falls back into chat models
  },
  limits: {},                 // { [model]: { rpm, rpd } } — superadmin copies these from AI Studio; unknown → { rpm: 10, rpd: 250 }
  chatReservePct: env.AI_CHAT_RESERVE_PCT,
  showThoughts: true,
  anomaly: { enabled: true, tickSec: env.ANOMALY_SCAN_TICK_SEC, quietIntervalMin: env.ANOMALY_QUIET_INTERVAL_MIN, alwaysAskAi: false, investigate: true },
  costWatch: { enabled: true, intervalMin: env.COST_WATCH_INTERVAL_MIN },
  kpiInsightTtlMin: env.KPI_INSIGHT_TTL_MIN,
  briefingTtlHours: env.BRIEFING_TTL_HOURS,
};
export const getAiSettings = async () => /* merged with DEFAULT_AI */;
export const saveAiSettings = async (patch, userId) => /* validated (zod), returns settings */;
```

### `ai/models.js`

```js
export const THINKING_LEVELS = { // from ai.google.dev thinking table, 2026-10-15
  'gemini-4-argon': ['low', 'medium', 'high'],
  'gemini-3.8-flash': ['low', 'medium', 'high'],
  'gemini-3.6-flash': ['minimal', 'low', 'medium', 'high'],
  'gemini-3.5-flash-lite': ['minimal', 'low', 'medium', 'high'],
  'gemini-3.1-pro-preview': ['low', 'medium', 'high'],
  'gemini-3-flash-preview': ['minimal', 'low', 'medium', 'high'],
};
export const FREE_TIER = new Set(['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite',
  'gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite']); // pricing page, 2026-10-15
export const thinkingConfigFor = (model, level, { includeThoughts = false } = {}) =>
  /* { thinkingLevel: 'LOW'|… clamped to the nearest supported level, includeThoughts } or { includeThoughts } when the model is not in the table / level null */;
export const listModels = async () => [{ id, displayName, inputTokenLimit, outputTokenLimit, thinking, free }]; // ai.models.list(), cached 10 min; generateContent-capable only
```

### `ai/budget.js` + `db/models/AiUsage.js`

`ai_usage` docs `{ model, purpose, companyId, status: ok|error|rate_limited|blocked|mock, tokens: { prompt, thoughts, candidates, total }, latencyMs, error, createdAt }` (TTL 30 days).
Purposes: `chat`, `router`, `title`, `summary`, `anomaly`, `investigation`, `kpi`, `cost`, `briefing`, `planning`, `test`.

```js
export const pacificDay = (date = new Date()) => /* 'YYYY-MM-DD' in America/Los_Angeles — Gemini quotas reset at midnight Pacific */;
export const canSpend = async (model, purpose) => ({ ok, reason }); // RPM token bucket (in memory) + RPD count (in memory, seeded from ai_usage for today); background purposes refused once used > rpd × (1 − chatReservePct/100)
export const recordUsage = async ({ model, purpose, companyId, status, usage, latencyMs, error }) => void;
export const usageToday = async () => [{ model, calls, tokens, rateLimited, errors, limits: { rpm, rpd }, free }];
```

### `ai/gemini.js`

```js
export class AiUnavailableError extends Error {} // code 'AI_QUOTA' | 'AI_ERROR' | 'AI_DISABLED'
export const isMock = () => env.AI_MOCK || !env.GEMINI_API_KEY; // no key → deterministic mock, provenance "mock"
/**
 * One non-streaming call with tier routing, budget, 429 handling and usage logging.
 * schema (JSON Schema object) → responseMimeType application/json + responseJsonSchema, result.json parsed.
 */
export const generate = async ({ tier, purpose, companyId, system, contents /* string | Content[] */, schema, mockInput, signal }) =>
  ({ text, json, model, tier, usage, latencyMs, mock: boolean });
export const generateStream = async function* ({ tier, purpose, companyId, system, contents, tools, signal, thinking }) { /* yields SDK chunks; phase 4 */ };
export const parseRetryDelaySec = (err) => number | null; // reads "retryDelay": "12s" from the API error body
```

429 rule: retryDelay ≤ 10 s → wait and retry once on the same model; otherwise switch to the tier's fallback
(none for `background` → throw `AiUnavailableError('AI_QUOTA')`). Every attempt is recorded in `ai_usage`.
Mock mode routes to `ai/mock.js` (`mockGenerate({ purpose, mockInput, schema })`) which must return valid,
deterministic, realistic output for every purpose that uses `generate` (anomaly decisions are derived from
`mockInput` features — see §2 — so the full demo works without an API key).

## 2. Anomaly detection (`server/src/ai/anomaly/`)

### `baselines.js` + `db/models/Baseline.js`

`baselines` docs `{ companyId, assetId, measurement, field, status, mean, std, p5, p95, n, computedAt }`
(unique on companyId+assetId+measurement+field+status).

```js
export const refreshBaselines = async (companyId, { days = 7, excludeLastMin = 60 } = {}) => ({ rows });
// Flux: range(start: -7d, stop: -1h) |> filter companyId |> filter _measurement in [machineParams, sensorData, energy] |> numeric only
//       |> group(columns: ["assetId", "_measurement", "_field", "status"]) |> aggregateWindow(every: 1m, fn: mean, createEmpty: false)
//       then mean / stddev / quantile(q: 0.05) / quantile(q: 0.95) / count — one small query each, joined in JS.
export const baselineFor = async (companyId) => Map<`${assetId}|${field}|${status}`, row>; // cached until next refresh
```

Fallback when n < 120 (less than 2 h of 1-minute means) or no row: parameter spec band →
`{ mean: (min+max)/2, std: (max−min)/6, p5: min, p95: max, source: 'spec' }`; otherwise `source: 'history'`.

### `features.js`

```js
export const computeFeatures = async (companyId, { now = new Date(), windowMin = 10 } = {}) => [{
  assetId, name, tag, type, plantId, status, statusSince, inShift, job /* {jobCardId, toolName} | null */,
  transition /* status changed < 3 min ago: z not reliable */,
  fields: [{ measurement, field, unit, last, mean, min, max, std, slopePerHour, n,
             baseline: { mean, std, p5, p95, source }, z, band /* 'above'|'below'|null vs p5/p95 widened 10% */,
             spikes /* count of 1-min means beyond 4σ */, flatline /* std≈0 while Running and baseline std>0 */ }],
  rejectionRate: { recentPct, baselinePct } | null,  // production assets, from rejections + partcounts over 60 min vs 7 d
  idlePowerRatio: number | null,                     // energy assets: POWER TOTAL now ÷ baseline for the current status
  flags: ['z', 'band', 'flatline', 'spikes', 'rejects', 'idle_power'],   // which deterministic screens fired
}];
```

One Flux query per company per tick: last `windowMin` minutes, `aggregateWindow(1m, mean)` grouped by
assetId/_measurement/_field (numeric only), filtered to the asset's **current status** (status tag) so z is
compared with the right baseline. Slope = least squares over the 1-minute means, per hour.

### `watch.js` (the scheduler)

```js
export const startAnomalyWatch = () => stopFn;             // setInterval(tickSec); one company at a time; never overlapping (per-company lock)
export const scanCompany = async (companyId, { force = false, reason = 'tick' } = {}) => ({ reviewed, anomalies, skipped, model, mock });
```

Per company per tick:
1. `computeFeatures`. An asset is **due** when: it has flags, or an open anomaly, or it was last reviewed more
   than `quietIntervalMin` ago, or `force`. Every telemetry asset is therefore reviewed by Gemini regularly;
   statistics only change how often. `alwaysAskAi` = every asset every tick.
2. Skip OFF assets outside shifts (nothing to judge), but keep them in health output as "Off".
3. One `generate({ tier: 'background', purpose: 'anomaly', schema, mockInput: features })` call for all due
   assets. Prompt: compact table per asset (`field | last | 10-min mean | baseline mean±std (source) | z | slope/h | band | flags`),
   context (type, status + since, in shift, job, rejection rate, idle power ratio) and instructions: judge
   physically (correlated signals, e.g. vibration + current + temperature = bearing wear; high idle power =
   energy leak; frozen value = sensor fault), be conservative, cite only fields from the table, give a health
   score for every due asset.
4. Response schema:
   ```json
   { "assets": [ { "assetId": "…", "healthScore": 0-100, "state": "normal|watch|anomalous", "summary": "…",
       "anomalies": [ { "type": "<ANOMALY_TYPES>", "severity": "info|warning|critical", "confidence": 0-1,
         "parameters": [ { "field": "…", "observed": 0, "expected": 0, "deviation": "+4.2σ" } ],
         "explanation": "…", "likelyCauses": ["…"], "recommendedActions": ["…"], "urgencyHours": 0 } ] } ] }
   ```
5. Guardrails (`guardrails.js`, pure + unit-tested): drop assets not in the input; drop parameters whose field
   is not in that asset's table or whose `observed` differs from the table's last/mean by > 15 %; drop
   anomalies left with no parameters; clamp scores; `watch` never notifies.
6. Effects: `assets.healthScore/healthSummary/healthUpdatedAt`; anomalies upserted by (assetId, type) while
   `state ∈ {open, acknowledged}` (update severity up, lastSeenAt, parameters, confidence); a resolved one of the
   same (asset, type) within 6 h is **reopened**; new ones get `detectedAt`, `model`, code via
   `records.create(systemCtx, 'anomalies', …)`; an anomaly auto-resolves after 3 consecutive **clean** scans
   (asset Running/Idle in shift and judged normal — OFF or skipped scans never count).
7. New warning/critical anomaly → notification (owners, admins and the plant's Maintenance technicians),
   live event `anomaly` `{ anomaly }` with audience `{ plantId }`, and (if `settings.anomaly.investigate`) an
   investigation.
8. Record last-reviewed time per asset (in memory + `assets.healthUpdatedAt`).

### `investigate.js`

```js
export const investigateAnomaly = async (companyId, anomalyId) => investigation;
```

Deterministic evidence pack: flagged fields' 1-min series for the last 2 h (`seriesFor`), baselines, last 5
work orders on the asset, last/next PM, related spare parts with current stock, similar anomalies in the last
30 days. One `generate({ tier: 'background', purpose: 'investigation', schema })` →
`{ summary, rootCause, confidence, recommendedActions[], suggestedWorkOrder: { name, description, priority, category, estimatedDurationMin }, urgencyHours, markdown }`.
Stored on `anomaly.investigation` with `{ model, at, evidence: { fields, series } }`; live event `anomaly`.

### Ground truth scoring (superadmin only)

`GET /api/admin/sim/events` gains `detection: { anomalyId, code, detectedAt, latencySec, matchedFields[] } | null`
— the first anomaly on the same asset detected after `startedAt` whose parameters intersect the scenario's
`affects`. The AI never reads `simevents`.

## 3. Routes

| Route | Who | Response |
|---|---|---|
| `GET /api/admin/ai` | superAdmin | `{ settings, apiKeyConfigured, mock }` |
| `PUT /api/admin/ai` | superAdmin | `{ settings }` (zod-validated patch; model ids must be strings matching `^[a-z0-9.\-]+$`) |
| `GET /api/admin/ai/models` | superAdmin | `{ models: [...listModels()], tiers }` |
| `POST /api/admin/ai/test` | superAdmin | `{ ok, model, latencyMs, text, error }` — tiny prompt via `generate({ purpose: 'test' })` |
| `GET /api/admin/ai/usage` | superAdmin | `{ day, models: usageToday() }` |
| `POST /api/ai/scan` | owner/admin of the company | `{ reviewed, anomalies }` — `scanCompany(ctx.companyId, { force: true, reason: 'manual' })` |
| `GET /api/ai/health?assetId=` | any user (asset access via records.get) | `{ asset: { healthScore, healthSummary, healthUpdatedAt }, anomalies: [open + last 10 resolved] }` |
| `POST /api/anomalies/:id/investigate` | owner/admin/technician with assets.update | `{ investigation }` |
| `POST /api/anomalies/:id/state` | same | body `{ state: acknowledged\|resolved\|false_positive, note? }` → `{ anomaly }` (via records.update) |
| `GET /api/notifications` | any user | `{ items: [...], unread }` — recipientUsers contains me or is empty (company-wide), plant rule, newest 30, `read` flag from readBy |
| `POST /api/notifications/:id/read`, `POST /api/notifications/read-all` | any user | `{ ok: true }` |

## 4. Client

- `client/src/superadmin/AiTab.jsx` (+ register the "AI" tab in SuperAdminPage): API key status / mock banner;
  tier table (model select from `/api/admin/ai/models` with "Free" badge and the current model; thinking level
  select showing only that model's supported levels; fallback select; Test button → latency + reply); quota
  table (rpm/rpd inputs per model in use, today's usage bars from `/api/admin/ai/usage`, rate-limited count);
  chat reserve %; background AI (anomaly scan on/off, tick seconds, quiet interval minutes, "Always ask AI",
  investigations on/off; cost watch interval; KPI insight TTL; briefing TTL); Save with dirty-state guard.
- `client/src/anomalies/AnomaliesPage.jsx` (`/anomalies`, PRIMARY_NAV "Anomalies", icon `Activity`): severity
  summary chips, filters (state, severity, asset, search), list of anomaly rows (severity icon+label, asset,
  type label, AI summary, parameter chips with deviation, confidence, detected relative time, state badge),
  "Scan now" (owner/admin). Detail `Sheet` (`AnomalyDetail.jsx`): header (code, asset link to `/machines/:id`,
  severity, state), AI summary card (`.ai-edge` + `AiProvenance`), evidence chart (TelemetryChart of the flagged
  fields ±2 h with normal band and a marker at detectedAt), investigation (react-markdown + remark-gfm) with
  root cause, recommended actions and the suggested work order card → "Create work order" (confirm dialog →
  POST `/api/m/workorders` prefilled with `anomalyId`, asset, priority, category, estimatedDurationMin; then
  link), "Plan maintenance" (disabled until phase 5 with a tooltip), and state actions (Acknowledge, Resolve,
  False positive with note).
- Machine 360 (`client/src/machines/MachinePage.jsx`): `HealthRing` (SVG, 0–100, colour band + number + label)
  with healthSummary in the header; parameter tiles flagged by open anomalies get a red ring + icon and the
  deviation text ("+4.2σ, rising") with a tooltip of the explanation; "Anomalies" card (open + recent);
  "Scan now" button for owner/admin. Machines grid cards show the health ring and an anomaly badge.
- Global alerts: `client/src/layout/NotificationsBell.jsx` in the header (unread count badge, dropdown of the
  latest notifications with icon by type, mark read / mark all read, click → navigate to the record or
  machine); toasts (sonner) for live `anomaly` events (severity warning/critical) with "View" action, and for
  `notification` events addressed to me.
- Superadmin Simulation: injections table shows detection (detected ✓ with latency and matched fields, or
  "waiting…" with elapsed time).
