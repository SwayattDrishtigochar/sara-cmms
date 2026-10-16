# SARA

SARA is an AI-first CMMS (computerised maintenance management system) built for a hackathon. It covers
maintenance, inventory and partners, production, bins, rules and reports, and most of the work is done by AI:

- a chat agent that reads, plans and changes records, with a Confirm card before every write;
- AI production planning and maintenance planning that shows what it does to production;
- AI anomaly detection on live machine telemetry that names the parameter that is wrong;
- costs and cost alerts, KPI cards of any chart type, and a daily briefing, all produced or explained by the AI.

Deterministic code computes the numbers (statistics, capacity, schedules, costs). Gemini makes the judgement
calls, picks between options and explains. Every AI output shows its model and time, and can be regenerated.

The plant comes from a separate repo, [`../sara-simulator`](../sara-simulator/README.md). It seeds one company
("Acme Components": 20 machines, 28 people) once, then keeps the machines streaming and the people working.
SARA itself does not know the data is simulated.

```
sara/
  server/   Express 5 API on :5080 (MongoDB + InfluxDB + Gemini), seed / validate-db / eval scripts
  client/   React 19 + Vite on :5173 (proxies /api to :5080)
  docs/     system design, module contracts, demo script
```

## Architecture

```
 sara-simulator (laptop or Raspberry Pi)          SARA server (Node, Express 5)            Browser (React 19)
 ┌──────────────────────────────┐                ┌──────────────────────────────────┐     ┌──────────────────────┐
 │ seed once (simstate marker)  │                │ auth (JWT + sessions), records.js│◄───►│ Command Center       │
 │ 20 machines: physics +       │── telemetry ─┐ │ live poller 3 s → event bus ─────┼─SSE─► Machines, Machine 360│
 │   injected faults            │              │ │ engines: capacity, planners,     │REST │ Anomalies, Planner   │
 │ 28 people: WOs, job cards,   │── records ─┐ │ │   costs, KPI runner              │     │ Costs, KPI Builder   │
 │   requests, PMs, stock       │            │ │ │ AI: anomaly watch, investigations│     │ Chat, module pages   │
 │ control loop 3 s ◄───────────┼─ control ─┐│ │ │   chat agent, briefing, insights │     │ Superadmin: AI, Sim  │
 └──────────────────────────────┘           ││ │ │   budget ledger                  │     └──────────────────────┘
                                            ▼▼ ▼ └───────┬─────────────┬────────────┘
                              MongoDB 8 (db "sara")  InfluxDB 2.7          │
                              records, sim control,  bucket per company ◄──┘ reads both
                              AI state, sessions     (id of the company)   └──► Google Gemini (or the mock)
```

- The simulator writes MongoDB and InfluxDB directly, like a SCADA gateway. Superadmin controls it through
  MongoDB documents (`simcontrol`, `simevents`), so it needs no inbound connection.
- One server process: the event bus, schedulers, budget counters and rate limits live in memory and are
  marked `ponytail:` in the code. Scaling out needs Redis (see [system design §9](docs/system-design.md)).

Details: [docs/system-design.md](docs/system-design.md), the simulator contract
[docs/simulator-v2.md](docs/simulator-v2.md) and the module contracts in `docs/phase*-contracts.md`.

## Setup (about 10 minutes)

**You need:** Node.js 22 or newer, pnpm (`corepack enable`; the version is pinned in `package.json`), and MongoDB 8
plus InfluxDB 2.x, either from the bundled `docker compose` (Docker Desktop) or a server you already have. A Gemini
API key is optional: with `AI_MOCK=true` every AI feature runs on the scripted mock and nothing is spent.

Run the steps in this order: the simulator needs the database, and SARA needs the simulator's company.

```sh
# 1. Install
git clone <repo-url> sara && cd sara
pnpm install
cp .env.example .env            # Windows: copy .env.example .env
# In .env: set JWT_SECRET, SUPERADMIN_PASSWORD, and either GEMINI_API_KEY=<your key> or AI_MOCK=true

# 2. Databases: pick one
docker compose up -d            # a) local MongoDB :27017 + InfluxDB :8086 (the defaults in .env work)
                                # b) remote: set MONGO_URI and INFLUX_* in .env (see below)

# 3. Platform tenant + superadmin
pnpm seed

# 4. Simulator: seeds Acme Components on its first run, then keeps it live
cd ../sara-simulator && npm ci && cp .env.example .env   # same MONGO_URI and INFLUX_* as sara/.env
npm start                       # leave it running (first run: about 1-2 min of telemetry backfill)

# 5. SARA (new terminal, in sara/)
pnpm dev                        # API http://localhost:5080, web app http://localhost:5173
```

Do **not** run `pnpm seed --demo` against a database the simulator uses. `--demo` generates its own
"Acme Components" with the simulator's ids and emails, and the simulator then refuses to seed (it reports a
half-seeded company). `--demo` is only for working without the simulator.

### Remote MongoDB / InfluxDB

- `MONGO_URI` must name the database: `mongodb://<host>:27017/sara`. Replica sets and Atlas work too, e.g.
  `mongodb://<host>:27017/sara?replicaSet=rs0` or `mongodb+srv://…/sara`. The simulator's `MONGO_URI` must be
  the same URI.
- `INFLUX_URL`, `INFLUX_ORG` and `INFLUX_TOKEN` must match the simulator's `.env`. The simulator writes one bucket
  per company (named by the company id) and SARA reads it. The token needs read and write access and the right to
  create buckets (tests also create and delete throwaway buckets).
- On a shared server, touch only your own database and bucket. The database server's clock is the one that
  counts: the simulator stamps data with MongoDB's time.

### Signing in

| Who | Email | Password |
|---|---|---|
| Superadmin (platform, AI and Simulation tabs) | `SUPERADMIN_EMAIL` (`superadmin@swayatt.com`) | `SUPERADMIN_PASSWORD` from `.env` |
| Owner (company-wide) | `owner_1@swayatt.com` | `Sara@12345` |
| Admins | `plant_manager_1`, `maintenance_manager_1`, `production_manager_1` `@swayatt.com` | `Sara@12345` |
| Technicians (23) | e.g. `maintenance_technician_1`, `production_supervisor_1`, `store_keeper_1` `@swayatt.com` | `Sara@12345` |
| Viewer (read-only) | `viewer_1@swayatt.com` | `Sara@12345` |

The domain is the simulator's `COMPANY_DOMAIN`, the password its `SIM_USER_PASSWORD`. `SIM_DEFAULT_PASSWORD` in
`sara/.env` must equal it, because SARA shows that value on the demo login page (`DEMO_MODE=true`) and in
Superadmin → Simulation → Credentials, which lists every account.

## AI: mock or Gemini

| Setting | What happens |
|---|---|
| `AI_MOCK=true`, or `GEMINI_API_KEY` empty | Deterministic mock, **0 Gemini calls**. The engines still run on the real data. Anomaly scans flag \|z\| ≥ 3 on two fields (≥ 5 on one), flatlines, idle power and rejects from the real features; plans, costs, KPIs and briefings use real numbers with scripted wording. Chat drives the real tools for the demo flows it lists when you say "hi". Provenance reads "<model> (mock)". |
| `AI_MOCK=false` and a key | Real Gemini. Chat and the background jobs (anomaly scans, investigations, cost texts, KPI insights, briefings) spend quota. `AI_CHAT_RESERVE_PCT` keeps part of each model's daily quota for chat, and the background tier never falls back into the chat models. Free-tier quotas are small: use a billing-enabled key for a demo. Models, thinking levels and budgets: Superadmin → AI. |

Restart the server after changing `AI_MOCK` (`.env` is outside `src`, so `--watch` does not reload it). Tests
and `pnpm eval` always force the mock.

## Demo

The timed, click-by-click 10-minute script is [docs/demo-script.md](docs/demo-script.md): Simulation and AI tabs,
inject overheating on CNC 2, the Command Center briefing, Machine 360, the AI flags `spindleTemp`, create the
work order from the anomaly, a simulated technician repairs it, the anomaly resolves, and the viewer is
read-only. It was rehearsed live with `AI_MOCK=true`.

**Before the demo:** simulator online (Superadmin → Simulation), Activity speed back to a normal value after any
fast-forward (high speeds compress work order durations, which skews MTTR, labour cost and planning history),
**Clear all** active injections, and press **Regenerate** on the briefing. Shifts run Monday to Saturday; on
Sunday or outside shifts the machines are OFF.

**More to show from Chat** (these prompts also work in mock mode; say "hi" for the list):

| Feature | Prompt (sign in as `plant_manager_1` or `owner_1`) | What happens |
|---|---|---|
| F1 production plan | "Plan 5000 Housing-A by 25 Oct" | Job cards across the three Housing-A moulds with slack and risks → Confirm → they appear on the Planner Gantt |
| F2 maintenance plan | "Plan maintenance for Press 1" (or **Plan maintenance** on an anomaly) | A zero-impact window, or insert / move / defer options with the production delay of each → Confirm → the work order gets its window |
| F4 CRUD | "Set Press 1 criticality to High", "Create a work order for a coolant leak on CNC 3", "Mark WO-12 in progress" | Confirm card with the change, then the record updates |
| F5 cost alert | "Alert me if Compressor 2 energy cost is above ₹3000 a day" | Confirm → Costs → **Check now**; a breach notifies and shows in the alert's history |
| F5 cost question | "Maintenance cost by asset this month" | Table and stacked bar of spares, consumables and labour |
| F6 KPI | "Build a heatmap of compressor energy by hour" | Live preview → Confirm → a card on the KPI Builder, with an AI insight |
| Permissions | as `viewer_1`, ask to plan production or create a work order | Refused: write tools are not available to the view role |

## Adding a module or a tool

**A module** (a collection with REST, a generic list / record / form page, and agent read and write access) is one
definition object. Add it to a file in `server/src/modules/defs/` (or a new file spread into `defs/index.js`):

```js
{
  name: 'toolcribs',            // collection and URL: /api/m/toolcribs, /m/toolcribs
  model: 'ToolCrib',
  label: 'Tool Cribs',
  group: 'Inventory',           // sidebar group
  icon: 'Boxes',                // lucide icon, mapped in client/src/lib/icons.js
  description: 'Where shared tools are kept.',  // the agent reads this and agentNotes
  plantScoped: true,            // records carry plantId; plant-locked users see only their plant
  list: ['name', 'location'],
  search: ['name'],
  fields: {
    name: { type: 'string', required: true, max: 80 },
    location: { type: 'string' },
  },
}
```

The registry builds the Mongoose model, the zod create and update schemas, tenancy (`companyId`, `plantId`),
soft delete, counters (`counter: { type, prefix, field }`) and permissions (`permissionKey`) from it. The client
renders the pages from `/api/modules` metadata, and the agent's `module_schema`, `mongo_*` and
`create_record` / `update_record` / `delete_record` tools pick it up. Custom behaviour on status changes goes in
`server/src/modules/actions/`. Run `pnpm validate-db` afterwards; seed data belongs in the simulator.

**A chat tool** is `{ name, group, description, schema, permission?, requiresConfirmation?, preview?, run }`:

- `schema` is a zod object; `run(ctx, args)` must read and write through `records.*` or `scopeFilter(ctx, mod)`,
  so tenancy and the plant lock apply.
- A write sets `requiresConfirmation: true` and a `preview` (a dry run). The user then sees a Confirm card, and
  the server re-checks permissions on Confirm.
- Add it to an existing group, or add a group: one line in `GROUP_HELP` (`server/src/agent/tools/load.js`) and its
  array spread into `server/src/agent/tools/registry.js` (which rejects duplicate names and unknown groups).
- If the demo needs it under `AI_MOCK=true`, add a flow to `server/src/ai/mockChat.js`, plus an eval case in
  `server/scripts/eval.js`.

## Security model

- **Tenancy:** every tenant document has `companyId`, plant-scoped ones `plantId`. `records.js` merges the scope
  filter last, so a caller cannot widen it; non-owners with a plant are locked to it. Agent filters, pipelines and
  `$lookup`s are validated and re-scoped, Flux is limited to the company's bucket, and the KPI runner runs as the
  viewer. Platform collections and the simulator's ground truth (`simevents`) are never reachable from tools.
- **Roles:** superAdmin (platform: AI and Simulation tabs), owner and admin (full), technician (per-module
  permissions), view (read-only; every write refused, chat writes included, with 403).
- **Auth:** HS256 JWT carrying a session id; each request checks the session in MongoDB (revocable, TTL
  `SESSION_TTL_HOURS`); SSE streams re-check every 60 s; bcrypt passwords; rate limits on login (per IP) and chat
  messages (per user); helmet, a CORS allow-list and a 2 MB body limit.
- **AI safety:** the model sees only scoped, redacted tool output (secret fields are stripped); every write needs a
  human Confirm that re-checks permissions; tool calls are audited (`ai_tool_audit`); the Gemini key never leaves
  the server (the AI tab shows only configured or missing). A budget ledger caps daily use per model.
- **Secrets:** one `.env` per repo, never committed or baked into images (`.dockerignore`). The simulator never
  prints its URI, token or password in errors.
- **Simulator trust:** it holds database credentials, so treat it as trusted infrastructure. Beyond a demo LAN,
  use a MongoDB user limited to the `sara` database, an InfluxDB token scoped to its org, and do not expose
  27017 / 8086 to untrusted networks.

## Requirement checklist

Status as of 16 Oct 2026 (21:00 IST). Every live check ran with `AI_MOCK=true`: no real Gemini call was made in
these checks, so the Gemini path is covered by the mocked unit tests and the eval, not by a live run.

| # | Requirement | Status | Notes |
|---|---|---|---|
| F1 | AI production planning: target qty + due date → job cards on every capable machine | Done | Capacity calendar (shifts, breaks, holidays, setup, one mould per machine) and a greedy planner; Planner page and chat; proposals apply idempotently with stale-plan detection. Applied live (5,000 × Housing-A). A plan made from chat has no AI explanation until you ask. |
| F2 | AI maintenance planning that avoids production or shows the push | Done | Zero-impact window first, else insert / move to another machine / defer, each with its delay and late jobs; the AI recommends one. Multi-task plans re-plan around each option. The Planner and the Confirm card also draw the moved job card on the other machine. |
| F3 | Gemini anomaly detection that names the wrong parameter | Done | Features (z-scores against each machine's 7-day history per status, flatlines, idle power, rejects) screen all 20 machines every minute; only machines with new evidence go to the model in one batched call; investigation with root cause and a suggested work order. Rehearsal: detected in 11.5 min with a server restarting every minute (1–2 min expected when stable; **Re-scan** forces a scan). The mock judge was slow or missed some injections (sudden breakdown, early bearing wear). |
| F4 | CRUD from chat with confirmation | Done | Create (1–20 records), update, delete, work order status and comments on every module, all through Confirm cards; viewer refused. |
| F5 | Cost management and alerts from chat | Done | Energy (tariffs), spares, consumables, labour and downtime by asset / plant / day; Costs page with an AI overview; alerts created from chat, checked every 15 min (first round 15 min after start; **Check now** runs it at once). |
| F6 | KPI / visual-metric builder from chat, any chart type | Done | 15 chart types (number, gauge, line, area, bar, stacked bar, combo, pie, scatter, radar, funnel, treemap, heatmap, timeline, table); created and changed from chat with a live preview; pinned cards on the Command Center. |
| F7 | Separate simulator repo, one company seeded once, realistic people and machines, controlled from superadmin, Pi ready | Done | See the 9 points below. Pi packaging (`deploy/install-pi.sh`, systemd unit, arm64 image) exists; it was not run on a physical Pi in this build. |
| F8 | Superadmin anomaly triggers change the data and Gemini detects them | Done | Anomaly lab: 10 scenarios × severity × ramp / hold per machine; the AI never sees the ground truth; a completed repair work order clears the fault; detection time and outcome shown per injection. |
| F9 | Every KPI, metric and insight produced or explained by the AI | Done | Briefing, KPI insights, cost overviews, planning explanations, anomaly texts and health scores, each with provenance and Regenerate. Under the mock they are scripted text over real numbers. |
| — | Maintenance core: assets, work orders, PMs, calibrations, requests | Done | Generic pages, status actions, PM / calibration dates updated on completion. |
| — | Inventory & partners: spare parts, stock, transactions, consumables, vendors, suppliers | Done | Stock decrements guarded against going negative. |
| — | Production: tools, customers, plans, job cards, rejections, downtimes, part counts | Done | Live from the simulator. |
| — | Bins: bins, bin sessions, station pools | Partial | Records, pages and seeded data; the live RFID bin flow is not built and the simulator does not move bins. |
| — | Rules & reports: tags, workflow rules, scheduled reports | Partial | Records and pages; rules do not fire live and scheduled reports are not sent (skipped on purpose). |
| — | Superadmin with AI and Simulation tabs | Done | Models per tier, quotas and background AI settings; simulator status, controls, anomaly lab, activity feed, credentials. |

**The 9 simulator points** (from [docs/simulator-v2.md](docs/simulator-v2.md)):

| # | Point | Status |
|---|---|---|
| 1 | Has the MongoDB and InfluxDB URLs and writes both directly | Done |
| 2 | First run creates one company, 20 assets and data for every module | Done (`pnpm validate-db` reports no schema errors) |
| 3 | Automates people's work: work orders, job cards, requests, PMs, stock, attendance | Done |
| 4 | Streams telemetry for all 20 machines of different types | Done (IMM, press, CNC, compressor, chiller, furnace, energy meter); a restart or outage gap of up to 6 h is backfilled |
| 5 | 1 owner, 3 admins, 20+ technicians in Maintenance and Production | Done (23 technicians, 1 viewer, 28 accounts) |
| 6 | Superadmin anomaly triggers per asset and type change the data | Done |
| 7 | One company only, seeded once, never duplicated on restart | Done (`simstate` marker; later seed steps run once by `seedVersion`) |
| 8 | `.env.example` documents every setting | Done |
| 9 | Behaves like real humans: shifts, delays, durations, comments, pauses, mistakes | Done; repair comments and resolutions follow the work order's own problem |

**Skipped on purpose:** signup, password reset and billing; file uploads; email / push delivery (notifications are
in-app); Gantt drag and drop (the AI moves work); PM auto-generation and live rule firing; multiple server
processes (see the `ponytail:` notes).

## Tests and checks

```sh
pnpm lint                                                      # Biome
cd server && SARA_TEST_DB=my_unique_label npx vitest run      # server tests (mocked AI)
cd client && npx vitest run                                    # client tests
pnpm eval                                                      # scripted agent conversations (mock)
pnpm validate-db                                               # checks the simulated company against the module schemas
cd ../sara-simulator && npm test                               # simulator tests (local MongoDB / InfluxDB)
```

Server tests create and drop `<SARA_TEST_DB>_<n>` databases (default `sara_test_<n>`) on `MONGO_TEST_URI`; the
database path in that URI is ignored and `?options` are kept. On a shared or remote server always set
`SARA_TEST_DB` to a unique label that cannot match a database already on the server (never `sara`, `test`, `admin`,
`local`, `config`). `pnpm eval` drops and reseeds `sara_eval` (or `SARA_EVAL_DB`) the same way.

## Docker

```sh
docker compose up -d                                          # databases only
docker compose --profile app up -d --build                    # + server :5080 and web app http://localhost:8080
docker compose --profile sim up -d --build                    # + ../sara-simulator
docker compose --profile app --profile sim up -d --build      # everything
```

Compose reads `./.env`. Its `server` and `simulator` services point at the compose databases.

## Troubleshooting

- Server exits with `MONGO_URI is required` or another config error: `.env` is missing or a value is invalid;
  see `.env.example`.
- Empty machine charts or zero energy costs: InfluxDB has no data for the company. Check that `INFLUX_*` match
  the simulator's and that the simulator is online.
- "Request failed (502)": the API is restarting; retry after a few seconds.
- No anomaly after an injection: wait for the ramp, or press **Re-scan** on the Machine 360 health card.
- Port 5080 in use: change `PORT` (5055 is taken by Docker Desktop on some machines).
- Simulator problems: [sara-simulator troubleshooting](../sara-simulator/README.md#troubleshooting).
