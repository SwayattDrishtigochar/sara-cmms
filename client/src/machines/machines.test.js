import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setFormatPrefs } from '../lib/format.js';
import {
  dropStale,
  HISTORY_MS,
  reduceLive,
  STALE_MS,
  seedHistory,
  seedLatest,
  selectStatusCounts,
  useLiveStore,
} from '../live/liveStore.js';
import { niceAxis, toChartRows } from '../ui/charts.jsx';
import { ParameterTiles } from './ParameterTiles.jsx';
import { EnergyCard, energyUsed } from './SideCards.jsx';
import { bandState, fieldLabel, startOfDay } from './telemetry.js';

const T = Date.UTC(2026, 9, 16, 6, 0, 0);
const iso = (ms) => new Date(ms).toISOString();

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('live store', () => {
  it('applies hello, telemetry and status events with per-field times and keeps 15 minutes of history', () => {
    let state = { connection: 'connecting', assets: {}, clockOffset: 0 };
    let clock = T;
    const apply = (type, data) => {
      state = { ...state, ...reduceLive(state, type, data, clock) };
    };
    apply('hello', {
      serverTime: T,
      snapshot: [
        {
          assetId: 'a',
          status: 'Running',
          since: iso(T - 60e3),
          values: { temp: 40, oldField: 7 },
          times: { temp: T, oldField: T - 3 * 3600e3 },
          valuesAt: iso(T),
        },
      ],
    });
    expect(state.connection).toBe('live');
    expect(state.assets.a).toMatchObject({
      status: 'Running',
      since: T - 60e3,
      values: { temp: 40 },
      valuesAt: T,
    });
    expect(state.assets.a.values.oldField).toBeUndefined(); // 3 h old: stale on arrival

    clock = T + 5e3;
    apply('telemetry', {
      assetId: 'a',
      status: 'Running',
      values: { temp: 41, toolName: 'Mould A', pressure: 3 },
      times: { temp: T + 5e3, toolName: T + 5e3, pressure: T - 5 * 60e3 },
      t: T + 5e3,
    });
    expect(state.assets.a.values).toEqual({ temp: 41, toolName: 'Mould A' }); // pressure is 5 min old
    expect(state.assets.a.history.temp).toEqual([
      [T, 40],
      [T + 5e3, 41],
    ]);

    clock = T + 60e3;
    apply('telemetry', { assetId: 'a', values: { temp: 45 }, times: { temp: T + 60e3 } });
    apply('telemetry', { assetId: 'a', values: { temp: 1 }, times: { temp: T + 30e3 } }); // older than held
    expect(state.assets.a.values.temp).toBe(45);
    clock = T + HISTORY_MS + 10e3;
    apply('telemetry', { assetId: 'a', t: clock, status: 'Stopped', values: { temp: 50 } }); // no times: uses t
    expect(state.assets.a.history.temp).toEqual([
      [T + 60e3, 45],
      [T + HISTORY_MS + 10e3, 50],
    ]);
    expect(state.assets.a.history.toolName).toBeUndefined();
    expect(state.assets.a).toMatchObject({ status: 'Stopped', since: T + HISTORY_MS + 10e3 });

    apply('status', { assetId: 'a', status: 'Idle', since: iso(T + HISTORY_MS + 20e3) });
    expect(state.assets.a).toMatchObject({ status: 'Idle', since: T + HISTORY_MS + 20e3 });
    expect(reduceLive(state, 'downtime', { assetId: 'a' })).toBeNull();
    expect(reduceLive(state, 'record', { module: 'workorders' })).toBeNull();

    // A quiet field stops being a current value; its history and the newest reading time stay.
    const swept = dropStale(state, clock).assets.a;
    expect(swept.values).toEqual({ temp: 50 }); // toolName was last read 15 min ago
    expect(dropStale({ ...state, assets: { a: swept } }, clock + STALE_MS + 1).assets.a).toMatchObject({
      values: {},
      valuesAt: T + HISTORY_MS + 10e3,
      history: { temp: state.assets.a.history.temp },
    });
    expect(dropStale({ ...state, assets: { a: swept } }, clock)).toBeNull();
  });

  it("judges staleness by the server's clock", () => {
    const snapshot = [{ assetId: 'a', values: { temp: 40 }, times: { temp: T - 30e3 } }];
    // This browser runs 10 minutes fast: by its own clock the reading would look stale.
    const fast = reduceLive({ assets: {} }, 'hello', { serverTime: T, snapshot }, T + 10 * 60e3);
    expect(fast.clockOffset).toBe(-10 * 60e3);
    expect(fast.assets.a.values).toEqual({ temp: 40 });
  });

  it('seeds older history and missing values without overwriting live data', () => {
    const now = Date.now();
    useLiveStore.setState({
      clockOffset: 0,
      assets: {
        a: {
          status: 'Running',
          since: now,
          values: { temp: 41 },
          times: { temp: now },
          valuesAt: now,
          history: { temp: [[now, 41]] },
        },
      },
    });
    seedHistory('a', [
      {
        field: 'temp',
        points: [
          [now - 120e3, 39],
          [now - 60e3, 40],
          [now, 99],
        ],
      },
    ]);
    seedLatest(
      [
        {
          assetId: 'a',
          status: 'OFF',
          values: {
            temp: { value: 7, time: iso(now - 5e3) },
            pressure: { value: 3, time: iso(now - 1e3) },
            quiet: { value: 1, time: iso(now - 10 * 60e3) },
          },
        },
      ],
      now,
    );
    const a = useLiveStore.getState().assets.a;
    expect(a.history.temp).toEqual([
      [now - 120e3, 39],
      [now - 60e3, 40],
      [now, 41],
    ]);
    expect(a.values).toEqual({ temp: 41, pressure: 3 });
    expect(a.status).toBe('Running');
  });

  it('counts statuses from live state, falling back to the stored status', () => {
    const state = { assets: { a: { status: 'ON' }, b: { status: 'Stopped' } } };
    const counts = selectStatusCounts([
      { _id: 'a', assetStatus: 'OFF' },
      { _id: 'b' },
      { _id: 'c', assetStatus: 'Idle' },
    ])(state);
    expect(counts).toEqual({ Running: 1, Idle: 1, Stopped: 1, OFF: 0, Maintenance: 0 });
  });
});

describe('telemetry helpers', () => {
  it('humanises field names', () => {
    expect(fieldLabel('oilTempPv')).toBe('Oil temperature');
    expect(fieldLabel('zoneTemp1')).toBe('Zone temp 1');
    expect(fieldLabel('press_speed')).toBe('Press speed');
    expect(fieldLabel('POWER PH-1')).toBe('Power PH-1');
    expect(fieldLabel('dischargePressure')).toBe('Discharge pressure');
  });

  it('finds local midnight in the company time zone', () => {
    // 16 Oct 2026 03:00 IST is 15 Oct 21:30 UTC; IST midnight is 15 Oct 18:30 UTC.
    expect(startOfDay('Asia/Kolkata', Date.UTC(2026, 9, 15, 21, 30))).toBe(Date.UTC(2026, 9, 15, 18, 30));
    expect(startOfDay('UTC', Date.UTC(2026, 9, 16, 12))).toBe(Date.UTC(2026, 9, 16));
  });

  it('classifies values against a normal band', () => {
    expect(bandState(60, { min: 35, max: 55 })).toBe('high');
    expect(bandState(3, { min: null, max: 4.5 })).toBe('ok');
    expect(bandState(2, { min: 5, max: null })).toBe('low');
    expect(bandState(undefined, { min: 1, max: 2 })).toBeNull();
  });

  it('rounds chart axes to clean ticks', () => {
    expect(niceAxis(32, 58)).toMatchObject({ domain: [30, 60], ticks: [30, 40, 50, 60] });
    expect(niceAxis(825, 1475).ticks).toEqual([800, 1000, 1200, 1400, 1600]);
    const pf = niceAxis(0.87, 0.97);
    expect(pf.ticks).toEqual([0.85, 0.9, 0.95, 1]);
    expect(pf.ticks.map(pf.format)).toEqual(['0.85', '0.90', '0.95', '1.00']);
    expect(niceAxis(118000, 131000).ticks.map(niceAxis(118000, 131000).format)).toEqual([
      '115K',
      '120K',
      '125K',
      '130K',
      '135K',
    ]);
  });

  it('breaks chart lines at real gaps but holds a value across a missed sample', () => {
    const rows = toChartRows(
      [
        {
          key: 'a',
          points: [
            [0, 1],
            [30e3, 2],
            [60e3, 3],
            [600e3, 4],
          ],
        },
        {
          key: 'b',
          points: [
            [0, 5],
            [60e3, 6],
          ],
        },
      ],
      30e3,
    );
    expect(rows.map((r) => r.t)).toEqual([0, 30e3, 60e3, 90e3, 600e3]);
    expect(rows[1]).toEqual({ t: 30e3, a: 2, b: 5 });
    expect(rows[3]).toEqual({ t: 90e3 });
    expect(rows[4]).toEqual({ t: 600e3, a: 4, b: null });
  });
});

describe('energy used today', () => {
  it('sums the interval consumption windows', () => {
    const series = [
      {
        field: 'ENERGY CONSUMPTION',
        points: [
          [1, 0.5],
          [2, 1.25],
          [3, 2],
        ],
      },
    ];
    expect(energyUsed(series)).toBe(3.75);
    expect(energyUsed([{ field: 'ENERGY CONSUMPTION', points: [] }])).toBeNull();
    expect(energyUsed(undefined)).toBeNull();
  });

  it('asks for summed ENERGY CONSUMPTION since midnight in the company time zone', async () => {
    setFormatPrefs({ timeZone: 'Asia/Kolkata' });
    const points = [
      [1, 12.5],
      [2, 30],
    ];
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ series: [{ field: 'ENERGY CONSUMPTION', points }] }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    render(
      createElement(
        QueryClientProvider,
        { client: new QueryClient() },
        createElement(EnergyCard, { assetId: 'a1' }),
      ),
    );
    expect(await screen.findByText('42.5 kWh')).toBeTruthy();
    const url = new URL(fetchMock.mock.calls[0][0], 'http://localhost');
    expect(url.pathname).toBe('/api/telemetry/series');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      assetId: 'a1',
      fields: 'ENERGY CONSUMPTION',
      fn: 'sum',
      start: new Date(startOfDay('Asia/Kolkata')).toISOString(),
    });
  });
});

describe('parameter tiles', () => {
  const fields = [{ measurement: 'machine', field: 'spindleLoad', unit: '%', normalMin: 30, normalMax: 80 }];
  const tiles = (status) => {
    useLiveStore.setState({
      assets: { m1: { status, values: { spindleLoad: 2 }, history: {}, valuesAt: Date.now() } },
    });
    return render(createElement(ParameterTiles, { assetId: 'm1', fields }));
  };

  it('judges the running band only while the machine runs', () => {
    tiles('Idle');
    expect(screen.queryByText('Below normal')).toBeNull();
    expect(screen.getByText(/Normal when running/)).toBeTruthy();
    cleanup();
    tiles('Running');
    expect(screen.getByText('Below normal')).toBeTruthy();
  });
});
