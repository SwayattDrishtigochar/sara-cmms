import { WebSocketServer } from 'ws';
import { getAiSettings } from '../ai/settings.js';
import { userFromToken } from '../auth/middleware.js';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import {
  AUTH_TIMEOUT_MS,
  CLOSE_CODES,
  HEARTBEAT_MS,
  MAX_JSON_BYTES,
  MAX_MSGS_PER_SEC,
  MAX_STARTS_PER_MIN,
  parseClientMessage,
  VoiceError,
} from './protocol.js';
import { createVoiceSession } from './session.js';

const PATH = '/api/voice';

/** Voice WebSocket on the HTTP server: upgrades for exactly /api/voice, Origin allow-list, auth from the first message. */
export const attachVoiceServer = (httpServer) => {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_JSON_BYTES, perMessageDeflate: false });
  const origins = new Set(env.CLIENT_URL.split(',').map((o) => new URL(o.trim()).origin));
  const sessions = new Map(); // userId → session (one per user, newest wins)
  const starts = new Map(); // userId → start timestamps of the last minute

  const fatal = (ws, code, message) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'error', code, message, fatal: true }));
    ws.close(CLOSE_CODES[code] ?? 1011, code);
  };

  const tooManyStarts = (userId) => {
    const now = Date.now();
    const stamps = (starts.get(userId) ?? []).filter((t) => now - t < 60_000);
    stamps.push(now);
    starts.set(userId, stamps);
    return stamps.length > MAX_STARTS_PER_MIN;
  };

  /** Auth, limits and the session for the first message; null when the connection was refused. */
  const begin = async (ws, data, isBinary) => {
    const start = parseClientMessage(data, isBinary);
    if (start.type !== 'start') throw new VoiceError('BAD_MESSAGE', 'The first message must be start');
    let auth;
    try {
      auth = await userFromToken(start.token);
    } catch (err) {
      if (err.status !== 401) throw err;
      throw new VoiceError('UNAUTHORIZED', err.message);
    }
    if (ws.readyState !== ws.OPEN) return null;
    const settings = await getAiSettings();
    if (auth.ctx.company?.isPlatform || settings.voice?.enabled === false)
      throw new VoiceError('VOICE_DISABLED', 'Voice is switched off for this account.');
    const userId = String(auth.ctx.userId);
    if (tooManyStarts(userId))
      throw new VoiceError('RATE_LIMITED', 'Voice was started too often. Wait a minute and try again.');
    const previous = sessions.get(userId);
    if (previous) {
      sessions.delete(userId);
      previous.close('replaced');
    }
    if (sessions.size >= settings.voice.maxConcurrent)
      throw new VoiceError(
        'VOICE_BUSY',
        'SARA is already talking to as many people as she can. Try again soon.',
      );
    const session = createVoiceSession({
      socket: ws,
      auth,
      start,
      settings,
      onClose: () => {
        if (sessions.get(userId) === session) sessions.delete(userId);
      },
    });
    sessions.set(userId, session);
    return session;
  };

  const onConnection = (ws) => {
    let session = null;
    let opened = null; // the begin() promise: later messages wait for it, in order
    let broken = false;
    let rate = { at: Date.now(), n: 0 };
    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });
    // e.g. a frame above maxPayload: ws closes 1009 itself, so the session ends as an error, not a goodbye.
    ws.on('error', (err) => {
      broken = true;
      logger.warn({ err: err.message }, 'voice socket error');
    });
    const authTimer = setTimeout(() => {
      if (!opened) fatal(ws, 'UNAUTHORIZED', 'Sign in did not arrive in time.');
    }, AUTH_TIMEOUT_MS);

    ws.on('message', (data, isBinary) => {
      const now = Date.now();
      if (now - rate.at >= 1000) rate = { at: now, n: 0 };
      rate.n += 1;
      if (rate.n > MAX_MSGS_PER_SEC) {
        if (rate.n === MAX_MSGS_PER_SEC + 1) {
          const message = 'Too many messages per second.';
          if (session) {
            if (ws.readyState === ws.OPEN)
              ws.send(JSON.stringify({ type: 'error', code: 'RATE_LIMITED', message, fatal: true }));
            session.close('error', CLOSE_CODES.RATE_LIMITED);
          } else fatal(ws, 'RATE_LIMITED', message);
        }
        return;
      }
      if (!opened) {
        clearTimeout(authTimer);
        opened = begin(ws, data, isBinary)
          .then((s) => {
            session = s;
            return s;
          })
          .catch((err) => {
            if (err instanceof VoiceError) fatal(ws, err.code, err.message);
            else {
              logger.error({ err }, 'voice start failed');
              fatal(ws, 'AI_ERROR', 'Voice could not start. Please try again.');
            }
            return null;
          });
        return;
      }
      opened.then((s) => s?.handleMessage(data, isBinary));
    });

    ws.on('close', () => {
      clearTimeout(authTimer);
      opened?.then((s) => s?.close(broken ? 'error' : 'ended'));
    });
    ws.markLost = () => {
      broken = true;
    };
  };

  const onUpgrade = (req, socket, head) => {
    const { pathname } = new URL(req.url ?? '/', 'http://localhost');
    if (pathname !== PATH) {
      socket.destroy();
      return;
    }
    if (!req.headers.origin || !origins.has(req.headers.origin)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws));
  };
  httpServer.on('upgrade', onUpgrade);

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        ws.markLost?.();
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();

  return {
    /** Ends every session (`closed server_shutdown`, persisted, sockets closed 1001) and stops accepting upgrades. */
    close: async (reason = 'server_shutdown') => {
      clearInterval(heartbeat);
      httpServer.off('upgrade', onUpgrade);
      await Promise.all([...sessions.values()].map((s) => s.close(reason, CLOSE_CODES.server_shutdown)));
      for (const ws of wss.clients) ws.close(CLOSE_CODES.server_shutdown, reason);
      await new Promise((resolve) => wss.close(() => resolve()));
    },
    size: () => sessions.size,
  };
};
