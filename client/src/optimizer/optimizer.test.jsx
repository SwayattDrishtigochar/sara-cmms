import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bandScale, OptimizerCard, signed } from './OptimizerCard.jsx';

const IMM = 'Injection Moulding Machine';
const answer = (over = {}) => ({
  supported: true,
  assetId: 'a1',
  assetName: 'IMM-01',
  assetType: IMM,
  generatedAt: new Date().toISOString(),
  cached: false,
  mock: true,
  model: 'gemini-test',
  job: { jobCardId: 'JC-7', jobName: 'Cover', partName: 'Housing cover', toolName: 'T-14', partsPerShot: 2 },
  current: { status: 'Running', cycleTimeSec: 32, partsPerHour: 225 },
  predicted: { cycleTimeSec: 29.5, partsPerHour: 244, cycleTimeChangePct: -7.8, extraPartsPerShift: 152 },
  shiftHours: 8,
  headline: 'Two settings can win 152 parts a shift.',
  recommendations: [
    {
      field: 'coolingTime',
      label: 'Cooling time',
      unit: 's',
      current: 12,
      recommended: 10.5,
      normalMin: 9,
      normalMax: 14,
      effectOnCycleTimePct: -4,
      reason: 'The part ejects well above its set temperature.',
      risk: 'Watch for warpage on the first shots.',
    },
  ],
  notes: ['Based on the last 2 hours.'],
  ...over,
});

const show = (props, body) => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, status: 200, json: async () => body })),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <OptimizerCard {...props} />
    </QueryClientProvider>,
  );
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('OptimizerCard', () => {
  it('shows the gain, the before/after numbers and each setting', async () => {
    show({ assetId: 'a1', assetType: IMM }, answer());
    expect(await screen.findByText('+152')).toBeTruthy();
    expect(screen.getByText('Cooling time')).toBeTruthy();
    expect(screen.getByText('-4.0 % cycle')).toBeTruthy();
    expect(screen.getByText('-7.8 %')).toBeTruthy();
    expect(screen.getByText('mock')).toBeTruthy();
    expect(screen.getByText('JC-7 · Housing cover · T-14')).toBeTruthy();
    expect(screen.getByText(/Watch for warpage/)).toBeTruthy();
  });

  it('says so when there is nothing to change', async () => {
    show({ assetId: 'a1', assetType: IMM, compact: true }, answer({ recommendations: [] }));
    expect(await screen.findByText('Already running close to its best settings')).toBeTruthy();
  });

  it('renders nothing for other machine types or unsupported answers', async () => {
    const other = show({ assetId: 'a1', assetType: 'Compressor' }, answer());
    expect(other.container.innerHTML).toBe('');
    cleanup();
    const unsupported = show({ assetId: 'a1', assetType: IMM }, { supported: false, reason: 'No data' });
    await vi.waitFor(() => expect(unsupported.container.innerHTML).toBe(''));
  });
});

describe('helpers', () => {
  it('signs numbers and places values on the band track', () => {
    expect(signed(-4)).toBe('-4.0');
    expect(signed(152, 0)).toBe('+152');
    expect(signed(null)).toBe('—');
    const pos = bandScale({ normalMin: 0, normalMax: 100, current: 50, recommended: 60 });
    expect(pos(0)).toBeCloseTo(100 / 12);
    expect(pos(50)).toBeCloseTo(50);
    // a current value outside the band still lands on the track
    const out = bandScale({ normalMin: 10, normalMax: 20, current: 30, recommended: 18 });
    expect(out(30)).toBeLessThanOrEqual(100);
    expect(out(10)).toBeGreaterThanOrEqual(0);
  });
});
