/**
 * Mock answers for the phase 5–6 AI calls (docs/phase5-contracts.md §4). Each call passes its input as
 * `mockInput` with a `kind`; the builder answers in that call's response shape from the input numbers,
 * so the planner, costs, KPI and briefing screens work (and tests assert) without an API key.
 */

const num = (n, dp = 0) => (Number.isFinite(Number(n)) ? Number(Number(n).toFixed(dp)) : null);
const money = (amount, symbol = '₹') =>
  amount == null ? `${symbol}0` : `${symbol}${Math.round(amount).toLocaleString('en-IN')}`;
const pct = (n) => (n == null ? null : `${n > 0 ? '+' : ''}${num(n, 1)}%`);
const COMPONENT = {
  energy: 'Energy',
  spares: 'Spare parts',
  consumables: 'Consumables',
  labour: 'Labour',
  downtime: 'Downtime',
  maintenance: 'Maintenance',
  total: 'Total cost',
};

/** F1/F2: why this plan (production) or what the maintenance proposal does. */
const planExplanation = ({ proposal: p = {} } = {}) => {
  const f = p.feasibility ?? {};
  const cards = p.jobCards ?? [];
  const title = p.title ?? 'The plan';
  const summary =
    f.feasible === false
      ? `${title} falls ${num(f.shortfall) ?? 0} pcs short of the due date with the current shifts; see the alternatives.`
      : `${title} fits: ${cards.length} job card${cards.length === 1 ? '' : 's'}, finishing ${num(f.slackHours, 1) ?? 0} h before the due date.`;
  const bullets = [
    ...cards
      .slice(0, 3)
      .map(
        (c) =>
          `${c.asset}: ${c.target} pcs with ${c.tool}${c.setupMin ? ` after a ${c.setupMin} min changeover` : ''}`,
      ),
    ...(p.risks ?? []).slice(0, 1).map((r) => r.text),
  ];
  return { summary, bullets: bullets.length ? bullets : ['No machine changes are needed'] };
};

/** F2: which push option to take, from the deterministic lateness. */
const maintenanceRecommendation = ({ task = {}, options = [], recommended } = {}) => {
  const pick = options.find((o) => o.id === recommended) ?? options[0] ?? { id: 'defer', label: 'Defer' };
  const late = num(pick.lateHours, 1) ?? 0;
  const what = task.title ?? 'The maintenance';
  return {
    recommendedOption: pick.id,
    summary:
      pick.id === 'zero_impact'
        ? `${what} fits in a free window before its deadline, so production is not touched.`
        : `${pick.label ?? pick.id} is the least disruptive way to do the ${what.replace(/^[A-Z](?=[a-z])/, (c) => c.toLowerCase())} before its deadline${
            late ? `, delaying production by ${late} h` : ''
          }.`,
    reasons: [
      late ? `Smallest delay against plan due dates (${late} h)` : 'No job card is late',
      pick.id === 'defer' ? 'Every other option breaks a due date' : 'Done before the deadline the AI set',
    ],
  };
};

/** F5: the Costs page overview. */
const costOverview = ({ period = {}, currency = {}, totals = {}, previous = {}, topDrivers = [] } = {}) => {
  const symbol = currency.symbol ?? '₹';
  const change = previous.total ? ((totals.total - previous.total) / previous.total) * 100 : null;
  const top = topDrivers[0];
  const label = period.label ?? '';
  const when = !label
    ? 'so far'
    : /^\d/.test(label)
      ? `on ${label}`
      : `in ${/^week/i.test(label) ? 'the ' : ''}${label}`;
  // A previous period with almost no recorded cost makes the % meaningless (e.g. just after go-live).
  const thin = (p) => p == null || Math.abs(p) > 300;
  const versus =
    change == null
      ? ''
      : thin(change)
        ? ' (the previous period has little recorded cost)'
        : ` (${pct(change)} vs the previous period)`;
  const trend = thin(change)
    ? 'There is too little recorded cost in the previous period for a fair comparison.'
    : Math.abs(change) < 10
      ? 'Overall spend is in line with the previous period.'
      : `Overall spend is ${num(Math.abs(change))}% ${change > 0 ? 'higher' : 'lower'} than the same stretch of the previous period.`;
  return {
    headline: `${money(totals.total, symbol)} spent ${when}${versus}`,
    summary: top
      ? `${top.label} drives the most cost at ${money(top.amount, symbol)}, mostly ${(
          COMPONENT[top.component] ?? top.component ?? 'cost'
        ).toLowerCase()}. ${trend}`
      : 'No cost was recorded in this period.',
    drivers: topDrivers.slice(0, 5).map((d) => ({
      key: d.key,
      explanation: `${d.label}: ${money(d.amount, symbol)}, mostly ${(COMPONENT[d.component] ?? 'cost').toLowerCase()}${
        d.deltaPct == null
          ? ''
          : thin(d.deltaPct)
            ? ', up from little recorded cost before'
            : `, ${pct(d.deltaPct)} vs the previous period`
      }.`,
      action:
        d.component === 'energy'
          ? 'Check idle consumption and switch auxiliaries off between jobs'
          : d.component === 'downtime'
            ? 'Review the top stop reason with production'
            : 'Review the work orders behind this cost',
    })),
  };
};

/** F5: two sentences on a breached cost alert (cause, then fix). */
const costAlert = ({ alert = {}, value, currency = {}, breakdown = [] } = {}) => {
  const symbol = currency.symbol ?? '₹';
  const below = alert.comparator === 'lt' || alert.comparator === 'lte';
  const component = COMPONENT[alert.metric] ?? 'Total cost';
  const metric = component.endsWith('cost') ? component : `${component} cost`;
  const rows = [...breakdown].sort((a, b) => (b.amount ?? 0) - (a.amount ?? 0));
  // An asset alert breaks down by component: naming the metric itself as the source says nothing.
  const top = rows.length > 1 && !metric.startsWith(rows[0].label) ? rows[0] : null;
  const when = { week: ['this week', 'last week'], month: ['this month', 'last month'] }[alert.period] ?? [
    'today',
    'yesterday',
  ];
  const what = `${metric} ${alert.scopeLabel ? `on ${alert.scopeLabel} ` : ''}`;
  return {
    explanation:
      `${what}reached ${money(value, symbol)} ${when[below ? 1 : 0]}, ${below ? 'under' : 'past'} the ${money(alert.threshold, symbol)} ${below ? 'floor' : 'limit'}` +
      `${top ? `; most of it came from ${top.label} (${money(top.amount, symbol)})` : ''}. ` +
      (below
        ? 'Check that the meters and work orders behind it are still being recorded.'
        : alert.metric === 'energy'
          ? 'Check for load running while the line is idle and move non-urgent load to off-peak hours.'
          : 'Review the work orders and stops behind it before the next period starts.'),
  };
};

/** F6/F9: one line under each KPI card (one call for every stale KPI). */
const TIME_VIZ = new Set(['line', 'area', 'combo']);
/** One line per card, worded for its chart: a value against target, a trend, a peak, or a ranking. */
const insightLine = ({ kpi = {}, stats = {} }) => {
  const title = kpi.title ?? 'This KPI';
  const unit = kpi.unit ?? '';
  const fmt = (v) =>
    v == null
      ? 'n/a'
      : unit === '₹'
        ? money(v)
        : `${(num(v, 1) ?? 0).toLocaleString('en-IN')}${unit === '%' ? '%' : unit ? ` ${unit}` : ''}`;
  const range = (kpi.timeRangeLabel ?? 'the period')
    .replace(/\s*\(.*\)$/, '')
    .replace(/^[A-Z](?=[a-z])/, (c) => c.toLowerCase());
  const [top, next] = stats.top ?? [];
  if (['number', 'gauge'].includes(kpi.viz) || !top) {
    const value = stats.value ?? stats.last ?? stats.mean;
    const goal =
      kpi.target == null || value == null
        ? ''
        : value >= kpi.target
          ? `, on its ${fmt(kpi.target)} target`
          : `, below the ${fmt(kpi.target)} target`;
    return `${title} is ${fmt(value)} ${range}${goal}.`;
  }
  if (TIME_VIZ.has(kpi.viz)) {
    return `${title} averaged ${fmt(stats.mean)} ${range}${stats.changePct != null ? `, ${pct(stats.changePct)} from first to last reading` : ''}; the peak was ${fmt(stats.max)} (${top.label}).`;
  }
  if (kpi.viz === 'heatmap') {
    return `${title}: the peak is ${fmt(stats.max)} at ${top.label}, against ${fmt(stats.mean)} on average ${range}.`;
  }
  // Rankings (bar, stacked bar, pie, funnel, treemap, table…): the leader, its share and the runner-up.
  const share =
    unit !== '%' && kpi.viz !== 'stackedBar' && stats.sum > 0 && stats.count > 1
      ? ` (${Math.round((top.value / stats.sum) * 100)}% of ${fmt(stats.sum)})`
      : '';
  const goal =
    kpi.target != null && stats.min != null
      ? stats.min >= kpi.target
        ? `; all are on the ${fmt(kpi.target)} target`
        : `; the lowest is ${fmt(stats.min)}, below the ${fmt(kpi.target)} target`
      : '';
  return `${title}: ${top.label} leads with ${fmt(top.value)}${share}${next ? `, then ${next.label} at ${fmt(next.value)}` : ''} ${range}${goal}.`;
};
const kpiInsight = ({ items = [] } = {}) => ({
  insights: items.map((item) => ({ id: item.id, text: insightLine(item) })),
});

/** F9: the Command Center briefing. */
const briefing = ({ company = {}, scope = {}, evidence = {} } = {}) => {
  const name = scope.label ?? company.name ?? 'The plant';
  const prod = evidence.production ?? {};
  const oee = evidence.oee ?? {};
  const anomalies = evidence.anomalies?.items ?? [];
  const overdue = evidence.maintenance?.overdue ?? 0;
  const topStop = evidence.downtime?.top?.[0];
  const costs = evidence.costs ?? {};
  const symbol = company.currency?.symbol ?? '₹';
  const sentences = [
    prod.planned
      ? `Production is at ${num(prod.pct) ?? 0}% of plan (${(prod.produced ?? 0).toLocaleString('en-IN')} of ${prod.planned.toLocaleString('en-IN')} pcs).`
      : 'No production was planned for this period.',
    oee.oee != null
      ? `OEE is ${num(oee.oee * 100)}%, availability ${num((oee.availability ?? 0) * 100)}%.`
      : null,
    topStop ? `The longest stop was on ${topStop.asset} (${num(topStop.minutes)} min).` : null,
    anomalies.length
      ? `${anomalies.length} open anomal${anomalies.length === 1 ? 'y' : 'ies'}, worst on ${anomalies[0].asset}.`
      : 'No open anomalies.',
    costs.total != null ? `Spend so far is ${money(costs.total, symbol)}.` : null,
  ].filter(Boolean);
  const actions = [
    anomalies[0] && {
      title: `Plan maintenance for ${anomalies[0].asset}`,
      why: anomalies[0].summary ?? 'Open anomaly',
      link: anomalies[0].assetId
        ? `/planner?maintenance=${anomalies[0].assetId}${anomalies[0].id ? `&anomaly=${anomalies[0].id}` : ''}`
        : null,
      ask: null,
    },
    overdue > 0 && {
      title: `Clear ${overdue} overdue work order${overdue === 1 ? '' : 's'}`,
      why: 'Overdue maintenance raises the breakdown risk',
      link: '/m/workorders',
      ask: null,
    },
    topStop && {
      title: `Review the stops on ${topStop.asset}`,
      why: `${num(topStop.minutes)} min of downtime`,
      link: topStop.assetId ? `/machines/${topStop.assetId}` : null,
      ask: `Why did ${topStop.asset} stop today?`,
    },
    {
      title: 'Check the plan for the rest of the week',
      why: 'Keeps the due dates in view',
      link: '/planner',
      ask: null,
    },
    { title: 'Review cost drivers', why: 'Spend by asset and category', link: '/costs', ask: null },
  ]
    .filter(Boolean)
    .slice(0, 3);
  const keys = ['production', 'oee', 'anomalies', 'downtime', 'maintenance', 'costs'].filter(
    (k) => evidence[k],
  );
  return {
    headline: `${name}: ${anomalies.length ? `${anomalies.length} machine${anomalies.length === 1 ? '' : 's'} to watch` : 'a steady shift'}${
      overdue ? `, ${overdue} overdue` : ''
    }`,
    narrative: sentences.join(' '),
    actions,
    evidence: (keys.length ? keys : ['production']).slice(0, 4),
  };
};

/** `mockInput.kind` → builder; mock.js uses these before its per-purpose builders. */
export const PHASE5_BUILDERS = {
  plan_explanation: planExplanation,
  maintenance_recommendation: maintenanceRecommendation,
  cost_overview: costOverview,
  cost_alert: costAlert,
  kpi_insights: kpiInsight,
  briefing,
};
