import { rms } from './captureWorklet.js';

export const LEAD_SEC = 0.06;

/** Gapless: a chunk starts where the previous ends, or LEAD_SEC from now after an underrun. */
export const scheduleChunk = ({ now, nextStart, duration, lead = LEAD_SEC }) => {
  const at = nextStart > now ? nextStart : now + lead;
  return { at, nextStart: at + duration };
};

/** PCM16 LE bytes → Float32 samples in [-1, 1] (a trailing odd byte is ignored). */
export const fromPcm16 = (arrayBuffer) => {
  // ponytail: Int16Array reads platform byte order (little-endian everywhere today); DataView if big-endian ever matters.
  const pcm = new Int16Array(arrayBuffer, 0, arrayBuffer.byteLength >> 1);
  const out = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = pcm[i] < 0 ? pcm[i] / 32768 : pcm[i] / 32767;
  return out;
};

export const DUCK_GAIN = 0.15; // level while a local barge-in waits for Gemini's verdict
export const DUCK_MS = 700; // no `interrupted` by then → full volume again
export const HANGOVER_MS = 250; // playback gaps shorter than this keep `onSpeaking` true
const RAMP_SEC = 0.01; // gain time constant: ~95 % of the way in 30 ms

/**
 * Plays PCM16 LE mono chunks as AudioBuffers at `rate` on `context` (the browser resamples to its own rate).
 * Graph: sources → analyser → gain → destination, so `level()` keeps reading SARA while she is ducked.
 */
export const createPlayer = (context, { rate = 24000, onSpeaking } = {}) => {
  const analyser = context.createAnalyser();
  analyser.fftSize = 512;
  const gain = context.createGain();
  analyser.connect(gain);
  gain.connect(context.destination);
  const scratch = new Float32Array(analyser.fftSize);
  const sources = new Set();
  let nextStart = 0;
  let speaking = false;
  let idleTimer = null;
  let duckTimer = null;

  const setSpeaking = (value) => {
    if (value === speaking) return;
    speaking = value;
    onSpeaking?.(value);
  };
  const rampTo = (value) => {
    gain.gain.cancelScheduledValues(context.currentTime);
    gain.gain.setTargetAtTime(value, context.currentTime, RAMP_SEC);
  };
  const unduck = () => {
    clearTimeout(duckTimer);
    duckTimer = null;
    rampTo(1);
  };

  return {
    enqueue(arrayBuffer) {
      const samples = fromPcm16(arrayBuffer);
      if (!samples.length) return;
      const buffer = context.createBuffer(1, samples.length, rate);
      buffer.getChannelData(0).set(samples);
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(analyser);
      const slot = scheduleChunk({ now: context.currentTime, nextStart, duration: samples.length / rate });
      nextStart = slot.nextStart;
      source.onended = () => {
        sources.delete(source);
        source.disconnect();
        if (!sources.size) idleTimer = setTimeout(() => setSpeaking(false), HANGOVER_MS);
      };
      sources.add(source);
      source.start(slot.at);
      clearTimeout(idleTimer);
      setSpeaking(true);
    },
    /** Local barge-in guess: lower the volume, keep playing; restores itself after DUCK_MS unless stop() comes first. */
    duck() {
      clearTimeout(duckTimer);
      rampTo(DUCK_GAIN);
      duckTimer = setTimeout(unduck, DUCK_MS);
    },
    stop() {
      for (const source of sources) {
        source.onended = null;
        try {
          source.stop();
        } catch {
          // already stopped
        }
        source.disconnect();
      }
      sources.clear();
      nextStart = 0;
      clearTimeout(idleTimer);
      unduck();
      setSpeaking(false);
    },
    /** True only while audio is queued (no hangover), so barge-in never fires on silence. */
    get speaking() {
      return sources.size > 0;
    },
    /** 0..1 output level from the AnalyserNode (0 while silent). */
    level() {
      if (!sources.size) return 0;
      analyser.getFloatTimeDomainData(scratch);
      return Math.min(1, rms(scratch));
    },
  };
};

/** Local barge-in: true once the mic level stays above `threshold` for `frames` frames in a row while SARA speaks. */
export const createBargeIn = ({ threshold = 0.06, frames = 3 } = {}) => {
  let run = 0;
  return (level, speaking) => {
    run = speaking && level > threshold ? run + 1 : 0;
    if (run < frames) return false;
    run = 0; // fire once per burst; the caller ducks playback
    return true;
  };
};
