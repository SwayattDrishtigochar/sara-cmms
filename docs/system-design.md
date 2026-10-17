# SARA — system design

SARA is an AI-first CMMS: maintenance, inventory and partners, production, bins, rules and reports on
generic schema-driven pages, with Gemini doing the judgement work (anomaly calls, investigations, chat
CRUD, planning explanations, cost and KPI insights). A separate repo, `sara-simulator`, is the plant's
digital twin: one simulated company whose machines and people write SARA's databases directly.

**Design rule.** Deterministic code computes the numbers (statistics, capacity, schedules, costs). Gemini
makes the judgement calls, picks between options and explains. Every AI output carries its provenance
(model and time) and can be regenerated.

Contracts in detail: `docs/simulator-v2.md` (simulator), `docs/phase2-contracts.md` (live data),
`docs/phase3-contracts.md` (AI plumbing, anomaly detection), `docs/phase4-contracts.md` (chat agent).

## 1. Architecture

```
 Raspberry Pi 4/5 or laptop                                         Browser (React 19, Vite, Tailwind 4)
 ┌───────────────────────────────────────┐                          ┌───────────────────────────────────┐
 │ sara-simulator (Node 22, systemd)     │                          │ Command Center · Machines · 360   │
 │  seed once (simstate marker)          │                          │ Anomalies · Planner · Costs · KPI │
 │  20 machines: physics + scenarios ────┼── line protocol (gzip) ─┐│ Chat + ⌘J drawer · Modules        │
 │  machine state (status, downtimes,    │                         ││ Superadmin: AI · Platform         │
 │    job counters, rejections) ─────────┼──┐                      │└──────▲────────────▲───────────────┘
 │  people (WOs, job cards, requests,    │  │                      │       │ REST       │ SSE: /api/live,
 │    PMs, stock, attendance) ───────────┼──┤                      │       │ (JWT)      │ chat messages
 │  control loop 3 s ◄── simcontrol,     │  │                      │       │            │
 │    simevents; heartbeat siminstances  │  │                      │ nginx (client image): SPA + /api proxy
 └───────────────────────────────────────┘  │                      │       │            │ (unbuffered SSE)
                                            ▼                      ▼ ┌─────┴────────────┴──────────────────┐
                          ┌──────────────────────┐  ┌─────────────┐ │ SARA server (Node 26, Express 5)     │
                          │ MongoDB 8 (db "sara")│  │ InfluxDB 2.7│ │  auth (JWT + sessions) · records.js  │
                          │ business records,    │◄─┤ bucket per  │◄┤  live poller 3 s ──► event bus ──►SSE│
                          │ sim control plane,   │  │ company id  │ │  AI: gemini.js · budget ledger       │
                          │ AI state, sessions   │  └─────────────┘ │      anomaly watch · investigations  │
                          └──────────▲───────────┘                  │      chat agent (router, tools, loop)│
                                     └──────────────────────────────┤  engines: capacity · planners ·      │
                                                                    │      costs · KPI runner (phase 5–6)  │
                                                                    └──────────────────┬───────────────────┘
                                                                                       ▼
                                                                         Google Gemini API (free tier)
```

## 2. Components

| Component | Where | Tech | Responsibility |
|---|---|---|---|
| Web app | `sara/client` | React 19, Vite 8, Tailwind 4, TanStack Query 5, zustand 5, react-router 7, recharts 3, radix-ui | Every page; generic module list/record/form pages from registry metadata; chat UI; voice panel (AudioWorklet mic, Web Audio player); live tiles |
| API server | `sara/server` | Node 26, Express 5, Mongoose 8, zod 4, `@google/genai`, `ws`, `@influxdata/influxdb-client`, pino | Auth, tenancy, records, live feed, AI layer, voice proxy (`/api/voice`), engines |
| Simulator | `sara-simulator` | Node ≥ 22, `mongodb`, `luxon`, `bcryptjs` | Seeds one company once, streams 20 machines, simulates 28 people, applies the injections from its own control panel (port 5090) |
| MongoDB 8 | compose `mongo` | | All business records, simulator control plane, AI state (conversations, usage, anomalies), sessions |
| InfluxDB 2.7 | compose `influxdb` | | Telemetry, one bucket per company (named by its id); measurements `machineParams`, `sensorData`, `energy`, `shotCountDetails`, `timelineData`, `qualityEvents` |
| nginx | client image | nginx 1.29 | Serves the SPA with history fallback; proxies `/api`, unbuffered for `/api/live` and `/api/conversations`, WebSocket upgrade for `/api/voice` |

**Server layout** (`server/src/`): `config/` (env, mongo, influx) · `auth/` · `context/` (request context:
role, company, plant rule, modules) · `modules/` (registry, field types, `records.js`, permissions, actions) ·
`routes/` · `telemetry/` (catalogue, Flux queries, live poller) · `ai/` (Gemini plumbing, budget, anomaly
watch) · `agent/` (router, loop, tools, validators) · `voice/` (Gemini Live proxy, phase 8) · `engines/`, `kpis/`, `jobs/` (phase 5–6) · `planning/`
(production and maintenance planners) · `platform/` (platform tenant, superadmin and indexes).

## 3. Data model

**Registry.** `modules/fields.js` plus `modules/defs/*.js` describe each of about 40 modules once (org,
maintenance, inventory, production, bins/rules/reports, AI-native: anomalies, cost alerts, KPIs, insights,
plan proposals). From that one definition the server derives the Mongoose schema, strict zod create/update
schemas, UI metadata for the generic pages and the prompt digest the agent sees.

**`records.js` is the only data path** for REST pages, agent writes, planners and the KPI runner. It
injects the tenant field, applies the plant rule, checks that every ref points into the same company,
allocates per-company/per-plant codes (`WO-n`, `JC-n` …) with atomic counters, enforces permissions,
soft-deletes, strips secrets, and supports `dryRun` (used to preview agent writes before Confirm).

**Platform collections** (superadmin only, never given to the agent): `parameterspecs`, `baselines`,
`platformsettings`, `sessions`, `counters`, `ai_conversations`, `ai_messages`, `ai_texts`, `ai_tool_audit`,
`ai_usage`. The simulator keeps its own control collections (`simcontrol`, `simevents`, `siminstances`,
`simactivity`, `simstate`) in the same database; SARA never reads or writes them.

## 4. Data flow

### 4.1 Machines and people → databases (simulator)

1. **First run only:** `ensureSeeded` writes the company (1 plant, 3 shifts, 20 assets, 28 people, tools,
   stock, PMs, 60 days of history, plans and job cards, 14 days of attendance) with ids derived from
   `COMPANY_SLUG`, then backfills 7 days of 1-minute telemetry. The `simstate` marker makes later runs skip
   seeding.
2. **Machines** step every second. Status follows the world: `Maintenance` while a maintenance WO is in
   progress, `Stopped` during a breakdown, `OFF` outside shifts, `Running` with a job card, else `Idle`.
   Points are written as gzip line protocol (≤ 5 000 lines a request, retry with backoff, 50 000-point ring
   buffer that drops the oldest non-status points first).
3. **Machine-derived state** goes to Mongo in the same step: asset status and `assetStatusSince`,
   downtimes, job card and tool counters, part counts per shift, rejections.
4. **People** act every 15 s inside their shifts, through `domain/` helpers that mirror SARA's own
   business rules (status transitions and stamping, FIFO spare consumption, request → WO, notifications),
   and log one `simactivity` sentence per action.
5. **Clock:** a Pi has no RTC, so the simulator stamps with MongoDB's clock (offset from `hello.localTime`).

### 4.2 Databases → browser (SARA live feed)

```
InfluxDB (last 2 min per field) ┐
Mongo changes since last look   ├─► livePoller (3 s, per company with listeners) ─► event bus ─► /api/live (SSE)
 (asset status, notifications,  │      telemetry · status · notification ·              filtered per subscriber:
  downtimes, record updatedAt)  ┘      downtime · record {module} · anomaly             company + plant rule + userIds
```

- A poller starts with the first `/api/live` subscriber of a company and stops with the last. The first
  look primes every field's latest value; later looks re-read 60 s back (writer clocks differ) and skip what
  they saw. `GET /api/telemetry/latest` answers from its cache while warm.
- `/api/live` re-checks the session every 60 s and closes when it ends.
- The client parses SSE over `fetch` (so the Bearer header works), patches TanStack Query caches and shows
  toasts for anomalies and notifications addressed to the user.

### 4.3 Simulator control panel (control plane in Mongo)

The simulator serves its own password-protected control panel (port 5090, `SIM_UI_PASSWORD`). It writes
`simcontrol` (running, tick, human activity, speed 1–120×, respond to anomalies, backfill requests) and
`simevents` (injections: asset, scenario, severity, ramp, hold). The simulator reads both every 3 s and
writes its heartbeat to `siminstances` (online = seen within 15 s). SARA has no simulator page or route:
there is no network path from SARA to the Pi, which only needs outbound access to MongoDB and InfluxDB.

### 4.4 The closed loop (F8)

```
inject bearing_wear on Press 1 ─► vibration ramps in the telemetry ─► anomaly watch flags it, Gemini names
"vibration" ─► investigation + notification ─► WO (SARA opens it after 2 scans, or the card, chat, planner) ─►
simulated technician completes it ─► injection cleared (clearedReason 'repair') ─► telemetry normal ─►
3 clean scans ─► anomaly auto-resolves
```

The simulator panel's detection scoreboard joins `simevents` (ground truth) with the first matching anomaly
for latency and matched fields. SARA and its AI never read `simevents`.

## 5. AI layer

### 5.1 Plumbing (`ai/gemini.js`, `ai/models.js`, `ai/settings.js`)

| Tier | Used for | Default model | Thinking | Fallback |
|---|---|---|---|---|
| router | intent, titles, summaries | `gemini-3.1-flash-lite` | none | none (heuristics) |
| fast | simple chat | `gemini-3.6-flash` | low | `gemini-3.8-flash` |
| balanced | most chat | `gemini-3.8-flash` | medium | `gemini-3.6-flash` |
| deep | hard chat | `gemini-3.8-flash` | high | `gemini-3.6-flash` |
| background | anomaly scans, investigations, KPI insights, cost notes, briefings | `gemini-3.5-flash-lite` | low | **none**: skip and retry next cycle |

- Models, thinking levels, fallbacks and limits live in `platformsettings` and change live from
  Superadmin → AI; thinking levels are clamped to what each model supports.
- `generate()` is one structured call (`responseJsonSchema`); `generateStream()` serves the chat loop.
- **429:** a `retryDelay` ≤ 10 s waits and retries once; otherwise the tier's fallback (with a `notice`
  event); if both fail, an error. Background work never falls into chat models.
- **Mock:** `AI_MOCK=true` or no key routes every purpose to deterministic, realistic mock output, so tests
  and keyless demos exercise the full flow. Tests always run mocked.

### 5.2 Budget ledger (`ai/budget.js`)

Free-tier quotas are per model, small, and reset at midnight Pacific. Before every call `canSpend(model,
purpose)` checks an in-memory RPM token bucket and the day's call count (seeded from `ai_usage`), and
refuses background purposes once they would eat into `chatReservePct` (40 %) of the model's daily quota.
Every attempt (ok, error, rate-limited, blocked, mock) is written to `ai_usage` (TTL 30 days); the AI tab
shows usage against the limits superadmin copied from AI Studio.

### 5.3 Anomaly watch (`ai/anomaly/`, F3)

1. **Baselines (hourly):** 7 days of 1-minute means grouped by asset, field and **status** → mean, σ, p5,
   p95. The status split gives Idle/OFF power its own baseline, which is how energy leaks show up. Under 2 h
   of history, the `parameterspecs` band stands in.
2. **Features (every tick, one Flux query per company):** last 10 min of 1-minute means → z-score, slope per
   hour, spikes, band breach, flatline, idle-power ratio, rejection rate; plus status, `inShift`, job.
3. **Frequency gate:** statistics decide only *how often* an asset is reviewed: every tick when flagged or
   with an open anomaly, otherwise every `quietIntervalMin`. Every asset still gets a regular AI review.
4. **Gemini decides:** all due assets of a company go into **one** background call (scans never overlap)
   that returns a health score for each and, for non-normal ones, typed anomalies with the parameters
   (`field`, observed, expected, deviation), explanation, likely causes, actions and urgency.
5. **Guardrails** (pure, unit-tested): drop assets or fields not in the input table, drop values that do not
   match the table (> 15 % off), drop anomalies left without parameters, clamp scores; `watch` never notifies.
6. **Lifecycle:** one open anomaly per (asset, type), updated in place; reopened if it recurs within 6 h;
   auto-resolved after 3 clean scans (Running/Idle in shift and judged normal; OFF or skipped scans never
   count). Effects: `healthScore`/`healthSummary` on the asset, notification + live `anomaly` event for new
   warning/critical ones, and an investigation.

### 5.4 Investigations (`ai/anomaly/investigate.js`)

A deterministic evidence pack (flagged series for 2 h, baselines, last 5 WOs, last/next PM, related spare
stock, similar anomalies in 30 days) goes into **one** background call returning root cause, confidence,
actions, a suggested work order, urgency and markdown. Charts are drawn from the evidence, not from model
text. Offered actions: Create WO, Plan maintenance (F2), Acknowledge, False positive.

### 5.5 Chat agent (`agent/`, F4–F6)

```
user message ─► router (structured: intent, complexity, groups, tier) ─► system prompt (user, company, time,
module digest, telemetry digest, page context, summary) + history ─► loop:
   generateStream(tools of the loaded groups) ─► thoughts / text deltas ─► function calls
      ─► zod check ─► tool.run(ctx) through validators + records.js ─► audit ─► responses (call order) ─► next step
   caps: MAX_TOOL_ITERATIONS 6, MAX_TURN_MS; stop endpoint or client disconnect aborts; escalate once
write tool call ─► records dryRun preview ─► ConfirmCard (diff, labels) ─► Confirm (atomic, re-checks
permission) ─► run ─► continuation of the same turn  |  Reject / 10 min expiry / new message ─► "not confirmed"
```

- **Tool groups:** `core` always (resolve, time ranges, schema, mongo find/count/distinct/aggregate,
  render table/chart/KPIs, CSV export, `load_tools`); loadable `maintenance`, `production`, `telemetry`,
  `health`, `write`, and in phase 5–6 `planning`, `cost`, `kpi`. Groups only accumulate in a conversation.
- **Validators** (unit-tested): `mongoFilter` (operator allow-list, tenant re-injected, regex limits, casts),
  `mongoPipeline` (stage allow-list, forced leading scope `$match`, `$lookup` rewritten with a tenant
  `$match` and secret `$project`, row caps, `maxTimeMS`), `redact` (secrets out), `flux` (own bucket only,
  one `range`, no `to()`/`http`/`sql`, `companyId` filter injected).
- **Writes:** only `agentWritable` modules, ≤ 20 items, one write call per model step, always behind
  Confirm. The pending action is stored on the message in Mongo (survives restarts).
- **History:** the model `Content` is stored verbatim (every `thoughtSignature` kept); older turns shrink to
  `{summary, rowCount}`, then into `conversation.summary`.
- **Streaming:** SSE events `meta`, `thought`, `delta`, `tool_call`, `tool_result`, `block`, `notice`,
  `escalated`, `usage`, `title`, `done`, `error`.

### 5.6 Other AI outputs (F9)

KPI insights (one call for every KPI whose insight is older than the TTL), cost-alert notes (two sentences
on cause and fix per breach), the Command Center briefing (deterministic evidence pack → narrative, 3
actions, evidence blocks; regenerated after 4 h or on demand) and planning explanations, all on the
background tier and all under the budget ledger.

### 5.7 Voice (Gemini Live proxy) (`voice/`, phase 8)

```
browser: mic → AudioWorklet (16 kHz PCM16, 40 ms frames) ─┐                ┌─► player (24 kHz PCM16, gapless)
         captions, tool trace, blocks, Confirm cards ◄────┤ wss /api/voice ├── binary audio + JSON events
                                                          ▼                │
SARA server: start { JWT } → userFromToken → one session per user ─► Gemini Live (one connection per session;
   system prompt = chat prompt + voice style + language, every permitted tool group, female prebuilt voice,
   input/output transcription, VAD, context compression, resumption handle)
   toolCall ─► execute(ctx) as in chat ─► audit ─► sendToolResponse      write ─► pending action ─► Confirm card
   confirm_action (voice, a later turn) or Confirm click ─► claimPendingAction ─► execute ─► result spoken
```

- **Why a proxy:** the key never leaves the server; tools run with the user's `ctx`, permissions, audit and
  pending actions; `usageMetadata` reaches the budget ledger; the mock plugs in at one point (`liveApi()`).
  Rejected: ephemeral tokens with browser-direct Live (tool calls would land in the browser).
- **Auth and limits:** the JWT rides in the first message (5 s deadline), Origin allow-list from `CLIENT_URL`,
  re-checked every 60 s and at token expiry; 16 KiB frames, 100 messages/s, 6 starts/min/user, one session per
  user, `maxConcurrent` server-wide, `maxSessionMin`, 90 s idle, heartbeat.
- **Turns:** each voice turn is one user + one assistant `ai_messages` doc (`channel: 'voice'`, `tier: 'voice'`,
  chat-shaped `parts` and replayable `gemini` contents) in a `voice: true` conversation, so Chat shows it and can
  continue it by text. Writes follow chat's rule: preview → pending action → confirm by voice (`confirm_action`,
  only the latest action and only from a later turn) or by click. Audio is relayed and counted, never stored.
- **Budget:** each Live connection (resumption reconnects included) is one `canSpend(model, 'voice')` and one
  `ai_usage` row (`purpose: 'voice'`, tokens, connect time, audio seconds); fallback model on refusal or failure.
- **Resilience:** `goAway` or an unexpected Gemini close → one reconnect with the resumption handle (or a fresh
  prompt from the stored turns) while ≤ 2 s of browser audio is buffered; the browser reconnects once after an
  abnormal close (same conversation). Shutdown ends every session (`closed server_shutdown`) before the HTTP server.
- **Mock (`ai/mockLive.js`):** the same Live messages from typed text: scripted flows over the real tools,
  captions in chunks and a soft 220 Hz tone as speech; audio input is ignored.

## 6. Planning, cost and KPI engines (phase 5–6, in progress)

Built as in the plan; the `engines/`, `kpis/` and `jobs/` folders are being filled now.

- **Capacity calendar** (`engines/capacity.js`): per machine, shift intervals minus breaks (overnight-shift
  fix: a break earlier than its shift start belongs to the next day) on running days, minus holidays, minus
  bookings (job cards, WO planned windows); efficiency = availability × performance over 14 days (default
  0.85). Tools have calendars too.
- **Production planner (F1)** (`engines/productionPlanner.js`): tools whose mould parts make the part →
  shots = ⌈qty ÷ (parts per shot × (1 − reject rate))⌉ → one job card per tool on the machine with the
  earliest finish (setup time on mould change), quantity split by rate (water-filling) → feasibility vs the
  due date, risks (PMs due, open anomalies). Greedy, marked `ponytail:`; upgrade path CP-SAT.
- **Maintenance planner (F2)** (`engines/maintenancePlanner.js`): due PMs/calibrations, open WOs, anomaly
  tasks (deadline = urgency) → zero-impact window first; otherwise push options: insert the block and
  re-run the forward scheduler (later job cards shift, delays reported), move the rest of the job card to
  another machine, or defer with the risk stated. Least lateness wins; the AI explains.
- **Proposals:** a run stores `planproposals {ops[], diff, scheduleVersion, expiresAt}`; apply only if
  `scheduleVersion` is unchanged (else re-plan) and replays `ops` through `records.js` with `proposalId` +
  `seq` under a unique partial index, so a double confirm or a resumed apply is idempotent (no Mongo
  transactions needed).
- **Costs (F5)** (`engines/costs.js`): energy = kWh × the day's tariff; spares = used transactions × lot
  cost; consumables; labour = time in progress × people × rate; downtime = clipped hours × asset rate.
  `costWatch` every 15 min compares period-to-date values with each `costalerts` rule, at most one breach per
  period, with an AI note and a notification.
- **KPI runner (F6)** (`kpis/runner.js`): a KPI is 1–4 read-tool sources (allow-listed, args re-validated
  with zod, run in the **viewer's** context, time range re-resolved on every run) plus an optional formula
  through the safe parser `lib/expr.js`; any chart type (number, gauge, line … heatmap, table). KPIs are
  created only from chat, with a live preview on the Confirm card.

## 7. Tenancy and security

- **Tenancy:** every tenant document carries `companyId`; plant-scoped ones carry `plantId`. `records.js`
  injects both, and a non-owner with a `plantId` is locked to that plant. Agent queries go through the same
  scope (validators re-inject the tenant into filters, pipelines and `$lookup`s); Flux is limited to the
  company's own bucket and `companyId` tag; the KPI runner uses the viewer's context. Tests assert that
  company A sees nothing of company B through any read tool, ref or `$lookup`.
- **Roles:** superAdmin (platform tenant; AI and Platform tabs), owner and admin (full), technician
  (`permissions[module][action]`), view (read-only; every write refused, chat writes included). Only a
  superAdmin can grant superAdmin.
- **Auth:** HS256 JWT carrying a session id; every request checks the session in Mongo (revocable, TTL
  `SESSION_TTL_HOURS`) and that the user is not deleted; SSE streams re-check every 60 s. bcrypt passwords.
  Rate limits on login (per IP) and chat messages (per user). helmet, CORS allow-list, `trust proxy 1`
  behind nginx, 2 MB body limit.
- **AI safety:** the model only sees redacted, scoped tool output; every write needs a human Confirm that
  re-checks permissions; tool calls are audited (`ai_tool_audit`, args redacted); the API key never leaves
  the server (the AI tab shows only "configured" or "missing"); platform collections and `simevents` are
  never reachable from tools.
- **Secrets:** one `.env` (never in images: `.dockerignore`), `.env.example` documents every variable.
- **Simulator trust:** it holds database credentials and writes directly, so it is trusted infrastructure,
  like a SCADA gateway. For anything beyond a demo LAN, enable MongoDB auth with a user limited to the
  `sara` database, give the simulator an InfluxDB token scoped to its org instead of the all-access one, and
  do not publish 27017/8086 to untrusted networks (compose publishes them so a Pi on the LAN can reach them).

## 8. Deployment

| What | How |
|---|---|
| Dev | `docker compose -f docker-compose.dev.yml up -d` (mongo + influxdb) or the hosted MongoDB/InfluxDB, `pnpm seed`, simulator `npm start`, `pnpm dev` (server :5080 with `--watch`, Vite :5173); step by step in `README.md` |
| SARA server (GCP Ubuntu VM) | `deploy/install-ubuntu.sh` (Docker, boot start, swap), then `docker compose --profile tls up -d --build` in `sara/` → `caddy` (80/443, automatic certificate for `DOMAIN`) → `client` (nginx, proxies `/api`) → `server` (internal :5080); both read the hosted databases from `.env`; no database container; HTTPS is required for the voice assistant's microphone |
| Simulator server (GCP Ubuntu VM) | `deploy/install-ubuntu.sh`, then `docker compose up -d --build` in `sara-simulator/` on another VM (or `deploy/install-pi.sh` on a Pi); same `MONGO_URI`/`INFLUX_*`, control panel on `SIM_UI_PORT`, firewall limited to the operator's IP |
| Server image | `server/Dockerfile`: multi-stage, pnpm `--prod --filter @sara/server`, `node:26-slim`, user `node`, HEALTHCHECK on `/api/health` (200 while Mongo is up) |
| Client image | `client/Dockerfile`: Vite build, `nginx:1.29-alpine`, SPA fallback, `/api` proxy, SSE unbuffered |
| Raspberry Pi | `sara-simulator/deploy/install-pi.sh` → Node 22, user `sara`, `/opt/sara-simulator`, systemd unit (`Restart=always`); or the multi-arch `node:22-slim` image |
| CI | `sara/.github/workflows/ci.yml`: Mongo + InfluxDB services, biome, server tests (mocked AI), client build + tests, image builds. `sara-simulator/.github/workflows/ci.yml`: Node 22 and 26, Mongo + InfluxDB, `npm test`, arm64 + amd64 image |

InfluxDB is set up on the first start of an empty volume from `INFLUX_ORG`, `INFLUX_TOKEN`,
`INFLUX_ADMIN_USER` and `INFLUX_ADMIN_PASSWORD`. Atlas and InfluxDB Cloud work by changing the URLs.

## 9. Scaling out (the `ponytail:` notes)

SARA deliberately runs as **one server process**. These in-memory singletons are marked `ponytail:` in the
code and are what has to change before running several instances:

| Singleton | Where | Scale-out replacement |
|---|---|---|
| Event bus (live events) | `lib/events.js` | Redis pub/sub (or Mongo change streams) so every instance's SSE clients get every event |
| Live pollers, one per company per process | `telemetry/livePoller.js` | One elected publisher per company (Redis lock) feeding the shared bus |
| Anomaly watch scheduler + per-company in-flight map | `ai/anomaly/watch.js` | A job lock per company (Redis `SET NX PX`, or a Mongo lease document) so only one instance scans |
| costWatch, KPI insights, briefing jobs | `jobs/` (phase 5–6) | Same job locks |
| AI budget RPM buckets and day counters | `ai/budget.js` | Atomic Redis counters (or Mongo `$inc`) shared by all instances; otherwise each instance spends the quota |
| Chat stop map | `agent/loop.js` | Redis pub/sub stop signal to the instance running the turn |
| Rate-limit buckets | `express-rate-limit` memory store | Redis store |
| Spare-part decrement without a transaction | `modules/actions/inventory.js` | A guarded update already prevents negative stock; add a transaction if exact ledgers matter |

Pending chat actions, sessions, counters, plan proposals and AI usage are already in MongoDB, and plan
apply is idempotent, so they need no change. The planners are greedy heuristics (upgrade: CP-SAT), and
features scale shift counts linearly (upgrade: read shots from InfluxDB). The simulator is one process per
company by design (one company only); it scales by running another instance with another `COMPANY_SLUG`.
