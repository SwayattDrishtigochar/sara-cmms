import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';

export const signToken = ({ userId, sessionId }) =>
  jwt.sign({ userId: String(userId), sessionId }, env.JWT_SECRET, {
    expiresIn: env.JWT_LIFETIME,
    algorithm: 'HS256',
  });

export const verifyToken = (token) => jwt.verify(token, env.JWT_SECRET, { algorithms: ['HS256'] });
