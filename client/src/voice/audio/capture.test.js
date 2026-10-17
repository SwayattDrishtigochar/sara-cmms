import { afterEach, describe, expect, it, vi } from 'vitest';
import { FrameBuffer, Resampler, rms, toPcm16 } from './captureWorklet.js';
import { micError, micSupport, startMic } from './mic.js';

const sine = (freq, rate, n) =>
  Float32Array.from({ length: n }, (_, i) => 0.8 * Math.sin((2 * Math.PI * freq * i) / rate));

/** Pushes `input` through a fresh resampler in chunks of the given sizes (cycled) and joins the output. */
const resample = (input, fromRate, sizes = [128]) => {
  const r = new Resampler(fromRate);
  const parts = [];
  for (let i = 0, k = 0; i < input.length; k++) {
    const size = sizes[k % sizes.length];
    parts.push(r.push(input.subarray(i, i + size)));
    i += size;
  }
  const out = new Float32Array(parts.reduce((sum, p) => sum + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

const crossings = (x) => {
  let n = 0;
  for (let i = 1; i < x.length; i++) if (Math.sign(x[i]) !== Math.sign(x[i - 1])) n++;
  return n;
};

describe('Resampler', () => {
  it('48 kHz → 16 kHz yields exactly N/3 samples across arbitrary chunk splits', () => {
    const input = sine(440, 48000, 48000);
    for (const sizes of [[128], [1], [7, 300, 2, 1000], [48000]]) {
      expect(resample(input, 48000, sizes)).toHaveLength(16000);
    }
    expect(resample(input, 48000, [7, 300, 2])).toEqual(resample(input, 48000, [128]));
  });

  it('keeps DC', () => {
    const out = resample(new Float32Array(4800).fill(0.5), 48000);
    for (const v of out) expect(v).toBeCloseTo(0.5, 6);
  });

  it('passes 1 kHz and attenuates 12 kHz (above the 8 kHz Nyquist)', () => {
    const low = sine(1000, 48000, 48000);
    const lowOut = resample(low, 48000);
    expect(rms(lowOut) / rms(low)).toBeGreaterThan(0.95);
    expect(Math.abs(crossings(lowOut) - crossings(low))).toBeLessThanOrEqual(2);

    const high = sine(12000, 48000, 48000);
    expect(rms(resample(high, 48000)) / rms(high)).toBeLessThan(0.4);
  });

  it('44.1 kHz → 16 kHz length is within ±1 of N·16000/44100', () => {
    const n = 44100 * 3 + 77;
    const out = resample(sine(500, 44100, n), 44100, [128, 5, 333]);
    expect(Math.abs(out.length - (n * 16000) / 44100)).toBeLessThanOrEqual(1);
  });
});

describe('toPcm16 / rms', () => {
  it('maps and clips', () => {
    expect(Array.from(toPcm16(Float32Array.of(-1, 1, 2, 0.5, -2, 0)))).toEqual([
      -32768, 32767, 32767, 16384, -32768, 0,
    ]);
  });

  it('rms of a full-scale square is 1, of nothing is 0', () => {
    expect(rms(Float32Array.of(1, -1, 1, -1))).toBe(1);
    expect(rms(new Float32Array(0))).toBe(0);
  });
});

describe('FrameBuffer', () => {
  it('turns 128-sample quanta into exact 640-sample frames', () => {
    const fb = new FrameBuffer();
    const frames = [];
    for (let q = 0; q < 12; q++) frames.push(...fb.push(new Float32Array(128).fill(q)));
    expect(frames).toHaveLength(2); // 12 × 128 = 1536 = 2 × 640 + 256 pending
    expect(frames.every((f) => f.length === 640)).toBe(true);
    expect(frames[0][0]).toBe(0);
    expect(frames[0][639]).toBe(4); // sample 639 is in quantum 4
    expect(frames[1][0]).toBe(5); // sample 640 starts quantum 5
    expect(frames[0]).not.toBe(frames[1]);
  });

  it('a 1280 B PCM frame comes out of 40 ms at 16 kHz', () => {
    expect(toPcm16(new FrameBuffer().push(new Float32Array(640))[0]).buffer.byteLength).toBe(1280);
  });
});

describe('worklet module', () => {
  it('imports outside an AudioWorkletGlobalScope without registering', async () => {
    expect(globalThis.registerProcessor).toBeUndefined();
    const mod = await import('./captureWorklet.js');
    expect(typeof mod.Resampler).toBe('function');
  });
});

describe('mic', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete navigator.mediaDevices;
  });

  const setMedia = (getUserMedia) =>
    Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia }, configurable: true });

  it('micSupport reports what is missing', () => {
    vi.stubGlobal('isSecureContext', false);
    expect(micSupport()).toEqual({ ok: false, reason: 'insecure' });
    vi.stubGlobal('isSecureContext', true);
    expect(micSupport()).toEqual({ ok: false, reason: 'no-media' });
    setMedia(vi.fn());
    vi.stubGlobal('AudioWorkletNode', undefined);
    expect(micSupport()).toEqual({ ok: false, reason: 'no-worklet' });
    vi.stubGlobal('AudioWorkletNode', class {});
    vi.stubGlobal('WebSocket', undefined);
    expect(micSupport()).toEqual({ ok: false, reason: 'no-websocket' });
    vi.stubGlobal('WebSocket', class {});
    expect(micSupport()).toEqual({ ok: true });
  });

  it.each([
    ['NotAllowedError', 'MIC_DENIED', /blocked/],
    ['SecurityError', 'MIC_DENIED', /blocked/],
    ['NotFoundError', 'NO_MIC', /No microphone/],
    ['NotReadableError', 'MIC_ERROR', /busy/],
    ['AbortError', 'MIC_ERROR', /could not start/],
  ])('maps getUserMedia %s to %s', async (name, code, message) => {
    setMedia(vi.fn(async () => Promise.reject(new DOMException('x', name))));
    const error = await startMic({ context: {} }).catch((e) => e);
    expect(error.code).toBe(code);
    expect(error.message).toMatch(message);
    expect(micError(undefined).code).toBe('MIC_ERROR');
  });

  /** Stub stream + context + worklet node; returns handles to inspect. */
  const fakeAudio = ({ addModule = async () => {} } = {}) => {
    const track = { enabled: true, stop: vi.fn() };
    const getUserMedia = vi.fn(async () => ({ getAudioTracks: () => [track] }));
    setMedia(getUserMedia);
    const source = { connect: vi.fn(), disconnect: vi.fn() };
    const context = {
      audioWorklet: { addModule: vi.fn(addModule) },
      createMediaStreamSource: vi.fn(() => source),
    };
    const nodes = [];
    vi.stubGlobal(
      'AudioWorkletNode',
      class {
        constructor(ctx, name, options) {
          Object.assign(this, { ctx, name, options, port: {}, disconnect: vi.fn() });
          nodes.push(this);
        }
      },
    );
    return { track, getUserMedia, source, context, nodes };
  };

  it('asks for a cleaned-up mono mic, wires frames and levels, mutes and cleans up', async () => {
    const { track, getUserMedia, source, context, nodes } = fakeAudio();
    const onFrame = vi.fn();
    const onLevel = vi.fn();
    const mic = await startMic({ context, onFrame, onLevel });

    expect(getUserMedia).toHaveBeenCalledWith({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    const [node] = nodes;
    expect(node.name).toBe('sara-capture');
    expect(node.options.numberOfOutputs).toBe(0);
    expect(source.connect).toHaveBeenCalledWith(node);
    expect(source.connect).toHaveBeenCalledTimes(1); // never to destination

    const pcm = new ArrayBuffer(1280);
    node.port.onmessage({ data: { pcm, level: 0.2 } });
    expect(onFrame).toHaveBeenCalledWith(pcm);
    expect(onLevel).toHaveBeenCalledWith(0.2);

    mic.setMuted(true);
    expect(track.enabled).toBe(false);
    mic.setMuted(false);
    expect(track.enabled).toBe(true);

    mic.stop();
    mic.stop();
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(source.disconnect).toHaveBeenCalled();
    expect(node.disconnect).toHaveBeenCalled();
    expect(node.port.onmessage).toBeNull();
  });

  it('stops the tracks when the worklet cannot load', async () => {
    const { track, context } = fakeAudio({
      addModule: async () => {
        throw new Error('nope');
      },
    });
    const error = await startMic({ context }).catch((e) => e);
    expect(error.code).toBe('MIC_ERROR');
    expect(track.stop).toHaveBeenCalled();
  });
});
