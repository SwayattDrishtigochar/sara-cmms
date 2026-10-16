/**
 * Server-Sent Events over a normal response (works for GET and POST; the browser reads it
 * with fetch + ReadableStream so it can send the Authorization header).
 */
export const openSse = (res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
  let closed = false;
  const write = (chunk) => {
    if (!closed && !res.writableEnded) res.write(chunk);
  };
  const ping = setInterval(() => write(': ping\n\n'), 15_000);
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(ping);
    if (!res.writableEnded) res.end();
  };
  res.on('close', close);
  return {
    send: (event, data) => write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
    close,
    get closed() {
      return closed;
    },
  };
};
