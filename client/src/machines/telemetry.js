import { formatNumber } from '../lib/format.js';

/** Headline parameters per asset type (mirrors the server's KEY_FIELDS). */
export const KEY_FIELDS = {
  'Injection Moulding Machine': ['oilTempPv', 'injectionPressure', 'cycleTime'],
  'Power Press': ['press_speed', 'load_monitor', 'vibration'],
  'CNC Machine': ['spindleLoad', 'spindleTemp', 'vibration'],
  Compressor: ['dischargePressure', 'dischargeTemp', 'loadPercent'],
  Chiller: ['supplyWaterTemp', 'returnWaterTemp', 'compressorCurrent'],
  Furnace: ['zoneTemp1', 'zoneTemp2', 'doorTemp'],
  'Energy Meter': ['POWER TOTAL', 'POWER FACTOR TOTAL', 'VOLTAGE AVERAGE'],
};
const ENERGY_KEYS = ['POWER TOTAL', 'CURRENT AVERAGE', 'POWER FACTOR TOTAL'];

// ponytail: card units are a built-in map; Machine 360 uses the real units from /telemetry/fields.
const CARD_UNITS = {
  oilTempPv: '°C',
  injectionPressure: 'bar',
  cycleTime: 's',
  press_speed: 'spm',
  load_monitor: 'ton',
  vibration: 'mm/s',
  spindleLoad: '%',
  spindleTemp: '°C',
  dischargePressure: 'bar',
  dischargeTemp: '°C',
  loadPercent: '%',
  supplyWaterTemp: '°C',
  returnWaterTemp: '°C',
  compressorCurrent: 'A',
  zoneTemp1: '°C',
  zoneTemp2: '°C',
  doorTemp: '°C',
  'POWER TOTAL': 'kW',
  'CURRENT AVERAGE': 'A',
  'VOLTAGE AVERAGE': 'V',
};

/** The 2–3 fields a machine card shows, with units. */
export const cardFields = (asset) =>
  (KEY_FIELDS[asset.typeOfAsset] ?? (asset.isEnergyAsset ? ENERGY_KEYS : [])).map((field) => ({
    field,
    unit: CARD_UNITS[field] ?? '',
  }));

const LABELS = {
  oilTempPv: 'Oil temperature',
  load_monitor: 'Press load',
  'POWER TOTAL': 'Power',
  'POWER FACTOR TOTAL': 'Power factor',
  'VOLTAGE AVERAGE': 'Voltage',
  'CURRENT AVERAGE': 'Current',
  'ENERGY CONSUMPTION': 'Energy used',
  'ENERGY READING': 'Energy meter',
};
const KEEP_UPPER = new Set(['PV', 'SV', 'PH', 'RPM', 'CO2', 'PF']);

/** "oilTempPv" → "Oil temperature", "zoneTemp1" → "Zone temp 1", "POWER PH-1" → "Power PH-1". */
export const fieldLabel = (field) => {
  if (LABELS[field]) return LABELS[field];
  const words = String(field)
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([a-zA-Z])(\d)/g, '$1 $2')
    .split(/\s+/)
    .filter(Boolean);
  return words
    .map((w, i) => {
      if (/\d/.test(w) || KEEP_UPPER.has(w.toUpperCase())) return w.toUpperCase();
      const lower = w.toLowerCase();
      return i === 0 ? lower[0].toUpperCase() + lower.slice(1) : lower;
    })
    .join(' ');
};

/** Live number formatting: 3 significant-ish digits (1,240 · 47.9 · 0.92). */
export const formatValue = (value) =>
  typeof value === 'number' ? formatNumber(value, { digits: Math.abs(value) >= 10 ? 1 : 2 }) : (value ?? '—');

export const isNumericField = (spec) => !spec.valueType || spec.valueType === 'number';

/** Section a field belongs to on Machine 360. */
export const fieldGroup = (measurement) =>
  measurement === 'energy' ? 'Energy' : measurement === 'shotCountDetails' ? 'Production' : 'Machine';
export const GROUP_ORDER = ['Machine', 'Energy', 'Production'];

/** Normal band of a field spec, or null when it has none. */
export const bandOf = (spec) => {
  const min = typeof spec?.normalMin === 'number' ? spec.normalMin : null;
  const max = typeof spec?.normalMax === 'number' ? spec.normalMax : null;
  return min == null && max == null ? null : { min, max };
};

/** Spec bands describe a running machine (as on the server), so they judge readings only while Running. */
export const bandApplies = (status) => !status || status === 'Running' || status === 'ON';

/** 'low' | 'high' | 'ok', or null when the value or the band is unknown. */
export const bandState = (value, band) => {
  if (typeof value !== 'number' || !band) return null;
  if (band.min != null && value < band.min) return 'low';
  if (band.max != null && value > band.max) return 'high';
  return 'ok';
};

/** "35–55 °C", "≤ 4.5 mm/s", "≥ 6 bar". */
export const bandText = (band, unit) => {
  const u = unit ? ` ${unit}` : '';
  if (band.min != null && band.max != null) return `${formatValue(band.min)}–${formatValue(band.max)}${u}`;
  return band.max != null ? `≤ ${formatValue(band.max)}${u}` : `≥ ${formatValue(band.min)}${u}`;
};

const offsetMs = (timeZone, at) => {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    })
      .formatToParts(at)
      .map(({ type, value }) => [type, Number(value)]),
  );
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(at / 1000) * 1000;
};

/** Midnight of `now`'s calendar day in `timeZone`, as epoch ms. */
export const startOfDay = (timeZone, now = Date.now()) => {
  const local = new Date(now + offsetMs(timeZone, now));
  const midnight = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  return midnight - offsetMs(timeZone, midnight - offsetMs(timeZone, midnight));
};
