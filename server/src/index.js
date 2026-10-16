import { startAnomalyWatch } from './ai/anomaly/watch.js';
import { createApp } from './app.js';
import { env } from './config/env.js';
import { pingInflux } from './config/influx.js';
import { connectMongo } from './config/mongo.js';
import { startCostWatch } from './costs/watch.js';
import { logger } from './lib/logger.js';
import './modules/registry.js';
import { adminAiRouter } from './routes/adminAi.js';
import { adminSimRouter } from './routes/adminSim.js';
import { aiRouter } from './routes/ai.js';
import { anomaliesRouter } from './routes/anomalies.js';
import { briefingRouter } from './routes/briefing.js';
import { conversationsRouter } from './routes/conversations.js';
import { costsRouter } from './routes/costs.js';
import { exportRouter } from './routes/export.js';
import { registerHealthCheck } from './routes/health.js';
import { kpisRouter } from './routes/kpis.js';
import { notificationsRouter } from './routes/notifications.js';
import { planningRouter } from './routes/planning.js';
import { planningMaintenanceRouter } from './routes/planningMaintenance.js';
import { telemetryRouter } from './routes/telemetry.js';
import { ensurePlatform, superadminUsesDemoPassword } from './sim/platform.js';
import { stopLivePollers } from './telemetry/livePoller.js';

registerHealthCheck('influx', pingInflux);

const start = async () => {
  await connectMongo();
  logger.info('MongoDB connected');
  await ensurePlatform();
  if (await superadminUsesDemoPassword()) {
    logger.warn(
      'The superadmin signs in with SIM_DEFAULT_PASSWORD, the password the demo login page shows. ' +
        'Set a different SUPERADMIN_PASSWORD in .env and change the superadmin password.',
    );
  }

  const app = createApp({
    routers: [
      { path: '/api/admin/sim', router: adminSimRouter },
      { path: '/api/admin/ai', router: adminAiRouter },
      { path: '/api', router: telemetryRouter },
      // These routers carry their full paths (/ai/…, /anomalies/…, /planning/…, /costs/…, /kpis/…, /briefing …).
      { path: '/api', router: aiRouter },
      { path: '/api', router: anomaliesRouter },
      { path: '/api', router: notificationsRouter },
      { path: '/api', router: conversationsRouter },
      { path: '/api', router: exportRouter },
      { path: '/api', router: planningRouter },
      { path: '/api', router: planningMaintenanceRouter },
      { path: '/api', router: costsRouter },
      { path: '/api', router: kpisRouter },
      { path: '/api', router: briefingRouter },
    ],
  });
  // Express 5 hands listen errors (EADDRINUSE) to the callback; reject so start() fails loudly.
  const server = await new Promise((resolve, reject) => {
    const s = app.listen(env.PORT, (err) => (err ? reject(err) : resolve(s)));
  });
  logger.info(`SARA server listening on http://localhost:${env.PORT}`);
  const stopAnomalyWatch = startAnomalyWatch();
  const stopCostWatch = startCostWatch();

  const shutdown = (signal) => {
    logger.info(`${signal} received, shutting down`);
    stopLivePollers();
    stopAnomalyWatch();
    stopCostWatch();
    server.close(() => process.exit(0));
    // Live streams never finish on their own: give normal requests a moment, then cut the rest.
    setTimeout(() => server.closeAllConnections(), 2_000).unref();
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
};

start().catch((err) => {
  logger.fatal({ err }, 'failed to start');
  process.exit(1);
});
