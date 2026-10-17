/**
 * Static telemetry vocabulary shared by queries, the live poller, the UI and the agent.
 * Per-type machine fields and their normal bands come from the telemetry source (it upserts
 * parameterspecs at start); energy fields are fixed (CMMS energy meters).
 */

export const MEASUREMENTS = [
  'energy',
  'machineParams',
  'sensorData',
  'shotCountDetails',
  'timelineData',
  'qualityEvents',
];

export const STATUSES = ['Running', 'Idle', 'Stopped', 'OFF', 'ON', 'Maintenance'];
/** Running time for availability. */
export const RUNNING_STATES = new Set(['Running', 'ON']);
/** Downtime when it happens inside a shift (Idle is not downtime). */
export const DOWN_STATES = new Set(['Stopped', 'OFF']);

export const ENERGY_FIELDS = [
  { field: 'POWER TOTAL', unit: 'kW' },
  { field: 'POWER PH-1', unit: 'kW' },
  { field: 'POWER PH-2', unit: 'kW' },
  { field: 'POWER PH-3', unit: 'kW' },
  { field: 'ENERGY CONSUMPTION', unit: 'kWh', aggregate: 'sum' },
  { field: 'ENERGY READING', unit: 'kWh', aggregate: 'last', cumulative: true },
  { field: 'CURRENT AVERAGE', unit: 'A' },
  { field: 'CURRENT PH-1', unit: 'A' },
  { field: 'CURRENT PH-2', unit: 'A' },
  { field: 'CURRENT PH-3', unit: 'A' },
  { field: 'VOLTAGE AVERAGE', unit: 'V' },
  { field: 'VOLTAGE PH-1', unit: 'V' },
  { field: 'VOLTAGE PH-2', unit: 'V' },
  { field: 'VOLTAGE PH-3', unit: 'V' },
  { field: 'POWER FACTOR TOTAL', unit: '' },
  { field: 'POWER FACTOR PH-1', unit: '' },
  { field: 'POWER FACTOR PH-2', unit: '' },
  { field: 'POWER FACTOR PH-3', unit: '' },
  { field: 'FREQUENCY', unit: 'Hz' },
  { field: 'CURRENT TEMP', unit: '°C', furnaceOnly: true },
  { field: 'SET TEMP', unit: '°C', furnaceOnly: true },
  { field: 'HEATER FIRING', unit: '%', furnaceOnly: true },
];

export const SHOT_FIELDS = [
  { field: 'shotsProduced', unit: 'shots', aggregate: 'sum' },
  { field: 'shotCount', unit: 'shots', aggregate: 'last', cumulative: true },
  { field: 'cycleTime', unit: 's' },
  { field: 'totalCycleTime', unit: 's', aggregate: 'sum' },
  { field: 'runningTime', unit: 's', aggregate: 'sum' },
  { field: 'idleTime', unit: 's', aggregate: 'sum' },
  { field: 'stoppedTime', unit: 's', aggregate: 'sum' },
];

/** Headline parameters per asset type (machine cards, default chart series). Field names match the devices' telemetry. */
export const KEY_FIELDS = {
  'Injection Moulding Machine': ['oilTempPv', 'injectionPressure', 'cycleTime'],
  'Power Press': ['press_speed', 'load_monitor', 'vibration'],
  'CNC Machine': ['spindleLoad', 'spindleTemp', 'vibration'],
  Compressor: ['dischargePressure', 'dischargeTemp', 'loadPercent'],
  Chiller: ['supplyWaterTemp', 'returnWaterTemp', 'compressorCurrent'],
  Furnace: ['zoneTemp1', 'zoneTemp2', 'doorTemp'],
  'Energy Meter': ['POWER TOTAL', 'POWER FACTOR TOTAL', 'VOLTAGE AVERAGE'],
};

/** Field name rule for queries and injections (spaces, hyphens and % appear in CMMS energy fields). */
export const FIELD_NAME = /^[A-Za-z0-9 _.\-/%()]{1,64}$/;
export const ASSET_ID = /^[a-f0-9]{24}$/;
