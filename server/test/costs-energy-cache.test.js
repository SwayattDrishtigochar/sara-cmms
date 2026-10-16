import { describe, expect, it, vi } from 'vitest';
import { cacheSeries } from '../src/costs/energyCache.js';

const RANGE = { start: '2026-10-01T00:00:00Z', stop: '2026-10-16T12:00:00Z', every: '15m', fn: 'sum' };
const FIELDS = ['ENERGY CONSUMPTION'];

const setup = () => {
  let t = 1_000_000;
  const clock = () => t;
  const fetch = vi.fn(async (companyId, ids) => ({ series: ids.map((id) => ({ assetId: id, companyId })) }));
  return { fetch, get: cacheSeries(fetch, { ttlMs: 60_000, clock }), tick: (ms) => (t += ms) };
};

describe('energy series cache', () => {
  it('answers a repeat within the TTL from the cache, in any asset order', async () => {
    const { fetch, get } = setup();
    const first = await get('A', ['a1', 'a2'], FIELDS, RANGE);
    expect(await get('A', ['a2', 'a1'], FIELDS, { ...RANGE, start: new Date(RANGE.start) })).toBe(first);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('queries again once the TTL has passed', async () => {
    const { fetch, get, tick } = setup();
    await get('A', ['a1'], FIELDS, RANGE);
    tick(59_999);
    await get('A', ['a1'], FIELDS, RANGE);
    tick(1);
    await get('A', ['a1'], FIELDS, RANGE);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('shares one in-flight query between concurrent identical calls', async () => {
    const { fetch, get } = setup();
    const results = await Promise.all([1, 2, 3, 4].map(() => get('A', ['a1'], FIELDS, RANGE)));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(new Set(results).size).toBe(1);
  });

  it('never hands one company, plant scope or range the series of another', async () => {
    const { fetch, get } = setup();
    const [a, b, pune, other] = await Promise.all([
      get('A', ['a1', 'a2'], FIELDS, RANGE),
      get('B', ['a1', 'a2'], FIELDS, RANGE),
      get('A', ['a1'], FIELDS, RANGE),
      get('A', ['a1', 'a2'], FIELDS, { ...RANGE, stop: '2026-10-16T12:15:00Z' }),
    ]);
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(b.series.every((s) => s.companyId === 'B')).toBe(true);
    expect(a.series.every((s) => s.companyId === 'A')).toBe(true);
    expect(pune.series.map((s) => s.assetId)).toEqual(['a1']);
    expect(other).not.toBe(a);
  });

  it('does not keep a failed query', async () => {
    const { fetch, get } = setup();
    fetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(get('A', ['a1'], FIELDS, RANGE)).rejects.toThrow('ECONNREFUSED');
    await expect(get('A', ['a1'], FIELDS, RANGE)).resolves.toMatchObject({ series: [{ assetId: 'a1' }] });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
