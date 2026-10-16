import { render, screen } from '@testing-library/react';
import { cloneElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ChartBlock } from './ChartBlock.jsx';

// jsdom has no layout: give the chart a fixed size so Recharts draws its axes.
vi.mock('recharts', async (importOriginal) => ({
  ...(await importOriginal()),
  ResponsiveContainer: ({ children }) => cloneElement(children, { width: 400, height: 200 }),
}));

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

describe('ChartBlock y axis', () => {
  it('uses round ticks instead of 9.5K steps', () => {
    render(
      <ChartBlock
        type="bar"
        xKey="day"
        series={[{ key: 'cost', label: 'Cost' }]}
        data={[
          { day: 'Mon', cost: 12000 },
          { day: 'Tue', cost: 38000 },
        ]}
      />,
    );
    for (const t of ['10K', '20K', '30K', '40K']) expect(screen.getByText(t)).toBeTruthy();
    expect(screen.queryByText('9.5K')).toBeNull();
  });
});
