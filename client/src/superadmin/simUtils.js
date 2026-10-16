/** Helpers for the Simulation tab. Everything above "Browser" is pure and unit-tested. */

const MINUTE = 60_000;
/** After it ends, an injection fades out over this long (server FADE_MS). */
export const FADE_MS = 2 * MINUTE;

/** 42 → "42 s", 300 → "5 min", 7200 → "2 h", 172800 → "2 days". */
export const span = (seconds) => {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} h`;
  const d = Math.floor(s / 86400);
  return `${d} ${d === 1 ? 'day' : 'days'}`;
};
const toMs = (value) => (value ? new Date(value).getTime() : Number.NaN);

/** "3 s ago", "4 min ago", "2 days ago"; null when there is no time. */
export const ago = (value, now = Date.now()) => {
  const t = toMs(value);
  return Number.isFinite(t) ? `${span((now - t) / 1000)} ago` : null;
};

/** Simulator stats.lastError "<ISO time> <message>" → { at, message }; at is null without a leading time. */
export const splitError = (text = '') => {
  const m = /^(\d{4}-\d\d-\d\dT\S+Z) (.*)$/s.exec(text);
  return m ? { at: m[1], message: m[2] } : { at: null, message: text };
};

/** "12 min left"; null once the time has passed. */
export const timeLeft = (value, now = Date.now()) => {
  const left = toMs(value) - now;
  return left > 0 ? `${span(left / 1000)} left` : null;
};

export const plural = (n, word) => `${n} ${n === 1 ? word : `${word}s`}`;

/** "bearing_wear" → "Bearing wear". */
export const humanize = (id = '') => {
  const text = String(id).replace(/[_-]+/g, ' ').trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
};

/** Mirrors the server's slugify (file names). */
export const slugify = (text) =>
  String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 30) || 'company';

const ROLES = { owner: 'Owner', admin: 'Admin', technician: 'Technician', view: 'Viewer' };
export const roleLabel = (role) => ROLES[role] ?? humanize(role ?? '');

/** Label of a scenario id from the simulator's catalogue. */
export const scenarioLabel = (id, catalogue = []) =>
  catalogue.find((s) => s.id === id)?.label ?? humanize(id);

/** A scenario applies when the asset type is in `appliesTo` (an empty list applies to all). */
export const applies = (scenario, asset) =>
  !asset || !scenario.appliesTo?.length || scenario.appliesTo.includes(asset.type);

/** [[type, assets sorted by name]] sorted by type, for the machine picker. */
export const byType = (assets = []) =>
  Object.entries(Object.groupBy(assets, (a) => a.type || 'Other'))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([type, list]) => [
      type,
      list.toSorted((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true })),
    ]);

/**
 * Where an active injection is by its own clock: ramp, then hold until `endsAt`, then a 2-minute fade; a
 * breakdown past its fade is `waiting`, as the machine stays Stopped until its repair work order is done.
 * `progress` is the share of ramp + hold that has passed (0–1).
 */
export const injectionState = (event, now = Date.now()) => {
  const start = toMs(event.startedAt);
  const end = toMs(event.endsAt);
  const rampEnd = start + (event.rampMin ?? 0) * MINUTE;
  const waiting = event.scenario === 'sudden_breakdown' && now >= end + FADE_MS;
  return {
    phase: waiting ? 'waiting' : now < rampEnd ? 'ramp' : now < end ? 'hold' : 'fade',
    progress: end > start ? Math.min(1, Math.max(0, (now - start) / (end - start))) : 1,
    elapsedSec: Math.max(0, (now - start) / 1000),
    fadeEndsAt: end + FADE_MS,
  };
};

const PHASES = {
  ramp: 'Ramping up',
  hold: 'At full strength',
  fade: 'Fading out',
  waiting: 'Stopped until repaired',
  done: 'Done',
};
export const phaseLabel = (phase) => PHASES[phase] ?? humanize(phase ?? '');

const OBJECT_ID = /^[a-f\d]{24}$/i;

/** "Fixed by WO-123" from what the repair recorded: the work order code, or an object naming it. */
const repairLabel = (by) => {
  const code = typeof by === 'string' ? by : (by?.code ?? by?.workOrderId);
  return code && !OBJECT_ID.test(String(code)) ? `Fixed by ${code}` : 'Fixed by a work order';
};

/** How an injection ended, in words: active, fixed by a repair, cleared by the superadmin, or ran its course. */
export const outcomeOf = (event) => {
  if (event.active) return { kind: 'active', label: 'Active' };
  if (event.clearedReason === 'repair') return { kind: 'repair', label: repairLabel(event.clearedBy) };
  if (event.clearedReason === 'superadmin') return { kind: 'superadmin', label: 'Cleared by superadmin' };
  return { kind: 'ended', label: 'Ended' };
};

/** App link of an activity's target: machines open Machine 360, any other record its record page. */
export const targetLink = (target) => {
  if (!target?.module || !target?.id) return null;
  const id = encodeURIComponent(target.id);
  return target.module === 'assets' ? `/machines/${id}` : `/m/${encodeURIComponent(target.module)}/${id}`;
};

/** A cell a spreadsheet would run as a formula (= + - @ tab CR) gets a leading quote, so it stays text. */
export const safeCell = (cell) => {
  const text = String(cell ?? '');
  return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
};

/** Rows of cells → CSV, or TSV with sep '\t'; formula-safe, and cells holding the separator, quotes or newlines are quoted. */
export const toDelimited = (rows, sep = ',') =>
  rows
    .map((row) =>
      row
        .map((cell) => {
          const text = safeCell(cell);
          return text.includes(sep) || /["\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
        })
        .join(sep),
    )
    .join('\n');

/** Sign-in sheet (header first) of the simulated company. */
export const credentialRows = (users, password) => [
  ['Email', 'Password', 'Name', 'Role', 'Title', 'Department', 'Shift'],
  ...users.map((u) => [u.email, password, u.name, roleLabel(u.role), u.title, u.department, u.shift]),
];

// ── Browser ─────────────────────────────────────────────────────────────────

/** Copies text; falls back to a hidden textarea where the Clipboard API is missing (http on a LAN IP). */
export const copyText = async (text) => {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const previous = document.activeElement;
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
    // Next to the focused button, so an open dialog's focus trap doesn't pull focus back mid-copy.
    (previous?.parentElement ?? document.body).append(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    previous?.focus?.();
    if (!ok) throw new Error('Copy is blocked in this browser');
  }
};

/** Saves text as a file. */
export const downloadText = (filename, text, type = 'text/csv;charset=utf-8') => {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
