import { render, screen } from '@testing-library/react';
import { cloneElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Viz } from './Viz.jsx';

// jsdom has no layout: give the chart a fixed size so Recharts draws its axes.
vi.mock('recharts', async (importOriginal) => ({
  ...(await importOriginal()),
  ResponsiveContainer: ({ children }) => cloneElement(children, { width: 400, height: 200 }),
}));

const result = {
  title: 'OEE by machine',
  viz: 'bar',
  unit: '%',
  xKey: 'x',
  xType: 'category',
  series: [{ key: 'oee', label: 'OEE', unit: '%', axis: 'left' }],
  data: [
    { x: 'IMM 1', oee: 71 },
    { x: 'Press 2', oee: 64 },
  ],
  timeRange: { label: 'last 7 days' },
  warnings: [],
};

describe('Viz compact', () => {
  it('keeps the category labels on a compact bar chart', () => {
    globalThis.ResizeObserver ??= class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
    render(<Viz result={result} compact />);
    expect(screen.getByText('IMM 1')).toBeTruthy();
    expect(screen.getByText('Press 2')).toBeTruthy();
  });
});
