import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setFormatPrefs } from '../lib/format.js';
import { Viz } from './Viz.jsx';
import { heatOpacity, tableOf, valueAxis, vizSummary } from './vizData.js';

const range = {
  start: '2026-10-09T18:30:00.000Z',
  stop: '2026-10-16T18:30:00.000Z',
  label: 'last 7 days',
  timeZone: 'Asia/Kolkata',
};
const stats = {
  count: 3,
  sum: 60,
  min: 10,
  max: 30,
  mean: 20,
  first: 10,
  last: 30,
  changePct: 200,
  top: [{ label: 'IMM 3', value: 30 }],
};
const base = { title: 'Fixture', unit: 'kWh', timeRange: range, ranAt: range.stop, warnings: [], stats };
const days = ['2026-10-14T00:00:00.000Z', '2026-10-15T00:00:00.000Z', '2026-10-16T00:00:00.000Z'];
const seriesData = {
  xKey: 'x',
  xType: 'time',
  series: [
    { key: 'kwh', label: 'Energy', unit: 'kWh', axis: 'left' },
    { key: 'shots', label: 'Shots', unit: 'shots', axis: 'right', type: 'line' },
  ],
  data: days.map((x, i) => ({ x, kwh: 10 * (i + 1), shots: 100 * (i + 1) })),
};
const slices = { slices: ['IMM 3', 'IMM 1', 'Press 1'].map((label, i) => ({ label, value: 30 - i * 10 })) };

const FIXTURES = {
  number: { value: 1234.5, tone: 'good', target: 1000 },
  gauge: { unit: '%', value: 72, min: 0, max: 100, target: 85, tone: 'warn', thresholds: { warn: 80 } },
  line: seriesData,
  area: seriesData,
  bar: { ...seriesData, xType: 'category', data: seriesData.data.map((d, i) => ({ ...d, x: `IMM ${i}` })) },
  stackedBar: {
    ...seriesData,
    xType: 'category',
    data: seriesData.data.map((d, i) => ({ ...d, x: `D${i}` })),
  },
  combo: seriesData,
  scatter: { ...seriesData, xType: 'number', data: [1, 2, 3].map((x) => ({ x, kwh: x * 3, shots: x })) },
  radar: { ...seriesData, xType: 'category', data: ['A', 'B', 'C'].map((x, i) => ({ x, kwh: i, shots: i })) },
  pie: slices,
  funnel: slices,
  treemap: slices,
  heatmap: {
    xLabels: ['00:00', '01:00'],
    yLabels: ['Wed 14 Oct', 'Thu 15 Oct'],
    cells: [
      { x: '00:00', y: 'Wed 14 Oct', value: 12 },
      { x: '01:00', y: 'Wed 14 Oct', value: 30 },
      { x: '00:00', y: 'Thu 15 Oct', value: 4 },
    ],
    cellMin: 4,
    cellMax: 30,
  },
  timeline: {
    lanes: [
      {
        label: 'IMM 1',
        runs: [
          { start: '2026-10-15T00:00:00.000Z', end: '2026-10-15T06:00:00.000Z', status: 'Running' },
          { start: '2026-10-15T06:00:00.000Z', end: '2026-10-15T07:00:00.000Z', status: 'Stopped' },
        ],
      },
    ],
  },
  table: {
    columns: [
      { key: 'asset', label: 'Asset' },
      { key: 'minutes', label: 'Downtime', unit: 'min' },
    ],
    rows: [
      { asset: 'IMM 1', minutes: 42 },
      { asset: 'Press 1', minutes: 17 },
    ],
  },
};
const resultOf = (viz, extra = {}) => ({ ...base, viz, title: `Fixture ${viz}`, ...FIXTURES[viz], ...extra });

beforeEach(() => {
  setFormatPrefs({ timeZone: 'Asia/Kolkata', dateFormat: 'DD-MM-YYYY', timeFormat: '24-hours' });
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Viz', () => {
  it.each(Object.keys(FIXTURES).filter((v) => v !== 'table'))(
    'renders %s as an image with a summary',
    (viz) => {
      render(<Viz result={resultOf(viz)} />);
      const role = viz === 'timeline' ? 'region' : 'img';
      const img = screen.getByRole(role, { name: new RegExp(`^Fixture ${viz}|of Fixture ${viz}`) });
      expect(img).toBeTruthy();
    },
  );

  it('renders all 15 types', () => {
    expect(Object.keys(FIXTURES)).toHaveLength(15);
  });

  it('number: value, unit, tone label and target', () => {
    render(<Viz result={resultOf('number')} />);
    expect(screen.getByText('1,235')).toBeTruthy();
    expect(screen.getByText('On target')).toBeTruthy();
    expect(screen.getByText(/Target 1,000 kWh/)).toBeTruthy();
    expect(screen.getByRole('img').getAttribute('aria-label')).toBe(
      'Fixture number for last 7 days: 1,235 kWh, target 1,000 kWh, on target',
    );
  });

  it('gauge: SVG with the value and a warning label', () => {
    const { container } = render(<Viz result={resultOf('gauge')} />);
    expect(container.querySelector('svg text')?.textContent).toBe('72 %');
    expect(screen.getByText('Warning')).toBeTruthy();
    expect(container.querySelectorAll('svg line')).toHaveLength(2); // warn + target ticks
  });

  it('heatmap: titled cells on a sequential scale, empty cells muted', () => {
    const { container } = render(<Viz result={resultOf('heatmap')} />);
    const hot = container.querySelector('[title="Wed 14 Oct · 01:00: 30 kWh"]');
    const cool = container.querySelector('[title="Thu 15 Oct · 00:00: 4 kWh"]');
    expect(hot.style.background).toContain('100%');
    expect(cool.style.background).toContain('10%');
    expect(container.querySelector('[title="Thu 15 Oct · 01:00: —"]').style.background).toBe(
      'var(--surface-2)',
    );
    fireEvent.pointerEnter(hot);
    expect(screen.getByText('Wed 14 Oct · 01:00: 30 kWh', { selector: 'span.tabular' })).toBeTruthy();
  });

  it('funnel and pie list every stage with its value', () => {
    render(<Viz result={resultOf('funnel')} />);
    expect(screen.getByText('IMM 3')).toBeTruthy();
    expect(screen.getByText('· 33%')).toBeTruthy();
    cleanup();
    render(<Viz result={resultOf('pie')} />);
    expect(screen.getByText('Press 1')).toBeTruthy();
    expect(screen.getByText('50%')).toBeTruthy();
  });

  it('timeline: one status strip per lane', () => {
    render(<Viz result={resultOf('timeline')} />);
    expect(screen.getByText('IMM 1')).toBeTruthy();
    expect(screen.getByRole('group', { name: /Running 6 h 0 m/ })).toBeTruthy();
  });

  it('table: the rows through DataTable', () => {
    render(<Viz result={resultOf('table')} />);
    const table = screen.getByRole('table');
    expect(within(table).getByText('Press 1')).toBeTruthy();
    expect(within(table).getByText('42 min')).toBeTruthy();
  });

  it('series charts: legend for two series and a table view', () => {
    render(<Viz result={resultOf('combo')} />);
    expect(screen.getByText('Energy')).toBeTruthy();
    expect(screen.getByText('Shots')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Show as table' }));
    const table = screen.getByRole('table');
    expect(within(table).getAllByRole('row')).toHaveLength(4);
    expect(within(table).getByText('300 shots')).toBeTruthy();
    expect(within(table).getByText('15-10-2026 05:30')).toBeTruthy();
  });

  it('compact hides the table toggle', () => {
    render(<Viz result={resultOf('bar')} compact />);
    expect(screen.queryByRole('button', { name: 'Show as table' })).toBeNull();
  });

  it('error and empty states', () => {
    render(<Viz result={resultOf('line', { error: 'Source energy timed out' })} />);
    expect(screen.getByText("This KPI couldn't be computed")).toBeTruthy();
    expect(screen.getByText('Source energy timed out')).toBeTruthy();
    cleanup();
    render(<Viz result={resultOf('heatmap', { cells: [] })} />);
    expect(screen.getByText('No data in last 7 days')).toBeTruthy();
  });
});

describe('vizData', () => {
  it('valueAxis puts round ticks over the stack height and the target', () => {
    const series = [{ key: 'spares' }, { key: 'labour' }];
    const rows = [
      { spares: 37000, labour: 818 },
      { spares: 4000, labour: null },
    ];
    expect(valueAxis(rows, series, { stacked: true }).ticks).toEqual([0, 10000, 20000, 30000, 40000]);
    expect(valueAxis(rows, series).ticks).toEqual([0, 10000, 20000, 30000, 40000]);
    expect(valueAxis([{ oee: 62 }], [{ key: 'oee' }], { marks: [85, null] }).ticks).toEqual([
      0, 25, 50, 75, 100,
    ]);
    expect(valueAxis([{ v: null }], [{ key: 'v' }])).toBeNull();
  });

  it('heatOpacity is monotonic from 0.1 to 1', () => {
    expect(heatOpacity(0, 0, 10)).toBe(0.1);
    expect(heatOpacity(10, 0, 10)).toBe(1);
    expect(heatOpacity(5, 0, 10)).toBe(0.55);
    expect(heatOpacity(null, 0, 10)).toBe(0);
    expect(heatOpacity(3, 3, 3)).toBe(1);
  });

  it('tableOf flattens timeline lanes and keeps series units', () => {
    const t = tableOf(resultOf('timeline'));
    expect(t.rows).toHaveLength(2);
    expect(t.rows[1]).toMatchObject({ lane: 'IMM 1', status: 'Stopped' });
    const s = tableOf(resultOf('line'));
    expect(s.columns.map((c) => c.unit)).toEqual([undefined, 'kWh', 'shots']);
  });

  it('vizSummary names the chart, range and extremes', () => {
    expect(vizSummary(resultOf('bar'))).toBe(
      'Bar chart of Fixture bar for last 7 days, 3 values, low 10 kWh, high 30 kWh, largest IMM 3 at 30 kWh',
    );
  });
});
