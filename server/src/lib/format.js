/** 3725 → "01:02:05" (the HH:MM:SS duration format CMMS stores). */
export const secondsToHms = (seconds) => {
  const s = Math.max(0, Math.round(seconds));
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
};

/** "01:02:05" → 3725. Tolerates "MM:SS", hours above 99, and junk (→ 0). */
export const hmsToSeconds = (hms) => {
  if (typeof hms !== 'string') return 0;
  const parts = hms.split(':').map(Number);
  if (parts.some((n) => Number.isNaN(n))) return 0;
  return parts.reduce((total, n) => total * 60 + n, 0);
};

export const addSecondsToHms = (hms, seconds) => secondsToHms(hmsToSeconds(hms) + seconds);

export const escapeRegex = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const humanize = (key) =>
  String(key)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\bId\b/, 'ID')
    .replace(/^./, (c) => c.toUpperCase());
