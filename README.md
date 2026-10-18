# SARA — the AI-first maintenance and production platform

**Live:** [https://ai.swayatt.com](https://ai.swayatt.com) · Built on the **Google Gemini API** · Runs on **Google Cloud Run**

SARA runs a manufacturing plant's maintenance, production, inventory and costs, and an AI does most of the work.
You talk to SARA by chat or by voice, in your own language; she reads live machine data, judges what is wrong,
plans production and maintenance, creates and changes records, builds KPIs, and explains every number she shows.
Deterministic engines compute the numbers (statistics, capacity, schedules, costs); Gemini makes the judgement
calls, chooses between options and explains. Every AI output carries the model and time that produced it and can
be regenerated.

## What you can do with SARA

**Ask anything, change anything (Chat).** One assistant over the whole platform, with 44 tools: look up and
compare records, query machine telemetry, draw tables and charts, create, update and delete records in every
module, move work orders through their statuses, plan production and maintenance, set cost alerts and build KPIs.
Every change is previewed on a **Confirm card** before it is saved, and SARA fills in what you did not say: ask
for "a work order for Furnace 2 breakdown" and she decides the category, priority, description from the live
readings, due date, duration, checklist and an available technician, shows "SARA decided: …" and waits for your
Confirm. Ask her to "open the high-priority open work orders" and the page opens with the filters applied.

**Talk to SARA (Voice).** Press the mic in the header or **Ctrl Shift Space**. SARA listens and answers aloud in
real time, in a female voice, in the language you speak (English, Hindi, Hinglish and more), shows captions of
both sides, puts tables, charts and KPI tiles on screen, opens pages, and asks "Shall I go ahead?" before a
change; say yes or tap Confirm. Talk over her to interrupt. Everything chat can do works by voice, with the
same permissions.

**Know every machine (Machines, Machine 360).** Live status, key parameters, trends, status timeline, OEE, energy
and cost per machine, with an AI health score and a one-line AI summary. A parameter SARA flags gets a red ring and
the reason ("vibration +5.2σ, rising").

**Catch faults before they stop production (Anomalies).** A watcher screens every machine's telemetry each
minute; machines with new evidence go to Gemini, which decides whether something is wrong, names the parameter
(observed vs expected), rates severity and confidence, and writes the likely causes and actions. A persisting
anomaly opens a work order by itself, assigned to a technician on shift with fitting skills, and notifies the
maintenance managers. Each anomaly has an AI **investigation**: evidence charts, root cause, a suggested work
order, and **Plan maintenance** straight into the Planner.

**Plan production in one click (Planner → Production).** Pick a part, a quantity and a due date. SARA builds the
whole plan: the machines (from the moulds that make the part and each machine's free time: shifts, breaks,
holidays, changeovers), the window and quantity per job card, and an operator for every shift. Edit any row,
press **Check plan** for a verdict (Doable / Needs adjustment / Not doable) with one-click suggestions, then
**Create plan**.

**Plan maintenance without hurting production (Planner → Maintenance).** Choose the whole plant or selected
machines and a horizon. SARA gathers the PMs, calibrations, open anomalies and open work orders due in it, puts
each task in the window that costs the least production (zero-impact windows first; otherwise it says what gets
pushed and by how much, priced at each machine's downtime cost), picks technicians by skill and shift, and
reports the production impact and the **downtime cost avoided**. Edit → Check → Create, like production.

**See where the money goes (Costs).** Energy (tariffs), spare parts, consumables, labour and downtime by machine,
plant, category and day, with an AI overview and the top cost drivers explained. Cost alerts are created from
chat ("alert me if Compressor 2 energy cost is above ₹3000 a day") and checked every 15 minutes; a breach notifies
you with SARA's two-line explanation.

**Build any KPI by asking (KPI Builder).** "Build a heatmap of compressor energy by hour", "OEE by machine this
week", "kWh per part". SARA shows a live preview, you confirm, and the card appears with a one-line AI insight
that refreshes. 15 chart types: number, gauge, line, area, bar, stacked bar, combo, pie, scatter, radar, funnel,
treemap, heatmap, timeline, table.

**Start the day with a briefing (Command Center).** Production vs plan, OEE, downtime, open anomalies, overdue
maintenance and cost highlights go into one AI briefing with three recommended actions, next to the live machine
floor, your pinned KPIs, the alert feed, today's Gantt and the maintenance due.

**Run the plant's records (Modules).** Maintenance (assets, work orders, preventive maintenance, calibrations,
requests, maintenance plans), inventory and partners (spare parts, stock, transactions, consumables, vendors,
suppliers), production (tools, customers, production plans, job cards, rejections, downtimes, part counts), bins
(bins, bin sessions, station pools) and rules and reports (tags, workflow rules, scheduled reports). Every module
has a list with search, filters and sorting, a record page with its related records in tabs (a machine's work
orders, job cards, anomalies and PMs; a production plan's chained job cards), and a form; and every module is
reachable from chat and voice.

**Administer the platform (Superadmin).** Models per AI tier with thinking level, fallback and a Test button;
daily quotas and usage; background AI settings (scan interval, investigations, automatic work orders, cost
watch); voice (model, voice, language, session limits); and a read-only overview of every company on the platform.

## How SARA uses Gemini

Every AI feature in SARA is a call to the Google Gemini API through the official `@google/genai` SDK, made from
the server only. No other AI vendor and no browser speech APIs are involved, and the API key never leaves the
server. There are three ways into Gemini, all sharing one plumbing layer:

```
 Browser ──REST + SSE──► routes/conversations.js ──► agent/loop.js ───────────┐
 Browser ──WebSocket───► voice/server.js ──► voice/session.js ──► Gemini Live │   chat tiers: router · fast · balanced · deep
 Schedulers: anomaly watch (60 s), cost watch (15 min), KPI insights,        ├──► ai/gemini.js ──► Gemini API
             briefing ──► engines build an evidence pack ──► structured call ─┘   background tier
                                                                              │
          every call: ai/settings.js (tier → model, thinking level, fallback) → ai/budget.js (RPM/RPD ledger, chat reserve)
                      → the request → usage written to ai_usage (tokens, latency, status) → shown on Superadmin → AI
 Tools never run inside Gemini: the model asks, the server runs agent/tools/* through records.js (tenancy, permissions)
 and the InfluxDB queries, and sends the result back as a function response.
```

### Models and tiers

| Tier | Used for | Default model | Thinking | Fallback |
|---|---|---|---|---|
| router | Classifying each chat message (intent, complexity, tool groups, tier); titles and summaries | `gemini-3.1-flash-lite` | none | heuristics |
| fast | Short lookups and small talk | `gemini-3.6-flash` | low | `gemini-3.8-flash` |
| balanced | Most questions: analysis, time series, multi-step tool use | `gemini-3.8-flash` | medium | `gemini-3.6-flash` |
| deep | Diagnosis, planning, writes, complex reports | `gemini-3.8-flash` | high | `gemini-3.6-flash` |
| voice | Gemini **Live API** session per conversation | `gemini-3.1-flash-live-preview` | — | `gemini-2.5-flash-native-audio-preview-12-2025` |
| background | Anomaly judge, investigations, planning texts, cost texts, KPI insights, briefing | `gemini-3.5-flash-lite` | low | none (skips, retries next cycle) |

Models, thinking levels, fallbacks, per-model RPM/RPD limits and the chat reserve are edited live on
Superadmin → AI (stored in `platformsettings`, defaults from `.env`). Thinking levels are clamped to what each
model supports (`ai/models.js`); the AI tab lists the models the key can use, and the Live models that support
`bidiGenerateContent`.

### A chat message, step by step

1. **Request.** `POST /api/conversations/:id/messages { text, tier?, context? }`. The JWT and its session are
   checked, and the user context is built: company, plant lock, role and permissions, enabled modules, time zone,
   currency and date format. The response is a Server-Sent Events stream.
2. **Routing.** One small structured call on the router tier (`generate({ tier: 'router', purpose: 'router',
   schema })`) returns `{ intent, complexity, needsInflux, isFollowUp, suggestedTier, groups, confident }`. A tier
   pinned in the composer wins; when the router is not confident every tool group is sent; when it fails,
   keyword heuristics choose the balanced tier.
3. **Prompt.** `agent/systemPrompt.js` assembles the system instruction: SARA's identity, the user and company,
   the current time in the plant's zone, the hard rules (data is scoped, never invent, state time ranges, resolve
   names first, draw tables and charts with the render tools, writes need confirmation, never reveal secrets),
   the decisive policy (fill missing fields with SARA's defaults and show them, one question at most, fix a
   failed call from its hint and retry once, answer in the user's language), a digest of the modules the user may
   read, a digest of the telemetry measurements per machine type, the open page's record (`context.recordRef`),
   and the conversation summary. `agent/history.js` adds the last `HISTORY_TURNS` (12) turns; older tool
   responses are shrunk to `{ summary, rowCount }` and unanswered calls are answered `not_confirmed`.
4. **Tools.** `agent/tools/registry.js` picks the tools the model may see: the core group always (`resolve`,
   `resolve_time_range`, `module_schema`, `mongo_find`, `mongo_count`, `mongo_distinct`, `mongo_aggregate`,
   `render_table`, `render_chart`, `render_kpis`, `export_csv`, `open_page`, `load_tools`) plus the loaded groups
   (`maintenance`, `production`, `telemetry`, `health`, `people`, `planning`, `cost`, `kpi`, `write`), filtered by
   the company's features and the user's permissions. Each tool's zod schema becomes a Gemini function
   declaration (`agent/declarations.js`), so the API, the UI forms and the model validate against the same schema.
5. **The call.** `ai/gemini.js generateStream({ tier, contents, tools, thinkingConfig })`: the tier maps to a
   model and thinking level, the budget ledger admits the request, the SDK streams. Thought parts become
   `thought` events, text becomes `delta` events, and the browser renders them as they arrive. SSE event types:
   `meta`, `thought`, `delta`, `tool_call`, `tool_result`, `block`, `notice`, `escalated`, `usage`, `title`,
   `done`, `error`.
6. **Tool loop.** For each function call the server validates the arguments with the tool's zod schema; Mongo
   filters and pipelines also pass `agent/validators/` (operator and stage allow-lists, tenant re-injection at any
   depth, `$lookup` rewritten with a tenant match and secret projection, regex safety, depth limits) and Flux is
   pinned to the company's bucket. Natural inputs are coerced (dates in words, `$start`/`$stop` placeholders,
   machine names or codes, "all"). The tool runs with the user's context through `records.js` (the scope filter
   is applied last) or the telemetry queries; the result is redacted (secret fields stripped), audited in
   `ai_tool_audit`, and reduced to a compact `forModel` payload (at most 50 rows, series become statistics) while
   the full rows stay server-side for `render_*` in the same turn. Identical calls within a turn are served from a
   cache. The loop sends one user content per step with every function response in call order, keeps Gemini's
   thought signatures for replay, and stops at `MAX_TOOL_ITERATIONS` (10) or `MAX_TURN_MS` (90 s).
7. **Writes and confirmation.** `create_record`, `update_record`, `delete_record`, `update_work_order_status`,
   `add_work_order_comment`, `assign_work_order`, `apply_plan`, `create_kpi` and `update_kpi` never write
   directly. The tool runs a dry run through `records.js` (schema, references by name or code, permissions),
   completes missing fields with SARA's defaults (category, priority, description from the gathered facts, due
   date, duration, checklist, an available technician) and returns a preview. The server stores a **pending
   action** (TTL `PENDING_ACTION_TTL_MIN`, 10 minutes), streams a `confirm` block with the diff and the "SARA
   decided" lines, and ends the turn as `awaiting_confirmation`. `POST …/actions/:id/confirm` re-checks the
   permissions, executes the write, and continues the same turn with the function response so the model can
   summarise what was created. Reject, expiry or a new message answers the call with `not_confirmed`.
8. **Resilience and bookkeeping.** A 429 with a `retryDelay` of 10 s or less waits and retries once; otherwise the
   tier's fallback model takes over with a `notice`. A non-deep answer that could not determine the result is
   restarted once on the deep tier (`escalated`). The stop endpoint or a closed connection aborts the request.
   The assistant message is persisted with its parts (thoughts, text, tool calls and results, blocks), model,
   tier, usage and latency; the first reply gets a title from the router tier.

### A voice session, step by step

1. **Connect.** The browser opens `wss://<host>/api/voice` and sends `start { token, language?, voice?, context }`
   within 5 s. The server checks the origin against `CLIENT_URL`, the JWT and the session, and the limits
   (one session per user, 3 concurrent server-wide, 10-minute maximum, 90 s idle).
2. **Gemini Live.** The server opens one Live session: `responseModalities: ['AUDIO']`, a prebuilt female voice
   (Kore by default), input and output transcription, automatic voice-activity detection, sliding-window context
   compression and session resumption. The system instruction is the chat prompt plus the voice style (short
   spoken sentences, numbers and units said naturally, never read ids aloud, draw results on screen before
   mentioning them, decide missing details, keep the user's language). The tools are every group the user may
   use, plus the voice-only `confirm_action` and `reject_action`.
3. **Streaming.** Microphone audio (an AudioWorklet resamples to 16 kHz PCM16, 20–40 ms frames) is relayed with
   `sendRealtimeInput`; Gemini's 24 kHz speech is streamed back to a gapless player; both transcripts become live
   captions. Talking over SARA, or Stop, interrupts her and flushes the playback.
4. **Tools and writes.** Function calls run on the server exactly as in chat (same registry, validators,
   permissions and audit) and go back with `sendToolResponse`. `render_*` results appear as blocks on the panel,
   `open_page` navigates the app, and a write produces the confirm card; a clear "yes" in a later turn calls
   `confirm_action` for the latest pending action only. If SARA says something is on screen without having drawn
   it, the server renders the last rows it fetched.
5. **Persistence and limits.** Each turn is saved like a chat turn (`channel: 'voice'`), so the conversation
   appears in Chat with a mic badge and can continue by text; audio is never stored. A `goAway` from Gemini
   reconnects with the resumption handle; usage per session is logged.

### The anomaly watch, every minute

1. **Features** (`ai/anomaly/features.js`). For every machine with telemetry, one InfluxDB query gives the last
   10 minutes of 1-minute means per field. Against `baselines.js` (seven-day mean and spread per field **per
   status**, refreshed hourly, with noise floors and the OEM normal bands) it computes z-scores, slopes, spikes,
   band breaches, flatlines, idle power ratios and the rejection rate (parts and rejects with a binomial z), with
   context: status and since when, in shift or not.
2. **Who goes to Gemini.** Flagged machines and machines with an open anomaly every tick; quiet machines every
   `ANOMALY_QUIET_INTERVAL_MIN` (10, stretched ×3 when the background model has used 70 % of its daily allowance);
   **Re-scan** forces all. Statistics only decide how often a machine is reviewed; Gemini decides what is wrong.
3. **One structured call** (`generate({ tier: 'background', purpose: 'anomaly', schema })`) with a compact table
   per machine (`field | label (unit) | last | 10-min mean | baseline ± σ | z | slope/h | band | flags`) and
   physics guidance (vibration + current + temperature rising together is bearing wear; high idle power is an
   energy leak; a frozen value is a sensor fault; a machine judged against its own status baseline). The response
   schema: per machine a health score, a state (`normal | watch | anomalous`), a summary, and anomalies with type,
   severity, confidence, parameters (field, observed, expected, deviation), explanation, likely causes,
   recommended actions and urgency.
4. **Guardrails** (`guardrails.js`): machines not in the input and parameters not in that machine's table are
   dropped, as are observed values more than 15 % off the table, anomalies left without parameters and `info`
   findings; every drop is logged with its reason, and each scan's evidence, decisions and drops go to the capped
   `ai_scan_log` collection.
5. **Effects.** Health score and summary on the machine; anomaly created, updated, reopened (within 6 h) or
   auto-resolved after 3 clean scans; notification and live event; an **investigation** (one more structured
   call: root cause, confidence, suggested work order, from an evidence pack of the flagged series, recent work
   orders, PMs and stock); and after the configured consecutive scans (critical at once) `autoWorkOrder.js` opens
   one work order with a technician from `planning/people.js` and links it to the anomaly.

### Other background calls

| Purpose | Trigger | Evidence the engine builds | Gemini returns | Kept |
|---|---|---|---|---|
| `planning` | Planner "Plan with SARA" and "Check plan" | the capacity calendar, the plan, its issues and adjustments | feasibility verdict text, bullets, what to adjust; the recommended maintenance option and why | on the proposal |
| `cost` | Costs page overview; a cost alert breach | cost summary by component and asset; the alert, its value and recent history | overview text with the top drivers; two sentences on cause and fix | per period (`ai_texts`), once per breach |
| `kpi` | KPI cards older than `KPI_INSIGHT_TTL_MIN` (60) or Explain | each KPI's normalised result | one-line insight per KPI (one call for many cards) | on the KPI |
| `briefing` | Command Center, older than `BRIEFING_TTL_HOURS` (4) or Regenerate | production vs plan, OEE, downtime, anomalies, overdue maintenance, cost highlights | headline, narrative, three actions, evidence blocks to show | per company and plant |
| `title`, `summary` | first reply of a conversation; conversations past `HISTORY_TURNS` | the exchange | a short title; a running summary | on the conversation |

Each shows its model and time in the UI (AiProvenance) and can be regenerated. When Gemini is unavailable or
the budget refuses a background call, the page still renders with the numbers and a note; the call is retried on
the next cycle.

### Budget, limits and safety

- **Ledger** (`ai/budget.js`): a per-model requests-per-minute bucket and a per-model daily count from `ai_usage`
  (reset at midnight Pacific, when Gemini quotas reset). `AI_CHAT_RESERVE_PCT` (40 %) of each model's daily
  allowance is kept for chat and voice; background purposes are refused once they would eat into it, and the
  background tier never falls back into the chat models. Usage per model (calls, tokens, rate limits) is on the
  AI tab.
- **Scoped tools.** The model only ever sees what the signed-in user may see: every read goes through the scope
  filter, secrets are stripped, Flux is limited to the company's bucket, and the KPI runner runs as the viewer.
- **Human in the loop.** No write happens without a Confirm (or a spoken yes), and the confirm re-checks
  permissions at that moment. Viewers get read-only tools.
- **Grounding.** Background answers are checked against the evidence they were given; chat answers cite the
  tool results of the turn; the Thinking panel shows the model's reasoning.
- **Key handling.** `GEMINI_API_KEY` lives in the API's environment; the AI tab shows only configured or missing;
  nothing logs the request URL.

### Where the code lives

| Area | Files |
|---|---|
| Gemini plumbing | `server/src/ai/gemini.js` (generate, generateStream, 429 handling, fallbacks), `settings.js`, `models.js`, `budget.js` |
| Chat agent | `server/src/agent/{router,systemPrompt,history,declarations,loop,pendingActions}.js`, `agent/tools/*`, `agent/validators/*`, `routes/conversations.js` |
| Voice | `server/src/voice/{server,session,liveClient,prompt,tools,persist,protocol}.js`, `routes/voice.js`, `client/src/voice/**` |
| Anomaly watch | `server/src/ai/anomaly/{watch,features,baselines,guardrails,investigate,autoWorkOrder,scanLog}.js`, `routes/{ai,anomalies}.js` |
| Planning, costs, KPIs, briefing | `server/src/{planning,costs,kpis,briefing}/**` (engines + their one structured call each) |
| Superadmin AI settings | `routes/adminAi.js`, `client/src/superadmin/AiTab.jsx` |

## Sign in

Open [https://ai.swayatt.com](https://ai.swayatt.com). The login page lists the accounts of **Acme Components**,
the plant on the platform (a Pune plant with 20 machines: injection moulding machines, power presses, CNCs,
compressors, a chiller, furnaces and the main incomer). Click a person to sign in as them, no password needed
(this one-click panel is the `DEMO_MODE=true` setting; with it off, use the e-mail and password below).

Every account below uses the password **`Sara@12345`**.

| Role | Email | Name | Job title |
|---|---|---|---|
| Owner (everything, every plant) | `owner_1@swayatt.com` | Vikram Mehta | Managing Director |
| Admin | `plant_manager_1@swayatt.com` | Anita Deshpande | Plant Manager |
| Admin | `maintenance_manager_1@swayatt.com` | Rajesh Joshi | Maintenance Manager |
| Admin | `production_manager_1@swayatt.com` | Neha Kulkarni | Production Manager |
| Technician, Maintenance | `maintenance_planner_1@swayatt.com` | Pooja Bhosale | Maintenance Planner |
| Technician, Maintenance | `maintenance_technician_1@swayatt.com` | Ramesh Kumar | Maintenance Technician |
| Technician, Maintenance | `maintenance_technician_2@swayatt.com` | Sandeep Yadav | Maintenance Technician |
| Technician, Maintenance | `maintenance_technician_3@swayatt.com` | Imran Qureshi | Maintenance Technician |
| Technician, Maintenance | `maintenance_technician_4@swayatt.com` | Suresh Patil | Electrical Technician |
| Technician, Maintenance | `maintenance_technician_5@swayatt.com` | Anil Gaikwad | Electrical Technician |
| Technician, Maintenance | `maintenance_technician_6@swayatt.com` | Arjun Rao | Hydraulics Technician |
| Technician, Maintenance | `maintenance_technician_7@swayatt.com` | Priya Nair | Utilities Technician |
| Technician, Maintenance | `maintenance_technician_8@swayatt.com` | Karthik Iyer | Instrumentation Technician |
| Technician, Maintenance | `tool_setter_1@swayatt.com` | Mahesh Chavan | Tool Setter |
| Technician, Maintenance | `store_keeper_1@swayatt.com` | Ganesh Jadhav | Store Keeper |
| Technician, Production | `production_supervisor_1@swayatt.com` | Manoj Shinde | Production Supervisor |
| Technician, Production | `production_supervisor_2@swayatt.com` | Rahul Deshmukh | Production Supervisor |
| Technician, Production | `production_technician_1@swayatt.com` | Sachin Pawar | Machine Operator |
| Technician, Production | `production_technician_2@swayatt.com` | Deepak More | Machine Operator |
| Technician, Production | `production_technician_3@swayatt.com` | Lakshmi Reddy | Machine Operator |
| Technician, Production | `production_technician_4@swayatt.com` | Vijay Thakur | Machine Operator |
| Technician, Production | `production_technician_5@swayatt.com` | Sunita Kamble | Machine Operator |
| Technician, Production | `production_technician_6@swayatt.com` | Amit Verma | Machine Operator |
| Technician, Production | `production_technician_7@swayatt.com` | Ravi Prasad | Machine Operator |
| Technician, Production | `production_technician_8@swayatt.com` | Santosh Mane | Machine Operator |
| Technician, Production | `quality_inspector_1@swayatt.com` | Farhan Shaikh | Quality Inspector |
| Technician, Production | `quality_inspector_2@swayatt.com` | Meena Pillai | Quality Inspector |
| Viewer (read-only) | `viewer_1@swayatt.com` | Kavita Bhatt | Management Viewer |

What each role sees: the owner and the admins have every page and every write; technicians get the modules
their permissions allow (and the assistant refuses the rest politely); the viewer can read everything and change
nothing, by chat or voice included. The platform superadmin (`superadmin@swayatt.com`, password set by
`SUPERADMIN_PASSWORD` on the server, never listed on the login page) sees Superadmin → AI and Platform.

**Try first:**

- Chat: "Which machines need attention right now, and why?" · "Plan 5000 Housing-A by next Friday" ·
  "Maintenance plan for the whole plant for the next 7 days" · "Create a work order for Furnace 2 breakdown" ·
  "Alert me if Compressor 2 energy cost is above ₹3000 a day" · "Build a heatmap of compressor energy by hour" ·
  "Open the open high-priority work orders".
- Voice: "SARA, how many machines are running right now?" · "IMM 3 का vibration कैसा है?" ·
  "Create a work order for Press 2 hydraulic leak, high priority" (then say "yes") · "Take me to the Planner".

## Architecture

```
 Plant data gateways                              SARA server (Node 22+, Express 5)              Browser (React 19, Vite)
 ┌──────────────────────────────┐                ┌──────────────────────────────────┐          ┌──────────────────────┐
 │ machine telemetry every 5 s  │── telemetry ─┐ │ auth (JWT + sessions), records.js│◄──REST──►│ Command Center       │
 │   (PLC / SCADA / meters)     │              │ │ live poller → event bus ─────────┼──SSE────► Machines, Machine 360│
 │ plant activity: work orders, │── records ───┼─┤ engines: capacity, planners,     │          │ Anomalies, Planner   │
 │   job cards, requests, stock │              │ │   costs, KPI runner, briefing    │◄──WS────►│ Costs, KPI Builder   │
 └──────────────────────────────┘              │ │ AI: anomaly watch, investigations│  voice   │ Chat, Voice, modules │
                                               │ │   chat + voice agents, insights  │          │ Superadmin           │
                                               ▼ │   budget ledger                  │          └──────────────────────┘
                              MongoDB (hosted)    └───────┬─────────────┬────────────┘
                              records, AI state,  InfluxDB (hosted)     │
                              sessions            bucket per company ◄──┘ reads both ──► Google Gemini API (+ Live API)
```

- `server/` — Express 5 API: registry-driven modules (one definition → Mongoose model, zod validation, REST,
  tenancy, permissions, agent access), the planning, cost, KPI and briefing engines, the anomaly watch, the chat
  agent and the voice gateway. `client/` — React 19 + Vite + Tailwind. `docs/` — system design and module contracts.
- Live updates reach the browser over Server-Sent Events; voice uses one WebSocket per session.
- Plant data gateways write machine telemetry into InfluxDB (one bucket per company, tagged by machine and
  status) and plant activity into MongoDB; SARA reads both and never depends on a particular gateway.

Details: [docs/system-design.md](docs/system-design.md) and the contracts in `docs/`.

## Deployment

**Production (ai.swayatt.com).** SARA runs on **Google Cloud Run**: the API (`server/Dockerfile`) and the web app
(`client/Dockerfile`, nginx) as container services, with hosted MongoDB and InfluxDB and the Gemini API key held
only by the API service's environment. HTTPS is required in production: browsers allow the microphone only on a
secure origin. On Cloud Run build the web app with `VITE_API_URL=https://<api service url>` and set the API's
`CLIENT_URL=https://ai.swayatt.com` (the CORS and voice-WebSocket origin allow-list).

**Any server with Docker.** `docker compose up -d --build` runs the API and the web app from `.env`
(`MONGO_URI`, `INFLUX_URL`, `INFLUX_TOKEN`, `INFLUX_ORG`, `JWT_SECRET`, `SUPERADMIN_PASSWORD`, `GEMINI_API_KEY`,
`CLIENT_URL`, `WEB_PORT`); the web app's nginx proxies `/api` (REST, SSE and the voice WebSocket) to the API, so
only the web port is published. `docker compose --profile tls up -d --build` adds Caddy with an automatic
certificate for `DOMAIN`. On an Ubuntu VM, `bash deploy/install-ubuntu.sh` installs Docker and prints the steps.
First start only: `docker compose exec server node scripts/seed.js` creates the platform tenant and the superadmin.
Plant data gateways deploy separately, pointed at the same databases.

**Local development.**

```sh
pnpm install && cp .env.example .env               # set JWT_SECRET, SUPERADMIN_PASSWORD, GEMINI_API_KEY
docker compose -f docker-compose.dev.yml up -d      # local MongoDB + InfluxDB, or point .env at hosted ones
pnpm seed                                           # platform tenant + superadmin
pnpm dev                                            # API http://localhost:5080, web app http://localhost:5173
```

Restart the API after changing `.env` (it is outside the watched `src` folder).

## Security model

- **Tenancy:** every record carries `companyId` (and `plantId` when plant-scoped); `records.js` applies the scope
  last, so no caller can widen it, and plant-locked users see only their plant. Agent filters, pipelines and
  `$lookup`s are validated and re-scoped; Flux queries are limited to the company's bucket; the KPI runner runs as
  the viewer.
- **Roles:** superAdmin (platform only), owner and admin (full), technician (per-module permissions), view
  (read-only; every write is refused, including from chat and voice).
- **Auth:** HS256 JWT with a session id checked in MongoDB on every request (revocable, `SESSION_TTL_HOURS`);
  live streams re-check every minute; bcrypt passwords; rate limits on login and chat; helmet, a CORS allow-list,
  a 2 MB body limit. The one-click login panel exists only while `DEMO_MODE=true`; the superadmin is never on it.
- **AI safety:** the model sees only scoped, redacted tool output; every write needs a human Confirm that re-checks
  permissions; tool calls are audited; the Gemini key never leaves the server; a budget ledger caps daily use.
- **Voice privacy:** audio is never stored; transcripts are kept as a chat conversation.

## Extending SARA

**A module** is one definition object in `server/src/modules/defs/` (name, label, group, fields with types and
options, `plantScoped`, `permissionKey`, counters, `children` for related records). The registry builds the
Mongoose model, the zod schemas, the REST routes, tenancy and permissions from it; the client renders the list,
record and form pages from the metadata; the assistant can read and write it at once.

**A tool** is `{ name, group, description, schema, permission?, requiresConfirmation?, preview?, run }` in
`server/src/agent/tools/`: `run` reads and writes through `records.*`, writes set `requiresConfirmation` with a
dry-run `preview`, and the registry turns the zod schema into the Gemini function declaration.

## Tests and checks

```sh
pnpm lint                                                  # Biome
cd server && SARA_TEST_DB=my_label npx vitest run         # server tests
cd client && npx vitest run                                # client tests
pnpm eval                                                  # assistant conversation checks (tool sequences, confirm cards)
pnpm validate-db                                           # every record against the module schemas
```

Server tests create and drop `<SARA_TEST_DB>_<n>` databases on `MONGO_TEST_URI`; on a shared server use a label
that cannot match a real database.

## Troubleshooting

- "Voice needs HTTPS or localhost": open the app on `https://` or `http://localhost`.
- "Microphone blocked": allow the microphone in the site settings next to the address bar, then Retry.
- "The voice connection dropped" at once: the page's origin is not in `CLIENT_URL`.
- Empty machine charts: InfluxDB has no data for the company; check `INFLUX_*` and that the plant's telemetry gateway is online.
- No anomaly after a fault appears: wait for the next scan, or press **Re-scan** on the machine's health card.
- Server exits with a config error: `.env` is missing or a value is invalid; see `.env.example`.
