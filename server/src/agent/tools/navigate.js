import { z } from 'zod';
import { badRequest } from '../../lib/errors.js';
import { humanize } from '../../lib/format.js';
import { OBJECT_ID_PATTERN } from '../../modules/fields.js';
import { getModule, labelOf } from '../../modules/registry.js';
import { findByIdOrCode, linkTo, readableModule } from './common.js';
import { KINDS, resolveRecords } from './resolve.js';

/**
 * `open_page` (F3): opens an app page for the user, with filters. Every URL is app-relative and built from a
 * fixed path plus validated query values, never from free text, so the model cannot send the user anywhere else.
 */

export const PAGES = [
  'home',
  'machines',
  'machine',
  'anomalies',
  'planner',
  'costs',
  'kpis',
  'chat',
  'list',
  'record',
];
/** Fixed-page filters, as client/src/machines and client/src/anomalies read them from the URL. */
const ANOMALY_STATES = ['active', 'open', 'acknowledged', 'resolved', 'false_positive', 'all'];
const ANOMALY_SEVERITIES = ['critical', 'warning', 'info'];
const COST_PERIODS = ['day', 'week', 'month'];
const MAX_FILTERS = 5;
const MAX_LIST_FILTERS = 3; // ModuleListPage shows the first three enum columns as filters

const kindOf = (module) => Object.keys(KINDS).find((k) => KINDS[k] === module) ?? null;
const isId = (mod, value) => (mod.idType === 'string' ? value.length <= 80 : OBJECT_ID_PATTERN.test(value));

/** A value from the model matched to an enum, case-insensitively. */
const enumValue = (values, value, what) => {
  const hit = values.find((v) => v.toLowerCase() === String(value).trim().toLowerCase());
  if (!hit) throw badRequest(`"${value}" is not a ${what}`, { hint: `Values: ${values.join(', ')}` });
  return hit;
};

/** `{ id, label }` of a record given by id, code (WO-42) or name (IMM 3); names go through resolve. */
const recordOf = async (ctx, module, ref) => {
  const mod = readableModule(ctx, module);
  const value = String(ref ?? '').trim();
  if (!value) throw badRequest(`Give the ${mod.singular.toLowerCase()} id, code or name`);
  if (isId(mod, value) || (mod.codeField && /^[A-Z]{2,5}-\d+$/i.test(value))) {
    try {
      const doc = await findByIdOrCode(ctx, module, value);
      return { id: String(doc._id), label: labelOf(mod, doc) };
    } catch (err) {
      if (err.status !== 404) throw err;
    }
  }
  const kind = kindOf(module);
  if (!kind) throw badRequest(`${mod.singular} "${value}" not found; pass its id`);
  const { matches, needsDisambiguation } = await resolveRecords(ctx, { kind, query: value });
  if (!matches.length) throw badRequest(`No ${mod.singular.toLowerCase()} matches "${value}"`);
  if (needsDisambiguation) {
    throw badRequest(`Several ${mod.label.toLowerCase()} match "${value}"; ask the user which one`, {
      matches: matches.map((m) => ({ id: m.id, label: m.label })),
    });
  }
  return matches[0];
};

/** Query params and label parts of a module list's filters, validated against the list page's columns. */
const listFilters = (mod, filters, params) => {
  const columns = mod.list.filter((k) => mod.fields[k]?.type === 'enum').slice(0, MAX_LIST_FILTERS);
  const parts = [];
  for (const { field, value } of filters) {
    if (!columns.includes(field)) {
      throw badRequest(`"${field}" is not a filter on the ${mod.label} page`, {
        hint: columns.length ? `Filters: ${columns.join(', ')}` : 'This page has no filters; use q to search',
      });
    }
    const spec = mod.fields[field];
    const hit = enumValue(spec.values, value, spec.label ?? humanize(field));
    params.set(field, hit);
    parts.push(`${(spec.label ?? humanize(field)).toLowerCase()} ${hit}`);
  }
  return parts;
};

const sortParam = (mod, sort) => {
  const key = sort.replace(/^-/, '');
  const spec = key === 'createdAt' ? { type: 'date' } : mod.fields[key];
  if (!spec || ['refs', 'tags', 'array', 'object'].includes(spec.type)) {
    throw badRequest(`Cannot sort ${mod.label.toLowerCase()} by "${key}"`);
  }
  return sort;
};

const FIELD_ALIAS = { typeOfAsset: 'type', assetStatus: 'status' };

const fixedFilters = (page, filters, params) => {
  const parts = [];
  for (const { field: raw, value } of filters) {
    const field = FIELD_ALIAS[raw] ?? raw;
    if (page === 'machines' && field === 'type') {
      const hit = enumValue(getModule('assets').fields.typeOfAsset.values, value, 'machine type');
      params.set('type', hit);
      parts.push(hit);
    } else if (page === 'machines' && field === 'status') {
      const hit = enumValue(getModule('assets').fields.assetStatus.values, value, 'machine status');
      params.set('status', hit === 'ON' ? 'Running' : hit);
      parts.push(params.get('status').toLowerCase());
    } else if (page === 'anomalies' && field === 'state') {
      params.set('state', enumValue(ANOMALY_STATES, value, 'anomaly state'));
      parts.push(params.get('state').replace('_', ' '));
    } else if (page === 'anomalies' && field === 'severity') {
      params.set('severity', enumValue(ANOMALY_SEVERITIES, value, 'severity'));
      parts.push(params.get('severity'));
    } else {
      const allowed = { machines: 'type, status', anomalies: 'state, severity' }[page];
      throw badRequest(`"${field}" is not a filter on the ${page} page`, {
        hint: allowed ? `Filters: ${allowed}` : 'This page has no filters',
      });
    }
  }
  return parts;
};

/** `{ url, label }` for validated args; throws a 400 the model can act on. */
export const buildPage = async (ctx, args) => {
  const params = new URLSearchParams();
  const filters = args.filters ?? [];
  let path;
  let label;
  const parts = [];
  switch (args.page) {
    case 'home':
      path = '/';
      label = 'Command Center';
      break;
    case 'kpis':
      path = '/kpis';
      label = 'KPI Builder';
      break;
    case 'chat':
      path = '/chat';
      label = 'Chat';
      break;
    case 'costs':
      path = '/costs';
      label = 'Costs';
      if (args.period) {
        params.set('period', enumValue(COST_PERIODS, args.period, 'cost period'));
        parts.push({ day: 'today', week: 'this week', month: 'this month' }[params.get('period')]);
      }
      break;
    case 'machines':
      path = '/machines';
      label = 'Machines';
      parts.push(...fixedFilters('machines', filters, params));
      if (args.q) params.set('q', args.q);
      break;
    case 'anomalies': {
      path = '/anomalies';
      label = 'Anomalies';
      parts.push(...fixedFilters('anomalies', filters, params));
      if (args.assetId) {
        const asset = await recordOf(ctx, 'assets', args.assetId);
        params.set('asset', asset.id);
        parts.push(asset.label);
      }
      if (args.anomalyId) params.set('open', (await recordOf(ctx, 'anomalies', args.anomalyId)).id);
      if (args.q) params.set('q', args.q);
      break;
    }
    case 'planner': {
      path = '/planner';
      label = args.tab === 'maintenance' ? 'Maintenance planner' : 'Production planner';
      if (args.assetId) {
        const asset = await recordOf(ctx, 'assets', args.assetId);
        params.set('maintenance', asset.id);
        label = 'Maintenance planner';
        parts.push(asset.label);
        if (args.anomalyId) params.set('anomaly', (await recordOf(ctx, 'anomalies', args.anomalyId)).id);
      } else if (args.tab) params.set('tab', args.tab);
      break;
    }
    case 'machine': {
      const asset = await recordOf(ctx, 'assets', args.recordId ?? args.assetId);
      path = linkTo('assets', asset.id);
      label = asset.label;
      break;
    }
    case 'record': {
      if (!args.module) throw badRequest('record needs module and recordId');
      const rec = await recordOf(ctx, args.module, args.recordId);
      path = linkTo(args.module, rec.id);
      label = rec.label;
      break;
    }
    case 'list': {
      if (!args.module) throw badRequest('list needs module');
      if (args.module === 'assets') return buildPage(ctx, { ...args, page: 'machines' });
      const mod = readableModule(ctx, args.module);
      path = `/m/${mod.name}`;
      label = mod.label;
      parts.push(...listFilters(mod, filters, params));
      if (args.q) params.set('q', args.q);
      if (args.sort) params.set('sort', sortParam(mod, args.sort));
      break;
    }
    default:
      throw badRequest(`Unknown page "${args.page}"`);
  }
  if (filters.length && !['machines', 'anomalies', 'list'].includes(args.page)) {
    throw badRequest(`The ${args.page} page has no filters`);
  }
  if (args.q && !params.has('q')) throw badRequest(`The ${args.page} page has no search`);
  const query = params.toString();
  const url = `${path}${query ? `?${query}` : ''}`;
  if (!url.startsWith('/') || url.startsWith('//')) throw badRequest('Only app pages can be opened');
  return { url, label: [label, ...parts].join(' · ') };
};

const filter = z.object({
  field: z.string().min(1).max(60),
  value: z.string().min(1).max(120),
});

export const navigateTools = [
  {
    name: 'open_page',
    group: 'core',
    description:
      'Opens a page of the SARA app on the user\'s screen, with filters applied. Use it when the user asks to open, show, go to or take them to a page, a list or a record, or when a list is better explored on its page than in chat ("show me open high-priority work orders" → { page: "list", module: "workorders", filters: [{ field: "priority", value: "High" }, { field: "workStatus", value: "Open" }] }). Pages: home, machines (filters type, status; q), machine (recordId: id, tag or name such as "IMM 3"), anomalies (filters state, severity; assetId, anomalyId, q), planner (tab production|maintenance; assetId and anomalyId open the maintenance planner for that machine), costs (period day|week|month), kpis, chat, list (module + enum filters of its list page, q, sort e.g. "-dueDate"), record (module + recordId: id, code such as WO-42, or name). Names are resolved for you. The answer tells what is shown: say it in one short sentence.',
    schema: z.object({
      page: z.enum(PAGES),
      module: z.string().max(60).optional(),
      recordId: z.string().max(120).optional(),
      filters: z.array(filter).max(MAX_FILTERS).optional(),
      q: z.string().max(120).optional(),
      sort: z.string().max(60).optional(),
      tab: z.enum(['production', 'maintenance']).optional(),
      period: z.enum(COST_PERIODS).optional(),
      assetId: z.string().max(120).optional(),
      anomalyId: z.string().max(120).optional(),
      reason: z.string().max(160).optional().describe('One short clause for the user: why this page'),
    }),
    run: async (ctx, args) => {
      const { url, label } = await buildPage(ctx, args);
      return {
        forModel: { url, label, summary: `${label} is now open on the user's screen` },
        summary: `Opened ${label}`,
        blocks: [
          { type: 'navigate', payload: { url, label, ...(args.reason ? { reason: args.reason } : {}) } },
        ],
      };
    },
  },
];
