import { isTest } from '../config/env.js';

/**
 * Demo flows of the mock chat model (AI_MOCK=true: no Gemini call). Every model turn re-reads the tool
 * calls made so far in this answer and picks the next step, so the real tools, confirmations and blocks
 * run as they would with Gemini: production and maintenance planning, cost alerts and summaries, KPI
 * cards, work orders, lookups and trends. Tests script the model themselves, so this is off there;
 * scripts/eval.js switches it on for its demo cases.
 */
export const demoChat = { enabled: !isTest };

// ---------- reading the question

const cap = (w) => w[0].toUpperCase() + w.slice(1).toLowerCase();
const ASSET = /\b(imm|cnc|press|compressor|chiller|furnace|boiler|pump|dryer|oven)[\s-]?0?(\d{1,2})\b/i;
/** "IMM 3", "Compressor 2", "Main Incomer" named in the text, or null. */
const assetIn = (text) => {
  const m = ASSET.exec(text);
  if (m) return `${m[1].length <= 3 ? m[1].toUpperCase() : cap(m[1])} ${Number(m[2])}`;
  return /main incomer/i.test(text) ? 'Main Incomer' : null;
};
const TYPE = /\b(compressors?|imms?|injection moulding|presses|press|cncs?|chillers?|furnaces?)\b/i;
/** A machine type the text talks about in general ("compressor energy", "the IMM machines"). */
const typeIn = (text) => {
  const w = TYPE.exec(text)?.[1].toLowerCase();
  if (!w) return null;
  if (w.startsWith('imm') || w.startsWith('inj')) return 'IMM';
  if (w.startsWith('press')) return 'Press';
  return w.startsWith('cnc') ? 'CNC' : cap(w.replace(/s$/, ''));
};
const RANGE =
  /\b(today|yesterday|this (?:shift|week|month|quarter|year)|last (?:shift|week|month|quarter|year)|current shift|(?:last|past) \d+ (?:minutes?|hours?|days?|weeks?|months?))\b/i;
const rangeIn = (text, fallback) => RANGE.exec(text)?.[1].toLowerCase().replace(/^past/, 'last') ?? fallback;
const codeIn = (text, prefix) =>
  new RegExp(`\\b${prefix}-\\d+\\b`, 'i').exec(text)?.[0].toUpperCase() ?? null;
const lakh = (n) => Math.round(n ?? 0).toLocaleString('en-IN');
/** "This month (…)" → "this month (…)" inside a sentence. */
const lc = (label = '') => label.replace(/^[A-Z](?=[a-z])/, (c) => c.toLowerCase());
const inr = (n) => (n == null ? '—' : `₹${lakh(n)}`);
const hours = (h) => `${Number(Number(h ?? 0).toFixed(1))} h`;
const list = (items) =>
  items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items.at(-1)}` : (items[0] ?? '');
const call = (name, args = {}) => ({ name, args });
const step = (thought, ...calls) => ({ thought, calls });
const REFUSED = /^(\w+) is not available to .+ \(role (\w+)\)$/;
/** A tool error in words for the user: a tool the role may not use is explained, not echoed. */
const errorText = (r) => {
  const refused = REFUSED.exec(r?.error ?? '');
  if (!refused) return r?.error;
  return `Your role (${refused[2]}) can't ${refused[1].replace(/_/g, ' ')}. Ask a manager or an admin, or tell me the details and I'll write them up for you to pass on.`;
};

/** The tool calls of this answer so far, each with the response the loop sent back. */
const callsOf = (contents) => {
  const calls = [];
  let open = [];
  let stepNo = 0;
  for (const c of contents) {
    const parts = c.parts ?? [];
    if (c.role === 'model') {
      const made = parts.filter((p) => p.functionCall);
      if (made.length) stepNo += 1;
      open = made.map((p) => ({ name: p.functionCall.name, args: p.functionCall.args ?? {}, step: stepNo }));
      calls.push(...open);
    } else {
      for (const p of parts.filter((x) => x.functionResponse)) {
        const pending = open.find((o) => o.name === p.functionResponse.name && !('response' in o));
        if (pending) pending.response = p.functionResponse.response ?? {};
      }
    }
  }
  return calls;
};

const stateOf = (text, calls, system = '') => {
  const page =
    /Page context: the user is on the (.+?) page(?: looking at [^"]*"([^"]+)" \((\w+) id ([0-9a-f]{24})\))?/.exec(
      system,
    );
  const last = (name) => calls.findLast((c) => c.name === name)?.response ?? null;
  return {
    text,
    t: text.toLowerCase(),
    calls,
    page: page?.[1] ?? null,
    record: page?.[3] ? { module: page[3], id: page[4], label: page[2] } : null,
    has: (name) => calls.some((c) => c.name === name),
    count: (name) => calls.filter((c) => c.name === name && c.response?.status !== 'failed').length,
    last,
    result: (name) => last(name)?.result ?? null,
    results: (name) => calls.filter((c) => c.name === name).map((c) => c.response?.result ?? null),
    ref: (name) => last(name)?.ref,
    lastStep: calls.filter((c) => c.step === calls.at(-1)?.step),
  };
};

/** First match of a resolve call (asset by default), or null. */
const matchOf = (s, query) =>
  s.calls.find((c) => c.name === 'resolve' && c.args.query === query)?.response?.result?.matches?.[0] ?? null;
const machineId = (s, name) => matchOf(s, name)?.id ?? (s.record?.module === 'assets' ? s.record.id : null);
const machineName = (s, name) =>
  matchOf(s, name)?.label?.split(' · ').pop() ??
  name ??
  (s.record?.module === 'assets' ? s.record.label : null);
const rangeOf = (s, i = 0) => s.results('resolve_time_range')[i] ?? {};
const confirmed = (s, name) => s.last(name)?.status === 'confirmed';

// ---------- KPI cards

/** Same encodings as the client viz: series charts share `x` + `series`, slice charts `label` + `value`. */
const SERIES_VIZ = ['bar', 'line', 'area', 'stackedBar', 'combo', 'scatter', 'radar'];
const SLICE_VIZ = ['pie', 'funnel', 'treemap'];
/** Recipes for the KPI page chips and the usual asks; `type` = the machines it reads by default. */
const KPI_RECIPES = [
  {
    re: /heat ?map|energy by hour|hourly energy/,
    type: 'Compressor',
    def: (s, ids, who, type) => ({
      title: `${type ?? who} energy by hour`,
      viz: 'heatmap',
      unit: 'kWh',
      timeRange: { text: rangeIn(s.t, 'last 7 days') },
      sources: [{ key: 'energy', tool: 'energy_consumption', args: { assetIds: ids, groupBy: 'hour' } }],
      encoding: { source: 'energy', x: 'hour', value: 'kwh' },
    }),
  },
  {
    re: /kwh per (?:part|shot|piece|pc)|energy per (?:part|shot|piece)/,
    type: 'IMM',
    def: (s, ids, who) => {
      const per = /shot/.test(s.t) ? 'shots' : 'produced';
      const pipeline = [
        { $match: { assetId: { $in: ids }, date: { $gte: '$start', $lt: '$stop' } } },
        { $group: { _id: null, [per]: { $sum: `$${per}` } } },
      ];
      return {
        title: `kWh per ${per === 'shots' ? 'shot' : 'part'} – ${who}`,
        description: `Energy of ${who} divided by the ${per === 'shots' ? 'shots' : 'parts'} it made.`,
        viz: 'number',
        unit: `kWh/${per === 'shots' ? 'shot' : 'pc'}`,
        thresholds: { direction: 'lower_is_better' },
        timeRange: { text: rangeIn(s.t, 'last 7 days') },
        sources: [
          { key: 'energy', tool: 'energy_consumption', args: { assetIds: ids } },
          { key: 'parts', tool: 'mongo_aggregate', args: { module: 'partcounts', pipeline } },
        ],
        formula: `round(sum(energy.kwh) / sum(parts.${per}), 3)`,
      };
    },
  },
  {
    re: /\boee\b/,
    def: (s) => {
      const gauge = /gauge|number|average|overall/.test(s.t);
      const pipeline = [
        { $match: { jobStatus: 'Completed', actualEnd: { $gte: '$start', $lt: '$stop' } } },
        { $group: { _id: '$asset', oee: { $avg: '$completionMetrics.oee.oee' } } },
        { $lookup: { from: 'assets', localField: '_id', foreignField: '_id', as: 'machine' } },
        {
          $project: {
            _id: 0,
            machine: { $first: '$machine.name' },
            oee: { $round: [{ $multiply: ['$oee', 100] }, 1] },
          },
        },
        { $sort: { oee: -1 } },
      ];
      return {
        title: gauge ? 'OEE' : 'OEE by machine',
        description: 'Availability × performance × quality of the job cards completed in the period.',
        viz: gauge ? 'gauge' : 'bar',
        unit: '%',
        target: 85,
        thresholds: { warn: 75, critical: 60, direction: 'higher_is_better' },
        timeRange: { text: rangeIn(s.t, 'this week') },
        sources: [{ key: 'oee', tool: 'mongo_aggregate', args: { module: 'jobcards', pipeline } }],
        ...(gauge
          ? { formula: 'round(avg(oee.oee), 1)' }
          : { encoding: { source: 'oee', x: 'machine', series: [{ key: 'oee', label: 'OEE', unit: '%' }] } }),
      };
    },
  },
  {
    re: /downtime|stops/,
    def: (s) => {
      const byReason = /reason|why|cause/.test(s.t);
      return {
        title: byReason ? 'Top downtime reasons' : 'Downtime by machine',
        viz: 'bar',
        unit: 'h',
        thresholds: { direction: 'lower_is_better' },
        timeRange: { text: rangeIn(s.t, 'this month') },
        sources: [
          { key: 'stops', tool: 'downtime_summary', args: { groupBy: byReason ? 'reason' : 'asset' } },
        ],
        encoding: {
          source: 'stops',
          x: byReason ? 'reason' : 'asset',
          series: [{ key: 'hours', label: 'Downtime', unit: 'h' }],
          sort: 'desc',
          limit: 8,
        },
      };
    },
  },
  {
    re: /pm compliance|preventive|\bpms?\b/,
    def: (s) => {
      const pm = { pmId: { $exists: true }, dueDate: { $gte: '$start', $lt: '$stop' } };
      return {
        title: 'PM compliance',
        description: 'Preventive work orders due in the period that are completed or closed.',
        viz: /\bnumber\b/.test(s.t) ? 'number' : 'gauge',
        unit: '%',
        target: 90,
        thresholds: { warn: 80, critical: 60, direction: 'higher_is_better' },
        timeRange: { text: rangeIn(s.t, 'this month') },
        sources: [
          {
            key: 'done',
            tool: 'mongo_count',
            args: { module: 'workorders', filter: { ...pm, workStatus: { $in: ['Completed', 'Closed'] } } },
          },
          { key: 'due', tool: 'mongo_count', args: { module: 'workorders', filter: pm } },
        ],
        formula: 'round(done / due * 100, 1)',
      };
    },
  },
  {
    re: /cost|spend/,
    def: (s) => {
      const maintenance = /maintenance|repair|spare/.test(s.t);
      return {
        title: maintenance ? 'Maintenance cost by asset' : 'Cost by asset',
        viz: 'stackedBar',
        unit: '₹',
        thresholds: { direction: 'lower_is_better' },
        timeRange: { text: rangeIn(s.t, 'this month') },
        sources: [
          {
            key: 'cost',
            tool: 'cost_summary',
            args: {
              groupBy: 'asset',
              ...(maintenance ? { components: ['spares', 'consumables', 'labour'] } : {}),
            },
          },
        ],
        encoding: {
          source: 'cost',
          x: 'label',
          series: (maintenance
            ? ['spares', 'consumables', 'labour']
            : ['energy', 'spares', 'consumables', 'labour', 'downtime']
          ).map((key) => ({ key, label: cap(key === 'spares' ? 'spare parts' : key) })),
          limit: 10,
        },
      };
    },
  },
  {
    re: /work ?orders?/,
    def: (s) => ({
      title: 'Open work orders by priority',
      viz: 'bar',
      thresholds: { direction: 'lower_is_better' },
      timeRange: { text: rangeIn(s.t, 'this month') },
      sources: [{ key: 'wo', tool: 'work_orders_summary', args: { groupBy: 'priority', scope: 'open' } }],
      encoding: {
        source: 'wo',
        x: 'priority',
        series: [
          { key: 'count', label: 'Open' },
          { key: 'overdue', label: 'Overdue' },
        ],
      },
    }),
  },
];

/** The 4 cards "suggest the KPIs that matter most" builds and pins, one confirmation each. */
const STARTER_KPIS = [
  'OEE by machine this week',
  'Top downtime reasons this month',
  'Maintenance cost by asset this month',
  'PM compliance this month',
];

const tuneKpi = (def, s) => {
  const out = { ...def };
  const word =
    /\bas an? (gauge|pie|bar|line|area|table|number|combo|scatter|radar|funnel|treemap|stacked ?bar)\b/.exec(
      s.t,
    )?.[1];
  const as = word?.startsWith('stacked') ? 'stackedBar' : word;
  const single = !def.encoding?.series || def.encoding.series.length === 1;
  // ponytail: timeline needs status runs (start/end lanes) that no recipe reads, so it is not offered here.
  if (
    as &&
    SERIES_VIZ.includes(def.viz) &&
    (SERIES_VIZ.includes(as) || as === 'table' || (SLICE_VIZ.includes(as) && single))
  ) {
    out.viz = as;
    if (SLICE_VIZ.includes(as))
      out.encoding = { ...def.encoding, label: def.encoding.x, value: def.encoding.series[0].key };
  }
  const target = /target(?: of| to)?\s*(\d+(?:\.\d+)?)/.exec(s.t)?.[1];
  if (target) out.target = Number(target);
  if (/\bpin/.test(s.t)) out.pinned = true;
  return out;
};

const kpiFlow = (s) => {
  const starter = /suggest|matter most|most important/.test(s.t);
  const asks = starter ? STARTER_KPIS : [s.text];
  const made = s.count('create_kpi');
  const last = s.last('create_kpi');
  if (made && last?.status === 'confirmed' && made >= asks.length) {
    const titles = s.results('create_kpi').map((r) => `**${r?.created?.title}**`);
    return {
      text: `Added ${list(titles)} to the [KPI Builder](/kpis)${starter ? ' and pinned them to the Command Center' : ''}. SARA writes a one-line insight under each card within a few minutes.\n\n**Next:** ask me to change one, e.g. "show it as a line chart" or "use the last 30 days".`,
    };
  }
  const ask = { ...s, text: asks[made] ?? s.text, t: (asks[made] ?? s.text).toLowerCase() };
  const recipe = KPI_RECIPES.find((r) => r.re.test(ask.t));
  if (!recipe) {
    return {
      text: 'I can build KPI cards from machine telemetry, energy, job cards, downtime, costs and maintenance. Try one of these:\n- Build a heatmap of compressor energy by hour\n- OEE by machine this week as a bar chart with a target of 85%\n- kWh per part on the IMM machines over the last 7 days\n- Top downtime reasons this month\n- PM compliance this month as a gauge',
    };
  }
  // One named machine is resolved; a machine type ("compressor energy", "the IMM machines") is listed by name.
  const named = recipe.type ? assetIn(ask.text) : null;
  const type = recipe.type && !named ? (typeIn(ask.text) ?? recipe.type) : null;
  if (named && !s.has('resolve')) {
    return step(
      `**Finding ${named}**\n\nThe card needs its id.`,
      call('resolve', { kind: 'asset', query: named }),
    );
  }
  if (type && !s.has('mongo_find')) {
    return step(
      `**Finding the ${type} machines**\n\nThe card needs their ids.`,
      call('mongo_find', {
        module: 'assets',
        filter: { name: { $regex: `^${type}`, $options: 'i' } },
        projection: ['name'],
        sort: 'name',
        limit: 20,
      }),
    );
  }
  const found = named
    ? [matchOf(s, named)].filter(Boolean)
    : type
      ? (s.result('mongo_find')?.rows ?? [])
      : [];
  if ((named || type) && !found.length) {
    const what = named ? `a machine called "${named}"` : `any ${type} machines`;
    return { text: `I couldn't find ${what}. Which machines should the card use?` };
  }
  const ids = found.map((m) => m.id ?? m._id);
  const label = named ?? (type === 'IMM' ? 'IMM machines' : `${type}s`);
  const def = tuneKpi(recipe.def(ask, ids, label, type), starter ? { ...ask, t: `${ask.t} pin` } : s);
  return {
    thought: `**Designing the card**\n\nA ${def.viz} of ${def.title.toLowerCase()} over ${def.timeRange.text}; the preview runs it on live data before anything is saved.`,
    text: `${starter ? `KPI ${made + 1} of ${asks.length}: here` : 'Here'} is **${def.title}** as a live preview. Confirm to add it to the KPI Builder${def.pinned ? ' and pin it to the Command Center' : ''}.`,
    calls: [call('create_kpi', def)],
  };
};

const kpiChangeFlow = (s) => {
  const title = /change the kpi "([^"]+)"/i.exec(s.text)?.[1];
  const ask = (
    s.text
      .split(/":?\s*/)
      .slice(1)
      .join(' ') || s.text
  ).toLowerCase();
  const id = s.record?.module === 'kpis' ? s.record.id : null;
  if (!id && !s.has('list_kpis')) return step('**Finding the card**', call('list_kpis'));
  const kpi =
    id ?? s.result('list_kpis')?.kpis?.find((k) => k.title.toLowerCase() === title?.toLowerCase())?.id;
  if (!kpi)
    return {
      text: `I couldn't find a KPI called "${title}". Open the KPI Builder and use **Change via chat** on the card.`,
    };
  if (!s.has('update_kpi')) {
    const changes = {};
    const viz = /\b(heatmap|gauge|line|area|bar|stacked|pie|table|number)\b/.exec(ask)?.[1];
    if (viz) changes.viz = viz === 'stacked' ? 'stackedBar' : viz;
    const range = rangeIn(ask);
    if (range) changes.timeRange = { text: range };
    const target = /target(?: of| to)?\s*(\d+(?:\.\d+)?)/.exec(ask)?.[1];
    if (target) changes.target = Number(target);
    if (/\bunpin/.test(ask)) changes.pinned = false;
    else if (/\bpin/.test(ask)) changes.pinned = true;
    const rename = /rename (?:it )?to "?([^"]+?)"?$/.exec(ask)?.[1];
    if (rename) changes.title = rename;
    if (!Object.keys(changes).length) {
      return {
        text: 'What should change? For example: "show it as a line chart", "use the last 30 days", "set the target to 90" or "pin it".',
      };
    }
    return {
      thought: '**Changing the card**\n\nThe preview shows the card with the change before it is saved.',
      text: 'Here is the card with your change. Confirm to save it.',
      calls: [call('update_kpi', { id: kpi, changes })],
    };
  }
  const done = s.result('update_kpi')?.updated;
  return {
    text: `Saved: **${done?.title}** now uses the new ${list(done?.changed ?? ['settings'])}. [Open the KPI Builder](/kpis)`,
  };
};

// ---------- planning

const planText = (r) => {
  const cards = r.jobCards.map(
    (j) =>
      `- **${j.asset}**: ${lakh(j.target)} pcs with ${j.tool}${j.setupMin ? ` after a ${j.setupMin} min changeover` : ''}, ${j.start} → ${j.end}`,
  );
  const head = r.feasible
    ? `**${r.code}** makes the due date: ${r.jobCards.length} job card${r.jobCards.length === 1 ? '' : 's'}, finishing ${r.projectedFinish}, ${hours(r.slackHours)} before ${r.dueDate}.`
    : `**${r.code}** can't make ${r.dueDate} with the current shifts: it finishes ${r.projectedFinish}${r.shortfall ? `, ${lakh(r.shortfall)} pcs short` : ''}.`;
  const risks = r.risks.length ? `\n\n**Watch:** ${r.risks.slice(0, 2).join('; ')}.` : '';
  const alts =
    !r.feasible && r.alternatives.length ? `\n\n**Options:** ${r.alternatives.slice(0, 2).join(' ')}` : '';
  return `${head}\n\n${cards.join('\n')}${risks}${alts}\n\nConfirm below to create the production plan and job cards.`;
};

const appliedText = (r) => {
  const links = [...(r.created ?? []), ...(r.updated ?? [])]
    .slice(0, 6)
    .map((x) => (x.link ? `[${x.label}](${x.link})` : x.label));
  return `Applied **${r.code}**: ${r.created?.length ?? 0} created, ${r.updated?.length ?? 0} updated — ${list(links)}. The schedule is on the [Planner](/planner).`;
};

/** apply_plan after a plan tool; a schedule that changed meanwhile gets the fresh plan once. */
const applyStep = (s, planned, text, option) => {
  if (!s.has('apply_plan'))
    return {
      text,
      calls: [call('apply_plan', { proposalId: planned.proposalId, ...(option ? { option } : {}) })],
    };
  const last = s.last('apply_plan');
  const fresh = last?.details?.proposalId;
  if (last?.error && fresh && s.calls.filter((c) => c.name === 'apply_plan').length < 2) {
    return {
      text: `The schedule changed while you were looking, so here is the updated plan **${last.details.proposalCode}**.`,
      calls: [call('apply_plan', { proposalId: fresh, ...(option ? { option } : {}) })],
    };
  }
  if (last?.error) {
    return { text: REFUSED.test(last.error) ? errorText(last) : `I couldn't apply the plan: ${last.error}` };
  }
  return {
    text: confirmed(s, 'apply_plan')
      ? appliedText(last.result)
      : 'The plan is waiting for your confirmation.',
  };
};

const productionFlow = (s) => {
  const qty = /(\d[\d,]*)\s*(k\b)?/.exec(s.text.replace(/\b\d{1,2}[-/ ]\d{1,2}[-/ ]\d{2,4}\b/g, ''));
  const quantity = qty ? Number(qty[1].replace(/,/g, '')) * (qty[2] ? 1000 : 1) : null;
  const part =
    /\d[\d,]*\s*(?:k\s+)?(?:(?:parts?|pcs|pieces|units|nos)\s+)?(?:of\s+)?([A-Za-z][\w-]*(?:\s+[A-Z0-9][\w-]*)?)/.exec(
      s.text,
    )?.[1];
  const due = /\b(?:due(?: on| by)?|by|before|until|deliver(?:ed)? on)\s+(.+?)\s*(?:[.?!;]|$)/i.exec(
    s.text,
  )?.[1];
  if (!quantity || !part || /^(parts?|pcs|pieces|units)$/i.test(part) || !due) {
    return {
      text: 'Tell me the part, the quantity and the due date, for example: **Plan 5000 Housing-A by 25 Oct**. I pick every mould that makes it, split the quantity and check the due date.',
    };
  }
  if (!s.has('plan_production')) {
    return step(
      `**Planning ${part}**\n\n${lakh(quantity)} pcs due ${due}: plan_production checks every mould that makes it, the free time of its machines and the changeovers.`,
      call('plan_production', { part, quantity, dueDate: due }),
    );
  }
  const planned = s.result('plan_production');
  if (!planned) {
    const err = s.last('plan_production');
    const parts = err?.details?.parts;
    return {
      text: `${errorText(err) ?? 'I could not plan that.'}${parts?.length ? ` Parts I can plan: ${list(parts)}.` : ''}`,
    };
  }
  return applyStep(s, planned, planText(planned));
};

const maintenanceFlow = (s) => {
  const anomaly = codeIn(s.text, 'ANM');
  const workOrder = codeIn(s.text, 'WO');
  const name = anomaly || workOrder ? null : assetIn(s.text);
  if (name && !s.has('resolve'))
    return step(`**Finding ${name}**`, call('resolve', { kind: 'asset', query: name }));
  if (name && !matchOf(s, name)) return { text: `I couldn't find a machine called "${name}".` };
  if (!s.has('plan_maintenance')) {
    const asset = machineId(s, name);
    const what = anomaly ?? workOrder ?? machineName(s, name) ?? 'every task due in the plant';
    return step(
      `**Looking for a window**\n\nplan_maintenance looks for a free slot for ${what} before its deadline, and otherwise for the cheapest way to push production.`,
      call('plan_maintenance', {
        ...(anomaly ? { anomaly } : workOrder ? { workOrder } : asset ? { asset } : {}),
        horizonDays: /\b(\d{1,2}) days\b/.exec(s.t) ? Number(/\b(\d{1,2}) days\b/.exec(s.t)[1]) : 7,
      }),
    );
  }
  const planned = s.result('plan_maintenance');
  if (!planned)
    return { text: errorText(s.last('plan_maintenance')) ?? 'I could not plan that maintenance.' };
  const options = planned.options.map(
    (o) =>
      `- **${o.label}**${o.id === planned.recommended ? ' (recommended)' : ''}: ${o.start} → ${o.end}${
        o.delays?.length
          ? `, moves ${o.delays.map((d) => `${d.code} +${hours(d.hours)}${d.late ? ' (late)' : ''}`).join(', ')}`
          : ', no production impact'
      }${o.risk ? ` — ${o.risk}` : ''}`,
  );
  const pick = planned.options.find((o) => o.id === planned.recommended);
  const text = `**${planned.code}** · ${planned.task.title}: ${planned.task.durationMin} min, deadline ${planned.task.deadline}.\n\n${options.join('\n')}\n\nI recommend **${pick?.label ?? planned.recommended}**${pick?.lateHours ? '' : ': no plan misses its due date'}. Confirm below to book it.`;
  return applyStep(s, planned, text, planned.recommended);
};

// ---------- costs

const METRICS = [
  ['energy', /energy|electricity|power|kwh/],
  ['downtime', /downtime|stops?/],
  ['spares', /spare/],
  ['consumables', /consumable/],
  ['labour', /labou?r/],
  ['maintenance', /maintenance|repair/],
];
const metricIn = (t) => METRICS.find(([, re]) => re.test(t))?.[0] ?? 'total';

const alertFlow = (s) => {
  const name = assetIn(s.text);
  const amount =
    /(?:₹|rs\.?|inr)\s*([\d,]+(?:\.\d+)?)\s*(k|lakh|l)?\b|([\d,]+(?:\.\d+)?)\s*(k|lakh)?\s*(?:₹|rs|rupees|inr)/i.exec(
      s.text,
    );
  const plain =
    /(?:above|over|more than|exceeds?|crosses|below|under|less than|>|<)\s*([\d,]+(?:\.\d+)?)/i.exec(s.text);
  const raw = amount?.[1] ?? amount?.[3] ?? plain?.[1];
  const unit = (amount?.[2] ?? amount?.[4] ?? '').toLowerCase();
  const threshold = raw ? Number(raw.replace(/,/g, '')) * (unit === 'k' ? 1e3 : unit ? 1e5 : 1) : null;
  if (!threshold) {
    return {
      text: 'What limit should trigger it? For example: **Alert me if Compressor 2 energy cost is above ₹3000 a day**. I can watch energy, spare parts, consumables, labour, downtime, maintenance or total cost per day, week or month.',
    };
  }
  if (name && !s.has('resolve'))
    return step(`**Finding ${name}**`, call('resolve', { kind: 'asset', query: name }));
  if (name && !matchOf(s, name)) return { text: `I couldn't find a machine called "${name}".` };
  const metric = metricIn(s.t);
  const comparator = /\b(below|under|less than|drops)\b|</.test(s.t)
    ? 'lt'
    : /\bat least\b|>=/.test(s.t)
      ? 'gte'
      : 'gt';
  const period = /\bweek/.test(s.t) ? 'week' : /\bmonth/.test(s.t) ? 'month' : 'day';
  const who = machineName(s, name);
  if (!s.has('create_record')) {
    const label = `${who ?? 'Company'} ${metric === 'total' ? 'total' : metric} cost ${comparator.startsWith('l') ? 'below' : 'above'} ${inr(threshold)}/${period}`;
    return {
      thought: `**Setting up the alert**\n\nA cost alert on ${metric} for ${who ?? 'the company'}, checked per ${period}; it needs your confirmation.`,
      text: `I'll watch **${label}**. Confirm to switch it on.`,
      calls: [
        call('create_record', {
          module: 'costalerts',
          items: [
            {
              name: label,
              metric,
              scope: who ? 'asset' : 'company',
              ...(who ? { assetId: machineId(s, name) } : {}),
              period,
              comparator,
              threshold,
            },
          ],
        }),
      ],
    };
  }
  const created = s.result('create_record')?.created?.[0];
  return {
    text: `Done: [${created?.label ?? 'the alert'}](${created?.link ?? '/costs'}) is on. SARA checks it every 15 minutes and notifies the owner and the plant admins once per ${period} when the limit is crossed. Pause it or run **Check now** on the [Costs page](/costs).`,
  };
};

const costFlow = (s) => {
  const name = assetIn(s.text);
  const range = rangeIn(s.t, 'this month');
  if (!s.has('resolve_time_range')) {
    return step(
      `**Costing ${range}**\n\nThe cost engine adds energy at the plant tariff, spare parts, consumables, labour and downtime.`,
      call('resolve_time_range', { text: range }),
      ...(name ? [call('resolve', { kind: 'asset', query: name })] : []),
    );
  }
  const metric = metricIn(s.t);
  const components =
    metric === 'maintenance'
      ? ['spares', 'consumables', 'labour']
      : metric === 'total'
        ? undefined
        : [metric];
  const groupBy = /by (?:category|type)/.test(s.t)
    ? 'category'
    : /by day|per day|daily|trend/.test(s.t)
      ? 'day'
      : /by plant/.test(s.t)
        ? 'plant'
        : /by component|breakdown/.test(s.t)
          ? 'component'
          : 'asset';
  const w = rangeOf(s);
  if (!s.has('cost_summary')) {
    const asset = name ? machineId(s, name) : null;
    return step(
      null,
      call('cost_summary', {
        start: w.start,
        stop: w.stop,
        groupBy,
        ...(components ? { components } : {}),
        ...(asset ? { assetIds: [asset] } : {}),
      }),
    );
  }
  const r = s.result('cost_summary');
  if (r?.rows?.length > 1 && !s.has('render_table')) {
    return step(
      null,
      call('render_table', { title: `Cost by ${groupBy} · ${w.label}`, sourceRef: s.ref('cost_summary') }),
    );
  }
  const what =
    metric === 'total' ? 'Total cost' : `${cap(metric === 'spares' ? 'spare parts' : metric)} cost`;
  const parts = Object.entries(r?.totalsText ?? {})
    .filter(([k, v]) => v && ['energy', 'spares', 'consumables', 'labour', 'downtime'].includes(k))
    .map(([k, v]) => `${k === 'spares' ? 'spare parts' : k} ${v}`);
  const top = (r?.rows ?? [])
    .slice(0, 3)
    .map((row) => `- **${row.label}**: ${inr(row.total)}`)
    .join('\n');
  return {
    text: `**${what}${name ? ` of ${machineName(s, name)}` : ''} for ${lc(w.label)}: ${r?.totalsText?.total ?? inr(r?.totals?.total)}**${parts.length > 1 ? ` (${parts.join(' · ')})` : ''}.\n\n${top}${r?.notes?.length ? `\n\n_${r.notes.join(' ')}_` : ''}\n\n**Next:** want an alert when it passes a limit? Say "Alert me if …".`,
  };
};

// ---------- work orders

const CATEGORIES = [
  ['Breakdown', /leak|broke|breakdown|stopped|jam|not working/],
  ['Electrical', /electric|trip|power|motor|wiring/],
  ['Hydraulic', /hydraulic|oil|pressure/],
  ['Mechanical', /vibration|noise|bearing|belt|alignment/],
  ['Cleaning', /clean/],
];

/** "Create 3 work orders: oil leak at Press 1, belt check and noisy fan": the listed jobs, else []. */
const bulkJobs = (text) => {
  if (!/\b(\d+|two|three|four|five|six|several)\s+(?:new\s+)?(?:work ?orders|breakdowns)\b/i.test(text))
    return [];
  return (/:\s*(.+)$/.exec(text)?.[1] ?? '')
    .split(/\s*(?:,|;|\band\b)\s*/i)
    .map((p) => p.replace(/[.!]+$/, '').trim())
    .filter((p) => p && !/\b(priority|due|assign)/i.test(p));
};

const createWoFlow = (s) => {
  const name = assetIn(s.text.split(':')[0]) ?? assetIn(s.text);
  const jobs = bulkJobs(s.text);
  const names = [...new Set([name, ...jobs.map(assetIn)].filter(Boolean))];
  const person = /\bassign(?:ed)?(?: it)? to ([A-Z][a-z]+(?: [A-Z][a-z]+)?)/.exec(s.text)?.[1];
  const due = /\bdue (?:on |by )?(today|tomorrow|this week|next week|\d[^,.;]*|[a-z]{3,9} \d{1,2})/i
    .exec(s.text)?.[1]
    ?.trim();
  if (!s.has('resolve') && !s.has('resolve_time_range') && (names.length || person || due)) {
    return step(
      '**Resolving names**\n\nI need the machine, the person and the date before I can draft the work order.',
      ...names.map((n) => call('resolve', { kind: 'asset', query: n })),
      ...(person ? [call('resolve', { kind: 'user', query: person })] : []),
      ...(due ? [call('resolve_time_range', { text: due })] : []),
    );
  }
  const missing = names.find((n) => !matchOf(s, n));
  if (missing) return { text: `I couldn't find a machine called "${missing}".` };
  const what =
    /:\s*([^,.;]+)/.exec(s.text)?.[1] ??
    /\bfor [^,]+?,\s*([^,.;]+)/.exec(s.text)?.[1] ??
    `Inspection${name ? ` – ${machineName(s, name)}` : ''}`;
  const user = person
    ? s.calls.find((c) => c.args.query === person)?.response?.result?.matches?.[0]?.id
    : null;
  const day = due ? rangeOf(s) : null;
  const itemFor = (job, machine, words) => {
    const title = cap(job.trim()).slice(0, 120);
    return {
      name:
        machine && !title.includes(machineName(s, machine)) ? `${title} – ${machineName(s, machine)}` : title,
      description: `${title}${machine ? ` on ${machineName(s, machine)}` : ''}. Raised from SARA chat.`,
      ...(machine ? { asset: machineId(s, machine) } : {}),
      priority: /\b(high|urgent|critical)\b/.test(s.t) ? 'High' : /\blow\b/.test(s.t) ? 'Low' : 'Medium',
      category: CATEGORIES.find(([, re]) => re.test(words))?.[0] ?? 'Inspection',
      ...(day?.stop ? { dueDate: new Date(Date.parse(day.stop) - 1000).toISOString() } : {}),
      ...(user ? { people: [user] } : {}),
    };
  };
  if (!s.has('create_record')) {
    const items =
      jobs.length > 1
        ? jobs.map((job) => {
            const machine = assetIn(job) ?? name;
            return itemFor(job.replace(/\s+(?:at|on|for|in)\s+.*$/i, ''), machine, job.toLowerCase());
          })
        : [itemFor(what, name, s.t)];
    const many = items.length > 1;
    return {
      thought: `**Drafting the work order${many ? 's' : ''}**\n\nEverything resolved; it waits for your confirmation.`,
      text: many
        ? `Here are the ${items.length} work orders. Confirm to create them.`
        : 'Here is the work order. Confirm to create it.',
      calls: [call('create_record', { module: 'workorders', items })],
    };
  }
  const created = s.result('create_record')?.created ?? [];
  if (created.length > 1) {
    return { text: `Done: ${list(created.map((c) => `**[${c.label}](${c.link})**`))} are open.` };
  }
  return {
    text: created[0]
      ? `Done: **[${created[0].label}](${created[0].link})** is open${name ? ` for ${machineName(s, name)}` : ''}${person ? `, assigned to ${person}` : ''}.\n\n**Next:** shall I find a maintenance window for it? Say "Plan maintenance for ${name ?? 'it'}".`
      : 'The work order was not created.',
  };
};

const STATUS = [
  ['Re Open', /re-?open/],
  ['Closed', /\bclose/],
  ['Completed', /complete|done|finish/],
  ['On Hold', /hold/],
  ['In Progress', /start|progress/],
];
const woStatusFlow = (s) => {
  const workOrder = codeIn(s.text, 'WO');
  const status = STATUS.find(([, re]) => re.test(s.t))?.[0];
  const note = /\bnote:?\s*(.+)$/i.exec(s.text)?.[1];
  if (!s.has('update_work_order_status')) {
    return {
      text: `Moving ${workOrder} to **${status}**. Confirm below.`,
      calls: [call('update_work_order_status', { workOrder, workStatus: status, ...(note ? { note } : {}) })],
    };
  }
  return { text: `Done: ${workOrder} is now **${status}**${note ? ` with your note` : ''}.` };
};

const commentFlow = (s) => {
  const workOrder = codeIn(s.text, 'WO');
  const comment = /:\s*(.+)$/.exec(s.text)?.[1] ?? s.text;
  if (!s.has('add_work_order_comment')) {
    return {
      text: `Adding your comment to ${workOrder}. Confirm below.`,
      calls: [call('add_work_order_comment', { workOrder, comment })],
    };
  }
  return { text: `Done: the comment is on ${workOrder}.` };
};

// ---------- generic update / delete (update_record, delete_record)

/** Record words: module, resolve kind (null = found by name with mongo_find) and the word itself. */
const RECORD_WORDS = [
  ['spareparts', 'spare_part', 'spare ?parts?'],
  ['consumables', null, 'consumables?'],
  ['tools', 'tool', 'tools?'],
  ['suppliers', 'supplier', 'suppliers?'],
  ['vendors', 'vendor', 'vendors?'],
  ['customers', 'customer', 'customers?'],
];
const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The record a change or delete is about: { module, kind, query, word?, id? }, or null. */
const targetOf = (s) => {
  const wo = codeIn(s.text, 'WO');
  if (wo) return { module: 'workorders', kind: 'work_order', query: wo };
  const jc = codeIn(s.text, 'JC');
  if (jc) return { module: 'jobcards', kind: 'job_card', query: jc };
  const asset = assetIn(s.text);
  if (asset) return { module: 'assets', kind: 'asset', query: asset };
  for (const [module, kind, word] of RECORD_WORDS) {
    const m = new RegExp(
      `\\b(${word})\\s+(?:called |named )?(.+?)(?=\\s+(?:to|as|from|because)\\b|[,;:!?]|\\.\\s|\\.?$)`,
      'i',
    ).exec(s.text);
    if (m) return { module, kind, query: m[2].replace(/^(?:the|a|an)\s+/i, '').trim(), word: m[1] };
  }
  return s.record ? { module: s.record.module, query: s.record.label, id: s.record.id } : null;
};

/** `{ id, label, row }` of the target once found, or `{ next }`: the lookup step to run first. */
const findTarget = (s, t) => {
  if (t.id) return { id: t.id, label: t.query, row: s.result('mongo_find')?.rows?.[0] };
  if (t.kind) {
    if (!s.has('resolve'))
      return { next: step(`**Finding ${t.query}**`, call('resolve', { kind: t.kind, query: t.query })) };
    const match = s.result('resolve')?.matches?.[0];
    if (!match) return { next: { text: `I couldn't find "${t.query}".` } };
    return { id: match.id, label: match.label?.split(' · ').pop(), row: s.result('mongo_find')?.rows?.[0] };
  }
  if (!s.has('mongo_find')) {
    const filter = { name: { $regex: `^${escapeRe(t.query)}$`, $options: 'i' } };
    return {
      next: step(`**Finding ${t.query}**`, call('mongo_find', { module: t.module, filter, limit: 1 })),
    };
  }
  const row = s.result('mongo_find')?.rows?.[0];
  return row
    ? { id: String(row._id), label: row.name ?? t.query, row }
    : { next: { text: `I couldn't find "${t.query}".` } };
};

const camelWords = (key) =>
  key
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(' ');
const FIELD_STOP = new Set(['the', 'of', 'for', 'on', 'its', 's', 'a', 'an', 'field', 'value']);
/** The field of `row` the words name ("minimum stock" → minimumQuantity), else the words in camelCase. */
const fieldOf = (row, words) => {
  const same = (w, k) => k.startsWith(w) || w.startsWith(k) || (w === 'stock' && k === 'quantity');
  const scored = Object.keys(row ?? {})
    .filter((k) => !k.startsWith('_'))
    .map((k) => [k, words.filter((w) => camelWords(k).some((p) => same(w, p))).length])
    .filter(([, n]) => n)
    .sort((a, b) => b[1] - a[1] || a[0].length - b[0].length);
  return scored[0]?.[0] ?? words.map((w, i) => (i ? cap(w) : w)).join('');
};
const castTyped = (raw, current) => {
  const v = raw.trim().replace(/^["']|["']$/g, '');
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (/^(true|yes)$/i.test(v)) return true;
  if (/^(false|no)$/i.test(v)) return false;
  // enums are stored capitalised ("High", "Running"): follow the current value's casing
  return typeof current === 'string' && /^[A-Z]/.test(current)
    ? v.replace(/\b[a-z]/g, (c) => c.toUpperCase())
    : v;
};

const UPDATE = /\b(?:set|change|update|rename)\s+(.+?)\s+to\s+(.+?)[.!]?$/i;
const updateFlow = (s) => {
  const t = targetOf(s);
  const found = findTarget(s, t);
  if (found.next) return found.next;
  if (!found.row) {
    return step(
      `**Reading ${found.label}**`,
      call('mongo_find', { module: t.module, filter: { _id: found.id }, limit: 1 }),
    );
  }
  const [, middle, raw] = UPDATE.exec(s.text);
  const skip = new Set(`${t.query} ${t.word ?? ''}`.toLowerCase().split(/[^a-z]+/));
  const words = middle
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((w) => w && !FIELD_STOP.has(w) && !skip.has(w));
  const field = /\brename\b/.test(s.t) || !words.length ? 'name' : fieldOf(found.row, words);
  const value = castTyped(raw, found.row[field]);
  if (!s.has('update_record')) {
    return {
      text: `Here is the change to ${found.label}. Confirm to save it.`,
      calls: [
        call('update_record', { module: t.module, updates: [{ id: found.id, data: { [field]: value } }] }),
      ],
    };
  }
  const done = s.result('update_record')?.updated?.[0];
  return {
    text: done
      ? `Done: **[${done.label}](${done.link})** now has ${words.join(' ') || 'name'} set to **${value}**.`
      : 'Nothing was changed.',
  };
};

const deleteFlow = (s) => {
  const t = targetOf(s);
  const found = findTarget(s, t);
  if (found.next) return found.next;
  const reason =
    /(?:\bbecause|\breason:?|,\s*(?:it(?:'s| is)|as))\s+(.+?)[.!]?$/i.exec(s.text)?.[1] ??
    'Deleted from SARA chat';
  if (!s.has('delete_record')) {
    return {
      text: `This deletes ${found.label}. Confirm to go ahead.`,
      calls: [call('delete_record', { module: t.module, ids: [found.id], reason: cap(reason) })],
    };
  }
  const gone = s.result('delete_record')?.deleted ?? [];
  return {
    text: gone.length ? `Done: ${list(gone.map((d) => d.label))} is deleted.` : 'Nothing was deleted.',
  };
};

// ---------- lookups

const tableThen = (s, tool, title, text) => {
  const rows = s.result(tool)?.rows ?? [];
  if (rows.length && !s.has('render_table'))
    return step(null, call('render_table', { title, sourceRef: s.ref(tool) }));
  return { text: text(s.result(tool) ?? {}, rows) };
};

const attentionFlow = (s) => {
  if (!s.has('list_anomalies')) {
    return step(
      '**Checking machine health**\n\nOpen anomalies first, then the machines with the lowest AI health scores.',
      call('list_anomalies', { state: 'active' }),
      call('mongo_find', {
        module: 'assets',
        filter: { healthScore: { $lt: 85 } },
        projection: ['name', 'healthScore', 'healthSummary', 'assetStatus'],
        sort: 'healthScore',
        limit: 5,
      }),
    );
  }
  return tableThen(s, 'list_anomalies', 'Open anomalies', (_, rows) => {
    const weak = s.result('mongo_find')?.rows ?? [];
    const lines = [
      ...rows
        .slice(0, 4)
        .map((a) => `- **${a.asset?.split(' · ').pop()}** · ${a.severity}: ${a.summary ?? a.type}`),
      ...weak
        .filter((m) => !rows.some((a) => a.asset?.endsWith(m.name)))
        .slice(0, 3)
        .map((m) => `- **${m.name}** health ${m.healthScore}/100: ${m.healthSummary ?? 'below normal'}`),
    ];
    if (!lines.length) {
      return 'Nothing needs attention right now: no open anomalies, and every machine SARA scored is at 85/100 or better.';
    }
    return `**${lines.length} machine${lines.length === 1 ? ' needs' : 's need'} attention:**\n\n${lines.join('\n')}\n\n**Next:** say "Plan maintenance for <machine>" and I'll find a window that protects the production plan.`;
  });
};

const machineFlow = (s) => {
  const name = assetIn(s.text);
  if (name && !s.has('resolve'))
    return step(`**Finding ${name}**`, call('resolve', { kind: 'asset', query: name }));
  const id = machineId(s, name);
  const who = machineName(s, name) ?? 'this machine';
  if (!id) return { text: 'Which machine? Name it (for example "IMM 3") or open its page and ask again.' };
  if (/trend/.test(s.t)) {
    if (!s.has('telemetry_fields'))
      return step(
        `**Reading ${who}'s key trends**`,
        call('telemetry_fields', { assetId: id }),
        call('resolve_time_range', { text: rangeIn(s.t, 'last 4 hours') }),
      );
    const fields = (s.result('telemetry_fields')?.rows ?? [])
      .filter((f) => f.key && f.valueType !== 'string')
      .slice(0, 4);
    const w = rangeOf(s);
    if (!s.has('telemetry_series') && fields.length) {
      return step(
        null,
        call('telemetry_series', {
          assetIds: [id],
          fields: fields.map((f) => f.field),
          start: w.start,
          stop: w.stop,
          title: `${who} · key trends`,
        }),
      );
    }
    const series = s.result('telemetry_series')?.series ?? [];
    return {
      text: `${who}'s key readings for **${lc(w.label) || 'the last 4 hours'}** are charted above.\n\n${series.map((x) => `- **${x.field}**: mean ${x.mean}${x.unit ? ` ${x.unit}` : ''} (${x.min}–${x.max}), ${x.trend ?? 'steady'}`).join('\n') || '- No readings in that window.'}`,
    };
  }
  if (!s.has('machine_health')) {
    return step(
      `**Checking ${who}**\n\nHealth score, open anomalies, live values${/work orders?/.test(s.t) ? ' and open work orders' : ''}.`,
      call('machine_health', { assetId: id }),
      call('telemetry_latest', { assetIds: [id] }),
      ...(/work orders?|anything open|any open/.test(s.t)
        ? [
            call('mongo_find', {
              module: 'workorders',
              filter: { asset: id, workStatus: { $nin: ['Completed', 'Closed'] } },
              projection: ['workOrderId', 'name', 'priority', 'workStatus', 'dueDate'],
              limit: 10,
            }),
          ]
        : []),
    );
  }
  const h = s.result('machine_health') ?? {};
  const live = s.result('telemetry_latest')?.rows?.[0] ?? {};
  const wos = s.result('mongo_find')?.rows ?? [];
  const open = h.openAnomalies ?? [];
  return {
    text: `**${who}** is **${live.status ?? h.asset?.status ?? 'unknown'}**${h.asset?.healthScore != null ? ` with an AI health score of **${h.asset.healthScore}/100**` : ''}. ${h.asset?.healthSummary ?? ''}\n\n${
      open.length
        ? open.map((a) => `- ${a.code} · ${a.severity}: ${a.summary}`).join('\n')
        : '- No open anomalies.'
    }${wos.length ? `\n- Open work orders: ${wos.map((w) => `${w.workOrderId} ${w.name} (${w.priority})`).join(', ')}` : /work orders?/.test(s.t) ? '\n- No open work orders.' : ''}\n\n**Next:** "Show its key trends for the last 4 hours".`,
  };
};

const FIELD_WORDS =
  /(vibration|temperature|temp|pressure|current|speed|power|oil|force|flow|humidity|voltage|cycle time)/i;
const trendFlow = (s) => {
  const name = assetIn(s.text);
  const word = FIELD_WORDS.exec(s.text)?.[1]
    .toLowerCase()
    .replace(/^temp$/, 'temperature');
  if (name && !s.has('resolve'))
    return step(`**Finding ${name}**`, call('resolve', { kind: 'asset', query: name }));
  const id = machineId(s, name);
  if (!id)
    return {
      text: `Which machine's ${word} should I plot? For example: "Show IMM 3 vibration for the last 2 hours".`,
    };
  const who = machineName(s, name);
  if (!s.has('telemetry_fields'))
    return step(
      `**Finding the ${word} field of ${who}**`,
      call('telemetry_fields', { assetId: id }),
      call('resolve_time_range', { text: rangeIn(s.t, 'last 2 hours') }),
    );
  const fields = s.result('telemetry_fields')?.rows ?? [];
  const field = fields.find(
    (f) =>
      f.field.toLowerCase().includes(word.split(' ')[0]) || (word === 'temperature' && /temp/i.test(f.field)),
  )?.field;
  if (!field)
    return {
      text: `${who} has no ${word} reading. It reports: ${fields
        .slice(0, 8)
        .map((f) => f.field)
        .join(', ')}.`,
    };
  const w = rangeOf(s);
  if (!s.has('telemetry_series'))
    return step(
      null,
      call('telemetry_series', { assetIds: [id], fields: [field], start: w.start, stop: w.stop }),
    );
  const x = s.result('telemetry_series')?.series?.[0];
  if (!x) return { text: `${who} sent no ${word} readings for ${lc(w.label)}.` };
  return {
    text: `**${who} ${word}** for ${lc(w.label)}: mean **${x.mean} ${x.unit ?? ''}**, between ${x.min} and ${x.max}, ${x.trend ?? 'steady'} (last ${x.last}).\n\n- ${x.trend === 'rising' ? 'It is rising: worth watching if it keeps climbing.' : 'No sustained rise in this window.'}\n\n**Next:** compare it with another machine over the same window?`,
  };
};

const energyFlow = (s) => {
  const name = assetIn(s.text);
  const both = /\bvs\.?\b|versus|compared?/.test(s.t);
  const ranges = both ? ['today', 'yesterday'] : [rangeIn(s.t, 'today')];
  if (!s.has('resolve_time_range')) {
    return step(
      '**Reading energy**\n\nEnergy comes from the 15-minute meter readings, costed at the plant tariff.',
      ...ranges.map((text) => call('resolve_time_range', { text })),
      name
        ? call('resolve', { kind: 'asset', query: name })
        : call('mongo_find', {
            module: 'assets',
            filter: { isEnergyAsset: true, typeOfAsset: { $ne: 'Energy Meter' } },
            projection: ['name'],
            limit: 20,
          }),
    );
  }
  const ids = name
    ? [machineId(s, name)].filter(Boolean)
    : (s.result('mongo_find')?.rows ?? []).map((a) => a._id);
  if (!ids.length)
    return {
      text: name ? `I couldn't find a machine called "${name}".` : 'No energy-metered machines found.',
    };
  if (!s.has('energy_consumption')) {
    return step(
      null,
      ...ranges.map((_, i) =>
        call('energy_consumption', {
          assetIds: ids,
          start: rangeOf(s, i).start,
          stop: rangeOf(s, i).stop,
          groupBy: 'asset',
        }),
      ),
    );
  }
  const [now, before] = s.results('energy_consumption');
  if (!name && !s.has('render_chart')) {
    return step(
      null,
      call('render_chart', {
        title: `Energy by machine · ${rangeOf(s).label}`,
        type: 'bar',
        xKey: 'asset',
        series: [{ key: 'kwh', label: 'Energy', unit: 'kWh' }],
        sourceRef: s.ref('energy_consumption'),
      }),
    );
  }
  if (both && !s.has('render_kpis')) {
    const delta = before?.totalKwh ? ((now.totalKwh - before.totalKwh) / before.totalKwh) * 100 : null;
    return step(
      null,
      call('render_kpis', {
        items: [
          {
            label: 'Today',
            value: now?.totalKwh ?? 0,
            unit: 'kWh',
            ...(delta != null
              ? {
                  delta: `${delta > 0 ? '+' : ''}${delta.toFixed(1)}% vs yesterday`,
                  tone: delta > 10 ? 'warning' : 'good',
                }
              : {}),
          },
          { label: 'Yesterday', value: before?.totalKwh ?? 0, unit: 'kWh' },
          { label: 'Cost today', value: now?.totalCost ?? '—' },
        ],
      }),
    );
  }
  const top = (now?.rows ?? [])
    .slice()
    .sort((a, b) => b.kwh - a.kwh)
    .slice(0, 3);
  return {
    text: both
      ? `**${machineName(s, name) ?? 'The plant'}** used **${now?.totalKwh ?? 0} kWh** today (${now?.totalCost ?? '—'}) against ${before?.totalKwh ?? 0} kWh yesterday (${before?.totalCost ?? '—'}). Today is still running, so it will grow until midnight.`
      : `**${name ? machineName(s, name) : 'Metered machines'}** used **${now?.totalKwh ?? 0} kWh** ${rangeOf(s).label?.toLowerCase() ?? ''} (${now?.totalCost ?? '—'}).${top.length > 1 ? `\n\n${top.map((r) => `- **${r.asset}**: ${r.kwh} kWh (${inr(r.cost)})`).join('\n')}` : ''}\n\n**Next:** "Alert me if ${top[0]?.asset ?? 'Compressor 2'} energy cost is above ₹3000 a day".`,
  };
};

const sparesFlow = (s) => {
  if (!s.has('spare_parts_below_minimum'))
    return step('**Checking stock**', call('spare_parts_below_minimum'));
  return tableThen(s, 'spare_parts_below_minimum', 'Spare parts below minimum', (_, rows) =>
    rows.length
      ? `**${rows.length} spare part${rows.length === 1 ? ' is' : 's are'} below minimum stock.**\n\n${rows
          .slice(0, 4)
          .map(
            (p) =>
              `- **${p.part}**: ${p.stock} of ${p.minimum} ${p.unit ?? ''} (short ${p.shortfall}) · ${p.suppliers ?? 'no supplier on file'}${p.leadTimeDays ? `, ${p.leadTimeDays} days lead time` : ''}`,
          )
          .join('\n')}\n\n**Next:** shall I raise a purchase request for the most critical one?`
      : 'Every spare part is at or above its minimum stock.',
  );
};

const woSummaryFlow = (s) => {
  const groupBy =
    /by (status|category|asset|machine|assignee|plant)/.exec(s.t)?.[1]?.replace('machine', 'asset') ??
    'priority';
  const scope = /overdue/.test(s.t) ? 'overdue' : /completed|closed|done/.test(s.t) ? 'completed' : 'open';
  if (!s.has('work_orders_summary'))
    return step('**Counting work orders**', call('work_orders_summary', { groupBy, scope }));
  const r = s.result('work_orders_summary') ?? {};
  const rows = r.rows ?? [];
  if (rows.length && !s.has('render_kpis')) {
    return step(
      null,
      call('render_kpis', {
        items: rows.slice(0, 6).map((row) => ({
          label: String(row[groupBy] ?? 'Other'),
          value: row.count,
          ...(row.overdue ? { delta: `${row.overdue} overdue`, tone: 'warning' } : {}),
        })),
      }),
    );
  }
  return {
    text: rows.length
      ? `You have **${r.total} ${scope} work order${r.total === 1 ? '' : 's'}**, by ${groupBy} above.${rows.some((x) => x.overdue) ? `\n\n- ${rows.reduce((n, x) => n + (x.overdue ?? 0), 0)} are overdue.` : '\n\n- None is overdue.'}\n\n**Next:** want them listed with their assignees?`
      : `There are no ${scope} work orders.`,
  };
};

const dueFlow = (s) => {
  const days = Number(/(\d{1,3}) days/.exec(s.t)?.[1] ?? (/month/.test(s.t) ? 30 : 7));
  if (!s.has('upcoming_maintenance'))
    return step('**Checking the maintenance calendar**', call('upcoming_maintenance', { days }));
  return tableThen(s, 'upcoming_maintenance', `PMs and calibrations due in ${days} days`, (_r, rows) =>
    rows.length
      ? `**${rows.length} task${rows.length === 1 ? '' : 's'} due in the next ${days} days**${rows.some((x) => x.overdue) ? `, ${rows.filter((x) => x.overdue).length} overdue` : ''}.\n\n${rows
          .slice(0, 3)
          .map((x) => `- **${x.code}** ${x.name}: ${x.dueLabel} (${x.estimatedDurationMin} min)`)
          .join(
            '\n',
          )}\n\n**Next:** "Plan maintenance for ${rows[0].asset?.split(' · ').pop()}" finds a window that protects production.`
      : `Nothing is due in the next ${days} days.`,
  );
};

const downtimeFlow = (s) => {
  const name = assetIn(s.text);
  const range = rangeIn(s.t, 'today');
  if (!s.has('resolve_time_range')) {
    return step(
      `**Looking at stops ${range}**`,
      call('resolve_time_range', { text: range }),
      ...(name ? [call('resolve', { kind: 'asset', query: name })] : []),
    );
  }
  const id = name ? machineId(s, name) : null;
  const w = rangeOf(s);
  if (!s.has('downtime_summary')) {
    return step(
      null,
      call('downtime_summary', {
        start: w.start,
        stop: w.stop,
        groupBy: id ? 'reason' : 'asset',
        ...(id ? { assetId: id } : {}),
      }),
    );
  }
  return tableThen(s, 'downtime_summary', `Downtime · ${w.label}`, (r, rows) => {
    if (!rows.length) return `No downtime ${id ? `on ${machineName(s, name)} ` : ''}for ${lc(w.label)}.`;
    const stops = rows.reduce((n, x) => n + (x.stops ?? 0), 0);
    const lines = rows
      .slice(0, 3)
      .map(
        (x) =>
          `- **${x.reason ?? x.asset}**: ${hours(x.hours)}, ${x.stops} stop${x.stops === 1 ? '' : 's'}${x.topReasons ? ` (${x.topReasons})` : ''}`,
      );
    return `**${id ? machineName(s, name) : 'The plant'} lost ${hours(r.totalHours)} to ${stops} stop${stops === 1 ? '' : 's'}** for ${lc(w.label)}${r.totalCost ? ` (${r.totalCost})` : ''}.\n\n${lines.join('\n')}${rows.some((x) => x.unverified) ? '\n\nSome stops have no verified reason yet: ask the operators to fill them in.' : ''}`;
  });
};

const attendanceFlow = (s) => {
  if (!s.has('resolve_time_range'))
    return step('**Checking attendance**', call('resolve_time_range', { text: rangeIn(s.t, 'today') }));
  if (!s.has('attendance_summary'))
    return step(null, call('attendance_summary', { start: rangeOf(s).start, stop: rangeOf(s).stop }));
  return tableThen(s, 'attendance_summary', `Check-ins · ${rangeOf(s).label}`, (r, rows) =>
    rows.length
      ? `**${r.count} people checked in** for ${lc(rangeOf(s).label)}; ${rows.filter((x) => x.stillIn).length} are still in.`
      : `Nobody checked in for ${lc(rangeOf(s).label)}.`,
  );
};

const jobFlow = (s) => {
  const jc = codeIn(s.text, 'JC');
  if (jc) {
    if (!s.has('job_card_progress'))
      return step(`**Reading ${jc}**`, call('job_card_progress', { jobCard: jc }));
    const j = s.result('job_card_progress') ?? {};
    return {
      text: `**${j.jobCard}** (${j.name}) on ${j.asset}: **${lakh(j.goodParts)} of ${lakh(j.target)}** good parts (${j.progressPct}%), ${j.onTrack ? 'on track' : 'behind plan'}; quality ${j.qualityPct}%.${j.oee ? ` OEE ${Math.round(j.oee.oee * 100)}%.` : ''}`,
    };
  }
  if (!s.has('mongo_find'))
    return step(
      '**Listing running job cards**',
      call('mongo_find', {
        module: 'jobcards',
        filter: { jobStatus: { $in: ['Open', 'In Progress', 'On Hold'] } },
        projection: ['jobCardId', 'jobName', 'asset', 'jobStatus', 'target', 'endDate'],
        populate: ['asset'],
        sort: 'endDate',
        limit: 20,
      }),
    );
  return tableThen(
    s,
    'mongo_find',
    'Open job cards',
    (r) =>
      `**${r.count} job cards** are open or running; the list is above. Ask about one by code (e.g. "${r.rows?.[0]?.jobCardId ?? 'JC-14'}") for its progress.`,
  );
};

const capacityFlow = (s) => {
  if (!s.has('capacity_calendar'))
    return step('**Reading the capacity calendar**', call('capacity_calendar'));
  const m = s.result('capacity_calendar')?.machines ?? [];
  const free = m
    .slice()
    .sort((a, b) => b.freeHours - a.freeHours)
    .slice(0, 3);
  return {
    text: `Free capacity for the next 7 days is charted above: **${Math.round(m.reduce((n, x) => n + x.freeHours, 0))} h** across ${m.length} machines.\n\n${free.map((x) => `- **${x.asset}**: ${Math.round(x.freeHours)} h free, ${Math.round(x.bookedHours ?? 0)} h booked`).join('\n')}\n\n**Next:** "Plan 5000 Housing-A by 25 Oct" uses that free time.`,
  };
};

const recordFlow = (s) => {
  if (!s.has('mongo_find'))
    return step(
      `**Reading ${s.record.label}**`,
      call('mongo_find', { module: s.record.module, filter: { _id: s.record.id }, limit: 1 }),
    );
  const doc = s.result('mongo_find')?.rows?.[0] ?? {};
  const fields = Object.entries(doc)
    .filter(
      ([k, v]) =>
        !/^_|Id$|At$|^company|^created|^updated|^deleted/.test(k) && v != null && typeof v !== 'object',
    )
    .slice(0, 8)
    .map(([k, v]) => `- **${k.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()}**: ${v}`);
  return {
    text: `**${s.record.label}**\n\n${fields.join('\n') || '- Nothing more is recorded.'}\n\n**Next:** ask me to change a field and I'll prepare the update for you to confirm.`,
  };
};

const HELP = `I'm SARA running in mock mode (AI_MOCK=true: no Gemini call is made), so I answer from scripted demo flows on your real data. Try:
- Plan 5000 Housing-A by 25 Oct
- Plan maintenance for Press 1
- Alert me if Compressor 2 energy cost is above ₹3000 a day
- Build a heatmap of compressor energy by hour
- Maintenance cost by asset this month
- Set Press 1 criticality to High
- Which machines need attention right now?`;

/** Ordered: the first flow whose test passes answers. */
const FLOWS = [
  [(s) => /^change the kpi\b/.test(s.t), kpiChangeFlow],
  [
    (s) => /^(hi|hello|hey|good (morning|afternoon|evening)|thanks|thank you|ok|okay)\b/.test(s.t),
    () => ({ text: `Hello! ${HELP.replace(/^I'm SARA/, 'I am SARA')}` }),
  ],
  [
    (s) =>
      /\b(alert|notify|warn|tell|ping) me\b|\bcost alert\b|\bset (?:up )?an? (?:cost )?alert\b/.test(s.t),
    alertFlow,
  ],
  [
    (s) =>
      s.page === 'kpis' || /\b(kpis?|heat ?map|gauge|dashboard|metric card|target of)\b|^build\b/.test(s.t),
    kpiFlow,
  ],
  [
    (s) =>
      /\bmaintenance\b|\banm-\d+|\bwindow\b|\bslot\b/.test(s.t) &&
      /\b(plan|schedule|find|when|book|slot|window)\b/.test(s.t),
    maintenanceFlow,
  ],
  [
    (s) => /\b(plan|schedule|produce|make)\b/.test(s.t) && /\d/.test(s.t) && !/\bpm-\d/.test(s.t),
    productionFlow,
  ],
  [(s) => /\b(delete|remove)\b/.test(s.t) && Boolean(targetOf(s)), deleteFlow],
  [
    (s) => /\bwo-\d+/.test(s.t) && STATUS.some(([, re]) => re.test(s.t)) && !/\bcomment\b/.test(s.t),
    woStatusFlow,
  ],
  [(s) => /\bwo-\d+/.test(s.t) && /\b(comment|note)\b/.test(s.t), commentFlow],
  [(s) => UPDATE.test(s.text) && Boolean(targetOf(s)), updateFlow],
  [
    (s) => /\b(create|raise|open|log|add)\b.*\b(work ?orders?|breakdowns?)\b|\bwork order for\b/.test(s.t),
    createWoFlow,
  ],
  [(s) => /\b(cost|costs|spend|spent|expenses?|budget)\b/.test(s.t), costFlow],
  [
    (s) => /\b(plot|chart|graph|trend|show)\b/.test(s.t) && FIELD_WORDS.test(s.t) && !/\btrends\b/.test(s.t),
    trendFlow,
  ],
  [(s) => /\b(energy|kwh|electricity|consumption)\b/.test(s.t), energyFlow],
  [(s) => /\b(spares?|spare parts?|stock|inventory|reorder)\b/.test(s.t), sparesFlow],
  [(s) => /\b(downtime|stopped|stops?|stoppages?|breakdowns?)\b|\bwhy did .+ stop/.test(s.t), downtimeFlow],
  [
    (s) =>
      /\b(attention|anomal\w*|abnormal|at risk|unhealthy)\b/.test(s.t) &&
      !assetIn(s.text) &&
      s.record?.module !== 'assets',
    attentionFlow,
  ],
  [(s) => Boolean(assetIn(s.text)) || s.record?.module === 'assets', machineFlow],
  [(s) => /\bwork ?orders?\b/.test(s.t), woSummaryFlow],
  [(s) => /\b(pms?|preventive|calibrations?|due|upcoming)\b/.test(s.t), dueFlow],
  [(s) => /\b(check(?:ed)?[ -]?ins?|attendance|present|who came)\b/.test(s.t), attendanceFlow],
  [(s) => /\bjc-\d+|\bjob ?cards?\b|\bproduction\b/.test(s.t), jobFlow],
  [(s) => /\b(capacity|free (?:time|hours)|gantt)\b/.test(s.t), capacityFlow],
  [
    (s) => Boolean(s.record) && /\b(summari[sz]e|this record|next here|what should i do)\b/.test(s.t),
    recordFlow,
  ],
];

/**
 * The next model step for the demo, from the question, this answer's history (contents after the
 * user's message) and the system prompt (page context). Null when the demo is off.
 */
export const demoStep = ({ text, history = [], system }) => {
  if (!demoChat.enabled) return null;
  const s = stateOf(String(text ?? ''), callsOf(history), system);
  const failed = s.lastStep.find(
    (c) => c.response?.error && !['plan_production', 'apply_plan'].includes(c.name),
  );
  if (failed) {
    const r = failed.response;
    if (REFUSED.test(r.error)) return { text: errorText(r) };
    return {
      text: `I couldn't finish that: ${r.error}${r.hint ? ` (${r.hint})` : ''}${r.issues?.length ? ` — ${r.issues.map((i) => `${i.path}: ${i.message}`).join('; ')}` : ''}.`,
    };
  }
  const next = (FLOWS.find(([test]) => test(s))?.[1] ?? (() => ({ text: HELP })))(s);
  // After a confirmation the answer goes on in the same message: start a new paragraph.
  const resumed = s.calls.at(-1)?.response?.status === 'confirmed';
  return resumed && next.text ? { ...next, text: `\n\n${next.text}` } : next;
};
