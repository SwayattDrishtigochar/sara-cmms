import { Router } from 'express';
import mongoose from 'mongoose';

export const healthRouter = Router();

/** Component checks registered by subsystems (influx, gemini …) as `name → async () => status`. */
const checks = new Map();
export const registerHealthCheck = (name, fn) => checks.set(name, fn);

healthRouter.get('/health', async (_req, res) => {
  const components = { mongo: mongoose.connection.readyState === 1 ? 'up' : 'down' };
  await Promise.all(
    [...checks].map(async ([name, fn]) => {
      try {
        components[name] = await fn();
      } catch (err) {
        components[name] = { status: 'down', error: err.message };
      }
    }),
  );
  const ok = components.mongo === 'up';
  res
    .status(ok ? 200 : 503)
    .json({ status: ok ? 'ok' : 'degraded', uptimeSec: Math.round(process.uptime()), components });
});
