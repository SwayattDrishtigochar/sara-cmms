import { ApiError, apiUrl, getToken } from './client.js';

const parse = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

/**
 * Reads a Server-Sent Events response with fetch (so it can send the bearer token and a body) and calls
 * `onEvent(type, data)` per frame, with `data` parsed as JSON when possible. Resolves when the server ends
 * the stream; throws ApiError on a non-2xx status and an AbortError when `signal` aborts.
 */
export const streamSse = async (path, { method = 'GET', body, signal, onEvent } = {}) => {
  const token = getToken();
  const res = await fetch(apiUrl(path), {
    method,
    signal,
    headers: {
      accept: 'text/event-stream',
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new ApiError(res.status, await res.json().catch(() => null));

  let type = '';
  let data = [];
  const readLine = (line) => {
    if (line === '') {
      if (data.length) onEvent?.(type || 'message', parse(data.join('\n')));
      type = '';
      data = [];
      return;
    }
    if (line.startsWith(':')) return; // comment, e.g. the keep-alive ping
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'event') type = value;
    else if (field === 'data') data.push(value);
  };

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return; // a frame without its closing blank line is dropped, as the SSE spec says
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) readLine(line.endsWith('\r') ? line.slice(0, -1) : line);
    }
  } finally {
    reader.cancel().catch(() => {});
  }
};
