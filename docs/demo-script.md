# SARA hackathon demo: 10 minutes, click by click

Rehearsed live on 2026-10-16 (14:45 to 15:15 UTC) against the remote `sara` database with the simulator running and AI_MOCK=true.
Measured on that run: overheating injected on CNC 2 at 14:51:16. The AI watch flagged ANM-11 ("spindleTemp on CNC 2 ...", critical, 95 % confident) at 15:02:47. Work order WO-99 was created at 15:06:24. The simulated technician Suresh Patil completed it, and the injection cleared with reason `repair` at 15:07:25 (humanSpeed 60). ANM-11 resolved at 15:13:02 after the next clean scan.
Detection took 11.5 min only because other agents were editing the server and `node --watch` restarted it every 30 to 60 s. Each restart clears the watch's memory, so a flagged machine then waits for its 10 min quiet interval. With nobody editing, detection comes on the first scan tick after the reading leaves its band, about 1 to 2 min into the ramp. If you are short on time, use **Re-scan** (step 6b).
Re-checked on 2026-10-17 (phase-7 gate, server stable, AI_MOCK=true): bearing wear, High, ramp 2 min on IMM 3. The watch flagged vibration (critical) about 4.3 min after the injection, and SARA opened WO-124 one second later with a technician and notifications. The panel showed 5.2 min, because this PC's clock runs 55 s ahead of MongoDB and SARA stamps detections with the PC clock.

## Before the judges arrive (T-10 min)

1. `DEMO_MODE=true` in `sara/.env`, so the login page lists the demo accounts: click a person to sign in as them, no password. The simulator runs: `cd sara-simulator && node src/index.js`. The server runs: `cd sara/server && npm run dev`. The client runs: `cd sara/client && npm run dev`, then open http://localhost:5173.
2. Open two browser windows side by side, or two profiles:
   - **Window A, two tabs**: the simulator's control panel at http://localhost:5090 (password: SIM_UI_PASSWORD from `sara-simulator/.env`), and SARA as `superadmin@swayatt.com` with the SUPERADMIN_PASSWORD from `sara/.env` (the superadmin is never in the demo list).
   - **Window B, owner**: click **Vikram Mehta** (Owner, Managing Director) in Demo accounts; without demo mode, `owner_1@swayatt.com` / `Sara@12345`.
3. In Window A, on the control panel, open Controls:
   - Simulation running: on.
   - Machine readings every 5 s.
   - Simulated people: on, Activity speed **10×**.
   - **Managers respond to AI anomalies: off.** SARA opens the work order itself (step 7:00), not a simulated manager.
   - In Active injections, click **Clear all** so the lab starts empty.
4. In the SARA tab of Window A, Superadmin → AI: **Open a work order automatically** on, **After consecutive scans** 2, **Minimum severity** Warning (the defaults), then Save. Switch it off instead if you want to click **Create work order** yourself in step 7:00.
5. In Window B, click **Regenerate** at the bottom of the SARA briefing so the text matches the live numbers.
6. Keep a third tab signed in as the viewer (`viewer_1@swayatt.com`, the last card in Demo accounts) for the last minute.

## 0:00 to 1:00: Simulator control panel (Window A)

Click path: http://localhost:5090, signed in with SIM_UI_PASSWORD. SARA itself has no simulator page: the panel belongs to the simulator.
- Simulator card: the instance is **Online** ("last seen 3 s ago"), with **Streaming**, uptime, points per second, people on shift and activity speed.
  Talking point: "A separate simulator repo, also Raspberry Pi ready, plays a whole plant. It streams machine readings into InfluxDB and runs 23 technicians, managers and operators working real shifts in MongoDB. Nothing in SARA knows it is simulated."
- Acme Components card: 28 users, 20 machines, over 120 work orders and the job cards and requests. Click **Credentials** to show the demo logins by role, then close it.
  Talking point: "One company, seeded once. Restarts never seed again."
- Controls card: the reading interval, simulated people, activity speed (1× to 60×) and backfill history.
- Live activity, at the bottom: real-time actions such as "Meena Pillai rejected 1 × Housing-A on IMM 4 (Sink Mark)".

## 1:00 to 1:40: Superadmin, AI tab (Window A, SARA tab)

In SARA open **Superadmin**: the tabs are **AI** and **Platform** (every customer company with its plants, users and machines). Click **AI**.
- The banner reads **"Mock mode (AI_MOCK is on): SARA answers with built-in, deterministic replies. No Gemini calls are made."** Say it out loud. See "Switching to real Gemini" below.
- Models per tier: Router, Fast, Balanced, Deep and Background. Each has a model, a thinking level, a fallback and a **Test** button. Do not click Test in mock mode.
- Quotas and usage today, the chat reserve, and Background AI: anomaly scans every 60 s, calm machines every 10 min, the investigate toggle, **Open a work order automatically** (after N consecutive scans, minimum severity) and cost watch.
  Talking point: "Every KPI, insight, briefing and anomaly comes from Gemini. Background work never eats the chat quota."

## 1:40 to 2:30: Inject the fault (Window A, control panel, Anomaly lab)

- Machine: **CNC 2**. Scenario: **Overheating**. Severity: **High**. Ramp **5** min. Hold **40** min. Click **Inject**.
- Active injections now shows "CNC 2 · Ramping up · Waiting for SARA".
  Talking point: "This is ground truth only the superadmin sees. The AI never sees what we inject. It has to find it in the data."

## 2:30 to 5:00: Owner's Command Center (Window B)

Click path: Command Center, the home page.
- **SARA briefing**: a headline ("Acme Components: N machines to watch"), a narrative with production against plan, OEE, the longest stop, open anomalies and spend, and **Do next** with three actions. The first is usually "Plan maintenance for <machine>", which deep-links into the Planner. The evidence below the actions is a production chart, an OEE tile, an anomalies table and a downtime table, every number live. The footer reads "Generated by gemini-3.5-flash-lite (mock) · Regenerate".
- **Alerts** (right): cost alerts and anomalies, newest first.
- **KPI strip**: four AI-built KPIs (PM compliance gauge, maintenance cost by asset, top downtime reasons, OEE by machine), each with an AI insight line.
  Talking point: "These were built from one chat sentence and pinned here."
- **Live floor**: every machine with its status, health ring and key reading, updated live.
- **Today's plan**: a mini Gantt of job cards and maintenance, with the red Now line.
- **Maintenance due**: overdue, due today, open work orders, each with **Plan**.

## 5:00 to 6:00: Machines, then Machine 360 (Window B)

- Click **Machines**. Show the status filter chips (Running, Idle and so on), search, sparklines and health rings.
- Click **CNC 2**, which opens Machine 360: live parameters with normal bands, energy tiles, production, trends (1 h, 6 h, 24 h, 7 d) and the 24 h status timeline.
- Point at **Spindle temp**. It climbs from about 32 °C toward 45 to 50 °C during the ramp.

## 6:00 to 7:00: The AI flags it (Window B)

- 6a. Wait for the bell or an Alerts entry: **"ANM-xx · CNC 2 · Spindle temp on CNC 2 averages 4x °C over the last N min, +…σ from its history baseline of 32"**. The Machine 360 health card turns critical, and the Anomalies card lists it.
- 6b. If nothing has appeared 2 min into the ramp, click **Re-scan** on the Machine 360 health card (owners and admins only). This forces one scan now.
  Talking point: "The watch screens all 20 machines every minute with deterministic features: z-scores against each machine's own 7-day history per state, flatlines, idle power and reject rates. Only machines with new evidence go to Gemini, in one batched call. Gemini names the parameter. In mock mode a scripted judge makes the same call from the same features."

## 7:00 to 8:00: Anomaly detail, then Create work order (Window B)

- Click the anomaly in Alerts, or go to **Anomalies** and click the CNC 2 row. The drawer shows:
  - **What SARA found**: the parameter table (Spindle temp, observed, expected, deviation), likely causes, recommended steps and "Act within 4 h".
  - **Evidence chart**: 2 h either side, with the normal band shaded and a red line at detection.
  - **Investigation**: root cause and a **Suggested work order** that is already filled in.
- When the watch reports the same anomaly on two scans in a row (or once when critical), SARA opens the work order itself: the row and the drawer show **"WO-xx opened automatically"**, with a technician on shift whose skills fit, and the maintenance managers, the owner and the technician get a notification (Superadmin → AI → "Open a work order automatically" sets the scans and the minimum severity). Click the badge: the work order's description is SARA's insight (parameters, observed vs expected, actions).
  Talking point: "One fault often shows on several readings. SARA files it once: a second anomaly on the same machine joins the open work order as a comment."
- If it has not opened yet (or you switched it off), click **Create work order**. The title, description, priority High, category Mechanical and 90 min are all prefilled. Click **Create work order** again. The toast reads "Work order WO-xx created".

## 8:00 to 9:00: A technician works it (Window A)

- In Window A, on the control panel's Controls, set Activity speed to **60×**.
- In Live activity, watch a maintenance technician "took WO-xx", then "started WO-xx", add a comment that fits the job (for example "Cleaned the spindle chiller filter; spindle temperature stable at 38 °C") and "completed WO-xx". At 60× this takes about 1 to 2 min.
- Recent injections now shows CNC 2 with Outcome **"Fixed by WO-xx"** and AI detection **"Detected in N min · ANM-xx flagged spindleTemp"**.
- Set Activity speed back to **10×**.
  Talking point: "The repair cleared the fault in the simulator, the readings settle, and SARA's next clean scan resolves the anomaly by itself."

## 9:00 to 9:40: Anomaly resolves (Window B)

- Back in Anomalies, the CNC 2 anomaly is **Resolved** (Detected and Resolved times, all within about 1 to 6 min after the work order completed). Machine 360 is back to "Good".
- Optionally click **Regenerate** on the briefing so it drops CNC 2.

## 9:40 to 10:00: Viewer is read-only (viewer tab)

- `viewer_1@swayatt.com` sees the same Command Center, but without Regenerate, Re-scan, Create work order or Acknowledge/Resolve. The work order page's Change status and Add comment are disabled, and the Superadmin page is not reachable.
  Talking point: "Permissions are enforced on the server too. Every write returns 'Your role (view) can't …'." This was checked live: creating, updating and deleting work orders, assets and KPIs, changing anomaly state, investigating, scanning, regenerating the briefing, cost refresh, and production and maintenance planning are all refused with 403. On the Planner the viewer sees plans read-only, with names instead of people pickers.

## Extension, +4 minutes: the Planner (Window B)

Sign in as `plant_manager_1@swayatt.com` / `Sara@12345` (or stay as the owner). Live data moves while the plant runs, so machines, times and names differ from run to run.

- **Production plan (1.5 min).** Planner → **Production**. Part **Housing-A** (the moulds and their machines are listed under it), quantity **5000**, due date about 9 days out → **Plan with SARA**. SARA shows a draft `PLN-n` ("becomes PP-n on create"), the verdict (**Doable** / **Needs adjustment** / **Not doable**), one job card per mould on the machine that is free soonest, its window, target and an operator for every shift, a Gantt and SARA's summary.
  Talking point: "One sentence of input. SARA picked the machines, the windows, the quantities and the people, and checked them against everything already booked."
- **Edit → Check (1 min).** Move one job card to a machine that is busy at that time (for example the T-102 card onto IMM 4) → **Check plan**. The verdict changes and the issue reads like a machine overlap, with a suggestion such as "start after JC-xx". Click **Apply suggestion**: the row is patched and checked again. Then **Create plan** → the `PP-n` record opens with its job cards as a chain per machine (`JC-a → JC-b`, windows, targets, operators), the compact Gantt and planned vs ordered quantity. The **Related** tabs list the same job cards.
- **Maintenance plan (1.5 min).** Planner → **Maintenance**. Scope **Whole plant**, 7 days, objective slider at **Protect production** → **Plan with SARA**. Each PM, calibration, open anomaly and open work order gets a window, a technician on shift with the right skills (electrical, hydraulic, mechanical, utilities, calibration) and an impact chip (**No impact** or hours and ₹). The tiles show the production impact, **Downtime cost avoided** against doing everything at once, and the zero-impact tasks. Slide toward **Fix fast** and plan again to show the trade-off. **Create plan** → `MP-n` with its work orders.
  If it answers "Nothing to plan: everything due in the next 7 days is already scheduled", inject an anomaly first (step 1:40) or pick **Selected machines** with the machine that has an open anomaly.
- From chat, the same works in words: "Plan 5000 Housing-A by 25 Oct", "Maintenance plan for the whole plant next 7 days", each ending in a Confirm card.

## Extension, +3 minutes: talk to SARA (Window B)

Sign in as the owner. Use Chrome on `http://localhost:5173` (or HTTPS) and a headset. Machines, numbers and work order numbers differ from run to run.

- **Open (15 s).** Press **Ctrl Shift Space** (or the mic in the header), allow the microphone. The panel opens bottom right: "Connecting…", then "Listening… ask anything"; the orb moves with your voice.
  Talking point: "SARA's voice runs on Gemini Live through our server: the key never reaches the browser, and she uses exactly the tools and permissions of chat."
- **Ask (45 s).** "SARA, how many machines are running right now?" She queries the machines, puts KPI tiles on screen and says something like "Twelve of your twenty machines are running right now; three are idle and five are stopped." Talk over her to show barge-in.
- **Hindi (30 s).** "IMM 3 का vibration कैसा है?" She looks up IMM 3's live values and answers in Hindi with the unit; the language chip stays **Auto**.
- **A change by voice (60 s).** "Create a work order for Press 2 hydraulic leak, high priority." The Confirm card appears and she asks "Shall I go ahead?". Say "Yes, go ahead": the card turns **Confirmed** and she says the work order number. It is in Work Orders.
- **Plan by voice (45 s).** "Plan 5000 Housing-A parts due next Friday." She builds the production plan, sums it up (job cards, machines, verdict) and asks "Shall I go ahead?". Say "Yes" or tap **Confirm** to book it.
- **Chat history (30 s).** **Open in Chat**: the conversation has the mic badge, your words as messages, the tool trace, the tiles and the confirmed card. Type "export that list" to show text continues the same conversation.

**Mock rehearsal (`AI_MOCK=true`, no credits).** The mock cannot hear and plays a soft tone instead of a voice. Open the panel and use **Say something** in this order: How many machines are running right now? → IMM 3 का vibration कैसा है? (Hindi answer) → Create a work order for Press 2: hydraulic leak, high priority → Yes, go ahead (or type it) → Plan 5000 Housing-A parts due next Friday → Yes, go ahead → Open in Chat.

**Real run.** The key now in `.env` answers 401 "API key not valid": put a valid Gemini key with credits in `.env`, set `AI_MOCK=false`, restart the API (see below). On Superadmin → AI → Voice pick the model and fallback from the list (the list call is free), voice Kore, language Auto, 10 min; under Quotas give the voice model enough RPM and RPD (each session is one request, a reconnect another).

## Switching to real Gemini (once the key works and credits are OK)

1. In `sara/.env`, set `AI_MOCK=false`. Leave the key line as it is.
2. Restart the API: stop the server process (Ctrl+C in the `sara/server` terminal), then run `npm run dev` again. `.env` sits outside `src`, so `node --watch` does **not** reload it by itself.
3. In Superadmin, AI: the mock banner is gone. Click **Test** once on the Background tier to confirm the key; that is one real call.
4. Budget: one demo run costs about 1 scan call per tick that has new evidence, 1 investigation, 1 briefing regenerate and a few chat turns: a few dozen calls in all. The key is prepaid, so keep an eye on Quotas and usage today on the AI tab during the run. The Background tier never falls back into the chat models: a 429 skips the cycle.
5. To go back, set `AI_MOCK=true` and restart the same way.

## If something goes wrong

- "Request failed (502)" toast: the API is restarting. Retry after about 5 s.
- Simulator offline on the control panel (or the panel does not answer on 5090): restart `node src/index.js` in `sara-simulator`. It never seeds again.
- An old injection is still active: click Clear all in Active injections.
