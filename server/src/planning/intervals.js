/**
 * Interval maths for the planners (pure). An interval is `{ start: Date, end: Date }`; inputs may be
 * unsorted or overlapping, outputs are sorted, merged and non-empty.
 */

const ms = (d) => new Date(d).getTime();
const toPairs = (list = []) =>
  list
    .map((i) => [ms(i.start), ms(i.end)])
    .filter(([s, e]) => e > s)
    .sort((a, b) => a[0] - b[0]);
const fromPairs = (pairs) => pairs.map(([s, e]) => ({ start: new Date(s), end: new Date(e) }));
const mergePairs = (pairs) => {
  const out = [];
  for (const [s, e] of pairs) {
    const last = out.at(-1);
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
};
const norm = (list) => mergePairs(toPairs(list));

/** Sorted union of the intervals (touching ones join). */
export const mergeIntervals = (list) => fromPairs(norm(list));

/** `base` minus every interval of `cuts`. */
export const subtractIntervals = (base, cuts) => {
  const c = norm(cuts);
  const out = [];
  for (const [s0, e] of norm(base)) {
    let s = s0;
    for (const [cs, ce] of c) {
      if (ce <= s) continue;
      if (cs >= e) break;
      if (cs > s) out.push([s, cs]);
      s = Math.max(s, ce);
      if (s >= e) break;
    }
    if (s < e) out.push([s, e]);
  }
  return fromPairs(out);
};

/** Time covered by both lists. */
export const intersectIntervals = (a, b) => {
  const x = norm(a);
  const y = norm(b);
  const out = [];
  let i = 0;
  let j = 0;
  while (i < x.length && j < y.length) {
    const s = Math.max(x[i][0], y[j][0]);
    const e = Math.min(x[i][1], y[j][1]);
    if (e > s) out.push([s, e]);
    if (x[i][1] < y[j][1]) i++;
    else j++;
  }
  return fromPairs(out);
};

/** Total length of the (merged) intervals in seconds. */
export const totalSeconds = (list) => norm(list).reduce((sum, [s, e]) => sum + (e - s) / 1000, 0);

/** Walks `free` from `from` and consumes `seconds` of it; null when the list runs out. */
export const advanceWorking = (free, from, seconds) => {
  const f = ms(from);
  if (seconds <= 0) return { end: new Date(f), segments: [] };
  let left = seconds * 1000;
  const segments = [];
  for (const [s, e] of norm(free)) {
    if (e <= f) continue;
    const st = Math.max(s, f);
    const take = Math.min(e - st, left);
    segments.push([st, st + take]);
    left -= take;
    if (left <= 0) return { end: new Date(st + take), segments: fromPairs(segments) };
  }
  return null;
};
