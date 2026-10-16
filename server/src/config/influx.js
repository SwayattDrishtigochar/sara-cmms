import { InfluxDB, Point } from '@influxdata/influxdb-client';
import { env } from './env.js';

export { Point };

export const influxEnabled = Boolean(env.INFLUX_URL && env.INFLUX_TOKEN);
const client = influxEnabled
  ? new InfluxDB({ url: env.INFLUX_URL, token: env.INFLUX_TOKEN, timeout: 30_000 })
  : null;

/** One bucket per company, named by its id (as in CMMS). */
export const bucketFor = (companyId) => String(companyId);

const requireClient = () => {
  if (!client) throw new Error('InfluxDB is not configured (INFLUX_URL / INFLUX_TOKEN)');
  return client;
};

/** Runs a Flux query and returns plain row objects. */
export const queryRows = (flux) => requireClient().getQueryApi(env.INFLUX_ORG).collectRows(flux);

const ensured = new Set();
let orgId = null;

/** Creates the company bucket on first use (422 = it already exists). */
export const ensureBucket = async (name) => {
  if (ensured.has(name)) return;
  const headers = { Authorization: `Token ${env.INFLUX_TOKEN}`, 'content-type': 'application/json' };
  if (!orgId) {
    const res = await fetch(`${env.INFLUX_URL}/api/v2/orgs?org=${encodeURIComponent(env.INFLUX_ORG)}`, {
      headers,
    });
    if (!res.ok) throw new Error(`InfluxDB org lookup failed (${res.status})`);
    orgId = (await res.json()).orgs?.[0]?.id;
    if (!orgId) throw new Error(`InfluxDB org "${env.INFLUX_ORG}" not found`);
  }
  const res = await fetch(`${env.INFLUX_URL}/api/v2/buckets`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ orgID: orgId, name, retentionRules: [] }),
  });
  if (!res.ok && res.status !== 422) throw new Error(`InfluxDB bucket create failed (${res.status})`);
  ensured.add(name);
};

/**
 * Writes points and resolves only once InfluxDB has accepted them: no timer flushes and no
 * background retries, so a failure reaches the caller.
 */
export const writePoints = async (bucket, points) => {
  if (!points.length) return;
  await ensureBucket(bucket);
  const writeApi = requireClient().getWriteApi(env.INFLUX_ORG, bucket, 'ms', {
    maxRetries: 0,
    flushInterval: 0,
    batchSize: points.length + 1,
  });
  writeApi.writePoints(points);
  await writeApi.close();
};

export const pingInflux = async () => {
  if (!influxEnabled) return 'disabled';
  const res = await fetch(`${env.INFLUX_URL}/health`).catch(() => null);
  return res?.ok ? 'up' : 'down';
};
