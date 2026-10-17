import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createBargeIn,
  createPlayer,
  DUCK_GAIN,
  DUCK_MS,
  fromPcm16,
  HANGOVER_MS,
  LEAD_SEC,
  scheduleChunk,
} from './player.js';

/** Minimal AudioContext stand-in: records every buffer source and when it was started. */
const fakeContext = () => {
  const sources = [];
  const analyser = {
    fftSize: 0,
    connect: vi.fn(),
    getFloatTimeDomainData: vi.fn((out) => out.fill(0.5)),
  };
  // The gain param jumps straight to each setTargetAtTime target (enough to check where it is heading).
  const gain = {
    connect: vi.fn(),
    gain: { value: 1, cancelScheduledValues: vi.fn(), setTargetAtTime: vi.fn((v) => (gain.gain.value = v)) },
  };
  const context = {
    currentTime: 1,
    destination: {},
    createAnalyser: () => analyser,
    createGain: () => gain,
    createBuffer: (channels, length, sampleRate) => {
      const data = new Float32Array(length);
      return { channels, length, sampleRate, duration: length / sampleRate, getChannelData: () => data };
    },
    createBufferSource: () => {
      const source = {
        connect: vi.fn(),
        disconnect: vi.fn(),
        start: vi.fn((at) => {
          source.at = at;
        }),
        stop: vi.fn(),
        onended: null,
      };
      sources.push(source);
      return source;
    },
  };
  return { context, sources, analyser, gain };
};

const chunk = (samples, value = 1000) => new Int16Array(samples).fill(value).buffer;

afterEach(() => {
  vi.useRealTimers();
});

describe('scheduleChunk', () => {
  it('leads the first chunk, keeps the rest contiguous and re-leads after an underrun', () => {
    const first = scheduleChunk({ now: 10, nextStart: 0, duration: 0.1 });
    expect(first.at).toBeCloseTo(10 + LEAD_SEC);
    const second = scheduleChunk({ now: 10.02, nextStart: first.nextStart, duration: 0.1 });
    expect(second.at).toBe(first.nextStart);
    const late = scheduleChunk({ now: 20, nextStart: second.nextStart, duration: 0.1 });
    expect(late.at).toBeCloseTo(20 + LEAD_SEC);
    expect(late.nextStart).toBeCloseTo(20.16);
  });
});

describe('fromPcm16', () => {
  it('decodes little-endian PCM16 and ignores a trailing odd byte', () => {
    const bytes = new Uint8Array([0x00, 0x80, 0xff, 0x7f, 0x00, 0x40, 0x12]);
    const out = fromPcm16(bytes.buffer);
    expect(out).toHaveLength(3);
    expect(out[0]).toBe(-1);
    expect(out[1]).toBe(1);
    expect(out[2]).toBeCloseTo(0.5, 3);
  });
});

describe('createPlayer', () => {
  it('plays chunks back to back with durations of samples / 24000', () => {
    const { context, sources, analyser, gain } = fakeContext();
    const player = createPlayer(context);
    expect(analyser.connect).toHaveBeenCalledWith(gain);
    expect(gain.connect).toHaveBeenCalledWith(context.destination);

    player.enqueue(chunk(2400)); // 100 ms
    player.enqueue(chunk(1200)); // 50 ms
    player.enqueue(chunk(480)); // 20 ms
    const starts = sources.map((s) => s.at);
    expect(starts[0]).toBeCloseTo(1 + LEAD_SEC);
    expect(starts[1]).toBeCloseTo(starts[0] + 0.1);
    expect(starts[2]).toBeCloseTo(starts[1] + 0.05);
    expect(sources.map((s) => s.buffer.duration)).toEqual([0.1, 0.05, 0.02]);
    expect(sources[0].buffer.sampleRate).toBe(24000);
    expect(sources[0].buffer.getChannelData(0)[0]).toBeCloseTo(1000 / 32767);
    expect(sources.every((s) => s.connect.mock.calls[0][0] === analyser)).toBe(true);
  });

  it('ignores empty chunks', () => {
    const { context, sources } = fakeContext();
    createPlayer(context).enqueue(new ArrayBuffer(1));
    expect(sources).toHaveLength(0);
  });

  it('stop() stops every source and resets the schedule', () => {
    const { context, sources } = fakeContext();
    const onSpeaking = vi.fn();
    const player = createPlayer(context, { onSpeaking });
    player.enqueue(chunk(2400));
    player.enqueue(chunk(2400));
    player.stop();
    expect(sources.every((s) => s.stop.mock.calls.length === 1 && s.onended === null)).toBe(true);
    expect(player.speaking).toBe(false);
    expect(onSpeaking.mock.calls).toEqual([[true], [false]]);

    context.currentTime = 1.01; // the old queue would have run to 1.26
    player.enqueue(chunk(2400));
    expect(sources[2].at).toBeCloseTo(1.01 + LEAD_SEC);
  });

  it('reports speaking transitions and level, with a hangover over short gaps', () => {
    vi.useFakeTimers();
    const { context, sources } = fakeContext();
    const onSpeaking = vi.fn();
    const player = createPlayer(context, { onSpeaking });
    expect(player.level()).toBe(0);

    player.enqueue(chunk(2400));
    player.enqueue(chunk(2400));
    expect(onSpeaking.mock.calls).toEqual([[true]]);
    expect(player.speaking).toBe(true);
    expect(player.level()).toBeCloseTo(0.5);

    sources[0].onended();
    expect(player.speaking).toBe(true);
    sources[1].onended();
    expect(player.speaking).toBe(false); // nothing queued: barge-in cannot fire on silence
    expect(player.level()).toBe(0);
    vi.advanceTimersByTime(HANGOVER_MS - 1);
    player.enqueue(chunk(2400)); // a short underrun (network jitter, tool gap): no flicker
    vi.advanceTimersByTime(HANGOVER_MS);
    expect(onSpeaking.mock.calls).toEqual([[true]]);

    sources[2].onended();
    vi.advanceTimersByTime(HANGOVER_MS);
    expect(onSpeaking.mock.calls).toEqual([[true], [false]]);

    player.enqueue(chunk(2400)); // first chunk after silence
    expect(onSpeaking.mock.calls).toEqual([[true], [false], [true]]);
  });

  it('stop() reports not speaking at once and cancels a pending hangover', () => {
    vi.useFakeTimers();
    const { context, sources } = fakeContext();
    const onSpeaking = vi.fn();
    const player = createPlayer(context, { onSpeaking });
    player.enqueue(chunk(2400));
    sources[0].onended();
    player.stop();
    expect(onSpeaking.mock.calls).toEqual([[true], [false]]);
    vi.advanceTimersByTime(HANGOVER_MS);
    expect(onSpeaking.mock.calls).toEqual([[true], [false]]);
  });

  it('duck() lowers the volume without stopping, and restores it when no interruption follows', () => {
    vi.useFakeTimers();
    const { context, sources, gain } = fakeContext();
    const player = createPlayer(context);
    player.enqueue(chunk(2400));
    player.duck();
    expect(gain.gain.value).toBe(DUCK_GAIN);
    expect(sources[0].stop).not.toHaveBeenCalled();
    expect(player.speaking).toBe(true);

    player.enqueue(chunk(2400)); // the rest of the answer keeps coming and is scheduled
    expect(sources).toHaveLength(2);
    vi.advanceTimersByTime(DUCK_MS - 100);
    player.duck(); // the user is still talking: the wait restarts
    vi.advanceTimersByTime(DUCK_MS - 1);
    expect(gain.gain.value).toBe(DUCK_GAIN);
    vi.advanceTimersByTime(1);
    expect(gain.gain.value).toBe(1);
  });

  it('stop() after duck() (a real interruption) stops playback and resets the volume for the next answer', () => {
    vi.useFakeTimers();
    const { context, sources, gain } = fakeContext();
    const player = createPlayer(context);
    player.enqueue(chunk(2400));
    player.duck();
    player.stop();
    expect(sources[0].stop).toHaveBeenCalled();
    expect(gain.gain.value).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('createBargeIn', () => {
  it('fires only after `frames` loud frames in a row while speaking', () => {
    const bargeIn = createBargeIn({ threshold: 0.06, frames: 3 });
    expect([0.1, 0.1, 0.01, 0.1, 0.1].map((l) => bargeIn(l, true))).toEqual([
      false,
      false,
      false,
      false,
      false,
    ]);
    expect(bargeIn(0.1, true)).toBe(true);
    expect(bargeIn(0.1, true)).toBe(false); // resets after firing

    const quiet = createBargeIn();
    expect([0.5, 0.5, 0.5, 0.5].map((l) => quiet(l, false))).toEqual([false, false, false, false]);
    expect([0.5, 0.5].map((l) => quiet(l, true))).toEqual([false, false]);
    expect(quiet(0.5, false)).toBe(false);
    expect(quiet(0.5, true)).toBe(false); // the run restarted
  });
});
