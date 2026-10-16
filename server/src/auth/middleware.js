import { buildUserContext } from '../context/buildUserContext.js';
import { Session } from '../db/models/Session.js';
import { forbidden, unauthorized } from '../lib/errors.js';
import { getModule } from '../modules/registry.js';
import { verifyToken } from './jwt.js';

const liveSession = (sessionId, userId) => ({
  sessionId,
  userId,
  expired: false,
  expiresAt: { $gt: new Date() },
});
const activeUser = (userId) => ({ _id: userId, deleted: { $ne: true } });

/** Resolves the Bearer token → session → user → request context (req.ctx). */
export const authenticate = async (req, _res, next) => {
  const [scheme, token] = (req.headers.authorization ?? '').split(' ');
  if (scheme !== 'Bearer' || !token) throw unauthorized('Sign in to continue');

  let payload;
  try {
    payload = verifyToken(token);
  } catch {
    throw unauthorized('Your session has expired, please sign in again');
  }
  const session = await Session.findOne(liveSession(payload.sessionId, payload.userId)).lean();
  if (!session) throw unauthorized('Your session has ended, please sign in again');

  const user = await getModule('users').Model.findOne(activeUser(payload.userId)).lean();
  if (!user) throw unauthorized('Your account is no longer active');

  req.user = user;
  req.sessionId = session.sessionId;
  req.tokenExpiresAt = payload.exp ? payload.exp * 1000 : null;
  req.ctx = await buildUserContext(user);
  next();
};

/** Same checks as authenticate, for long-lived streams: token unexpired, session live, user not deleted. */
export const stillSignedIn = async (req) => {
  if (req.tokenExpiresAt && Date.now() >= req.tokenExpiresAt) return false;
  const [session, user] = await Promise.all([
    Session.exists(liveSession(req.sessionId, req.user._id)),
    getModule('users').Model.exists(activeUser(req.user._id)),
  ]);
  return Boolean(session && user);
};

export const requireSuperAdmin = (req, _res, next) => {
  if (req.ctx?.role !== 'superAdmin') throw forbidden('Superadmin only');
  next();
};
