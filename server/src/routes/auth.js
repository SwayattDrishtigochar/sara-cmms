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
import { parseOrThrow, unauthorized } from '../lib/errors.js';
import { getModule } from '../modules/registry.js';
import { superadminUsesDemoPassword } from '../sim/platform.js';

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email'),
  password: z.string().min(1, 'Enter your password').max(200),
});

const safeUser = (user) => {
  const { password: _password, ...rest } = user;
  return rest;
};

export const authRouter = Router();

authRouter.post(
  '/login',
  rateLimit({
    windowMs: 60_000,
    limit: env.RATE_LIMIT_LOGIN_PER_MIN,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: { code: 'RATE_LIMITED', message: 'Too many sign-in attempts, try again in a minute' } },
  }),
  async (req, res) => {
    const { email, password } = parseOrThrow(loginSchema, req.body, 'sign-in details');
    const User = getModule('users').Model;
    const user = await User.findOne({ email, deleted: { $ne: true } })
      .select('+password')
      .lean();
    // Same message for unknown email and wrong password: don't reveal which accounts exist.
    if (!user || !(await bcrypt.compare(password, user.password ?? '')))
      throw unauthorized('Wrong email or password');

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
    res.json({
      token: signToken({ userId: user._id, sessionId }),
      user: safeUser(user),
      context: publicContext(ctx),
    });
  },
);

authRouter.post('/logout', authenticate, async (req, res) => {
  await Session.updateOne({ sessionId: req.sessionId }, { $set: { expired: true } });
  res.status(204).end();
});

authRouter.get('/me', authenticate, (req, res) => {
  res.json({ user: safeUser(req.user), context: publicContext(req.ctx) });
});

/**
 * Demo helper for the login page (DEMO_MODE only): who can sign in to the simulated companies.
 * Public, so never the platform tenant, a superadmin or the superadmin password: while the superadmin
 * could still sign in with the shared demo password, the page lists the accounts without it.
 */
authRouter.get('/demo-accounts', async (_req, res) => {
  if (!env.DEMO_MODE) return res.json({ accounts: [] });
  const password = (await superadminUsesDemoPassword()) ? '' : env.SIM_DEFAULT_PASSWORD;
  const Company = getModule('companies').Model;
  const User = getModule('users').Model;
  const companies = await Company.find({ isSimulated: true, isPlatform: { $ne: true } })
    .select('name')
    .sort({ createdAt: 1 })
    .lean();
  const users = await User.find({
    companyId: { $in: companies.map((c) => c._id) },
    role: { $ne: 'superAdmin' },
    deleted: { $ne: true },
  })
    .select('firstName lastName email role userTitle companyId')
    .sort({ createdAt: 1 })
    .lean();
  res.json({
    accounts: companies.map((c) => ({
      company: c.name,
      password,
      users: users
        .filter((u) => String(u.companyId) === String(c._id))
        .map((u) => ({
          email: u.email,
          name: `${u.firstName} ${u.lastName ?? ''}`.trim(),
          role: u.role,
          title: u.userTitle,
        })),
    })),
  });
});
