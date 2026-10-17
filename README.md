# SARA

SARA is an AI-first CMMS (computerised maintenance management system) built for a hackathon. It covers
maintenance, inventory and partners, production, bins, rules and reports, and most of the work is done by AI:

- a chat agent that reads, plans and changes records, with a Confirm card before every write;
- a Planner where SARA builds a whole production plan (machines, windows, quantities, operators per shift) or a
  whole maintenance plan (work orders, windows, technicians, production impact and downtime cost) that you can
  edit and check before anything is booked;
- AI anomaly detection on live machine telemetry that names the parameter that is wrong, and opens a work order
  with a technician on shift by itself when the anomaly persists;
- costs and cost alerts, KPI cards of any chart type, and a daily briefing, all produced or explained by the AI;
- a voice assistant: talk to SARA in your own language and she answers aloud in a female voice (Gemini Live),
  with the same tools, permissions and Confirm cards as chat.

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
 │ control loop 3 s ◄───────────┼─ control ─┐│ │ │   chat agent, briefing, insights │     │ Superadmin: AI, Plat.│
 └──────────────────────────────┘           ││ │ │   budget ledger                  │     └──────────────────────┘
                                            ▼▼ ▼ └───────┬─────────────┬────────────┘
                              MongoDB 8 (db "sara")  InfluxDB 2.7          │
                              records, sim control,  bucket per company ◄──┘ reads both
                              AI state, sessions     (id of the company)   └──► Google Gemini (or the mock)
```

- The simulator writes MongoDB and InfluxDB directly, like a SCADA gateway, and has its own control panel
  (port 5090, `sara-simulator/ui`): SARA contains nothing simulator-specific and reads like a real platform.
- Voice: the browser streams microphone audio over one WebSocket (`/api/voice`) to the server, which holds one
  Gemini Live connection per session and runs the tools itself; the Gemini key never reaches the browser.
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

`pnpm seed` creates only the platform tenant and the superadmin; every customer company comes from the
simulator (tests seed their own companies through `server/test/helpers/fixtures.js`).

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
| Superadmin (platform: AI and Platform tabs) | `SUPERADMIN_EMAIL` (`superadmin@swayatt.com`) | `SUPERADMIN_PASSWORD` from `.env` |
| Owner (company-wide) | `owner_1@swayatt.com` | `Sara@12345` |
| Admins | `plant_manager_1`, `maintenance_manager_1`, `production_manager_1` `@swayatt.com` | `Sara@12345` |
| Technicians (23) | e.g. `maintenance_technician_1`, `production_supervisor_1`, `store_keeper_1` `@swayatt.com` | `Sara@12345` |
| Viewer (read-only) | `viewer_1@swayatt.com` | `Sara@12345` |

The domain is the simulator's `COMPANY_DOMAIN`, the password its `SIM_USER_PASSWORD`. The simulator's control
panel (port 5090, `SIM_UI_PASSWORD`) lists every account; SARA itself never shows passwords.

### Simulator control panel

The plant's controls live in the simulator, not in SARA: `http://<simulator host>:5090` (`SIM_UI_PORT`), signed in
with the `SIM_UI_PASSWORD` from `sara-simulator/.env` (8+ characters; empty = panel off, `SIM_UI_PORT=0` = off). It
shows the simulator's heartbeat, the company with its **Credentials**, **Controls** (running, reading cadence,
simulated people, activity speed, backfill), the **Anomaly lab** (machine, scenario, severity, ramp, hold → Inject;
Clear; each injection's outcome and whether and how fast SARA detected it) and the live activity feed.

- **Laptop:** `npm start` in `sara-simulator`; the panel is served by the same process (prebuilt in `ui/dist`).
- **Raspberry Pi:** `sudo bash deploy/install-pi.sh`, then fill `MONGO_URI`, `INFLUX_*` and `SIM_UI_PASSWORD` in
  `/opt/sara-simulator/.env` and `sudo systemctl restart sara-simulator`; the script prints the panel URL.
- **Docker:** `docker compose --profile sim up -d --build` here (publishes 5090; the simulator's own `.env` supplies
  `SIM_UI_PASSWORD`), or `docker run … -p 5090:5090` in the simulator repo.

Details: [sara-simulator README](../sara-simulator/README.md#control-panel).

## AI: mock or Gemini

| Setting | What happens |
|---|---|
| `AI_MOCK=true`, or `GEMINI_API_KEY` empty | Deterministic mock, **0 Gemini calls**. The engines still run on the real data. Anomaly scans flag \|z\| ≥ 3 on two fields (≥ 5 on one), flatlines, idle power and rejects from the real features; plans, costs, KPIs and briefings use real numbers with scripted wording. Chat drives the real tools for the demo flows it lists when you say "hi". Provenance reads "<model> (mock)". Voice runs on a scripted Live mock: it does not hear the microphone, answers typed text and **Say something**, and plays a soft tone instead of speech, over the real tools. |
| `AI_MOCK=false` and a key | Real Gemini. Chat and the background jobs (anomaly scans, investigations, cost texts, KPI insights, briefings) spend quota. `AI_CHAT_RESERVE_PCT` keeps part of each model's daily quota for chat, and the background tier never falls back into the chat models. Free-tier quotas are small: use a billing-enabled key for a demo. Models, thinking levels and budgets: Superadmin → AI. Each voice session opens one Gemini Live connection (one request of the voice model's quota, more on a reconnect). |

Restart the server after changing `AI_MOCK` (`.env` is outside `src`, so `--watch` does not reload it). Tests
and `pnpm eval` always force the mock.

## Superadmin

`superadmin@swayatt.com` sees two tabs:

- **AI**: models per tier (Router, Fast, Balanced, Deep, Background) with thinking level, fallback and **Test**;
  quotas and usage today, the chat reserve; Background AI: scan interval, calm-machine interval, investigations,
  cost watch, and **Open a work order automatically** with **After consecutive scans** (1–10, default 2) and
  **Minimum severity** (Warning or Critical, default Warning); **Voice**: on/off, Live model and fallback, default
  voice and language, session length and concurrent sessions. The Gemini key shows only as configured or missing.
- **Platform**: every customer company with its plants, users and machines (read-only).

## Voice assistant

Talk to SARA with the **mic button** in the header, **Ctrl Shift Space** (⌘ Shift Space on a Mac) on any page, or
**Continue by voice** on a chat conversation. She listens and answers aloud in real time, shows captions of both
sides, and puts tables, charts and KPI tiles on screen. Anything chat can do works by voice, with the same
permissions: a change shows the Confirm card and she asks "Shall I go ahead?"; say yes ("haan", "go ahead" …) or
tap **Confirm**. Viewers get read-only tools, as in chat. Talk over her to interrupt; **Stop** does the same.

- **Voice and language:** female voices only (Kore by default; 14 to choose from in the panel). Language **Auto**
  answers in the language you speak, Hinglish included; the panel's language chip can fix one language.
- **Limits:** 10-minute sessions, 3 at once server-wide, one per user (a new tab takes over), and a session ends after
  90 s of silence. Superadmin → AI → Voice changes the defaults, the models and turns voice off.
- **Browser:** the microphone needs HTTPS or `localhost` (recent Chrome, Edge, Safari or Firefox). A headset avoids
  SARA hearing herself; echo cancellation is on either way. With the microphone blocked, **Use typing instead** keeps
  a typed session.
- **Try it:** "SARA, how many machines are running right now?", "IMM 3 का vibration कैसा है?" (she answers in Hindi),
  "Create a work order for Press 2 hydraulic leak, high priority" (she reads the change and asks "Shall I go ahead?";
  say yes or tap **Confirm**), "Plan 5000 Housing-A parts due next Friday". Script: [docs/demo-script.md](docs/demo-script.md).
- **Mock or real:** with `AI_MOCK=true` (the dev default) voice costs nothing: a scripted Live mock answers typed
  text and **Say something** over the real tools and plays a soft tone instead of speech. Real listening and her real
  voice need `AI_MOCK=false`, a valid Gemini key with credits, and an API restart. The key now in `.env` answers 401
  "API key not valid": replace it first.
- **Privacy:** audio is never stored. Transcripts are saved as a chat conversation with a mic badge, so Chat can
  continue it by text.
- **Under the hood:** browser ⇄ `wss://<host>/api/voice` ⇄ SARA server ⇄ Gemini Live (`docs/system-design.md` §5.7).
  Live models must support `bidiGenerateContent`; Superadmin → AI → Voice lists the ones your key can use. Behind
  nginx, `client/nginx.conf` forwards the WebSocket upgrade; the browser's origin must be in `CLIENT_URL`.

## Planner

`/planner` has two tabs. Nothing is booked until you press **Create plan**; until then SARA keeps a draft
(`PLN-n`) that you can edit, check, regenerate or discard. Drafts are listed under **Suggested plans** (discarded
and expired ones behind **Show discarded**), created plans under Production Plans / Maintenance Plans.

**Production.** Pick a part (its moulds and capable machines are listed), the quantity, the due date and
optionally a customer → **Plan with SARA**. SARA picks the machine for each job card from the moulds that make the
part and the machines' free time (shifts, breaks, holidays, changeovers, one mould per machine), the window, the
quantity per card and an operator for every shift of the window (moulding operators on IMMs, press operators on
presses, CNC operators on CNCs, nobody booked twice). The result shows a verdict (**Doable**, **Needs
adjustment**, **Not doable**), the job card table, a Gantt and SARA's summary.

**Maintenance.** Scope **Whole plant** or **Selected machines**, a start date and 1–30 days, an objective slider
from **Protect production** to **Fix fast**, optionally **Allow Sundays and holidays** → **Plan with SARA**. SARA
gathers the PMs, calibrations, open anomalies and open work orders due in that horizon, puts each task in the
window that costs least for the objective (a zero-impact window first; otherwise it pushes job cards and says by
how much, priced at each machine's downtime cost per hour), and picks a technician on shift whose skills fit the
task (electrical, hydraulic, mechanical, utilities, calibration). Tiles show the production impact in hours and
₹, the **Downtime cost avoided** against doing everything at once, and the zero-impact tasks.

**Edit → Check → Create.** Change any row (machine, start, end, quantity, operators; or a task's window, duration
and technician; the people pickers mark who is free, who fits and who is busy with what) and press **Check plan**.
SARA re-checks overlaps, moulds, working time, run time, due date, quantity, staffing and skills, and lists the
issues with suggestions; **Apply suggestion** patches the rows and checks again. **Create plan** is enabled once the
plan is checked and not "Not doable"; it creates the production plan (`PP-n`) with its job cards, or the
maintenance plan (`MP-n`) with its work orders, and opens the record. If the schedule moved in the meantime, the
updated plan is shown instead of booking a stale one. The same flow works from chat: `plan_production` /
`plan_maintenance` → `check_plan` → `apply_plan` with a Confirm card.

**Related records.** Every record page lists its linked records in tabs with counts (an asset's work orders, job
cards, anomalies, PMs and calibrations; a user's work orders and job cards; a customer's plans; an anomaly's work
order), with **Add** prefilled with the parent. A production plan shows its job cards as a chain per machine
(`JC-19 → JC-22`, with windows, targets and operators), a compact Gantt and planned vs ordered quantity; a
maintenance plan shows its work orders with technicians and its impact tiles.

## Automatic work orders

The anomaly watch screens every machine's telemetry each minute; machines with new evidence go to Gemini, which
judges them and writes SARA's insight (parameter, observed vs expected, likely causes, actions). When an anomaly is
reported on **After consecutive scans** scans in a row (a critical one at once) and is at least **Minimum
severity**, SARA opens a work order: title "<type> on <machine> – auto", the insight as description, category
and priority from the anomaly, a deadline from its urgency and a technician on shift with fitting skills. The
maintenance managers, the owner and the technician are notified, and the anomaly shows **"WO-n opened
automatically"**. One fault often raises several anomalies on one machine (bearing wear: vibration, current,
temperature): the later ones join the open work order as a comment instead of opening another. A deviation that
keeps growing (|z| past 5, then 10) is judged again at once instead of waiting for the quiet interval. Turn it off
or tune it on Superadmin → AI.

## Demo

The timed, click-by-click 10-minute script is [docs/demo-script.md](docs/demo-script.md): the simulator's control panel and the AI tab,
inject overheating on CNC 2, the Command Center briefing, Machine 360, the AI flags `spindleTemp`, create the
work order from the anomaly (or SARA opens it by itself), a simulated technician repairs it, the anomaly resolves,
and the viewer is read-only. It was rehearsed live with `AI_MOCK=true`. An optional Planner extension (production
plan with operators, a whole-plant maintenance plan, edit → Check → Create) follows the main script.

**Before the demo:** simulator online (its control panel on port 5090), Activity speed back to a normal value after any
fast-forward (high speeds compress work order durations, which skews MTTR, labour cost and planning history),
**Clear all** active injections, and press **Regenerate** on the briefing. Shifts run Monday to Saturday; on
Sunday or outside shifts the machines are OFF.

**More to show from Chat** (these prompts also work in mock mode; say "hi" for the list):

| Feature | Prompt (sign in as `plant_manager_1` or `owner_1`) | What happens |
|---|---|---|
| F1 production plan | "Plan 5000 Housing-A by 25 Oct" | Job cards across the Housing-A moulds with operators per shift, checked (verdict, issues) → Confirm → `PP-n` with its job card chain |
| F2 maintenance plan | "Maintenance plan for the whole plant next 7 days" or "Plan maintenance for Press 1" | Work orders with windows, technicians, production impact and downtime cost avoided → Confirm → `MP-n` with its work orders |
| F2 single window | "Plan a maintenance window for WO-12" (or **Plan maintenance** on an anomaly) | A zero-impact window, or insert / move / defer options with the production delay of each → Confirm → the work order gets its window |
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
- **Roles:** superAdmin (platform: AI and Platform tabs), owner and admin (full), technician (per-module
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

Status as of 17 Oct 2026. Every live check ran with `AI_MOCK=true`: no real Gemini call was made in these
checks, so the Gemini path is covered by the mocked unit tests and the eval, not by a live run.

| # | Requirement | Status | Notes |
|---|---|---|---|
| F1 | AI production planning: target qty + due date → job cards on every capable machine | Done | Capacity calendar (shifts, breaks, holidays, setup, one mould per machine) and a greedy planner, now with operators per shift and a doability check (phase 7 below). Planner page and chat; proposals apply idempotently with stale-plan detection. |
| F2 | AI maintenance planning that avoids production or shows the push | Done | Zero-impact window first, else insert / move to another machine / defer, each with its delay and late jobs. Whole-plant or per-machine plans with technicians and downtime cost (phase 7 below); there the options are zero-impact / insert / defer (moving a job card to another machine is only offered for a single window). |
| F3 | Gemini anomaly detection that names the wrong parameter | Done | Features (z-scores against each machine's 7-day history per status, flatlines, idle power, rejects) screen all 20 machines every minute; only machines with new evidence go to the model in one batched call; investigation with root cause and a suggested work order. Rehearsal: detected in 11.5 min with a server restarting every minute (1–2 min expected when stable; **Re-scan** forces a scan). The mock judge was slow or missed some injections (sudden breakdown, early bearing wear). |
| F4 | CRUD from chat with confirmation | Done | Create (1–20 records), update, delete, work order status and comments on every module, all through Confirm cards; viewer refused. |
| F5 | Cost management and alerts from chat | Done | Energy (tariffs), spares, consumables, labour and downtime by asset / plant / day; Costs page with an AI overview; alerts created from chat, checked every 15 min (first round 15 min after start; **Check now** runs it at once). |
| F6 | KPI / visual-metric builder from chat, any chart type | Done | 15 chart types (number, gauge, line, area, bar, stacked bar, combo, pie, scatter, radar, funnel, treemap, heatmap, timeline, table); created and changed from chat with a live preview; pinned cards on the Command Center. |
| F7 | Separate simulator repo, one company seeded once, realistic people and machines, controlled from superadmin, Pi ready | Done | See the 9 points below. Controlled from the simulator's own password-protected control panel (port 5090) since phase 7. Pi packaging (`deploy/install-pi.sh`, systemd unit, arm64 image) exists; it was not run on a physical Pi in this build. |
| F8 | Superadmin anomaly triggers change the data and Gemini detects them | Done | Anomaly lab in the control panel: 10 scenarios × severity × ramp / hold per machine; SARA never sees the ground truth; a completed repair work order clears the fault; detection time and outcome shown per injection. |
| F9 | Every KPI, metric and insight produced or explained by the AI | Done | Briefing, KPI insights, cost overviews, planning explanations, anomaly texts and health scores, each with provenance and Regenerate. Under the mock they are scripted text over real numbers. |
| — | Maintenance core: assets, work orders, PMs, calibrations, requests | Done | Generic pages, status actions, PM / calibration dates updated on completion. |
| — | Inventory & partners: spare parts, stock, transactions, consumables, vendors, suppliers | Done | Stock decrements guarded against going negative. |
| — | Production: tools, customers, plans, job cards, rejections, downtimes, part counts | Done | Live from the simulator. |
| — | Bins: bins, bin sessions, station pools | Partial | Records, pages and seeded data; the live RFID bin flow is not built and the simulator does not move bins. |
| — | Rules & reports: tags, workflow rules, scheduled reports | Partial | Records and pages; rules do not fire live and scheduled reports are not sent (skipped on purpose). |
| — | Superadmin with AI and Platform tabs | Done | Models per tier, quotas and background AI settings; read-only list of the companies with their counts. The simulator's status, controls, anomaly lab, activity feed and credentials live in its own control panel (phase 7). |

**The 7 phase-7 points** (asked on 17 Oct 2026; contracts in [docs/phase7-contracts.md](docs/phase7-contracts.md)).
Checked live on the Acme data: PP-12 and PP-13 (one from the Planner, one from chat), MP-1 (three work orders from
a PM) and MP-2 (from chat).

| # | Point | Status | Notes and known limits |
|---|---|---|---|
| 1 | All job cards of a production plan shown inside it, attached to each other | Done | Plan record: chain per machine, compact Gantt, planned vs ordered and produced quantities, verdict and SARA's summary; plus the Related tab. |
| 2 | Maintenance Plan module and Planner tab that joins work orders | Done | Module Maintenance Plans (`MP-n`); its work orders carry the plan; Planner → Maintenance. |
| 3 | Part + quantity → full automatic production plan: machine, duration, quantity, operator per job card | Done | Operators are picked per shift by trade and load. Limit: job cards from the telemetry source book every operator of a trade for their whole multi-day window, so the plan often reports operator-missing warnings or falls back to an operator of another trade. |
| 4 | Automatic maintenance plan (whole plant or chosen machines) with work orders and technicians, low production impact and downtime cost | Done | Objective slider, impact and downtime cost avoided vs doing everything at once. Limits: a task that has to push production keeps its earliest window, so in a thin shift it can get a technician of another trade; whole plans do not move job cards to another machine. |
| 5 | User edits the suggestion; on submit SARA says doable or what to adjust | Done | Check plan → verdict, issues, Apply suggestion, re-check; Create is blocked only on "Not doable" (with "Create anyway" after the warning). Limit: a "Needs adjustment" plan can be created while a critical issue still has an unapplied suggestion. |
| 6 | Watcher over every machine; anomalies through Gemini with SARA insights; a persisting anomaly opens a notification and a work order at once | Done | Settings on Superadmin → AI; several anomalies of one fault share one work order. Live runs used the scripted judge (`AI_MOCK=true`); the real Gemini path is covered by mocked tests only. Limit: two server processes opening orders for two anomalies of one machine at the same moment could still make two (single-process deployment). |
| 7 | Simulation UI moved into the simulator; nothing in SARA looks simulated or fake | Done | SARA's superadmin has only AI and Platform; `server/test/desim.test.js` fails on any simulator or fake-data wording in `server/src` and `client/src`. The docs folder still describes the simulator, on purpose. |

**The voice assistant (phase 8)** (asked on 17 Oct 2026; contracts in
[docs/phase8-voice-contracts.md](docs/phase8-voice-contracts.md)). Checked live in mock mode (`AI_MOCK=true`, no
Gemini call): the Live model ids and real speech are not verified yet because the key in `.env` is rejected.

| # | Point | Status | Notes and known limits |
|---|---|---|---|
| 1 | Listens and works in real time | Done | Microphone → 16 kHz PCM over a WebSocket → Gemini Live; captions both ways, barge-in, tools while talking. In mock mode SARA cannot hear: type or use **Say something**. |
| 2 | Talks to the user in a female voice | Done | 14 female prebuilt voices, Kore by default (Superadmin → AI → Voice, or the panel). Mock mode plays a soft tone instead of speech. |
| 3 | Multi-language audio | Done | Auto answers in the speaker's language (Hindi and Hinglish included) or one fixed language. |
| 4 | Any work by voice, like chat | Done | Every chat tool the user may use, Confirm cards confirmed by voice or by click, results in the chat history. Viewers are read-only. |
| 5 | Gemini APIs only | Done | Gemini Live for speech in and out and for captions; no browser speech APIs, no other vendor; the key stays on the server. |

**The 9 simulator points** (from [docs/simulator-v2.md](docs/simulator-v2.md)):

| # | Point | Status |
|---|---|---|
| 1 | Has the MongoDB and InfluxDB URLs and writes both directly | Done |
| 2 | First run creates one company, 20 assets and data for every module | Done (`pnpm validate-db` reports no schema errors) |
| 3 | Automates people's work: work orders, job cards, requests, PMs, stock, attendance | Done |
| 4 | Streams telemetry for all 20 machines of different types | Done (IMM, press, CNC, compressor, chiller, furnace, energy meter); a restart or outage gap of up to 6 h is backfilled |
| 5 | 1 owner, 3 admins, 20+ technicians in Maintenance and Production | Done (23 technicians, 1 viewer, 28 accounts) |
| 6 | Superadmin anomaly triggers per asset and type change the data | Done (from the simulator's control panel) |
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
- Voice says "Voice needs HTTPS or localhost": open the app on `https://` or `http://localhost`; a LAN IP over plain
  HTTP cannot use the microphone.
- Voice says "Microphone blocked": allow the microphone in the site settings next to the address bar, then Retry.
- Voice says "All voice lines are busy": raise **Concurrent sessions** on Superadmin → AI → Voice.
- Voice says "The voice connection dropped" at once: the page's origin (for example `http://127.0.0.1:5173`) is not
  in `CLIENT_URL`, which is also the voice WebSocket's Origin allow-list.
- Simulator problems: [sara-simulator troubleshooting](../sara-simulator/README.md#troubleshooting).
