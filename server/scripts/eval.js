/**
 * Agent eval (CMMS-AI-Agent-PROMPT §11/§13 + phase-4 CRUD cases): every conversation runs through the real
 * loop, router, tools and validators against a freshly seeded database, with the scripted mock model of
 * test/helpers/mockGemini.js standing in for Gemini (no API calls). Asserts the tool sequence, the blocks
 * and the confirmation flow; exits 1 on any failure.
 *
 *   node scripts/eval.js            # database sara_eval on MONGO_TEST_URI's host (dropped and reseeded)
 *   SARA_EVAL_DB=my_eval node scripts/eval.js
 */
process.env.AI_MOCK = 'true';
process.env.NODE_ENV = 'test';
try {
  process.loadEnvFile(new URL('../../.env', import.meta.url));
} catch {
  // CI passes variables directly
}
const dbName = process.env.SARA_EVAL_DB ?? 'sara_eval';
if (dbName === 'sara') throw new Error('The eval drops its database; never point it at "sara"');
// Same rule as test/helpers/setup.js: the database name replaces any path, `?options` stay.
const [hosts, options] = (process.env.MONGO_TEST_URI || 'mongodb://localhost:27017').split('?');
process.env.MONGO_URI = `${hosts.replace(/^([a-z+]+:\/\/[^/]+).*$/, '$1')}/${dbName}${options ? `?${options}` : ''}`;

const { influxEnabled } = await import('../src/config/influx.js');
const { runTurn } = await import('../src/agent/loop.js');
const { claimPendingAction } = await import('../src/agent/pendingActions.js');
const { AiConversation } = await import('../src/db/models/AiConversation.js');
const { contextFor, setupDatabase, teardownDatabase } = await import('../test/helpers/db.js');
const { clearScripts, recorder, refOf, resultOf, script } = await import('../test/helpers/mockGemini.js');
const { hasModule } = await import('../src/modules/registry.js');
const { demoChat } = await import('../src/ai/mockChat.js');

const TELEMETRY = new Set([
  'telemetry_fields',
  'telemetry_latest',
  'telemetry_series',
  'telemetry_status_timeline',
  'telemetry_shot_counts',
  'energy_consumption',
]);
const call = (name, args = {}) => ({ name, args });
const resolveAsset = (query) => call('resolve', { kind: 'asset', query });
const first = (responses, name = 'resolve') => resultOf(responses, name)?.matches?.[0]?.id;
const range = (text) => call('resolve_time_range', { text });

/**
 * A case: `text` (+ `who`), scripted `steps` (fresh per run; closures may keep state), the expected
 * `tools` in call order, `blocks` that must appear, `confirm` (then the continuation must run `after`),
 * `mayFail` tools allowed to return an error, `mentions` the final text must match, `followUp` reuses
 * the previous case's conversation.
 */
const CASES = [
  {
    name: '1 open work orders by priority',
    text: 'How many open work orders do we have, grouped by priority?',
    steps: () => [
      { calls: [call('work_orders_summary', { groupBy: 'priority' })] },
      ({ responses }) => ({
        calls: [
          call('render_kpis', {
            items: resultOf(responses, 'work_orders_summary')
              .rows.slice(0, 6)
              .map((r) => ({ label: String(r.priority), value: r.count })),
          }),
        ],
      }),
      { text: 'Open work orders by priority are shown above.' },
    ],
    tools: ['work_orders_summary', 'render_kpis'],
    blocks: ['kpis'],
  },
  {
    name: '2 high-priority overdue this week with assignees',
    text: 'Show high-priority work orders overdue this week with assignees.',
    steps: () => {
      let window;
      return [
        { calls: [range('this week')] },
        ({ responses }) => {
          window = resultOf(responses, 'resolve_time_range');
          return {
            calls: [
              call('mongo_find', {
                module: 'workorders',
                filter: {
                  priority: 'High',
                  workStatus: { $nin: ['Completed', 'Closed'] },
                  dueDate: { $gte: window.start, $lt: window.stop },
                },
                populate: ['people', 'asset'],
              }),
            ],
          };
        },
        ({ responses }) => ({
          calls: [
            call('render_table', {
              title: 'Overdue high-priority work orders',
              sourceRef: refOf(responses, 'mongo_find'),
            }),
          ],
        }),
        () => ({ text: `Here they are for ${window.label}.` }),
      ];
    },
    tools: ['resolve_time_range', 'mongo_find', 'render_table'],
    blocks: ['table'],
    mentions: /this week|\d{2}-\d{2}-\d{4}/i,
  },
  {
    name: '3 most downtime last month and why',
    text: 'Which assets had the most downtime last month, and why?',
    steps: () => {
      let window;
      return [
        { calls: [range('last month')] },
        ({ responses }) => {
          window = resultOf(responses, 'resolve_time_range');
          return {
            calls: [
              call('downtime_summary', { start: window.start, stop: window.stop, groupBy: 'asset' }),
              call('downtime_summary', { start: window.start, stop: window.stop, groupBy: 'reason' }),
            ],
          };
        },
        ({ responses }) => ({
          calls: [
            call('render_table', {
              title: 'Downtime by asset',
              sourceRef: refOf(responses, 'downtime_summary'),
            }),
          ],
        }),
        () => ({ text: `Downtime for ${window.label}: the table shows the worst assets.` }),
      ];
    },
    tools: ['resolve_time_range', 'downtime_summary', 'downtime_summary', 'render_table'],
    blocks: ['table'],
    mentions: /last month|\d{2}-\d{4}|[A-Z][a-z]{2,8} 2026/,
  },
  {
    name: '4 energy of Compressor 2 today vs yesterday',
    text: 'Energy consumption of Compressor 2 today vs yesterday?',
    steps: () => {
      const s = {};
      return [
        { calls: [resolveAsset('Compressor 2'), range('today'), range('yesterday')] },
        ({ responses }) => {
          s.asset = first(responses);
          const [today, yesterday] = responses
            .filter((r) => r.name === 'resolve_time_range')
            .map((r) => r.response.result);
          s.today = today;
          return {
            calls: [
              call('energy_consumption', { assetIds: [s.asset], start: today.start, stop: today.stop }),
              call('energy_consumption', {
                assetIds: [s.asset],
                start: yesterday.start,
                stop: yesterday.stop,
              }),
            ],
          };
        },
        ({ responses }) => {
          const [a, b] = responses.map((r) => r.response.result?.totalKwh ?? 0);
          return {
            calls: [
              call('render_kpis', {
                items: [
                  { label: 'Today', value: a, unit: 'kWh', delta: a - b },
                  { label: 'Yesterday', value: b, unit: 'kWh' },
                ],
              }),
            ],
          };
        },
        () => ({ text: `Energy for ${s.today.label} compared with yesterday.` }),
      ];
    },
    tools: [
      'resolve',
      'resolve_time_range',
      'resolve_time_range',
      'energy_consumption',
      'energy_consumption',
      'render_kpis',
    ],
    blocks: ['kpis'],
    mentions: /today/i,
  },
  {
    name: '5 plot oil temperature of Press 1',
    text: 'Plot the oil temperature of Press 1 for the last 2 hours.',
    steps: () => {
      const s = {};
      return [
        { calls: [resolveAsset('Press 1'), range('last 2 hours')] },
        ({ responses }) => {
          s.asset = first(responses);
          s.window = resultOf(responses, 'resolve_time_range');
          return { calls: [call('telemetry_fields', { assetId: s.asset })] };
        },
        ({ responses }) => {
          const fields = resultOf(responses, 'telemetry_fields')?.rows ?? [];
          const field =
            fields.find((f) => /oil/i.test(f.field) && /temp/i.test(f.field))?.field ??
            fields[0]?.field ??
            'oilTemp';
          return {
            calls: [
              call('telemetry_series', {
                assetIds: [s.asset],
                fields: [field],
                start: s.window.start,
                stop: s.window.stop,
              }),
            ],
          };
        },
        () => ({ text: `Oil temperature for ${s.window.label} is charted above.` }),
      ];
    },
    tools: ['resolve', 'resolve_time_range', 'telemetry_fields', 'telemetry_series'],
    mentions: /last 2 hours/i,
  },
  {
    name: '6 spare parts below minimum',
    text: 'Which spare parts are below minimum stock and who supplies them?',
    steps: () => [
      { calls: [call('spare_parts_below_minimum')] },
      ({ responses }) => ({
        calls: [
          call('render_table', {
            title: 'Below minimum',
            sourceRef: refOf(responses, 'spare_parts_below_minimum'),
          }),
        ],
      }),
      { text: 'These parts need reordering.' },
    ],
    tools: ['spare_parts_below_minimum', 'render_table'],
    blocks: ['table'],
  },
  {
    name: '7 PMs and calibrations due in 7 days',
    text: 'List PMs and calibrations due in the next 7 days with assignees.',
    steps: () => [
      { calls: [call('upcoming_maintenance', { days: 7 })] },
      ({ responses }) =>
        resultOf(responses, 'upcoming_maintenance')?.count
          ? {
              calls: [
                call('render_table', {
                  title: 'Due in 7 days',
                  sourceRef: refOf(responses, 'upcoming_maintenance'),
                }),
              ],
            }
          : { text: 'Nothing is due in the next 7 days.' },
      { text: 'Here is what is due in the next 7 days.' },
    ],
    tools: ['upcoming_maintenance', '...'],
  },
  {
    name: '8 create a work order for Chiller 1 (confirm)',
    text: 'Create a work order for Chiller 1: coolant leak, high priority, due tomorrow, assign to Ramesh.',
    steps: () => [
      {
        calls: [
          resolveAsset('Chiller 1'),
          call('resolve', { kind: 'user', query: 'Ramesh' }),
          range('tomorrow'),
        ],
      },
      ({ responses }) => ({
        calls: [
          call('create_record', {
            module: 'workorders',
            items: [
              {
                name: 'Coolant leak',
                asset: first(responses),
                priority: 'High',
                dueDate: resultOf(responses, 'resolve_time_range').start,
                people: [responses[1].response.result.matches[0].id],
              },
            ],
          }),
        ],
      }),
      ({ responses }) => ({
        text: `Created ${responses[0].response.result?.created?.[0]?.label ?? '?'} (${responses[0].response.result?.created?.[0]?.link}).`,
      }),
    ],
    tools: ['resolve', 'resolve', 'resolve_time_range', 'create_record'],
    blocks: ['confirm'],
    confirm: true,
    after: ['create_record'],
    mentions: /Created WO-\d+.*\/m\/workorders\//,
  },
  {
    name: '9 OEE of JC-12 vs target',
    text: 'What is the OEE of job card JC-12 and how does it compare with its target?',
    steps: () => [
      { calls: [call('job_card_progress', { jobCard: 'JC-12' })] },
      { text: 'JC-12 progress is above.' },
    ],
    tools: ['job_card_progress'],
  },
  {
    name: '10 why was Machine 3 stopped yesterday 2-4 pm',
    text: 'Why was Machine 3 stopped yesterday between 2 and 4 pm?',
    steps: () => {
      const s = {};
      return [
        { calls: [resolveAsset('Machine 3'), range('yesterday between 2 and 4 pm')] },
        ({ responses }) => {
          s.asset = first(responses);
          s.window = resultOf(responses, 'resolve_time_range');
          const when = { $gte: s.window.start, $lt: s.window.stop };
          return {
            calls: [
              call('telemetry_status_timeline', {
                assetId: s.asset,
                start: s.window.start,
                stop: s.window.stop,
              }),
              call('mongo_find', {
                module: 'downtimes',
                filter: {
                  assetId: s.asset,
                  startedAt: { $lt: s.window.stop },
                  $or: [{ endedAt: { $gte: s.window.start } }, { endedAt: { $exists: false } }],
                },
              }),
              call('mongo_find', { module: 'workorders', filter: { asset: s.asset, createdAt: when } }),
            ],
          };
        },
        () => ({
          text: `For ${s.window.label}: the timeline, downtime and work orders above explain the stop.`,
        }),
      ];
    },
    tools: ['resolve', 'resolve_time_range', 'telemetry_status_timeline', 'mongo_find', 'mongo_find'],
    mentions: /14:00|2 ?pm|yesterday/i,
  },
  {
    name: '11 shift A rejections yesterday',
    text: 'How many parts did shift A reject yesterday and what were the top reasons?',
    steps: () => {
      let window;
      return [
        { calls: [range('shift A yesterday')] },
        ({ responses }) => {
          window = resultOf(responses, 'resolve_time_range');
          return {
            calls: [call('rejection_summary', { start: window.start, stop: window.stop, groupBy: 'reason' })],
          };
        },
        () => ({ text: `Rejections in ${window.label}.` }),
      ];
    },
    tools: ['resolve_time_range', 'rejection_summary'],
    mentions: /shift A/i,
  },
  {
    name: '12 who checked in today',
    text: 'Who checked in today and how much break time did each take?',
    steps: () => {
      let window;
      return [
        { calls: [call('load_tools', { groups: ['people'] }), range('today')] },
        ({ responses }) => {
          window = resultOf(responses, 'resolve_time_range');
          return { calls: [call('attendance_summary', { start: window.start, stop: window.stop })] };
        },
        () => ({ text: `Attendance for ${window.label}.` }),
      ];
    },
    tools: ['load_tools', 'resolve_time_range', 'attendance_summary'],
    mentions: /today/i,
  },
  {
    name: '13 maintenance last quarter + CSV',
    text: 'Summarise maintenance activity for the last quarter and give me a CSV.',
    steps: () => {
      let window;
      return [
        { calls: [range('last quarter')] },
        ({ responses }) => {
          window = resultOf(responses, 'resolve_time_range');
          return {
            calls: [
              call('work_orders_summary', {
                groupBy: 'status',
                scope: 'all',
                start: window.start,
                stop: window.stop,
              }),
              call('work_orders_summary', {
                groupBy: 'asset',
                scope: 'all',
                start: window.start,
                stop: window.stop,
              }),
            ],
          };
        },
        ({ responses }) => ({
          calls: [
            call('export_csv', { name: 'maintenance-last-quarter', sourceRef: responses[1].response.ref }),
          ],
        }),
        () => ({ text: `Maintenance for ${window.label}; the CSV is attached.` }),
      ];
    },
    tools: ['resolve_time_range', 'work_orders_summary', 'work_orders_summary', 'export_csv'],
    blocks: ['file'],
    mentions: /Q[1-4] 2026|quarter/i,
  },
  {
    name: '14 automation rules on Furnace 2',
    text: 'Which automation rules are enabled on Furnace 2 and when did they last fire?',
    steps: () => [
      { calls: [resolveAsset('Furnace 2')] },
      ({ responses }) => ({
        calls: [
          call('mongo_find', {
            module: 'workflowrules',
            filter: { assets: first(responses), isEnabled: true },
          }),
        ],
      }),
      { text: 'Here are the automation rules of Furnace 2.' },
    ],
    tools: ['resolve', 'mongo_find'],
    mayFail: hasModule('workflowrules') ? [] : ['mongo_find'], // the rules module arrives in a later phase
  },
  {
    name: '15a follow-up base',
    text: 'Show open work orders by asset',
    steps: () => [
      { calls: [call('work_orders_summary', { groupBy: 'asset' })] },
      { text: 'Open work orders by asset.' },
    ],
    tools: ['work_orders_summary'],
  },
  {
    name: '15b follow-up "and last week?" sees the previous turn',
    text: 'and last week?',
    followUp: true,
    steps: () => {
      let window;
      return [
        { calls: [range('last week')] },
        ({ responses }) => {
          window = resultOf(responses, 'resolve_time_range');
          return {
            calls: [
              call('work_orders_summary', {
                groupBy: 'asset',
                scope: 'all',
                start: window.start,
                stop: window.stop,
              }),
            ],
          };
        },
        () => ({ text: `Same view for ${window.label}.` }),
      ];
    },
    tools: ['resolve_time_range', 'work_orders_summary'],
    mentions: /last week/i,
    historyTurns: 2,
  },
  {
    name: '15c follow-up "export that"',
    text: 'export that',
    followUp: true,
    steps: () => [
      { calls: [call('work_orders_summary', { groupBy: 'asset' })] },
      ({ responses }) => ({
        calls: [
          call('export_csv', {
            name: 'work-orders-by-asset',
            sourceRef: refOf(responses, 'work_orders_summary'),
          }),
        ],
      }),
      { text: 'Exported.' },
    ],
    tools: ['work_orders_summary', 'export_csv'],
    blocks: ['file'],
    historyTurns: 3,
  },
  {
    name: '16 status of all energy assets',
    text: "What's the current status of all energy assets?",
    steps: () => [
      {
        calls: [
          call('mongo_find', {
            module: 'assets',
            filter: { isEnergyAsset: true },
            projection: ['name', 'assetStatus', 'typeOfAsset'],
          }),
        ],
      },
      ({ responses }) => ({
        calls: [
          call('telemetry_latest', {
            assetIds: resultOf(responses, 'mongo_find')
              .rows.slice(0, 20)
              .map((r) => r._id),
          }),
        ],
      }),
      ({ responses }) => ({
        calls: [
          call('render_table', { title: 'Energy assets', sourceRef: refOf(responses, 'telemetry_latest') }),
        ],
      }),
      { text: 'Current status of the energy assets.' },
    ],
    tools: ['mongo_find', 'telemetry_latest', 'render_table'],
    blocks: ['table'],
  },
  {
    name: '17 mark WO-42 completed (confirm)',
    text: 'Mark WO-42 as completed, note: replaced bearing.',
    steps: () => [
      {
        calls: [
          call('update_work_order_status', {
            workOrder: 'WO-42',
            workStatus: 'Completed',
            note: 'Replaced bearing',
          }),
        ],
      },
      ({ responses }) =>
        responses[0].response.error
          ? {
              calls: [
                call('update_work_order_status', {
                  workOrder: 'WO-42',
                  workStatus: 'In Progress',
                  note: 'Starting the bearing job',
                }),
              ],
            }
          : { text: 'Done.' },
      ({ responses }) => ({
        text: `WO-42 is now ${responses[0].response.result?.workStatus ?? 'unchanged'}.`,
      }),
    ],
    tools: ['update_work_order_status', '...'],
    blocks: ['confirm'],
    confirm: true,
    after: ['update_work_order_status'],
    mayFail: ['update_work_order_status'], // Open → Completed is not a legal move; the model then picks the next one
  },
  {
    name: '18 viewer asks to create a work order',
    who: 'viewer_1@acme.test',
    text: 'Create a work order for Chiller 1: coolant leak, high priority, due tomorrow, assign to Ramesh.',
    steps: () => [
      { calls: [call('create_record', { module: 'workorders', items: [{ name: 'Coolant leak' }] })] },
      ({ responses }) => ({
        text: /not available/.test(responses[0].response.error ?? '')
          ? 'Your role can only view records, so I cannot create work orders. Here is a draft you can pass on: Coolant leak on Chiller 1, high priority, due tomorrow, Ramesh.'
          : 'unexpected',
      }),
    ],
    tools: ['create_record'],
    mayFail: ['create_record'],
    mentions: /cannot create work orders.*draft/,
  },
  {
    name: 'CRUD update a spare part minimum (confirm)',
    text: 'Set the minimum stock of Bearing 6205-2RS to 12',
    steps: () => [
      { calls: [call('resolve', { kind: 'spare_part', query: 'Bearing 6205-2RS' })] },
      ({ responses }) => ({
        calls: [
          call('update_record', {
            module: 'spareparts',
            updates: [{ id: first(responses), data: { minimumQuantity: 12 } }],
          }),
        ],
      }),
      ({ responses }) => ({ text: `Updated ${responses[0].response.result?.updated?.[0]?.label}.` }),
    ],
    tools: ['resolve', 'update_record'],
    blocks: ['confirm'],
    confirm: true,
    after: ['update_record'],
    mentions: /Updated .*Bearing/,
  },
  {
    name: 'CRUD bulk create two requests (confirm)',
    text: 'Add two maintenance requests: oil drip at Press 1 and noisy fan at Compressor 2',
    steps: () => [
      { calls: [resolveAsset('Press 1'), resolveAsset('Compressor 2')] },
      ({ responses }) => ({
        calls: [
          call('create_record', {
            module: 'requests',
            items: [
              {
                name: 'Oil drip',
                asset: responses[0].response.result.matches[0].id,
                allocationType: 'Asset',
              },
              {
                name: 'Noisy fan',
                asset: responses[1].response.result.matches[0].id,
                allocationType: 'Asset',
              },
            ],
          }),
        ],
      }),
      ({ responses }) => ({
        text: `Created ${responses[0].response.result?.created?.length ?? 0} requests.`,
      }),
    ],
    tools: ['resolve', 'resolve', 'create_record'],
    blocks: ['confirm'],
    confirm: true,
    after: ['create_record'],
    mentions: /Created 2 requests/,
  },
  {
    name: 'CRUD delete a consumable (confirm)',
    text: 'Delete the consumable Cotton Waste, it is a duplicate',
    steps: () => [
      {
        calls: [
          call('mongo_find', {
            module: 'consumables',
            filter: { name: 'Cotton Waste' },
            projection: ['name'],
          }),
        ],
      },
      ({ responses }) => ({
        calls: [
          call('delete_record', {
            module: 'consumables',
            ids: [resultOf(responses, 'mongo_find').rows[0]._id],
            reason: 'Duplicate',
          }),
        ],
      }),
      ({ responses }) => ({ text: `Deleted ${responses[0].response.result?.deleted?.length ?? 0}.` }),
    ],
    tools: ['mongo_find', 'delete_record'],
    blocks: ['confirm'],
    confirm: true,
    after: ['delete_record'],
    mentions: /Deleted 1/,
  },
  // Phase 5–6 demo questions, driven by the built-in demo flows (src/ai/mockChat.js) instead of a
  // per-case script: the same mock model the dev server runs with AI_MOCK=true.
  {
    name: 'P5-1 plan 5000 Housing-A by 25 Oct (confirm)',
    demo: true,
    text: 'Plan 5000 parts of Housing-A due 25 Oct',
    tools: ['plan_production', 'check_plan', 'apply_plan'],
    blocks: ['plan', 'confirm'],
    confirm: true,
    after: ['apply_plan'],
    mentions: /Applied \*\*PLN-\d+\*\*: 4 created/,
  },
  {
    name: 'P5-2 plan maintenance for Press 1 (confirm)',
    demo: true,
    text: 'Plan maintenance for Press 1 in the next 30 days',
    tools: ['resolve', 'plan_maintenance', 'apply_plan'],
    blocks: ['plan', 'confirm'],
    confirm: true,
    after: ['apply_plan'],
    // The fixture's PM falls due at a fixed date: near it the recommendation becomes the move option (more records).
    mentions: /Applied \*\*PLN-\d+\*\*: \d+ created/,
  },
  {
    name: 'P7-1 maintenance plan for the whole plant (confirm)',
    demo: true,
    text: 'Maintenance plan for the whole plant next 30 days',
    tools: ['plan_maintenance', 'apply_plan'],
    blocks: ['plan', 'confirm'],
    confirm: true,
    after: ['apply_plan'],
    mentions: /Applied \*\*PLN-\d+\*\*: \d+ created/,
  },
  {
    name: 'P5-3 cost alert for Compressor 2 (confirm)',
    demo: true,
    text: 'Alert me if Compressor 2 energy cost > ₹3000/day',
    tools: ['resolve', 'create_record'],
    blocks: ['confirm'],
    confirm: true,
    after: ['create_record'],
    mentions: /is on/,
  },
  {
    name: 'P5-4 compressor energy heatmap KPI (confirm)',
    demo: true,
    text: 'Build a heatmap of compressor energy by hour',
    tools: ['mongo_find', 'create_kpi'],
    blocks: ['confirm'],
    confirm: true,
    after: ['create_kpi'],
    mentions: /KPI Builder/,
  },
  {
    name: 'P5-5 maintenance cost by asset this month',
    demo: true,
    text: 'Maintenance cost by asset this month',
    tools: ['resolve_time_range', 'cost_summary', 'render_table'],
    blocks: ['chart', 'table'],
    mentions: /Maintenance cost for this month \(\d{2}-\d{2}-\d{4}/,
  },
  {
    name: 'P5-6 KPI page chip: OEE by machine (confirm)',
    demo: true,
    text: 'OEE by machine this week as a bar chart with a target of 85%',
    context: { page: 'kpis' },
    tools: ['create_kpi'],
    blocks: ['confirm'],
    confirm: true,
    after: ['create_kpi'],
  },
  {
    name: 'P5-7 chat starter: work order for IMM 3 (confirm)',
    demo: true,
    text: 'Create a work order for IMM 3: coolant leak, high priority, due tomorrow',
    tools: ['resolve', 'resolve_time_range', 'create_record'],
    blocks: ['confirm'],
    confirm: true,
    after: ['create_record'],
    mentions: /Done: \*\*\[WO-\d+/,
  },
  {
    name: 'P5-8 chat starter: machines that need attention',
    demo: true,
    text: 'Which machines need attention right now, and why?',
    tools: ['list_anomalies', 'mongo_find', '...'],
    mentions: /attention/,
  },
  {
    name: 'P5-9 demo: update an asset field (confirm)',
    demo: true,
    text: 'Set Press 1 criticality to High',
    tools: ['resolve', 'mongo_find', 'update_record'],
    blocks: ['confirm'],
    confirm: true,
    after: ['update_record'],
    mentions: /now has criticality set to \*\*High\*\*/,
  },
  {
    name: 'P5-10 demo: update a spare part minimum (confirm)',
    demo: true,
    text: 'Set the minimum stock of spare part Bearing 6205-2RS to 14',
    tools: ['resolve', 'mongo_find', 'update_record'],
    blocks: ['confirm'],
    confirm: true,
    after: ['update_record'],
    mentions: /minimum stock set to \*\*14\*\*/,
  },
  {
    name: 'P5-11 demo: delete a consumable (confirm)',
    demo: true,
    text: 'Delete the consumable Mould Release Spray, it is a duplicate',
    tools: ['mongo_find', 'delete_record'],
    blocks: ['confirm'],
    confirm: true,
    after: ['delete_record'],
    mentions: /Mould Release Spray is deleted/,
  },
  {
    name: 'P5-12 demo: bulk create two work orders (confirm)',
    demo: true,
    text: 'Create 2 work orders: oil leak at Press 1 and noisy fan at Compressor 2',
    tools: ['resolve', 'resolve', 'create_record'],
    blocks: ['confirm'],
    confirm: true,
    after: ['create_record'],
    mentions: /Done: \*\*\[WO-\d+.* and \*\*\[WO-\d+.* are open/,
  },
];

/** Compares the called tool names with the expectation; `'...'` matches any tail. */
const sameSequence = (got, want) => {
  const wild = want.at(-1) === '...';
  const head = wild ? want.slice(0, -1) : want;
  return wild
    ? head.every((n, i) => got[i] === n)
    : got.length === head.length && head.every((n, i) => got[i] === n);
};

const run = async () => {
  await setupDatabase();
  const contexts = new Map();
  const ctxFor = async (email) => {
    if (!contexts.has(email)) contexts.set(email, await contextFor(email));
    return contexts.get(email);
  };
  const llm = await import('../src/agent/llm.js');
  const gemini = await import('../src/ai/gemini.js');
  let lastContents = [];
  llm.setLlm({
    generate: gemini.generate,
    generateStream: (args) => {
      lastContents = args.contents;
      return gemini.generateStream(args);
    },
  });

  let conversation = null;
  const failures = [];
  for (const c of CASES) {
    const problems = [];
    const ctx = await ctxFor(c.who ?? 'owner_1@acme.test');
    clearScripts();
    demoChat.enabled = Boolean(c.demo);
    if (!c.demo) script(() => true, c.steps());
    if (!c.followUp || !conversation) {
      conversation = (
        await AiConversation.create({ companyId: ctx.companyId, userId: ctx.userId })
      ).toObject();
    }
    const sse = recorder();
    const started = Date.now();
    let outcome = await runTurn({ ctx, conversation, userText: c.text, sse, context: c.context });
    const toolNames = sse.of('tool_call').map((e) => e.name);
    if (!sameSequence(toolNames, c.tools))
      problems.push(`tools ${toolNames.join(' → ')} ≠ ${c.tools.join(' → ')}`);
    const failed = sse
      .of('tool_result')
      .filter(
        (r) => !r.ok && !(c.mayFail ?? []).includes(r.name) && !(TELEMETRY.has(r.name) && !influxEnabled),
      );
    if (failed.length)
      problems.push(`failed tools: ${failed.map((r) => `${r.name} (${r.error})`).join('; ')}`);
    const blocks = sse.of('block').map((b) => b.type);
    for (const b of c.blocks ?? [])
      if (!blocks.includes(b)) problems.push(`missing ${b} block (got ${blocks.join(', ') || 'none'})`);
    if (c.historyTurns) {
      const userTexts = lastContents.filter((x) => x.role === 'user' && x.parts.some((p) => p.text)).length;
      if (userTexts < c.historyTurns)
        problems.push(`history has ${userTexts} user turns, expected ${c.historyTurns}`);
    }
    if (c.confirm) {
      const confirm = sse.of('block').find((b) => b.type === 'confirm');
      if (outcome.status !== 'awaiting_confirmation' || !confirm)
        problems.push(`expected a confirmation, got ${outcome.status}`);
      else {
        const claimed = await claimPendingAction({ ctx, conversation, actionId: confirm.payload.actionId });
        const next = recorder();
        outcome = await runTurn({ ctx, conversation, sse: next, continuation: claimed });
        const after = next.of('tool_result');
        if (
          !sameSequence(
            after.map((r) => r.name),
            c.after,
          )
        )
          problems.push(`continuation tools ${after.map((r) => r.name).join(' → ')}`);
        const bad = after.filter((r) => !r.ok);
        if (bad.length)
          problems.push(`confirmed write failed: ${bad.map((r) => r.error ?? r.summary).join('; ')}`);
      }
    }
    if (outcome.status !== 'complete') problems.push(`status ${outcome.status}`);
    if (c.mentions && !c.mentions.test(outcome.text))
      problems.push(`final text "${outcome.text}" does not match ${c.mentions}`);
    const ms = Date.now() - started;
    console.log(
      `${problems.length ? 'FAIL' : 'ok  '} ${c.name} (${ms} ms)${problems.length ? `\n     ${problems.join('\n     ')}` : ''}`,
    );
    if (problems.length) failures.push(c.name);
  }
  llm.setLlm(null);
  console.log(
    `\n${CASES.length - failures.length}/${CASES.length} passed${influxEnabled ? '' : ' (InfluxDB not configured: telemetry tool errors tolerated)'}`,
  );
  return failures.length;
};

let code = 1;
try {
  code = (await run()) ? 1 : 0;
} catch (err) {
  console.error(err);
} finally {
  await teardownDatabase().catch(() => {});
}
process.exit(code);
