import { clsx } from 'clsx';

export const cn = (...args) => clsx(...args);

let prefs = {
  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  dateFormat: 'DD-MM-YYYY',
  timeFormat: '12-hours',
  currency: { name: 'INR', symbol: '₹' },
};

/** Called once the user's company context is known. */
export const setFormatPrefs = (company) => {
  if (!company) return;
  prefs = {
    timeZone: company.timeZone ?? prefs.timeZone,
    dateFormat: company.dateFormat ?? prefs.dateFormat,
    timeFormat: company.timeFormat ?? prefs.timeFormat,
    currency: company.currency ?? prefs.currency,
  };
};
export const getFormatPrefs = () => prefs;

const partsOf = (date, options) => {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: prefs.timeZone, ...options }).formatToParts(
    date,
  );
  return Object.fromEntries(parts.map((p) => [p.type, p.value]));
};

const toDate = (value) => {
  if (value == null || value === '') return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** Date in the company's format and time zone, e.g. 15-10-2026. */
export const formatDate = (value) => {
  const d = toDate(value);
  if (!d) return '—';
  const p = partsOf(d, { year: 'numeric', month: '2-digit', day: '2-digit' });
  return prefs.dateFormat.replace('DD', p.day).replace('MM', p.month).replace('YYYY', p.year);
};

export const formatTime = (value) => {
  const d = toDate(value);
  if (!d) return '—';
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: prefs.timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: prefs.timeFormat !== '24-hours',
  }).format(d);
};

export const formatDateTime = (value) => {
  const d = toDate(value);
  return d ? `${formatDate(d)} ${formatTime(d)}` : '—';
};

const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
/** "3 h ago", "in 2 days"; falls back to the date beyond a week. */
export const formatRelative = (value) => {
  const d = toDate(value);
  if (!d) return '—';
  const diff = (d.getTime() - Date.now()) / 1000;
  const abs = Math.abs(diff);
  if (abs < 45) return 'just now';
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
  if (abs < 7 * 86400) return rtf.format(Math.round(diff / 86400), 'day');
  return formatDate(d);
};

export const formatNumber = (value, { digits = 2, unit } = {}) => {
  if (value == null || value === '' || Number.isNaN(Number(value))) return '—';
  const n = Number(value);
  const text = new Intl.NumberFormat('en-IN', {
    maximumFractionDigits: Math.abs(n) >= 100 ? 0 : digits,
  }).format(n);
  if (!unit) return text;
  if (unit.startsWith('₹') || unit === 'INR') return `${prefs.currency.symbol}${text}${unit.slice(1)}`;
  return `${text} ${unit}`;
};

export const formatMoney = (value) =>
  value == null
    ? '—'
    : `${prefs.currency.symbol}${new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(value)}`;

/** 3725 → "1 h 2 m"; also accepts "HH:MM:SS". */
export const formatDuration = (value) => {
  let seconds = value;
  if (typeof value === 'string' && value.includes(':')) {
    seconds = value
      .split(':')
      .map(Number)
      .reduce((t, n) => t * 60 + n, 0);
  }
  if (seconds == null || Number.isNaN(Number(seconds))) return '—';
  const s = Math.round(Number(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h >= 24) return `${Math.floor(h / 24)} d ${h % 24} h`;
  if (h) return `${h} h ${m} m`;
  if (m) return `${m} m`;
  return `${s} s`;
};

export const initials = (name = '') =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join('');

/** Human label for any populated ref or raw value. */
export const refLabel = (value) => {
  if (value == null) return '—';
  if (typeof value !== 'object') return String(value);
  if (value.firstName || value.lastName) return [value.firstName, value.lastName].filter(Boolean).join(' ');
  const code =
    value.workOrderId ??
    value.jobCardId ??
    value.requestId ??
    value.reqId ??
    value.preventiveMaintenanceId ??
    value.calibrationId ??
    value.anomalyCode ??
    value.assetTag ??
    value.toolNumber ??
    value.partNumber ??
    value.binRfId ??
    value.plantCode;
  const title = value.name ?? value.jobName ?? value.partName ?? value.summary ?? value.message?.title;
  if (code && title) return `${code} · ${title}`;
  return title ?? code ?? String(value._id ?? '');
};
