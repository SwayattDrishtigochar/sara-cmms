import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { demoChat, demoStep } from '../src/ai/mockChat.js';

const kpi = (text) => demoStep({ text, history: [], system: '' }).calls?.[0]?.args;

beforeAll(() => {
  demoChat.enabled = true;
});
afterAll(() => {
  demoChat.enabled = false;
});

describe('mock chat KPI chart types', () => {
  it('honours "as a <viz>" for every series and slice chart', () => {
    for (const viz of ['combo', 'scatter', 'radar', 'line', 'area', 'table']) {
      expect(kpi(`Build top downtime reasons this month as a ${viz}`).viz, viz).toBe(viz);
    }
    expect(kpi('Build maintenance cost by asset this month as a stacked bar').viz).toBe('stackedBar');
    for (const viz of ['pie', 'funnel', 'treemap']) {
      const def = kpi(`Build top downtime reasons this month as a ${viz}`);
      expect(def.viz, viz).toBe(viz);
      expect(def.encoding).toMatchObject({ label: 'reason', value: 'hours' });
    }
    // several series do not fit one slice chart: the recipe's chart stays
    expect(kpi('Build maintenance cost by asset this month as a funnel').viz).toBe('stackedBar');
  });
});

describe('mock chat update and delete', () => {
  it('starts an update or delete by finding the record', () => {
    expect(demoStep({ text: 'Set Press 1 criticality to High', history: [] }).calls).toEqual([
      { name: 'resolve', args: { kind: 'asset', query: 'Press 1' } },
    ]);
    expect(demoStep({ text: 'Delete WO-12, it is a duplicate', history: [] }).calls).toEqual([
      { name: 'resolve', args: { kind: 'work_order', query: 'WO-12' } },
    ]);
    expect(demoStep({ text: 'Remove the consumable Grease EP2', history: [] }).calls[0]).toMatchObject({
      name: 'mongo_find',
      args: { module: 'consumables', filter: { name: { $regex: '^Grease EP2$' } } },
    });
  });
});

describe('mock chat plans', () => {
  const turn = (name, args, result) => [
    { role: 'model', parts: [{ functionCall: { name, args } }] },
    { role: 'user', parts: [{ functionResponse: { name, response: { result } } }] },
  ];
  const planned = {
    proposalId: 'p1',
    code: 'PLN-3',
    verdict: 'adjust',
    feasible: true,
    dueDate: '26-10-2026 23:59',
    projectedFinish: '23-10-2026 10:00',
    slackHours: 85,
    shortfall: 0,
    jobCards: [{ key: 'op-1', asset: 'IMM 5', tool: 'T-103', target: 5000, start: 'a', end: 'b' }],
    risks: [],
    alternatives: [],
  };
  const text = 'Plan 5000 parts of Housing-A due 26 Oct';

  it('checks a production plan before applying it, and never applies a not-doable one', () => {
    const plan = turn('plan_production', {}, planned);
    expect(demoStep({ text, history: plan }).calls).toEqual([
      { name: 'check_plan', args: { proposalId: 'p1', edits: {} } },
    ]);
    const check = (verdict) => ({
      proposalId: 'p1',
      code: 'PLN-3',
      verdict,
      issues: verdict === 'doable' ? [] : ['IMM 5 is booked by JC-19 until 18-10 00:00.'],
      adjustments:
        verdict === 'doable' ? [] : [{ id: 'adj-1', kind: 'move_start', label: 'Start after JC-19' }],
      jobCards: [{ ...planned.jobCards[0], operators: ['Ravi Prasad', 'Sachin Pawar'] }],
    });
    const ok = demoStep({ text, history: [...plan, ...turn('check_plan', {}, check('doable'))] });
    expect(ok.calls).toEqual([{ name: 'apply_plan', args: { proposalId: 'p1' } }]);
    expect(ok.text).toMatch(/\*\*Doable:\*\*/);
    expect(ok.text).toMatch(/Ravi Prasad and Sachin Pawar/);
    const bad = demoStep({ text, history: [...plan, ...turn('check_plan', {}, check('not_doable'))] });
    expect(bad.calls).toBeUndefined();
    expect(bad.text).toMatch(/\*\*Not doable:\*\* IMM 5 is booked/);
    expect(bad.text).toMatch(/Start after JC-19/);
    expect(bad.text).toMatch(/\/planner\?tab=production&proposal=p1/);
  });

  it('makes a whole-plant maintenance plan and applies it', () => {
    const t = 'Maintenance plan for the whole plant next 7 days';
    expect(demoStep({ text: t, history: [] }).calls).toEqual([
      {
        name: 'plan_maintenance',
        args: { scope: 'plant', horizonDays: 7, objective: 'protect_production' },
      },
    ]);
    const result = {
      proposalId: 'm1',
      code: 'PLN-5',
      kind: 'maintenance_plan',
      name: 'Maintenance plan – Pune',
      verdict: 'doable',
      metrics: {
        tasks: 1,
        zeroImpactTasks: 1,
        productionHoursLost: 0,
        naiveProductionHoursLost: 2,
        downtimeCostAvoided: 9000,
      },
      tasks: [
        {
          key: 't-1',
          title: 'PM-4 Monthly',
          asset: 'IMM 6',
          start: 'a',
          end: 'b',
          technician: 'Ramesh Kumar',
          impactHours: 0,
          zeroImpact: true,
          late: false,
        },
      ],
      issues: [],
    };
    const next = demoStep({ text: t, history: turn('plan_maintenance', {}, result) });
    expect(next.calls).toEqual([{ name: 'apply_plan', args: { proposalId: 'm1' } }]);
    expect(next.text).toMatch(/Ramesh Kumar · no production impact/);
    expect(next.text).toMatch(/₹9,000 of downtime cost avoided/);
    expect(demoStep({ text: 'Plan maintenance for Press 1', history: [] }).calls[0].name).toBe('resolve');
    // A named machine gets its own plan (technicians, impact); a "window" asks for the single slot.
    const press = turn(
      'resolve',
      { kind: 'asset', query: 'Press 1' },
      { matches: [{ id: 'a1', label: 'PRS-01 · Press 1' }] },
    );
    expect(demoStep({ text: 'Plan maintenance for Press 1 this week', history: press }).calls).toEqual([
      {
        name: 'plan_maintenance',
        args: { scope: 'assets', assetIds: ['a1'], horizonDays: 7, objective: 'protect_production' },
      },
    ]);
    expect(demoStep({ text: 'Find a maintenance window for Press 1', history: press }).calls[0].args).toEqual(
      { asset: 'a1', horizonDays: 7 },
    );
  });
});

describe('mock chat refused tools', () => {
  const refused = (name) => [
    { role: 'model', parts: [{ functionCall: { name, args: {} } }] },
    {
      role: 'user',
      parts: [
        {
          functionResponse: {
            name,
            response: {
              error: `${name} is not available to Kavita Bhatt (role view)`,
              hint: 'Explain this to the user and offer to draft the details instead',
            },
          },
        },
      ],
    },
  ];

  it('explains a tool the role may not use instead of echoing the tool error', () => {
    const plan = demoStep({
      text: 'Plan 5000 parts of Housing-A due 25 Oct',
      history: refused('plan_production'),
    });
    expect(plan.text).toBe(
      "Your role (view) can't plan production. Ask a manager or an admin, or tell me the details and I'll write them up for you to pass on.",
    );
    const other = demoStep({ text: 'Set Press 1 criticality to High', history: refused('resolve') });
    expect(other.text).toMatch(/^Your role \(view\) can't resolve\./);
    expect(other.text).not.toMatch(/Kavita|hint|Explain this/);
  });
});

describe('mock chat decides the fields of a plain ask', () => {
  const turn = (name, args, response) => [
    { role: 'model', parts: [{ functionCall: { name, args } }] },
    { role: 'user', parts: [{ functionResponse: { name, response } }] },
  ];
  const furnace = turn(
    'resolve',
    { kind: 'asset', query: 'Furnace 2' },
    { result: { matches: [{ id: 'f2', label: 'FUR-02 · Furnace 2' }] } },
  );
  const gathered = (people, live) => [
    {
      role: 'model',
      parts: [
        { functionCall: { name: 'available_people', args: {} } },
        { functionCall: { name: 'telemetry_latest', args: { assetIds: ['f2'] } } },
      ],
    },
    {
      role: 'user',
      parts: [
        { functionResponse: { name: 'available_people', response: people } },
        { functionResponse: { name: 'telemetry_latest', response: live } },
      ],
    },
  ];
  const facts = gathered(
    { result: { rows: [{ id: 'u7', name: 'Ramesh Kumar' }] } },
    { result: { rows: [{ asset: 'Furnace 2', status: 'Stopped', currentTemp: 619.4 }] } },
  );
  const plain = 'Create a work order for Furnace 2 breakdown';

  it('work order for Furnace 2 breakdown: resolve → who is free + live reading → decided fields → confirm', () => {
    expect(demoStep({ text: plain, history: [] }).calls).toEqual([
      { name: 'resolve', args: { kind: 'asset', query: 'Furnace 2' } },
    ]);
    expect(demoStep({ text: plain, history: furnace }).calls).toEqual([
      { name: 'available_people', args: {} },
      { name: 'telemetry_latest', args: { assetIds: ['f2'] } },
    ]);
    const draft = demoStep({ text: plain, history: [...furnace, ...facts] });
    expect(draft.calls[0].name).toBe('create_record');
    const [item] = draft.calls[0].args.items;
    expect(item).toMatchObject({
      name: 'Breakdown – Furnace 2',
      asset: 'f2',
      priority: 'High',
      category: 'Breakdown',
      estimatedDurationMin: 120,
      people: ['u7'],
    });
    expect(item.dueDate).toMatch(/^\d{4}-/);
    expect(item.description).toMatch(/Live now: status Stopped, currentTemp 619\.4/);
    expect(draft.text).toMatch(
      /^Decided: priority High \(breakdown\), category Breakdown, due today, 120 min, assigned to Ramesh Kumar \(free now\)\. Change anything in the card, then confirm\./,
    );
  });

  it('drafts without an assignee or readings when those tools fail, instead of giving up', () => {
    const failed = gathered(
      { error: 'Unknown tool "available_people"' },
      { error: 'InfluxDB is not configured' },
    );
    const draft = demoStep({ text: plain, history: [...furnace, ...failed] });
    expect(draft.calls[0].name).toBe('create_record');
    expect(draft.calls[0].args.items[0].people).toBeUndefined();
    expect(draft.calls[0].args.items[0].description).toBe('Breakdown on Furnace 2. Raised from SARA chat.');
    expect(draft.text).toMatch(
      /^Decided: priority High \(breakdown\), category Breakdown, due today, 120 min\./,
    );
  });

  it.each([
    [
      'Furnace 2 ke liye breakdown work order banao',
      /^Maine tay kiya: priority High \(breakdown\), category Breakdown, aaj tak, 120 min, Ramesh Kumar ko assign \(abhi free\)\. Card mein kuch bhi badal sakte hain, phir confirm karein\.$/,
      /^Ho gaya: \*\*\[WO-9[^\]]*\]\(\/wo\)\*\* ban gaya Furnace 2 ke liye, Ramesh Kumar ko assign\.$/,
    ],
    [
      'Furnace 2 के लिए breakdown work order बनाओ',
      /^मैंने तय किया: priority High \(breakdown\), category Breakdown, आज तक, 120 min, Ramesh Kumar को assign \(अभी free\)। कार्ड में कुछ भी बदलें, फिर confirm करें।$/,
      /^हो गया: \*\*\[WO-9[^\]]*\]\(\/wo\)\*\* बन गया Furnace 2 के लिए, Ramesh Kumar को assign।$/,
    ],
  ])('"%s" is answered in the same language', (text, decided, done) => {
    expect(demoStep({ text, history: [] }).calls[0]).toEqual({
      name: 'resolve',
      args: { kind: 'asset', query: 'Furnace 2' },
    });
    const draft = demoStep({ text, history: [...furnace, ...facts] });
    expect(draft.calls[0].args.items[0]).toMatchObject({ name: 'Breakdown – Furnace 2', priority: 'High' });
    expect(draft.text).toMatch(decided);
    const made = turn(
      'create_record',
      {},
      { status: 'confirmed', result: { created: [{ label: 'WO-9 · Breakdown – Furnace 2', link: '/wo' }] } },
    );
    expect(demoStep({ text, history: [...furnace, ...facts, ...made] }).text.trim()).toMatch(done);
  });

  it('assigns whoever is free with people "auto", and a named person by id (did you mean)', () => {
    const auto = demoStep({ text: 'Assign whoever is free to WO-163', history: [] });
    expect(auto.calls).toEqual([
      { name: 'assign_work_order', args: { workOrder: 'WO-163', people: 'auto' } },
    ]);
    expect(auto.text).toMatch(/^Decided: whoever is free now takes WO-163\./);
    const named = 'Assign WO-163 to Rakesh Kumar';
    expect(demoStep({ text: named, history: [] }).calls).toEqual([
      { name: 'resolve', args: { kind: 'user', query: 'Rakesh Kumar' } },
    ]);
    // One "did you mean" suggestion is taken as the answer; several are offered.
    const one = turn(
      'resolve',
      { kind: 'user', query: 'Rakesh Kumar' },
      { result: { matches: [], suggestions: [{ id: 'u7', label: 'Ramesh Kumar' }] } },
    );
    expect(demoStep({ text: named, history: one }).calls).toEqual([
      { name: 'assign_work_order', args: { workOrder: 'WO-163', people: ['u7'] } },
    ]);
    const two = turn(
      'resolve',
      { kind: 'user', query: 'Rakesh Kumar' },
      {
        result: {
          matches: [],
          suggestions: [
            { id: 'u7', label: 'Ramesh Kumar' },
            { id: 'u8', label: 'Rakesh Jain' },
          ],
        },
      },
    );
    expect(demoStep({ text: named, history: two }).text).toBe(
      'I couldn\'t find "Rakesh Kumar". Did you mean Ramesh Kumar and Rakesh Jain?',
    );
    const done = turn(
      'assign_work_order',
      {},
      { status: 'confirmed', result: { assigned: [{ name: 'Ramesh Kumar' }] } },
    );
    expect(demoStep({ text: 'Assign whoever is free to WO-163', history: done }).text).toMatch(
      /Done: WO-163 is assigned to Ramesh Kumar\./,
    );
  });

  it('builds an anomalies KPI over the asked range', () => {
    const def = demoStep({ text: 'Make a KPI of anomalies for last 3 days', history: [] }).calls[0];
    expect(def.name).toBe('create_kpi');
    expect(def.args).toMatchObject({
      title: 'Anomalies by severity',
      viz: 'bar',
      timeRange: { text: 'last 3 days' },
    });
    expect(def.args.sources[0]).toMatchObject({ tool: 'mongo_aggregate', args: { module: 'anomalies' } });
    expect(JSON.stringify(def.args.sources[0].args.pipeline)).toContain('"$gte":"$start"');
  });

  it('reads the production of a part through its job cards', () => {
    const text = 'Production of Bracket-C today';
    expect(demoStep({ text, history: [] }).calls).toEqual([
      { name: 'resolve_time_range', args: { text: 'today' } },
    ]);
    const window = turn(
      'resolve_time_range',
      { text: 'today' },
      { result: { start: 'S', stop: 'E', label: 'Today (17-10-2026)' } },
    );
    const find = demoStep({ text, history: window }).calls[0];
    expect(find).toMatchObject({
      name: 'mongo_find',
      args: {
        module: 'jobcards',
        filter: { partName: 'Bracket-C', startDate: { $lt: 'E' }, endDate: { $gte: 'S' } },
      },
    });
    const cards = turn('mongo_find', find.args, {
      result: { rows: [{ jobCardId: 'JC-7' }, { jobCardId: 'JC-9' }] },
    });
    expect(demoStep({ text, history: [...window, ...cards] }).calls).toEqual([
      { name: 'job_card_progress', args: { jobCard: 'JC-7' } },
      { name: 'job_card_progress', args: { jobCard: 'JC-9' } },
    ]);
    const none = turn('mongo_find', find.args, { result: { rows: [] } });
    expect(demoStep({ text, history: [...window, ...none] }).text).toBe(
      'No job card for **Bracket-C** ran today (17-10-2026).',
    );
  });

  it('opens a record from its code alone, and a monthly PM gets its cycle and template', () => {
    expect(demoStep({ text: 'Open WO-163', history: [] }).calls).toEqual([
      { name: 'open_page', args: { page: 'record', module: 'workorders', recordId: 'WO-163' } },
    ]);
    expect(demoStep({ text: 'open JC-14', history: [] }).calls[0].args.module).toBe('jobcards');
    const text = 'Create a monthly PM for Furnace 2 cleaning';
    expect(demoStep({ text, history: [] }).calls[0]).toEqual({
      name: 'resolve',
      args: { kind: 'asset', query: 'Furnace 2' },
    });
    const pm = demoStep({ text, history: furnace });
    expect(pm.calls[0].name).toBe('create_record');
    expect(pm.calls[0].args.module).toBe('preventivemaintenances');
    expect(pm.calls[0].args.items[0]).toMatchObject({
      name: 'Cleaning – Furnace 2',
      assetAllocation: 'f2',
      estimatedDurationMin: 60,
      trigger: { scheduleType: 'Regular', cycle: { everyNumber: 1, duration: 'Months' } },
      selectWorkOrder: { name: 'Cleaning – Furnace 2', priority: 'Medium' },
    });
    expect(pm.text).toMatch(
      /^Decided: every month, first due in 30 days, 60 min, Medium priority work orders\./,
    );
    const fortnight = demoStep({ text: 'Set up a PM every 2 weeks for Press 1 belt check', history: [] });
    expect(fortnight.calls[0]).toEqual({ name: 'resolve', args: { kind: 'asset', query: 'Press 1' } });
  });
});
