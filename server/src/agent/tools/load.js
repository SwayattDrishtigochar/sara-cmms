import { z } from 'zod';

/**
 * Tool groups a conversation can load on demand, with the one-line help the model and router see;
 * `core` is always sent (phase 4 §2). A new group is one line here plus its tools in registry.js.
 */
export const GROUP_HELP = {
  maintenance: 'work order summaries, spare parts below minimum, upcoming PMs and calibrations',
  production: 'job card progress, rejection and downtime summaries',
  telemetry: 'live machine values, time series, status timeline, shot counts, energy consumption and cost',
  health: 'AI health score and anomalies of a machine',
  people: 'attendance and breaks',
  write:
    'create, update, delete records; change work order status; add work order comments (always confirmed by the user)',
  planning:
    'machine capacity calendar, production plans by part, quantity and due date with operators per shift, maintenance plans for a plant or assets with technicians and production impact, single maintenance windows with push options, checking an edited plan, applying a plan (always confirmed by the user)',
  cost: 'cost summaries: energy, spare parts, consumables, labour and downtime by asset, plant, category or day',
  kpi: 'create, change and list KPI cards on the KPI Builder page (always confirmed by the user)',
};
export const LOADABLE_GROUPS = Object.keys(GROUP_HELP);

export const loadTools = [
  {
    name: 'load_tools',
    group: 'core',
    description: `Loads extra tool groups for the rest of this conversation. Call it as soon as a question needs a group that is not loaded. Groups: ${LOADABLE_GROUPS.map((g) => `${g} (${GROUP_HELP[g]})`).join('; ')}. Example: { groups: ["telemetry"] }.`,
    schema: z.object({ groups: z.array(z.enum(LOADABLE_GROUPS)).min(1).max(LOADABLE_GROUPS.length) }),
    // The loop adds the groups to the conversation and re-sends the declarations; this just answers.
    run: async (_ctx, { groups }) => ({
      forModel: { loaded: groups, note: 'The tools of these groups are now available' },
      summary: `Loaded ${groups.join(', ')}`,
    }),
  },
];
