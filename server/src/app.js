import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { authenticate } from './auth/middleware.js';
import { env } from './config/env.js';
import { errorHandler, notFound } from './lib/errors.js';
import { logger } from './lib/logger.js';
import { authRouter } from './routes/auth.js';
import { healthRouter } from './routes/health.js';
import { modulesRouter } from './routes/modules.js';

/**
 * Builds the Express app. `routers` lets subsystems (telemetry, chat, admin …) plug in:
 * { path, router, public?: no auth }.
 */
export const createApp = ({ routers = [] } = {}) => {
  const app = express();
  app.set('query parser', 'extended');
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  console.log('env.CLIENT_URL', env.CLIENT_URL);
  app.use(helmet());
  app.use(cors({ origin: env.CLIENT_URL.split(',').map((o) => o.trim()) }));
  app.use(
    pinoHttp({
      logger,
      autoLogging: { ignore: (req) => req.url === '/api/health' },
    }),
  );

  // Several routers share the /api prefix: a request that passes more than one mount signs in once.
  const signedIn = (req, res, next) => (req.ctx ? next() : authenticate(req, res, next));

  app.use(express.json({ limit: '2mb' }));

  app.use('/api', healthRouter);
  app.use('/api/auth', authRouter);
  for (const { path, router, public: isPublic } of routers) {
    if (isPublic) app.use(path, router);
    else app.use(path, signedIn, router);
  }
  app.use('/api', signedIn, modulesRouter);

  app.use('/api', (_req, _res, next) => next(notFound('No such API route')));
  app.use(errorHandler);
  return app;
};
