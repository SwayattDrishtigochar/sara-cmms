import { badRequest, forbidden } from '../../lib/errors.js';

/**
 * AI-native modules of phases 5–6 (docs/phase5-contracts.md §2): plan proposals (F1/F2), cost alerts (F5)
 * and KPIs (F6/F9). Proposals and KPIs are written by their engines/tools only; cost alerts come from chat
 * through the generic write tools.
 */

export const KPI_VIZ = [
  'number',
  'gauge',
  'line',
  'area',
  'bar',
  'stackedBar',
  'combo',
  'pie',
  'scatter',
  'radar',
  'funnel',
  'treemap',
  'heatmap',
  'timeline',
  'table',
];
export const COST_METRICS = ['energy', 'spares', 'consumables', 'labour', 'downtime', 'maintenance', 'total'];
export const PROPOSAL_STATUSES = ['draft', 'applying', 'applied', 'discarded', 'stale', 'expired', 'failed'];
const SEVERITIES = ['info', 'warning', 'critical'];

/** A cost alert names what it watches: an asset for scope asset, a plant for scope plant. */
const checkAlertScope = (alert) => {
  const scope = alert.scope ?? 'asset';
  if (scope === 'asset' && !alert.assetId) throw badRequest('Pick the asset this alert watches (assetId)');
  if (scope === 'plant' && !alert.plantId) throw badRequest('Pick the plant this alert watches (plantId)');
};
/** Proposals are written by planning/proposals.js through the Model only, never by the generic routes. */
const engineOnly = () => {
  throw forbidden('Plan proposals are made by the SARA planner; use the Planner page or the assistant');
};
/** KPIs come from the create_kpi / update_kpi tools (records called with source 'kpi'); delete stays generic. */
const kpiToolsOnly = ({ opts }) => {
  if (opts?.source !== 'kpi')
    throw forbidden('KPIs are built by the SARA assistant; ask it to create or change one');
};
const costAlertHooks = {
  beforeCreate: ({ doc }) => checkAlertScope(doc),
  beforeUpdate: ({ existing, patch }) => checkAlertScope({ ...existing, ...patch }),
};

/** AI text stamp shared by proposals and KPIs. */
const aiText = {
  type: 'object',
  readOnly: true,
  fields: {
    text: { type: 'text' },
    model: { type: 'string' },
    at: { type: 'date' },
    mock: { type: 'boolean' },
  },
};

export default [
  {
    name: 'planproposals',
    model: 'PlanProposal',
    label: 'Plan Proposals',
    singular: 'Plan proposal',
    group: 'AI',
    icon: 'CalendarRange',
    description:
      'Production and maintenance plans proposed by the SARA planners, waiting to be confirmed or already applied.',
    agentNotes:
      'Read only here: create them with plan_production / plan_maintenance and apply them with apply_plan.',
    plantScoped: true,
    softDelete: false,
    agentWritable: false,
    counter: { type: 'PlanProposal', prefix: 'PLN-', field: 'proposalCode' },
    codeField: 'proposalCode',
    titleField: 'title',
    list: ['proposalCode', 'kind', 'title', 'status', 'feasibility', 'createdAt'],
    search: ['proposalCode', 'title'],
    indexes: [[{ companyId: 1, status: 1, createdAt: -1 }]],
    hooks: { beforeCreate: engineOnly, beforeUpdate: engineOnly },
    // Every field is engine-managed (planning/proposals.js writes the Model directly).
    fields: {
      proposalCode: { type: 'string', readOnly: true, label: 'Plan #' },
      // production = part/quantity/due plan; maintenance = one task with push options; maintenance_plan = a
      // scope/horizon package of tasks with technicians (phase 7).
      kind: {
        type: 'enum',
        values: ['production', 'maintenance', 'maintenance_plan'],
        required: true,
        readOnly: true,
      },
      title: { type: 'string', readOnly: true },
      status: { type: 'enum', values: PROPOSAL_STATUSES, default: 'draft', readOnly: true },
      scheduleVersion: { type: 'number', readOnly: true, hidden: true },
      expiresAt: { type: 'date', readOnly: true },
      input: { type: 'mixed', readOnly: true, hidden: true },
      horizon: { type: 'object', readOnly: true, fields: { start: { type: 'date' }, end: { type: 'date' } } },
      productionPlanId: { type: 'ref', ref: 'productionplans', readOnly: true, label: 'Production plan' },
      maintenancePlanId: { type: 'ref', ref: 'maintenanceplans', readOnly: true, label: 'Maintenance plan' },
      anomalyId: { type: 'ref', ref: 'anomalies', readOnly: true, label: 'Anomaly' },
      assetIds: { type: 'refs', ref: 'assets', readOnly: true, label: 'Machines' },
      ops: {
        type: 'array',
        readOnly: true,
        hidden: true,
        rowIds: false,
        of: {
          seq: { type: 'number', required: true },
          op: { type: 'enum', values: ['create', 'update'], required: true },
          module: { type: 'string', required: true },
          id: { type: 'string' },
          label: { type: 'string' },
          data: { type: 'mixed' },
          before: { type: 'mixed' },
        },
      },
      diff: { type: 'mixed', readOnly: true, hidden: true },
      options: { type: 'mixed', readOnly: true, hidden: true },
      recommendedOption: { type: 'string', readOnly: true },
      feasibility: {
        type: 'object',
        readOnly: true,
        fields: {
          feasible: { type: 'boolean' },
          verdict: { type: 'enum', values: ['doable', 'adjust', 'not_doable'] },
          dueDate: { type: 'date' },
          projectedFinish: { type: 'date' },
          slackHours: { type: 'number', unit: 'h' },
          shortfall: { type: 'number', unit: 'pcs' },
          maxDelayHours: { type: 'number', unit: 'h' },
          notes: { type: 'text' },
        },
      },
      // Phase 7: the last check of the (possibly edited) plan: Issue[] and Adjustment[] (§3.4), and the
      // maintenance plan's metrics (§3.6). Mixed: the engines own the shapes.
      issues: { type: 'mixed', readOnly: true, hidden: true },
      adjustments: { type: 'mixed', readOnly: true, hidden: true },
      metrics: { type: 'mixed', readOnly: true, hidden: true },
      risks: {
        type: 'array',
        readOnly: true,
        rowIds: false,
        of: {
          kind: {
            type: 'enum',
            values: ['pm_due', 'anomaly', 'tool_life', 'no_capacity', 'late', 'deferred', 'other'],
          },
          severity: { type: 'enum', values: SEVERITIES, default: 'warning' },
          text: { type: 'string', max: 300 },
          assetId: { type: 'ref', ref: 'assets' },
        },
      },
      alternatives: {
        type: 'array',
        readOnly: true,
        rowIds: false,
        of: {
          kind: {
            type: 'enum',
            values: ['extra_shift', 'other_mould', 'partial_delivery', 'non_running_day', 'defer'],
          },
          text: { type: 'string', max: 300 },
          projectedFinish: { type: 'date' },
          extraParts: { type: 'number', unit: 'pcs' },
        },
      },
      explanation: aiText,
      appliedOption: { type: 'string', readOnly: true },
      appliedOps: { type: 'number', default: 0, readOnly: true, hidden: true },
      appliedAt: { type: 'date', readOnly: true },
      appliedBy: { type: 'ref', ref: 'users', readOnly: true },
      result: { type: 'mixed', readOnly: true, hidden: true },
      error: { type: 'text', readOnly: true },
    },
  },
  {
    name: 'costalerts',
    model: 'CostAlert',
    label: 'Cost Alerts',
    singular: 'Cost alert',
    group: 'Costs',
    icon: 'BellRing',
    description:
      'Alerts that fire when a cost (energy, spares, consumables, labour, downtime) crosses a threshold in a day, week or month.',
    agentNotes:
      'Create with create_record, e.g. "alert me if Compressor 2 energy cost > ₹3000/day" → { module: "costalerts", items: [{ name: "Compressor 2 energy > ₹3,000/day", metric: "energy", scope: "asset", assetId: "<resolve the asset first>", period: "day", comparator: "gt", threshold: 3000 }] }. threshold is money in the company currency for the whole period (not per hour); maintenance = spares + consumables + labour; scope "plant" needs plantId, "company" neither. The watch checks the period-to-date cost every 15 minutes and fires at most once per period. Pause with update_record { enabled: false }.',
    plantScoped: true,
    inheritPlantFrom: ['assetId'],
    list: [
      'name',
      'metric',
      'scope',
      'assetId',
      'period',
      'threshold',
      'enabled',
      'lastValue',
      'lastTriggeredAt',
    ],
    search: ['name'],
    sort: 'name',
    hooks: costAlertHooks,
    fields: {
      name: { type: 'string', required: true, max: 120 },
      metric: { type: 'enum', values: COST_METRICS, required: true },
      scope: { type: 'enum', values: ['company', 'plant', 'asset'], default: 'asset' },
      assetId: { type: 'ref', ref: 'assets', label: 'Asset', help: 'Required when scope is asset' },
      period: { type: 'enum', values: ['day', 'week', 'month'], default: 'day' },
      comparator: { type: 'enum', values: ['gt', 'gte', 'lt', 'lte'], default: 'gt' },
      threshold: { type: 'number', min: 0, required: true, unit: '₹' },
      enabled: { type: 'boolean', default: true },
      recipients: { type: 'refs', ref: 'users', help: 'Empty: owners and the plant admins' },
      notes: { type: 'text' },
      lastValue: { type: 'number', readOnly: true, unit: '₹', label: 'Period to date' },
      lastEvaluatedAt: { type: 'date', readOnly: true },
      lastTriggeredAt: { type: 'date', readOnly: true },
      lastPeriodKey: { type: 'string', readOnly: true, hidden: true },
      history: {
        type: 'array',
        readOnly: true,
        rowIds: false,
        maxItems: 60,
        of: {
          periodKey: { type: 'string' },
          value: { type: 'number' },
          threshold: { type: 'number' },
          triggeredAt: { type: 'date' },
          explanation: { type: 'text' },
          model: { type: 'string' },
          notificationId: { type: 'string' },
        },
      },
    },
  },
  {
    name: 'kpis',
    model: 'Kpi',
    label: 'KPIs',
    singular: 'KPI',
    group: 'AI',
    icon: 'Gauge',
    description: 'KPI cards built by the SARA assistant from read tools, with an AI insight line.',
    agentNotes:
      'Create and change them only with create_kpi / update_kpi (they validate the sources and show a live preview).',
    plantScoped: true,
    sharedWhenNoPlant: true, // plantId null = company-wide KPI, everyone reads it
    agentWritable: false,
    titleField: 'title',
    list: ['title', 'viz', 'unit', 'timeRange', 'pinned', 'updatedAt'],
    search: ['title', 'description'],
    sort: '-updatedAt',
    hooks: { beforeCreate: kpiToolsOnly, beforeUpdate: kpiToolsOnly },
    fields: {
      title: { type: 'string', required: true, max: 120 },
      description: { type: 'text', max: 1000 },
      viz: { type: 'enum', values: KPI_VIZ, required: true },
      unit: { type: 'string', max: 20 },
      target: { type: 'number' },
      thresholds: {
        type: 'object',
        fields: {
          warn: { type: 'number' },
          critical: { type: 'number' },
          direction: {
            type: 'enum',
            values: ['higher_is_better', 'lower_is_better'],
            default: 'higher_is_better',
          },
        },
      },
      timeRange: {
        type: 'object',
        fields: { text: { type: 'string', required: true, max: 120, default: 'last 7 days' } },
      },
      sources: {
        type: 'array',
        rowIds: false,
        maxItems: 4,
        of: {
          key: { type: 'string', required: true, pattern: '^[a-z][A-Za-z0-9_]{0,19}$' },
          tool: { type: 'string', required: true, max: 60 },
          args: { type: 'mixed' },
          pick: { type: 'string', max: 120 },
        },
      },
      formula: { type: 'string', max: 300 },
      encoding: {
        type: 'object',
        fields: {
          source: { type: 'string', max: 20 },
          x: { type: 'string', max: 80 },
          y: { type: 'string', max: 80 },
          value: { type: 'string', max: 80 },
          label: { type: 'string', max: 80 },
          start: { type: 'string', max: 80 },
          end: { type: 'string', max: 80 },
          series: {
            type: 'array',
            rowIds: false,
            maxItems: 6,
            of: {
              key: { type: 'string', required: true, max: 80 },
              label: { type: 'string', max: 80 },
              unit: { type: 'string', max: 20 },
              axis: { type: 'enum', values: ['left', 'right'], default: 'left' },
              type: { type: 'enum', values: ['line', 'bar', 'area'] },
            },
          },
          sort: { type: 'enum', values: ['none', 'asc', 'desc'], default: 'none' },
          limit: { type: 'number', min: 1, max: 1000 },
        },
      },
      pinned: { type: 'boolean', default: false, help: 'Shown on the Command Center' },
      insight: aiText,
    },
  },
];
