import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './client.js';
import { streamSse } from './sse.js';

const bytes = (text) => new TextEncoder().encode(text);

/** A response body that delivers the given chunks (strings or byte arrays) one read at a time. */
const bodyOf = (chunks) =>
  new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(typeof chunk === 'string' ? bytes(chunk) : chunk);
      controller.close();
    },
  });

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('streamSse', () => {
  it('parses frames split across chunks, skips pings and drops an unfinished frame', async () => {
    localStorage.setItem('token', 'tok-1');
    const unit = bytes('event: telemetry\ndata: {"unit":"°C"}\n\n');
    const cut = unit.indexOf(0xb0); // split inside the two-byte "°"
    const fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      body: bodyOf([
        'event: hello\nda',
        'ta: {"serverTime":1}\n',
        '\n: ping\n\nevent: status\ndata: {"assetId":"a","sta',
        'tus":"Running"}\r\n\r\n',
        unit.slice(0, cut),
        unit.slice(cut),
        'data: two\ndata: lines\n\n',
        'event: partial\ndata: {"never":true}',
      ]),
    }));
    vi.stubGlobal('fetch', fetch);

    const events = [];
    await streamSse('/live', { onEvent: (type, data) => events.push([type, data]) });

    expect(events).toEqual([
      ['hello', { serverTime: 1 }],
      ['status', { assetId: 'a', status: 'Running' }],
      ['telemetry', { unit: '°C' }],
      ['message', 'two\nlines'],
    ]);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('/api/live');
    expect(init.headers.authorization).toBe('Bearer tok-1');
  });

  it('sends a JSON body and throws ApiError with the server message on a non-2xx status', async () => {
    const fetch = vi.fn(async () => ({
      ok: false,
      status: 403,
      json: async () => ({ error: { message: 'Not allowed', code: 'forbidden' } }),
    }));
    vi.stubGlobal('fetch', fetch);

    const call = streamSse('/chat', { method: 'POST', body: { text: 'hi' }, onEvent: () => {} });
    await expect(call).rejects.toBeInstanceOf(ApiError);
    await expect(call).rejects.toMatchObject({ status: 403, message: 'Not allowed' });
    expect(fetch.mock.calls[0][1]).toMatchObject({ method: 'POST', body: '{"text":"hi"}' });
  });
});
