import { costTools } from '../../costs/tools.js';
import { kpiTools } from '../../kpis/tools.js';
import { maintenancePlanningTools } from '../../planning/maintenanceTool.js';
import { planningTools } from '../../planning/tools.js';
import { healthTools } from './health.js';
import { GROUP_HELP, LOADABLE_GROUPS, loadTools } from './load.js';
import { mongoReadTools } from './mongo.read.js';
import { presentTools } from './present.js';
import { resolveTools } from './resolve.js';
import { summaryTools } from './summaries.js';
import { telemetryTools } from './telemetry.js';
import { writeTools } from './write.js';

/**
 * Every tool once (phase 4 §2): `{ name, group, description, schema, permission?, requiresConfirmation?,
 * preview?, run }`. `toolsFor(ctx, groups)` is what the model gets: core plus the loaded groups, filtered
 * by company features and the user's permission.
 */

export const allGroups = ['core', ...LOADABLE_GROUPS];
export { GROUP_HELP, LOADABLE_GROUPS };

const GROUP_FEATURE = { production: 'productionEnabled' };

const list = [
  ...resolveTools,
  ...mongoReadTools,
  ...presentTools,
  ...loadTools,
  ...summaryTools,
  ...telemetryTools,
  ...healthTools,
  ...writeTools,
  ...planningTools,
  ...maintenancePlanningTools,
  ...costTools,
  ...kpiTools,
];
const byName = new Map();
for (const tool of list) {
  if (byName.has(tool.name)) throw new Error(`Tool "${tool.name}" is defined twice`);
  if (!allGroups.includes(tool.group))
    throw new Error(`Tool "${tool.name}" has unknown group "${tool.group}"`);
  byName.set(tool.name, tool);
}

export const getTool = (name) => byName.get(name) ?? null;
export const allTools = () => [...byName.values()];

export const groupEnabled = (ctx, group) => {
  const feature = GROUP_FEATURE[group];
  return !feature || ctx.company?.features?.[feature] === true;
};

/** Tools the model may see: core + `groups`, minus groups the company lacks and tools the user may not use. */
export const toolsFor = (ctx, groups = []) => {
  const wanted = new Set(['core', ...groups]);
  return allTools().filter(
    (t) => wanted.has(t.group) && groupEnabled(ctx, t.group) && (!t.permission || t.permission(ctx)),
  );
};

/** Loadable groups that make sense for this user (feature on, at least one permitted tool). */
export const groupsFor = (ctx) =>
  LOADABLE_GROUPS.filter((g) => groupEnabled(ctx, g) && toolsFor(ctx, [g]).some((t) => t.group === g));
