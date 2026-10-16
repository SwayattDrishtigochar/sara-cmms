import { z } from 'zod';

// One `.env` at the repo root serves the server, scripts, Vite and docker-compose.
// Variables already set in the environment (Docker, CI) win over the file.
try {
  process.loadEnvFile(new URL('../../../.env', import.meta.url));
} catch {
  // no .env file: rely on the real environment
}

const blankToUndefined = (v) => (v === '' ? undefined : v);
const str = (fallback) => z.preprocess(blankToUndefined, z.string().default(fallback));
const int = (fallback) =>
  z.preprocess(blankToUndefined, z.coerce.number().int().nonnegative().default(fallback));
const bool = (fallback = false) =>
  z
    .preprocess(blankToUndefined, z.enum(['true', 'false']).default(String(fallback)))
    .transform((v) => v === 'true');

const schema = z.object({
  NODE_ENV: z.preprocess(
    blankToUndefined,
    z.enum(['development', 'test', 'production']).default('development'),
  ),
  PORT: int(5080),
  CLIENT_URL: str('http://localhost:5173'),
  LOG_LEVEL: str('info'),
  LOG_PROMPTS: bool(),
  DEMO_MODE: bool(),

  MONGO_URI: z.string().min(1, 'MONGO_URI is required'),
  MONGO_TEST_URI: str('mongodb://localhost:27017'),

  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters'),
  JWT_LIFETIME: str('1d'),
  SESSION_TTL_HOURS: int(24),
  SUPERADMIN_EMAIL: str('superadmin@swayatt.com'),
  SUPERADMIN_PASSWORD: str('Admin@SARA-2026'),

  INFLUX_URL: str(''),
  INFLUX_TOKEN: str(''),
  INFLUX_ORG: str('sara'),

  GEMINI_API_KEY: str(''),
  AI_MOCK: bool(),
  GEMINI_MODEL_ROUTER: str('gemini-3.1-flash-lite'),
  GEMINI_MODEL_FAST: str('gemini-3.6-flash'),
  GEMINI_MODEL_BALANCED: str('gemini-3.8-flash'),
  GEMINI_MODEL_DEEP: str('gemini-3.8-flash'),
  GEMINI_MODEL_BACKGROUND: str('gemini-3.5-flash-lite'),
  GEMINI_FALLBACK_FAST: str('gemini-3.8-flash'),
  GEMINI_FALLBACK_BALANCED: str('gemini-3.6-flash'),
  GEMINI_FALLBACK_DEEP: str('gemini-3.6-flash'),

  MAX_ROWS: int(200),
  MAX_TOOL_ITERATIONS: int(6),
  MAX_TURN_MS: int(90000),
  TOOL_TIMEOUT_MS: int(20000),
  HISTORY_TURNS: int(12),
  PENDING_ACTION_TTL_MIN: int(10),
  ENABLE_RAW_FLUX: bool(),
  DEFAULT_TIMEZONE: str('Asia/Kolkata'),

  ANOMALY_SCAN_TICK_SEC: int(60),
  ANOMALY_QUIET_INTERVAL_MIN: int(10),
  COST_WATCH_INTERVAL_MIN: int(15),
  KPI_INSIGHT_TTL_MIN: int(60),
  BRIEFING_TTL_HOURS: int(4),
  AI_CHAT_RESERVE_PCT: int(40),

  RATE_LIMIT_LOGIN_PER_MIN: int(10),
  RATE_LIMIT_MESSAGES_PER_MIN: int(30),

  SIM_DEFAULT_PASSWORD: str('Sara@12345'),
  SIM_DEFAULT_DOMAIN: str('swayatt.com'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  const lines = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
  console.error(`Invalid environment configuration:\n${lines.join('\n')}`);
  process.exit(1);
}

export const env = Object.freeze(parsed.data);
export const isTest = env.NODE_ENV === 'test';
