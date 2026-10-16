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
