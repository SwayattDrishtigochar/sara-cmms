// Pure Gantt geometry and time-zone maths (no React, no DOM): the Planner, the plan block and the
// Command Center mini Gantt all draw from these numbers.

export const HOUR = 36e5;
export const DAY = 864e5;

const toMs = (v) => (typeof v === 'number' ? v : v instanceof Date ? v.getTime() : Date.parse(v));

// ── Time zones ───────────────────────────────────────────────────────────────

const zoneFormats = new Map();
const zoneFormat = (timeZone) => {
  if (!zoneFormats.has(timeZone)) {
    zoneFormats.set(
      timeZone,
      new Intl.DateTimeFormat('en-US', {
        timeZone,
        hourCycle: 'h23',
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
        second: 'numeric',
      }),
    );
  }
  return zoneFormats.get(timeZone);
};

/** Offset of `timeZone` from UTC at instant `t`, in ms (Asia/Kolkata → 19 800 000). */
export const zoneOffset = (t, timeZone = 'UTC') => {
  const ms = toMs(t);
  const p = Object.fromEntries(
    zoneFormat(timeZone)
      .formatToParts(ms)
      .map((x) => [x.type, Number(x.value)]),
  );
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
};

/** Instant of a wall-clock time (`local` = that wall time written as UTC ms) in `timeZone`. */
const fromLocal = (local, timeZone) => local - zoneOffset(local - zoneOffset(local, timeZone), timeZone);

/** Local midnight (ms) of the day `t` falls on in `timeZone`. */
export const startOfDay = (t, timeZone) => {
  const local = toMs(t) + zoneOffset(t, timeZone);
  return fromLocal(Math.floor(local / DAY) * DAY, timeZone);
};

/** 23:59:59 local (ms) of a `YYYY-MM-DD` date from `<input type="date">`. */
export const endOfDay = (date, timeZone) => fromLocal(Date.parse(`${date}T23:59:59Z`), timeZone);

/** `YYYY-MM-DD` of instant `t` in `timeZone` (for `<input type="date" min>`). */
export const localDate = (t, timeZone) =>
  new Date(toMs(t) + zoneOffset(t, timeZone)).toISOString().slice(0, 10);

/** `YYYY-MM-DDTHH:mm` of instant `t` in `timeZone` (for `<input type="datetime-local">`); '' without a value. */
export const localDateTime = (t, timeZone) =>
  t == null || t === '' ? '' : new Date(toMs(t) + zoneOffset(t, timeZone)).toISOString().slice(0, 16);

/** Instant (ms) of a `YYYY-MM-DDTHH:mm` wall time in `timeZone`; null when the text is not a date. */
export const fromLocalDateTime = (text, timeZone) => {
  const local = Date.parse(`${text}:00Z`);
  return Number.isNaN(local) ? null : fromLocal(local, timeZone);
};

// ── Scale & ticks ────────────────────────────────────────────────────────────

/** Linear time ↔ pixel mapping of `range` onto `width` px. */
export const timeScale = (range, width) => {
  const s = toMs(range.start);
  const span = Math.max(1, toMs(range.end) - s);
  return { x: (t) => ((toMs(t) - s) / span) * width, t: (px) => s + (px / width) * span };
};

const dayLabel = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric' });
const pad = (n) => String(n).padStart(2, '0');

/** Axis ticks in the company zone: hours (step fitted to the width) up to 2 days, else days. */
export const ticks = (range, timeZone, width) => {
  const s = toMs(range.start);
  const e = toMs(range.end);
  if (!(e > s) || !(width > 0)) return [];
  const { x } = timeScale(range, width);
  const hourMode = e - s <= 2 * DAY;
  const unit = hourMode ? HOUR : DAY;
  const pxPerUnit = width / ((e - s) / unit);
  const step = hourMode
    ? ([1, 2, 3, 6, 12].find((h) => h * pxPerUnit >= 56) ?? 24)
    : pxPerUnit >= 40
      ? 1
      : pxPerUnit >= 20
        ? 2
        : 7;
  const out = [];
  for (let local = Math.ceil((s + zoneOffset(s, timeZone)) / unit) * unit; ; local += unit) {
    const t = fromLocal(local, timeZone);
    if (t > e) break;
    const index = hourMode ? new Date(local).getUTCHours() : Math.round(local / DAY);
    if (index % step) continue;
    const midnight = !hourMode || index === 0;
    out.push({ x: x(t), t, label: midnight ? dayLabel.format(local) : `${pad(index)}:00`, major: midnight });
  }
  return out;
};

const HHMM = /^(\d{1,2}):(\d{2})$/;
const minutesOf = (text) => {
  const m = HHMM.exec(text);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

/**
 * Shift bands over `range` as instants: shifts given as instants are clipped to the range; shifts given
 * as `HH:MM` (start/end) repeat on every local day, an end before the start runs past midnight.
 */
export const shiftBands = (shifts = [], range, timeZone) => {
  const s = toMs(range.start);
  const e = toMs(range.end);
  const out = [];
  const push = (name, a, b) => {
    if (b > s && a < e) out.push({ name, start: Math.max(s, a), end: Math.min(e, b) });
  };
  for (const shift of shifts) {
    const from = minutesOf(shift.start);
    const to = minutesOf(shift.end);
    if (from == null || to == null) {
      push(shift.name, toMs(shift.start), toMs(shift.end));
      continue;
    }
    for (let day = startOfDay(s, timeZone) - DAY; day < e; day = startOfDay(day + DAY + 2 * HOUR, timeZone)) {
      const local = day + zoneOffset(day, timeZone);
      const a = fromLocal(local + from * 6e4, timeZone);
      const b = fromLocal(local + (to > from ? to : to + 1440) * 6e4, timeZone);
      push(shift.name, a, b);
    }
  }
  return out.sort((a, b) => a.start - b.start);
};

// ── Rows, lanes, bars ────────────────────────────────────────────────────────

/** Machine type of a row: `row.group`, else its label without the trailing number ("IMM 5" → "IMM"). */
export const groupOf = (row) => row.group ?? (String(row.label ?? '').replace(/[\s-]*\d+$/, '') || 'Other');

const subtract = (a, b, cuts) => {
  let parts = [[a, b]];
  for (const [ca, cb] of cuts) {
    parts = parts.flatMap(([pa, pb]) =>
      cb <= pa || ca >= pb
        ? [[pa, pb]]
        : [
            [pa, ca],
            [cb, pb],
          ].filter(([x, y]) => y > x),
    );
  }
  return parts;
};

/**
 * Positions every row and bar. Bars are clipped to `range` (w ≥ 2 px); overlapping bars of a row stack
 * in lanes (the row grows); maintenance bars span the whole row and split the job cards they cross into
 * `segments`; a ghost bar with `from` gets an `outline` at its old place. Rows are grouped by machine
 * type, with a `groupHeight` px header per group (0: no headers). Markers before the range pin to its start.
 */
export const layoutGantt = ({
  rows = [],
  bars = [],
  markers = [],
  range,
  width,
  rowHeight = 36,
  barHeight = 22,
  groupHeight = 0,
  now,
}) => {
  const { x } = timeScale(range, width);
  const s = toMs(range.start);
  const e = toMs(range.end);
  const px = (a, b) => ({ x: x(a), w: Math.max(2, x(b) - x(a)) });
  const laneStep = barHeight + 4;

  const order = [];
  for (const row of rows) {
    const g = groupOf(row);
    const group = order.find((o) => o.label === g);
    if (group) group.rows.push(row);
    else order.push({ label: g, rows: [row] });
  }

  const items = new Map(rows.map((r) => [r.id, []]));
  for (const bar of bars) {
    const a = Math.max(s, toMs(bar.start));
    const b = Math.min(e, toMs(bar.end));
    if (b > a && items.has(bar.rowId)) items.get(bar.rowId).push({ bar, a, b });
  }

  const outRows = [];
  const outBars = [];
  const groups = [];
  let y = 0;
  for (const group of order) {
    if (groupHeight) {
      groups.push({ label: group.label, y, h: groupHeight });
      y += groupHeight;
    }
    for (const row of group.rows) {
      const list = items.get(row.id).sort((p, q) => p.a - q.a || p.b - q.b);
      const maint = list.filter((i) => i.bar.kind === 'maintenance');
      const laneEnds = [];
      for (const item of list) {
        if (item.bar.kind === 'maintenance') continue;
        let lane = laneEnds.findIndex((end) => end <= item.a);
        if (lane === -1) lane = laneEnds.push(item.b) - 1;
        else laneEnds[lane] = item.b;
        item.lane = lane;
      }
      const h = rowHeight + Math.max(0, laneEnds.length - 1) * laneStep;
      outRows.push({ id: row.id, y, h });
      for (const { bar, a, b, lane = 0 } of list) {
        const isMaint = bar.kind === 'maintenance';
        const cuts =
          (bar.kind ?? 'jobcard') === 'jobcard'
            ? maint.filter((m) => m.a < b && m.b > a).map((m) => [m.a, m.b])
            : [];
        const pieces = cuts.length ? subtract(a, b, cuts) : [[a, b]];
        let outline = null;
        if (bar.ghost && bar.from) {
          const fa = Math.max(s, toMs(bar.from.start));
          const fb = Math.min(e, toMs(bar.from.end));
          if (fb > fa) outline = px(fa, fb);
        }
        outBars.push({
          ...bar,
          ...px(a, b),
          y: isMaint ? y + 3 : y + (rowHeight - barHeight) / 2 + lane * laneStep,
          h: isMaint ? h - 6 : barHeight,
          lane: isMaint ? 0 : lane,
          segments: (pieces.length ? pieces : [[a, b]]).map(([pa, pb]) => px(pa, pb)),
          outline,
          clipStart: toMs(bar.start) < s,
          clipEnd: toMs(bar.end) > e,
        });
      }
      y += h;
    }
  }

  const rowY = new Map(outRows.map((r) => [r.id, r.y]));
  const outMarkers = markers
    .filter((m) => rowY.has(m.rowId) && toMs(m.at) <= e)
    .map((m) => ({ ...m, x: x(Math.max(s, toMs(m.at))), y: rowY.get(m.rowId) }));
  const n = now == null ? null : toMs(now);
  return {
    height: y,
    rows: outRows,
    groups,
    bars: outBars,
    markers: outMarkers,
    nowX: n != null && n >= s && n <= e ? x(n) : null,
  };
};

// ── Proposal overlay ─────────────────────────────────────────────────────────

/**
 * The live calendar with a proposal's ghost bars on top: a moved/extended ghost replaces the current bar
 * of the same job card (by id or code), rows and markers the calendar lacks are added, delays come along.
 */
export const mergePlan = (base, plan) => {
  if (!plan) return base;
  if (!base) return plan;
  const ghosts = (plan.bars ?? []).filter((b) => b.ghost);
  const replaced = new Set(
    ghosts.filter((g) => g.change === 'moved' || g.change === 'extended').flatMap((g) => [g.id, g.code]),
  );
  replaced.delete(undefined);
  const rowIds = new Set(base.rows.map((r) => r.id));
  const markerIds = new Set((base.markers ?? []).map((m) => m.id));
  return {
    ...base,
    rows: [...base.rows, ...(plan.rows ?? []).filter((r) => !rowIds.has(r.id))],
    bars: [...base.bars.filter((b) => !replaced.has(b.id) && !replaced.has(b.code)), ...ghosts],
    markers: [...(base.markers ?? []), ...(plan.markers ?? []).filter((m) => !markerIds.has(m.id))],
    delays: plan.delays ?? [],
  };
};

/** Latest end among a plan's ghost bars (ms), or null. */
export const ghostEnd = (plan) => {
  const ends = (plan?.bars ?? []).filter((b) => b.ghost).map((b) => toMs(b.end));
  return ends.length ? Math.max(...ends) : null;
};
