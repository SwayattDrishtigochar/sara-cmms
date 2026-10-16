import { mockScripts } from '../../src/ai/mock.js';

/**
 * Scripted chat model for tests and scripts/eval.js, on top of the AI_MOCK stream in src/ai/mock.js.
 * A step is `{ thought?, text?, calls?: [{ name, args }] }` or `({ text, responses, turn }) => step`;
 * `responses` are the function responses the loop sent back for the previous step.
 */

/** Registers a script for messages matching `match` (first match wins); returns its remover. */
export const script = (match, steps) => {
  const entry = { match, steps };
  mockScripts.unshift(entry);
  return () => {
    const i = mockScripts.indexOf(entry);
    if (i !== -1) mockScripts.splice(i, 1);
  };
};

export const clearScripts = () => {
  mockScripts.length = 0;
};

/** The `result` the loop sent back for the call named `name` in a step's responses. */
export const resultOf = (responses, name) => responses.find((r) => r.name === name)?.response?.result;

/** The `ref` of the call named `name` (for render_* / export_csv sourceRef). */
export const refOf = (responses, name) => responses.find((r) => r.name === name)?.response?.ref;

/** Collects SSE events of a turn: `{ send, close, closed, events, of(type), types() }`. */
export const recorder = ({ onEvent } = {}) => {
  const events = [];
  const sse = {
    closed: false,
    send: (event, data) => {
      events.push({ event, data });
      onEvent?.(event, data);
    },
    close: () => {
      sse.closed = true;
    },
    events,
    of: (type) => events.filter((e) => e.event === type).map((e) => e.data),
    types: () => events.map((e) => e.event),
  };
  return sse;
};

/** Parses an SSE body (`event:` / `data:` frames) into `[{ event, data }]`. */
export const parseSse = (body) =>
  String(body)
    .split('\n\n')
    .filter((frame) => frame.includes('event:'))
    .map((frame) => {
      const event = /^event: (.+)$/m.exec(frame)?.[1];
      const data = /^data: (.+)$/m.exec(frame)?.[1];
      return { event, data: data ? JSON.parse(data) : null };
    });
