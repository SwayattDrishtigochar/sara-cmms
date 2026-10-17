import { z } from 'zod';
import { FEMALE_VOICES, VOICE_LANGUAGES } from '../ai/settings.js';

/** Voice wire protocol (phase 8 §4): browser ⇄ server limits and message shapes. */

export const INPUT_RATE = 16_000;
export const OUTPUT_RATE = 24_000;
export const FRAME_MIN_BYTES = 320; // 10–256 ms of PCM16 at 16 kHz
export const FRAME_MAX_BYTES = 8192;
export const MAX_JSON_BYTES = 16 * 1024; // ws maxPayload
export const MAX_TEXT_CHARS = 2000;
export const AUTH_TIMEOUT_MS = 5000;
export const MAX_MSGS_PER_SEC = 100; // audio is 25/s
export const MAX_STARTS_PER_MIN = 6; // per user
export const IDLE_SEC = 90;
export const CONNECT_TIMEOUT_MS = 10_000;
export const RESUME_BUFFER_MS = 2000;
export const MAX_CLIENT_BUFFER = 1_000_000; // bytes queued to a slow browser before audio is dropped
export const LATE_TRANSCRIPT_MS = 1500;
export const HEARTBEAT_MS = 20_000;
export const REVALIDATE_MS = 60_000;
export const AUDIO_IN_RATE = 1.5 * INPUT_RATE * 2; // bytes/s of browser audio relayed to Gemini (1.5x real time)
export const AUDIO_IN_BURST = 2 * INPUT_RATE * 2; // 2 s of audio
export const AUDIO_OVERRUN_MS = 3000; // audio above the rate this long → RATE_LIMITED
export const RECONNECT_WINDOW_MS = 60_000; // one reconnect after an unexpected Gemini close per window

/** Typed text without any leading "App note:" prefixes (only the server writes App notes). */
export const stripAppNote = (text) => text.replace(/^(?:\s*App note:\s*)+/i, '').trim();

/** WebSocket close code per `closed` reason or `error` code (§4.3). */
export const CLOSE_CODES = Object.freeze({
  ended: 1000,
  idle: 1000,
  max_duration: 1000,
  replaced: 1000,
  server_shutdown: 1001,
  error: 1011,
  signed_out: 4001,
  UNAUTHORIZED: 4001,
  VOICE_DISABLED: 4003,
  CONVERSATION_NOT_FOUND: 4004,
  BAD_MESSAGE: 4008,
  RATE_LIMITED: 4008,
  VOICE_BUSY: 4029,
  AI_QUOTA: 4029,
  AI_ERROR: 4502,
});

/** A protocol error with a §4.3 code. */
export class VoiceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'VoiceError';
    this.code = code;
  }
}

const actionId = z.string().min(1).max(60);

const start = z.strictObject({
  type: z.literal('start'),
  token: z.string().min(1).max(4096),
  conversationId: z
    .string()
    .regex(/^[a-f0-9]{24}$/i)
    .optional(),
  language: z.enum(VOICE_LANGUAGES.map((l) => l.code)).optional(),
  voice: z.enum(FEMALE_VOICES.map((v) => v.name)).optional(),
  context: z
    .strictObject({
      page: z.string().max(60).optional(),
      recordRef: z
        .strictObject({
          module: z.string().max(60),
          id: z.string().max(60),
          label: z.string().max(120).optional(),
        })
        .optional(),
    })
    .optional(),
});

export const clientMessageSchema = z.discriminatedUnion('type', [
  start,
  z.strictObject({ type: z.literal('text'), text: z.string().trim().min(1).max(MAX_TEXT_CHARS) }),
  z.strictObject({ type: z.literal('mute'), muted: z.boolean() }),
  z.strictObject({ type: z.literal('interrupt') }),
  z.strictObject({ type: z.literal('confirm'), actionId }),
  z.strictObject({ type: z.literal('reject'), actionId }),
  z.strictObject({ type: z.literal('end') }),
]);

const bad = (message) => new VoiceError('BAD_MESSAGE', message);

/** One ws frame → `{ type: 'audio', data: Buffer }` or a parsed JSON message; throws a BAD_MESSAGE VoiceError. */
export const parseClientMessage = (data, isBinary) => {
  const buf = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
  if (isBinary) {
    if (buf.length < FRAME_MIN_BYTES || buf.length > FRAME_MAX_BYTES || buf.length % 2)
      throw bad('Audio frames are PCM16 at 16 kHz, 320–8192 bytes');
    return { type: 'audio', data: buf };
  }
  let json;
  try {
    json = JSON.parse(buf.toString('utf8'));
  } catch {
    throw bad('Messages must be JSON');
  }
  const parsed = clientMessageSchema.safeParse(json);
  if (!parsed.success) throw bad('Unknown or invalid message');
  return parsed.data;
};
