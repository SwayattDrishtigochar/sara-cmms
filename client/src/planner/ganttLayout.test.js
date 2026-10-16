import { describe, expect, it } from 'vitest';
import {
  endOfDay,
  ghostEnd,
  layoutGantt,
  localDate,
  mergePlan,
  shiftBands,
  startOfDay,
  ticks,
  timeScale,
  zoneOffset,
} from './ganttLayout.js';

const TZ = 'Asia/Kolkata';
const H = 36e5;
// 16-10-2026 00:00 IST
const S = Date.parse('2026-10-15T18:30:00Z');
const at = (h) => new Date(S + h * H).toISOString();
const range = (hours) => ({ start: at(0), end: at(hours) });
const rows = [
  { id: 'imm5', label: 'IMM 5' },
  { id: 'p1', label: 'Press 1' },
  { id: 'imm1', label: 'IMM 1' },
];

describe('time zones', () => {
  it('finds IST offsets, local midnights and date inputs', () => {
    expect(zoneOffset(S, TZ)).toBe(5.5 * H);
    expect(startOfDay(S + 13.7 * H, TZ)).toBe(S);
    expect(startOfDay(S - 1, TZ)).toBe(S - 24 * H);
    expect(new Date(endOfDay('2026-10-25', TZ)).toISOString()).toBe('2026-10-25T18:29:59.000Z');
    expect(localDate(S + H, TZ)).toBe('2026-10-16');
  });
});

describe('timeScale', () => {
  it('maps time to pixels and back', () => {
    const scale = timeScale(range(24), 960);
    expect(scale.x(at(6))).toBe(240);
    expect(scale.t(480)).toBe(S + 12 * H);
  });
});

describe('layoutGantt', () => {
  const base = { rows, range: range(24), width: 960, rowHeight: 36, barHeight: 22 };

  it('positions bars, clips them to the range and keeps 2 px minimum', () => {
    const out = layoutGantt({
      ...base,
      bars: [
        { id: 'a', rowId: 'imm5', start: at(6), end: at(12), kind: 'jobcard' },
        { id: 'b', rowId: 'imm1', start: at(-5), end: at(2), kind: 'jobcard' },
        { id: 'c', rowId: 'imm1', start: at(30), end: at(32), kind: 'jobcard' },
        { id: 'd', rowId: 'imm5', start: at(13), end: at(13.001), kind: 'jobcard' },
        { id: 'e', rowId: 'ghost-row', start: at(1), end: at(2) },
      ],
      now: at(3),
    });
    const a = out.bars.find((b) => b.id === 'a');
    expect(a).toMatchObject({ x: 240, w: 240, y: 7, h: 22, lane: 0, segments: [{ x: 240, w: 240 }] });
    const b = out.bars.find((x) => x.id === 'b');
    expect(b).toMatchObject({ x: 0, w: 80, clipStart: true, clipEnd: false });
    expect(out.bars.find((x) => x.id === 'c')).toBeUndefined();
    expect(out.bars.find((x) => x.id === 'e')).toBeUndefined();
    expect(out.bars.find((x) => x.id === 'd').w).toBe(2);
    expect(out.nowX).toBe(120);
    expect(layoutGantt({ ...base, now: at(30) }).nowX).toBeNull();
  });

  it('groups rows by machine type, with headers when asked', () => {
    const out = layoutGantt({ ...base, groupHeight: 20 });
    expect(out.rows.map((r) => r.id)).toEqual(['imm5', 'imm1', 'p1']);
    expect(out.groups).toEqual([
      { label: 'IMM', y: 0, h: 20 },
      { label: 'Press', y: 92, h: 20 },
    ]);
    expect(out.rows.map((r) => r.y)).toEqual([20, 56, 112]);
    expect(out.height).toBe(148);
    expect(layoutGantt({ ...base, rows: [{ id: 'x', label: 'Line', group: 'Assembly' }] }).groups).toEqual(
      [],
    );
  });

  it('stacks overlapping bars in lanes and grows the row', () => {
    const out = layoutGantt({
      ...base,
      bars: [
        { id: 'a', rowId: 'imm5', start: at(0), end: at(10) },
        { id: 'b', rowId: 'imm5', start: at(5), end: at(15) },
        { id: 'c', rowId: 'imm5', start: at(10), end: at(20) },
      ],
    });
    const lanes = Object.fromEntries(out.bars.map((b) => [b.id, b.lane]));
    expect(lanes).toEqual({ a: 0, b: 1, c: 0 });
    expect(out.rows[0].h).toBe(36 + 26);
    expect(out.bars.find((b) => b.id === 'b').y).toBe(7 + 26);
    expect(out.rows[1].y).toBe(62);
  });

  it('splits a job card around a maintenance bar of the same row', () => {
    const out = layoutGantt({
      ...base,
      bars: [
        { id: 'jc', rowId: 'p1', start: at(0), end: at(12), kind: 'jobcard' },
        { id: 'wo', rowId: 'p1', start: at(4), end: at(6), kind: 'maintenance', ghost: true },
        { id: 'other', rowId: 'imm5', start: at(0), end: at(12), kind: 'jobcard' },
      ],
    });
    const jc = out.bars.find((b) => b.id === 'jc');
    expect(jc.segments).toEqual([
      { x: 0, w: 160 },
      { x: 240, w: 240 },
    ]);
    expect(jc.lane).toBe(0);
    const wo = out.bars.find((b) => b.id === 'wo');
    expect(wo).toMatchObject({ x: 160, w: 80, h: 30, lane: 0 });
    expect(out.bars.find((b) => b.id === 'other').segments).toHaveLength(1);
  });

  it('draws an outline where a moved ghost bar used to be', () => {
    const out = layoutGantt({
      ...base,
      bars: [
        {
          id: 'jc',
          rowId: 'p1',
          start: at(8),
          end: at(14),
          ghost: true,
          change: 'moved',
          from: { start: at(6), end: at(12) },
        },
        {
          id: 'far',
          rowId: 'p1',
          start: at(16),
          end: at(18),
          ghost: true,
          from: { start: at(40), end: at(42) },
        },
      ],
    });
    expect(out.bars.find((b) => b.id === 'jc').outline).toEqual({ x: 240, w: 240 });
    expect(out.bars.find((b) => b.id === 'far').outline).toBeNull();
  });

  it('places anomaly markers on their row, pinned to the range start', () => {
    const out = layoutGantt({
      ...base,
      markers: [
        { id: 'm1', rowId: 'p1', at: at(-30) },
        { id: 'm2', rowId: 'imm5', at: at(6) },
        { id: 'm3', rowId: 'nope', at: at(6) },
      ],
    });
    expect(out.markers.map((m) => [m.id, m.x, m.y])).toEqual([
      ['m1', 0, 72],
      ['m2', 240, 0],
    ]);
  });
});

describe('ticks', () => {
  it('uses hours up to two days, fitted to the width', () => {
    const t = ticks(range(24), TZ, 960);
    expect(t).toHaveLength(13);
    expect(t[0]).toMatchObject({ x: 0, label: 'Fri 16', major: true });
    expect(t[1]).toMatchObject({ x: 80, label: '02:00', major: false });
    expect(ticks(range(24), TZ, 240).map((x) => x.label)).toEqual([
      'Fri 16',
      '06:00',
      '12:00',
      '18:00',
      'Sat 17',
    ]);
  });

  it('uses days beyond two days', () => {
    const t = ticks(range(24 * 7), TZ, 700);
    expect(t.map((x) => x.label)).toEqual([
      'Fri 16',
      'Sat 17',
      'Sun 18',
      'Mon 19',
      'Tue 20',
      'Wed 21',
      'Thu 22',
      'Fri 23',
    ]);
    expect(t[1].x).toBe(100);
    expect(t.every((x) => x.major)).toBe(true);
    expect(ticks(range(24 * 7), TZ, 0)).toEqual([]);
  });
});

describe('shiftBands', () => {
  it('repeats HH:MM shifts on every local day, overnight past midnight', () => {
    const bands = shiftBands(
      [
        { name: 'A', start: '06:00', end: '14:00' },
        { name: 'C', start: '22:00', end: '06:00' },
      ],
      range(24),
      TZ,
    );
    expect(bands.map((b) => [b.name, (b.start - S) / H, (b.end - S) / H])).toEqual([
      ['C', 0, 6],
      ['A', 6, 14],
      ['C', 22, 24],
    ]);
  });

  it('clips shifts given as instants', () => {
    expect(shiftBands([{ name: 'B', start: at(-2), end: at(4) }], range(24), TZ)).toEqual([
      { name: 'B', start: S, end: S + 4 * H },
    ]);
  });
});

describe('mergePlan', () => {
  const base = {
    range: range(24),
    rows: [{ id: 'p1', label: 'Press 1' }],
    bars: [
      { id: 'jc14', code: 'JC-14', rowId: 'p1', start: at(0), end: at(10) },
      { id: 'jc15', code: 'JC-15', rowId: 'p1', start: at(10), end: at(12) },
    ],
    markers: [{ id: 'm1', rowId: 'p1', at: at(1) }],
  };
  const plan = {
    rows: [
      { id: 'p1', label: 'Press 1' },
      { id: 'p2', label: 'Press 2' },
    ],
    bars: [
      { id: 'g1', code: 'JC-14', rowId: 'p1', start: at(0), end: at(12), ghost: true, change: 'extended' },
      { id: 'g2', rowId: 'p2', start: at(4), end: at(6), ghost: true, change: 'new' },
      { id: 'jc15', rowId: 'p1', start: at(10), end: at(12) },
    ],
    markers: [{ id: 'm1', rowId: 'p1', at: at(1) }],
    delays: [{ jobCardId: 'jc14', code: 'JC-14', rowId: 'p1', hours: 2, late: false }],
  };

  it('overlays ghosts, replaces moved bars and adds missing rows', () => {
    const out = mergePlan(base, plan);
    expect(out.rows.map((r) => r.id)).toEqual(['p1', 'p2']);
    expect(out.bars.map((b) => b.id)).toEqual(['jc15', 'g1', 'g2']);
    expect(out.markers).toHaveLength(1);
    expect(out.delays).toHaveLength(1);
    expect(mergePlan(base, null)).toBe(base);
    expect(mergePlan(null, plan)).toBe(plan);
    expect(ghostEnd(plan)).toBe(S + 12 * H);
    expect(ghostEnd({ bars: [] })).toBeNull();
  });
});
