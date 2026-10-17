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
