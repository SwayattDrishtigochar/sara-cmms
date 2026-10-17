import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { signToken } from '../auth/jwt.js';
import { authenticate } from '../auth/middleware.js';
import { env } from '../config/env.js';
import { buildUserContext, publicContext } from '../context/buildUserContext.js';
import { Session } from '../db/models/Session.js';
import { notFound, parseOrThrow, unauthorized } from '../lib/errors.js';
import { getModule } from '../modules/registry.js';

const emailField = z.string().trim().toLowerCase().email('Enter a valid email');
const loginSchema = z.object({
  email: emailField,
  password: z.string().min(1, 'Enter your password').max(200),
});
const demoLoginSchema = z.object({ email: emailField });

const safeUser = (user) => {
  const { password: _password, ...rest } = user;
  return rest;
};

/** Per-IP limiter with the login settings; each route gets its own counter. */
const loginLimiter = () =>
  rateLimit({
    windowMs: 60_000,
    limit: env.RATE_LIMIT_LOGIN_PER_MIN,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: { code: 'RATE_LIMITED', message: 'Too many sign-in attempts, try again in a minute' } },
  });

/** Opens a session for a user and returns the sign-in response body { token, user, context }. */
const signIn = async (user, req) => {
  const User = getModule('users').Model;
  const sessionId = randomUUID();
  await Session.create({
    userId: user._id,
    companyId: user.companyId,
    sessionId,
    expiresAt: new Date(Date.now() + env.SESSION_TTL_HOURS * 3_600_000),
    ip: req.ip,
    userAgent: req.headers['user-agent']?.slice(0, 300),
  });
  await User.updateOne({ _id: user._id }, { $set: { lastLogin: new Date() } });
  const ctx = await buildUserContext(user);
  return {
    token: signToken({ userId: user._id, sessionId }),
    user: safeUser(user),
    context: publicContext(ctx),
  };
};

export const authRouter = Router();

authRouter.post('/login', loginLimiter(), async (req, res) => {
  const { email, password } = parseOrThrow(loginSchema, req.body, 'sign-in details');
  const User = getModule('users').Model;
  const user = await User.findOne({ email, deleted: { $ne: true } })
    .select('+password')
    .lean();
  // Same message for unknown email and wrong password: don't reveal which accounts exist.
  if (!user || !(await bcrypt.compare(password, user.password ?? '')))
    throw unauthorized('Wrong email or password');
  res.json(await signIn(user, req));
});

authRouter.post('/logout', authenticate, async (req, res) => {
  await Session.updateOne({ sessionId: req.sessionId }, { $set: { expired: true } });
  res.status(204).end();
});

authRouter.get('/me', authenticate, (req, res) => {
  res.json({ user: safeUser(req.user), context: publicContext(req.ctx) });
});

// ── Demo mode ───────────────────────────────────────────────────────────────
// Only the people of a real (non-platform) company at DEMO_DOMAIN; never the superadmin, never a password.

const demoSuffix = () => `@${env.DEMO_DOMAIN.toLowerCase()}`;
const demoFilter = () => ({ role: { $ne: 'superAdmin' }, deleted: { $ne: true } });
/** `@domain$` as a Mongo regex; the domain's dots are literal. */
const demoEmailRegex = () => ({ $regex: `${demoSuffix().replace(/\./g, '\\.')}$`, $options: 'i' });
const ROLE_ORDER = { owner: 0, admin: 1, technician: 2, view: 3 };
const DEPT_ORDER = { Maintenance: 0, Production: 1 };
const demoSortKey = (u) =>
  [ROLE_ORDER[u.role] ?? 9, DEPT_ORDER[u.department] ?? 9, u.userTitle ?? '', u.email].join('\u0000');

/** Real customer companies (by id) a demo user may belong to. */
const demoCompanies = async (ids) =>
  getModule('companies')
    .Model.find({ _id: { $in: ids }, isPlatform: { $ne: true }, deleted: { $ne: true } })
    .select('name')
    .sort({ name: 1 })
    .lean();

authRouter.get('/demo-accounts', loginLimiter(), async (_req, res) => {
  if (!env.DEMO_MODE) throw notFound();
  const users = await getModule('users')
    .Model.find({ ...demoFilter(), email: demoEmailRegex() })
    .select('firstName lastName email role department userTitle companyId')
    .lean();
  const companies = await demoCompanies([...new Set(users.map((u) => String(u.companyId)))]);
  const accounts = companies.map((c) => ({
    company: { id: String(c._id), name: c.name },
    users: users
      .filter((u) => String(u.companyId) === String(c._id))
      .sort((a, b) => demoSortKey(a).localeCompare(demoSortKey(b)))
      .map((u) => ({
        email: u.email,
        name: [u.firstName, u.lastName].filter(Boolean).join(' '),
        role: u.role,
        title: u.userTitle ?? '',
        department: u.department ?? '',
      })),
  }));
  res.json({ accounts: accounts.filter((a) => a.users.length) });
});

authRouter.post('/demo-login', loginLimiter(), async (req, res) => {
  if (!env.DEMO_MODE) throw notFound();
  const { email } = parseOrThrow(demoLoginSchema, req.body, 'sign-in details');
  const user =
    email.endsWith(demoSuffix()) &&
    (await getModule('users')
      .Model.findOne({ ...demoFilter(), email })
      .lean());
  const company = user && (await demoCompanies([user.companyId]))[0];
  if (!company) throw unauthorized('Wrong email or password');
  req.log?.info({ email }, 'demo login');
  res.json(await signIn(user, req));
});
