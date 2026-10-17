// AudioWorklet module (self-contained: no imports). Loaded with `?url` + `audioWorklet.addModule`, and imported
// normally by tests and the player for the pure helpers below.

/** Streaming box-filter decimator: averages the input samples of each output period; state survives across chunks. */
export class Resampler {
  constructor(fromRate, toRate = 16000) {
    this.from = fromRate;
    this.to = toRate;
    this.consumed = 0; // input samples seen so far
    this.emitted = 0; // output samples produced so far
    this.sum = 0;
    this.count = 0;
  }

  push(float32) {
    const out = new Float32Array(Math.ceil(((float32.length + this.count) * this.to) / this.from) + 1);
    let n = 0;
    for (let i = 0; i < float32.length; i++) {
      this.sum += float32[i];
      this.count++;
      this.consumed++;
      // Integer edge test (no float drift): output k ends once consumed·to ≥ (k + 1)·from.
      if (this.consumed * this.to >= (this.emitted + 1) * this.from) {
        out[n++] = this.sum / this.count;
        this.emitted++;
        this.sum = 0;
        this.count = 0;
      }
    }
    return out.subarray(0, n);
  }
}

/** Float [-1, 1] → PCM16 (clamped; negative × 32768, positive × 32767, rounded). */
export const toPcm16 = (float32) => {
  const out = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    out[i] = Math.round(s < 0 ? s * 32768 : s * 32767);
  }
  return out;
};

/** Root-mean-square level of a block (0 for an empty one). */
export const rms = (float32) => {
  if (!float32.length) return 0;
  let sum = 0;
  for (let i = 0; i < float32.length; i++) sum += float32[i] * float32[i];
  return Math.sqrt(sum / float32.length);
};

/** Hands out exact frames (640 samples = 40 ms at 16 kHz) whatever the input quantum. */
export class FrameBuffer {
  constructor(size = 640) {
    this.frame = new Float32Array(size);
    this.fill = 0;
  }

  push(float32) {
    const frames = [];
    let i = 0;
    while (i < float32.length) {
      const take = Math.min(this.frame.length - this.fill, float32.length - i);
      this.frame.set(float32.subarray(i, i + take), this.fill);
      this.fill += take;
      i += take;
      if (this.fill === this.frame.length) {
        frames.push(this.frame);
        this.frame = new Float32Array(this.frame.length);
        this.fill = 0;
      }
    }
    return frames;
  }
}

const Base = globalThis.AudioWorkletProcessor ?? class {};

class CaptureProcessor extends Base {
  constructor() {
    super();
    // `sampleRate` is a global of AudioWorkletGlobalScope (the context's rate).
    this.resampler = new Resampler(globalThis.sampleRate);
    this.frames = new FrameBuffer();
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (channel) {
      for (const frame of this.frames.push(this.resampler.push(channel))) {
        const pcm = toPcm16(frame).buffer;
        this.port.postMessage({ pcm, level: Math.min(1, rms(frame)) }, [pcm]);
      }
    }
    return true;
  }
}

if (typeof registerProcessor === 'function') registerProcessor('sara-capture', CaptureProcessor);
