import { describe, expect, it } from 'vitest';
import {
  applyAdjustment,
  checkOf,
  isDirty,
  objectiveOf,
  operatorOf,
  segmentsOf,
  setCard,
  setTask,
  skillsForTask,
  toEditedMaintenance,
  toEditedProduction,
  verdictTone,
  withOperator,
} from './planEdits.js';

const H = 36e5;
const t0 = Date.parse('2026-10-20T00:30:00Z'); // 06:00 IST
const at = (h) => new Date(t0 + h * H).toISOString();

const proposal = {
  _id: 'pp1',
  kind: 'production',
  input: { partName: 'Housing-A', quantity: 5000, dueDate: at(72), plantId: 'pl1' },
  feasibility: { feasible: true, verdict: 'doable', dueDate: at(72) },
  diff: {
    bars: [],
    jobCards: [
      {
        key: 'op-1',
        assetId: { _id: 'imm5' },
        toolId: 't101',
        target: 5000,
        start: at(0),
        end: at(16),
        operators: [{ userId: 'u1', name: 'Sachin', shiftName: 'A', start: at(0), end: at(8) }],
      },
    ],
  },
};

describe('toEditedProduction', () => {
  it('reads a proposal (ids as strings, ISO dates, operators trimmed)', () => {
    const e = toEditedProduction(proposal);
    expect(e).toEqual({
      proposalId: 'pp1',
      partName: 'Housing-A',
      quantity: 5000,
      dueDate: at(72),
      plantId: 'pl1',
      jobCards: [
        {
          key: 'op-1',
          assetId: 'imm5',
          toolId: 't101',
          target: 5000,
          start: at(0),
          end: at(16),
          operators: [{ userId: 'u1', shiftName: 'A', start: at(0), end: at(8) }],
        },
      ],
    });
  });

  it('prefers the check rows and the edited input stored on the proposal', () => {
    const check = {
      feasibility: { dueDate: at(80) },
      jobCards: [{ key: 'op-1', assetId: 'imm3', toolId: 't102', target: 4000, start: at(1), end: at(10) }],
      proposal: { ...proposal, input: { ...proposal.input, edited: { quantity: 4000 } } },
    };
    const e = toEditedProduction(check);
    expect(e.quantity).toBe(4000);
    expect(e.dueDate).toBe(at(80));
    expect(e.jobCards[0]).toMatchObject({ assetId: 'imm3', target: 4000, operators: [] });
  });
});

describe('toEditedMaintenance', () => {
  it('maps tasks to key/window/duration/technicianId', () => {
    const e = toEditedMaintenance({
      _id: 'pm1',
      title: 'Maintenance plan – Pune',
      input: { objective: 'balanced' },
      diff: {
        tasks: [
          {
            key: 't-1',
            start: at(2),
            end: at(3.5),
            durationMin: 90,
            technician: { userId: 'u9', name: 'Arjun' },
          },
          { key: 't-2', start: at(5), end: at(6), durationMin: 60, technician: null },
        ],
      },
    });
    expect(e).toEqual({
      proposalId: 'pm1',
      name: 'Maintenance plan – Pune',
      objective: 'balanced',
      tasks: [
        { key: 't-1', start: at(2), end: at(3.5), durationMin: 90, technicianId: 'u9' },
        { key: 't-2', start: at(5), end: at(6), durationMin: 60, technicianId: null },
      ],
    });
  });
});

describe('edits', () => {
  const e = toEditedProduction(proposal);
  it('setCard / setTask patch one row by key and append unknown keys', () => {
    expect(setCard(e, 'op-1', { assetId: 'imm3' }).jobCards[0].assetId).toBe('imm3');
    expect(setCard(e, 'new-1', { assetId: 'imm1' }).jobCards).toHaveLength(2);
    const m = { tasks: [{ key: 't-1', technicianId: null }] };
    expect(setTask(m, 't-1', { technicianId: 'u2' }).tasks[0].technicianId).toBe('u2');
  });

  it('applyAdjustment merges the patch (rows by key, dueDate, quantity)', () => {
    const next = applyAdjustment(e, {
      id: 'adj-1',
      kind: 'move_start',
      patch: { jobCards: [{ key: 'op-1', start: at(4), end: at(20) }], dueDate: at(90), quantity: 4800 },
    });
    expect(next.jobCards[0]).toMatchObject({ start: at(4), end: at(20), assetId: 'imm5' });
    expect(next.dueDate).toBe(at(90));
    expect(next.quantity).toBe(4800);
    expect(e.jobCards[0].start).toBe(at(0)); // untouched
  });

  it('isDirty ignores key order and undefined fields', () => {
    expect(isDirty(e, { ...e })).toBe(false);
    expect(isDirty(e, { ...e, extra: undefined })).toBe(false);
    expect(isDirty(e, setCard(e, 'op-1', { target: 4999 }))).toBe(true);
  });
});

describe('segments and operators', () => {
  const shifts = [
    { name: 'A', start: '06:00', end: '14:00' },
    { name: 'B', start: '14:00', end: '22:00' },
  ];
  it('splits a window into the shift segments of the zone', () => {
    const segs = segmentsOf(shifts, { start: at(0), end: at(12) }, 'Asia/Kolkata');
    expect(segs.map((s) => s.name)).toEqual(['A', 'B']);
    expect(segs[0]).toEqual({ name: 'A', start: at(0), end: at(8) });
    expect(segs[1].end).toBe(at(12));
    expect(segmentsOf([], { start: at(0), end: at(2) }, 'Asia/Kolkata')).toEqual([
      { name: null, start: at(0), end: at(2) },
    ]);
  });

  it('finds and replaces the operator of a segment', () => {
    const seg = { name: 'A', start: at(0), end: at(8) };
    const ops = [
      { userId: 'u1', shiftName: 'A', start: at(0), end: at(8) },
      { userId: 'u2', shiftName: 'B' },
    ];
    expect(operatorOf(ops, seg).userId).toBe('u1');
    expect(operatorOf(ops, { name: 'B', start: at(8), end: at(12) }).userId).toBe('u2');
    const next = withOperator(ops, seg, 'u3');
    expect(next.map((o) => o.userId).sort()).toEqual(['u2', 'u3']);
    expect(withOperator(ops, seg, null).map((o) => o.userId)).toEqual(['u2']);
  });
});

describe('words and skills', () => {
  it('verdict tones and objectives', () => {
    expect(verdictTone('doable')).toBe('good');
    expect(verdictTone('adjust')).toBe('warn');
    expect(verdictTone('not_doable')).toBe('critical');
    expect([0, 33, 34, 66, 67, 100].map(objectiveOf)).toEqual([
      'protect_production',
      'protect_production',
      'balanced',
      'balanced',
      'fix_fast',
      'fix_fast',
    ]);
  });

  it('skillsForTask unions category and asset skills', () => {
    expect(skillsForTask({ category: 'Electrical', assetType: 'Energy Meter' })).toEqual([
      'electrical',
      'plc',
      'drives',
      'instrumentation',
    ]);
    expect(skillsForTask({ category: 'Inspection' })).toEqual([]);
  });

  it('checkOf derives a check from a stored proposal', () => {
    const c = checkOf({ proposal: { ...proposal, issues: [{ kind: 'late' }] }, plan: { rows: [] } });
    expect(c.verdict).toBe('doable');
    expect(c.jobCards).toHaveLength(1);
    expect(c.issues).toHaveLength(1);
    expect(checkOf({ proposal: { feasibility: { feasible: false } } }).verdict).toBe('adjust');
  });
});
