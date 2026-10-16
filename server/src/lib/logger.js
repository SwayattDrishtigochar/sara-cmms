import pino from 'pino';
import { env } from '../config/env.js';

export const logger = pino({
  level: env.NODE_ENV === 'test' ? 'silent' : env.LOG_LEVEL,
  redact: {
    paths: ['req.headers.authorization', '*.password', '*.token', '*.GEMINI_API_KEY'],
    censor: '[redacted]',
  },
});
