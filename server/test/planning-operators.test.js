import { describe, expect, it } from 'vitest';
import { shiftWindows } from '../src/lib/shifts.js';
import { assignOperators, operatorFields } from '../src/planning/productionOperators.js';

/** Pure operator assignment (phase 7 §3.2) on a three-shift plant in UTC; people.js is the real module. */

const H = 3_600_000;
const T0 = new Date('2026-10-19T00:00:00Z'); // a Monday
const t = (h) => new Date(T0.getTime() + h * H);
const plant = {
  _id: 'p1',
  shifts: [
    { _id: 'sA', shiftName: 'A', shiftStartTime: '06:00', shiftEndTime: '14:00', breaks: [] },
    { _id: 'sB', shiftName: 'B', shiftStartTime: '14:00', shiftEndTime: '22:00', breaks: [] },
    { _id: 'sC', shiftName: 'C', shiftStartTime: '22:00', shiftEndTime: '06:00', breaks: [] },
  ],
  runningSchedule: [],
  holidays: [],
};
const WINDOW = { start: t(-24), end: t(72) };
/** A Production person on one shift, free of bookings. */
const person = (userId, shiftId, skills = []) => ({
  userId,
  name: userId,
  title: 'Machine Operator',
  role: 'technician',
  department: 'Production',
  skills,
  shiftId,
  shiftName: plant.shifts.find((s) => s._id === shiftId).shiftName,
  plantId: 'p1',
  onShift: shiftWindows(
    { ...plant, shifts: plant.shifts.filter((s) => s._id === shiftId) },
    WINDOW.start,
    WINDOW.end,
    'UTC',
  ).map(({ start, end }) => ({ start, end })),
  bookings: [],
  loadHours: 0,
});
const machine = (assetId, typeOfAsset = 'Injection Moulding Machine') => ({
  assetId,
  name: assetId.toUpperCase(),
  typeOfAsset,
});
const machinesById = new Map(
  [machine('imm3'), machine('imm5'), machine('press1', 'Power Press')].map((m) => [m.assetId, m]),
);
const assign = (cards, people) => assignOperators(cards, { people, plant, zone: 'UTC', machinesById });
const overlap = (a, b) => a.start < b.end && b.start < a.end;

describe('assignOperators', () => {
  it('puts one operator on every shift segment of a card', () => {
    const people = [
      person('ravi', 'sC', ['moulding']),
      person('sachin', 'sA', ['moulding']),
      person('vijay', 'sB', ['moulding']),
    ];
    const out = assign([{ key: 'op-1', assetId: 'imm3', start: t(0), end: t(24) }], people);
    const { operators, issues, shifts } = out.get('op-1');
    expect(issues).toEqual([]);
    expect(shifts).toBe(4); // C (00–06), A, B, C (22–24)
    expect(operators.map((o) => [o.shiftName, o.userId])).toEqual([
      ['C', 'ravi'],
      ['A', 'sachin'],
      ['B', 'vijay'],
      ['C', 'ravi'],
    ]);
    expect(operators[0]).toMatchObject({ shiftId: 'sC', start: t(0), end: t(6) });
    expect(operators[3]).toMatchObject({ start: t(22), end: t(24) });
    expect(operatorFields(operators)).toEqual({
      assignedTo: ['ravi', 'sachin', 'vijay'],
      operatorPlan: operators.map(({ userId, shiftName, start, end }) => ({
        user: userId,
        shiftName,
        start,
        end,
      })),
    });
    expect(people.every((p) => p.bookings.length === 0)).toBe(true); // the roster is a working copy
  });

  it('never books the same person on two overlapping segments', () => {
    const people = [
      person('sachin', 'sA', ['moulding']),
      person('deepak', 'sA', ['press']),
      person('vijay', 'sB', ['moulding']),
    ];
    const out = assign(
      [
        { key: 'op-1', assetId: 'imm3', start: t(6), end: t(22) },
        { key: 'op-2', assetId: 'imm5', start: t(8), end: t(20) },
      ],
      people,
    );
    const all = [...out.entries()].flatMap(([key, v]) => v.operators.map((o) => ({ ...o, key })));
    for (const a of all)
      for (const b of all) if (a !== b && a.userId === b.userId) expect(overlap(a, b)).toBe(false);
    expect(out.get('op-1').operators.map((o) => o.userId)).toEqual(['sachin', 'vijay']);
    expect(out.get('op-2').operators.map((o) => o.userId)).toEqual(['deepak']); // nobody else on B
    expect(out.get('op-2').issues.map((i) => i.kind)).toEqual(['operator_missing']);
  });

  it('prefers the operator skilled for the machine type', () => {
    const people = [person('deepak', 'sA', ['press']), person('sachin', 'sA', ['moulding'])];
    const imm = assign([{ key: 'op-1', assetId: 'imm3', start: t(6), end: t(14) }], people);
    expect(imm.get('op-1').operators[0].userId).toBe('sachin');
    const press = assign([{ key: 'op-1', assetId: 'press1', start: t(6), end: t(14) }], people);
    expect(press.get('op-1').operators[0].userId).toBe('deepak');
  });

  it('flags a shift with nobody as operator_missing', () => {
    const people = [person('sachin', 'sA', ['moulding']), person('vijay', 'sB', ['moulding'])];
    const out = assign([{ key: 'op-1', assetId: 'imm3', start: t(0), end: t(24) }], people);
    const { operators, issues } = out.get('op-1');
    expect(operators.map((o) => o.shiftName)).toEqual(['A', 'B']);
    expect(issues).toHaveLength(2);
    expect(issues[0]).toMatchObject({
      kind: 'operator_missing',
      severity: 'warning',
      jobCard: 'op-1',
      assetId: 'imm3',
      text: 'No Production operator is free for IMM3 in shift C on 19-10-2026',
    });
  });
});
