import { mockScripts, scriptFor } from './mock.js';
import { demoStep } from './mockChat.js';

/**
 * Scripted stand-in for a Gemini Live connection (AI_MOCK=true): the same messages the SDK delivers
 * (transcripts, PCM audio, tool calls, interrupted, turnComplete, usage, resumption handles) driven by
 * typed text. It cannot hear, so audio input is ignored, and it "speaks" a soft tone instead of a voice.
 */

/** Delay between emitted messages; tests set 0. */
export const mockLiveTiming = { chunkMs: 20 };

const TONE_HZ = 220;
const TONE_AMP = 0.06;
const WORD_MS = 120;
const GAP_MS = 40;
const FADE_MS = 15;
const MIN_MS = 300;
const MAX_MS = 4000;
const AUDIO_CHUNK_MS = 200;
const AUDIO_MIME = 'audio/pcm;rate=24000';

/** PCM16 LE mono: 120 ms of a soft 220 Hz sine per word with raised-cosine fades, 40 ms gaps, 0.3–4 s. */
export const toneFor = (text, { rate = 24000 } = {}) => {
  const ms = (n) => Math.round((rate * n) / 1000);
  const maxWords = Math.floor((MAX_MS + GAP_MS) / (WORD_MS + GAP_MS));
  const words = Math.min(
    maxWords,
    String(text ?? '')
      .split(/\s+/)
      .filter(Boolean).length,
  );
  const word = ms(WORD_MS);
  const gap = ms(GAP_MS);
  const fade = ms(FADE_MS);
  const total = Math.max(ms(MIN_MS), words * word + Math.max(0, words - 1) * gap);
  const pcm = Buffer.alloc(total * 2);
  for (let w = 0; w < words; w++) {
    const start = w * (word + gap);
    for (let i = 0; i < word; i++) {
      const edge = Math.min(i, word - 1 - i);
      const env = edge < fade ? 0.5 * (1 - Math.cos((Math.PI * edge) / fade)) : 1;
      const v = TONE_AMP * env * Math.sin((2 * Math.PI * TONE_HZ * i) / rate);
      pcm.writeInt16LE(Math.round(v * 32767), (start + i) * 2);
    }
  }
  return pcm;
};

const MAX_SPOKEN = 400;
/** Markdown → plain speech: no **, #, bullets, tables or links; list items become sentences; ≤ 400 chars. */
export const spoken = (markdown) => {
  const text = String(markdown ?? '')
    .replace(/```[\s\S]*?```/g, '')
    .split('\n')
    .filter((line) => !/^\s*\|/.test(line))
    .map((line) =>
      line
        .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/^\s*#{1,6}\s+/, '')
        .replace(/^\s*(?:[-*+•]|\d+[.)])\s+/, '')
        .replace(/\*\*|__|`/g, '')
        .replace(/(^|\s)[*_](\S)/g, '$1$2')
        .replace(/(\S)[*_](?=\s|$|[.,;:!?])/g, '$1')
        .replace(/\s*→\s*/g, ' to ')
        .replace(/\s+·\s+/g, ', ')
        .trim(),
    )
    .filter(Boolean)
    .map((line) => (/[.!?:;।…]$/.test(line) ? line : `${line}.`))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= MAX_SPOKEN) return text;
  const cut = text.slice(0, MAX_SPOKEN);
  const end = Math.max(...['. ', '! ', '? ', '। '].map((p) => cut.lastIndexOf(p)));
  if (end > MAX_SPOKEN / 2) return cut.slice(0, end + 1);
  return `${cut.slice(0, cut.lastIndexOf(' ', MAX_SPOKEN - 1))}…`;
};

// ---------- reading the utterance

const DEVANAGARI = /[ऀ-ॿ]/;
/**
 * The whole utterance is a short answer ("yes", "Yes, go ahead", "नहीं, रहने दो"): answer words and a few
 * fillers, nothing else. "ok, how many machines are running?" is a question, not a yes.
 * Separators instead of \b: \b does not work next to Devanagari letters and marks.
 */
const FILLERS = ['please', 'ji', 'जी', 'sara', 'it', 'that', 'now', 'then'];
const answerOnly = (words, tail = []) => {
  const any = [...words, ...tail, ...FILLERS].join('|');
  return new RegExp(`^\\s*(?:${words.join('|')})(?:[\\s,]+(?:${any}))*\\s*[.!।]*\\s*$`, 'iu');
};
const YES = answerOnly([
  'yes',
  'yeah',
  'yep',
  'sure',
  'ok',
  'okay',
  'go ahead',
  'do it',
  'confirm',
  'haan ji',
  'haan',
  'हाँ',
  'हां',
  'जी',
  'ठीक है',
  'kar do',
  'कर दो',
]);
const NO = answerOnly(
  ['no', 'nope', 'cancel', "don't", 'don’t', 'stop', 'nahi', 'नहीं', 'मत'],
  ['do it', 'do that', 'rehne do', 'रहने दो', 'करो'],
);
const PENDING_LINE = /A change is waiting for the user's answer: "(.*?)" \(actionId ([^)\s]+)\)/;
const APP_NOTE = /^App note:/;
const ASSET = /\b(imm|cnc|press|compressor|chiller|furnace)[\s-]?0?(\d{1,2})\b/i;
const assetIn = (text) => {
  const m = ASSET.exec(text);
  if (!m) return null;
  const type =
    m[1].length <= 3 ? m[1].toUpperCase() : `${m[1][0].toUpperCase()}${m[1].slice(1).toLowerCase()}`;
  return `${type} ${Number(m[2])}`;
};
const call = (name, args = {}) => ({ name, args });
const list = (items, and = 'and') =>
  items.length > 1 ? `${items.slice(0, -1).join(', ')} ${and} ${items.at(-1)}` : (items[0] ?? '');
const round = (n) => Number(Number(n).toFixed(1));

/** This turn's tool calls with their responses (history = model calls / user responses, chat-shaped). */
const callsOf = (history) => {
  const calls = [];
  for (const c of history) {
    for (const p of c.parts ?? []) {
      if (p.functionCall) calls.push({ ...p.functionCall });
      if (p.functionResponse) {
        const made = calls.find((x) => x.id === p.functionResponse.id);
        if (made) made.response = p.functionResponse.response ?? {};
      }
    }
  }
  return calls;
};

const scriptOf = (text) =>
  mockScripts.find((x) => (typeof x.match === 'function' ? x.match(text) : x.match.test(text)));

const stateOf = (text, history, system) => {
  const calls = callsOf(history);
  const last = (name) => calls.findLast((c) => c.name === name)?.response ?? null;
  return {
    text,
    scripted: Boolean(scriptOf(text)),
    t: text.toLowerCase(),
    hindi: DEVANAGARI.test(text),
    calls,
    system,
    has: (name) => calls.some((c) => c.name === name),
    last,
    result: (name) => last(name)?.result ?? null,
    callId: (name) => calls.findLast((c) => c.name === name)?.id ?? null,
  };
};

// ---------- voice flows

const RUNNING = new Set(['Running', 'ON']);
const TONE = { Running: 'good', ON: 'good', Idle: 'warning', Stopped: 'bad', OFF: 'bad' };
const EN_STATE = { Idle: 'idle', Stopped: 'stopped', OFF: 'switched off', Maintenance: 'in maintenance' };
const HI_STATE = { Idle: 'idle हैं', Stopped: 'बंद हैं', OFF: 'बंद हैं', Maintenance: 'maintenance में हैं' };

const machinesRunning = (s) => {
  if (!s.has('mongo_aggregate')) {
    return {
      calls: [
        call('mongo_aggregate', {
          module: 'assets',
          pipeline: [{ $group: { _id: '$assetStatus', count: { $sum: 1 } } }, { $sort: { count: -1 } }],
        }),
      ],
    };
  }
  const rows = (s.result('mongo_aggregate')?.rows ?? []).filter((r) => r && typeof r === 'object');
  if (rows.length && !s.has('render_kpis')) {
    return {
      calls: [
        call('render_kpis', {
          items: rows.slice(0, 8).map((r) => ({
            label: String(r._id ?? 'Unknown'),
            value: r.count,
            tone: TONE[r._id] ?? 'neutral',
          })),
        }),
      ],
    };
  }
  const total = rows.reduce((n, r) => n + (r.count ?? 0), 0);
  const running = rows.filter((r) => RUNNING.has(r._id)).reduce((n, r) => n + r.count, 0);
  const rest = rows.filter((r) => !RUNNING.has(r._id));
  if (s.hindi) {
    const others = rest.map((r) => `${r.count} ${HI_STATE[r._id] ?? `${r._id ?? 'unknown'} हैं`}`);
    return {
      text: `अभी ${total} में से ${running} मशीनें चल रही हैं${others.length ? `; ${list(others, 'और')}` : ''}। मैंने गिनती स्क्रीन पर दिखा दी है।`,
    };
  }
  if (!total) return { text: "I couldn't find any machines in this plant." };
  const others = rest.map(
    (r) =>
      `${r.count} ${r.count === 1 ? 'is' : 'are'} ${EN_STATE[r._id] ?? String(r._id ?? 'unknown').toLowerCase()}`,
  );
  return {
    text: `${running} of your ${total} machines are running right now${others.length ? `; ${list(others)}` : ''}. I've put the numbers on your screen.`,
  };
};

/** "How many open work orders?": work_orders_summary by priority → KPI tiles → one spoken sentence. */
const workOrderCount = (s) => {
  const scope = /overdue/.test(s.t) ? 'overdue' : 'open';
  if (!s.has('work_orders_summary')) {
    return { calls: [call('work_orders_summary', { groupBy: 'priority', scope })] };
  }
  const r = s.result('work_orders_summary') ?? {};
  const rows = r.rows ?? [];
  if (rows.length && !s.has('render_kpis')) {
    return {
      calls: [
        call('render_kpis', {
          items: rows.slice(0, 6).map((row) => ({
            label: String(row.priority ?? 'None'),
            value: row.count,
            ...(row.overdue ? { delta: `${row.overdue} overdue`, tone: 'warning' } : {}),
          })),
        }),
      ],
    };
  }
  const total = r.total ?? 0;
  const high = rows.reduce((n, row) => n + (row.highPriority ?? 0), 0);
  const overdue = rows.reduce((n, row) => n + (row.overdue ?? 0), 0);
  if (s.hindi) {
    return {
      text: total
        ? `आपके ${total} ${scope} work orders हैं; ${high} high priority हैं और ${overdue} overdue हैं। पूरी गिनती स्क्रीन पर है।`
        : `अभी कोई ${scope} work order नहीं है।`,
    };
  }
  if (!total) return { text: `You have no ${scope} work orders.` };
  const extra = [high && `${high} high priority`, scope === 'open' && overdue && `${overdue} overdue`].filter(
    Boolean,
  );
  return {
    text: `You have ${total} ${scope} work order${total === 1 ? '' : 's'}${extra.length ? `: ${list(extra)}` : ''}. I've put the breakdown on your screen.`,
  };
};

const HI_FIELDS = [
  [/vibrat|वाइब्रेशन|कंपन/i, /vibrat/i, 'वाइब्रेशन'],
  [/temp|तापमान/i, /temp/i, 'तापमान'],
  [/pressure|दबाव|प्रेशर/i, /pressure/i, 'प्रेशर'],
  [/current|करंट/i, /current/i, 'करंट'],
];
const HI_STATUS = {
  Running: 'चल रही है',
  ON: 'चालू है',
  Idle: 'idle है',
  Stopped: 'बंद है',
  OFF: 'बंद है',
  Maintenance: 'maintenance में है',
};
const META = new Set(['asset', 'assetId', 'type', 'status', 'statusSince', 'asOf']);

/** "IMM 3 का vibration कैसा है?": resolve → telemetry_latest → a Hindi answer from the live reading. */
const machineInHindi = (s) => {
  const name = assetIn(s.text);
  if (!s.has('resolve')) return { calls: [call('resolve', { kind: 'asset', query: name })] };
  const match = s.result('resolve')?.matches?.[0];
  if (!match) return { text: `मुझे "${name}" नाम की मशीन नहीं मिली। कृपया नाम दोबारा बताइए।` };
  if (!s.has('telemetry_latest')) return { calls: [call('telemetry_latest', { assetIds: [match.id] })] };
  const row = s.result('telemetry_latest')?.rows?.[0] ?? {};
  const status = HI_STATUS[row.status] ?? (row.status ? `${row.status} है` : 'की स्थिति अभी पता नहीं है');
  const [, fieldRe, word] = HI_FIELDS.find(([asked]) => asked.test(s.text)) ?? [null, null, null];
  const numeric = Object.entries(row).filter(([k, v]) => !META.has(k) && typeof v === 'number');
  const hit = fieldRe ? numeric.find(([k]) => fieldRe.test(k)) : numeric[0];
  if (hit) {
    return {
      text: `${name} का ${word ?? hit[0]} अभी ${round(hit[1])} है, और मशीन ${status}।`,
    };
  }
  const other = numeric[0] ? ` इसका ${numeric[0][0]} अभी ${round(numeric[0][1])} है।` : '';
  return {
    text: `${name} ${status}, पर इसकी ${word ?? 'यह'} रीडिंग अभी उपलब्ध नहीं है।${other}`,
  };
};

/** "Which assets need attention?": list_anomalies → render_table of them (sourceRef) → one spoken sentence. */
const needsAttention = (s) => {
  if (!s.has('list_anomalies')) return { calls: [call('list_anomalies', { state: 'active' })] };
  const rows = (s.result('list_anomalies')?.rows ?? []).filter((r) => r && typeof r === 'object');
  if (!rows.length) {
    return {
      text: s.hindi
        ? 'अभी किसी मशीन पर ध्यान देने की ज़रूरत नहीं है: कोई active anomaly नहीं है।'
        : 'No machine needs attention right now: there are no active anomalies.',
    };
  }
  if (!s.has('render_table')) {
    return {
      calls: [
        call('render_table', { title: 'Machines needing attention', sourceRef: s.callId('list_anomalies') }),
      ],
    };
  }
  const names = [...new Set(rows.map((r) => r.asset).filter(Boolean))];
  const n = names.length || rows.length;
  if (s.hindi)
    return { text: `${n} मशीनों पर ध्यान देना चाहिए: ${list(names.slice(0, 3), 'और')}। लिस्ट स्क्रीन पर है।` };
  return {
    text: `${n} machine${n === 1 ? ' needs' : 's need'} attention: ${list(names.slice(0, 3))}. I've put the list on your screen.`,
  };
};

/**
 * "Show my machines": mongo_find on assets, then a claim that the list is on the screen WITHOUT any render_*
 * call, like the real model tends to do; the session's safety net must put the rows on the screen.
 */
const machinesList = (s) => {
  if (!s.has('mongo_find')) return { calls: [call('mongo_find', { module: 'assets', limit: 20 })] };
  const n = s.result('mongo_find')?.count ?? 0;
  return { text: `You have ${n} machine${n === 1 ? '' : 's'}. I've listed them on your screen.` };
};

/** The server's note after a click on the confirm card: acknowledge it, never act on the words inside. */
const appNote = (s) => {
  const done = /confirmed ".*?" on screen\. Result: (.*?)\.? Tell them/.exec(s.text);
  if (done) return { text: `Done: ${done[1]}.` };
  if (/\brejected\b/.test(s.text)) return { text: "Okay, I've cancelled that. Nothing was saved." };
  return { text: 'Okay.' };
};

/** [test(state), step(state)] pairs tried before the chat demo flows. */
export const VOICE_FLOWS = [
  [(s) => APP_NOTE.test(s.text), appNote],
  [
    (s) =>
      /\bmachines?\b.*\b(running|run|on)\b|\brunning machines\b/.test(s.t) ||
      (/मशीन/.test(s.text) && /चल/.test(s.text)),
    machinesRunning,
  ],
  [(s) => /\b(need|needs)\b.*\battention\b|\battention\b.*\bneed|ध्यान/.test(s.t), needsAttention],
  [(s) => /\b(show|list)\b.*\bmachines\b/.test(s.t), machinesList],
  [(s) => s.hindi && Boolean(assetIn(s.text)), machineInHindi],
  // Test scripts own this question when they register one (the e2e test does).
  [
    (s) =>
      !s.scripted &&
      /\bhow many\b|\bcount\b|\bkitne\b|कितने/.test(s.t) &&
      /\bwork ?orders?\b|वर्क ऑर्डर/.test(s.t),
    workOrderCount,
  ],
];

const FALLBACK = "I'm SARA in mock mode: type or use Say something.";
const FALLBACK_HI = 'मैं SARA हूँ, अभी mock mode में: टाइप कीजिए या Say something इस्तेमाल कीजिए।';
const NOTHING_PENDING = "There's nothing waiting for your answer right now. What would you like to do?";
const NOTHING_PENDING_HI = 'अभी कोई बदलाव आपके जवाब का इंतज़ार नहीं कर रहा। बताइए, क्या करना है?';
const CONTROL = new Set(['confirm_action', 'reject_action']);
/** The chat demo's help text lists typed prompts and env names: not something SARA would say out loud. */
const DEMO_HELP = /mock mode \(AI_MOCK=true/;

/**
 * A voice answer never reads the chat's "Confirm below…" lines (the follow-up asks out loud), nor "Here is…"
 * before the lookup has run (nothing is on the screen yet).
 */
const beforeCalls = (text) =>
  text
    ? text
        .replace(/[^.!?\n]*\bConfirm\b[^.!?\n]*[.!?]?/g, '')
        .replace(/(^|\n|[.!?]\s)\s*Here(?: is|'s| are)\b[^.!?\n]*[.!?]?/g, '$1')
    : '';

/** A tool refusal as SARA would say it: no tool names or role codes. */
const plainError = (error) => {
  const text = String(error ?? '');
  if (/is not available to .*\(role [^)]+\)/.test(text))
    return "your role doesn't allow that. A manager or an admin can do it, or I can note the details for them";
  return text.replace(/[.!?]+$/, '');
};

/** What SARA says when confirm_action / reject_action did not go through. */
const controlFailed = (r) => {
  if (r.status === 'gone')
    return /expired/i.test(r.error ?? '')
      ? 'That change expired before you answered, so nothing was saved. Ask me again if you still need it.'
      : 'That change was already handled, so there is nothing left to confirm.';
  if (r.status === 'forbidden') return "You're not allowed to make that change, so I didn't save it.";
  if (r.status === 'failed') return `I couldn't make that change: ${plainError(r.error)}.`;
  return r.error ?? 'That change could not be made.';
};

const doneText = (r) => {
  const code = r.result?.created?.[0]?.label?.split(' · ')[0];
  const summary = String(r.summary ?? 'the change is saved').replace(/[.!?]+$/, '');
  return `Done: ${summary}${code && !summary.includes(code) ? `, ${code}` : ''}.`;
};

const createSession = ({ config = {}, callbacks = {} }) => {
  const system = typeof config.systemInstruction === 'string' ? config.systemInstruction : '';
  const tools = config.tools ?? [];
  const fromPrompt = PENDING_LINE.exec(system);
  let action = fromPrompt ? { label: fromPrompt[1], actionId: fromPrompt[2] } : null;
  let closed = false;
  let busy = false;
  let gen = 0;
  let callNo = 0;
  let handleNo = 0;
  let waiting = null;

  const deliver = (msg) => {
    if (!closed) callbacks.onmessage?.(msg);
  };
  setTimeout(() => deliver({ setupComplete: {} }), 0);
  /** Emits after the pacing delay unless the turn was superseded or the session closed. */
  const emit = async (msg, g) => {
    await new Promise((r) => setTimeout(r, mockLiveTiming.chunkMs));
    if (closed || g !== gen) return false;
    deliver(msg);
    return true;
  };

  /** Transcript in ≤ 3 chunks interleaved with ≤ 200 ms tone chunks; `lead` = something was said before. */
  const speak = async (speech, g, lead = false) => {
    if (!speech) return true;
    const words = (lead ? ` ${speech}` : speech).split(/(?<=\s)/);
    const size = Math.ceil(words.length / 3);
    const groups = [];
    for (let i = 0; i < words.length; i += size) groups.push(words.slice(i, i + size).join(''));
    const audio = toneFor(speech);
    const step = Math.round((24000 * AUDIO_CHUNK_MS) / 1000) * 2;
    const chunks = [];
    for (let i = 0; i < audio.length; i += step) chunks.push(audio.subarray(i, i + step));
    const per = Math.ceil(chunks.length / groups.length);
    for (const [i, text] of groups.entries()) {
      if (!(await emit({ serverContent: { outputTranscription: { text } } }, g))) return false;
      for (const chunk of chunks.slice(i * per, (i + 1) * per)) {
        const part = { inlineData: { mimeType: AUDIO_MIME, data: chunk.toString('base64') } };
        if (!(await emit({ serverContent: { modelTurn: { parts: [part] } } }, g))) return false;
      }
    }
    return true;
  };

  const finish = async (g, { promptChars, speech }) => {
    const promptTokenCount = Math.ceil(promptChars / 4);
    const responseTokenCount = Math.ceil(speech.length / 4);
    const end = [
      { serverContent: { generationComplete: true } },
      {
        usageMetadata: {
          promptTokenCount,
          responseTokenCount,
          totalTokenCount: promptTokenCount + responseTokenCount,
        },
      },
      { serverContent: { turnComplete: true } },
      { sessionResumptionUpdate: { newHandle: `mock-${++handleNo}`, resumable: true } },
    ];
    for (const msg of end) if (!(await emit(msg, g))) return;
  };

  /** The next model step of this turn, in the order of the contract (§3.7). */
  const nextStep = (text, history) => {
    const turn = history.filter((c) => c.role === 'model').length;
    const last = history.at(-1)?.role === 'user' ? history.at(-1).parts.map((p) => p.functionResponse) : [];
    const awaiting = last.find((r) => r.response?.status === 'awaiting_confirmation');
    if (awaiting) {
      const label = String(awaiting.response.label ?? 'This change').replace(/[.!?]+$/, '');
      action = { actionId: awaiting.response.actionId, label };
      return { text: `${label}. Shall I go ahead?` };
    }
    const control = last.find((r) => CONTROL.has(r.name));
    if (control) {
      const r = control.response ?? {};
      if (r.status) action = null;
      if (r.status === 'confirmed') return { text: doneText(r) };
      if (r.status === 'rejected') return { text: "Okay, I won't make that change." };
      return { text: controlFailed(r) };
    }
    const answer = YES.test(text) ? 'confirm_action' : NO.test(text) ? 'reject_action' : null;
    if (answer && turn === 0) {
      if (action) return { calls: [call(answer, { actionId: action.actionId })] };
      // A bare "yes" / "no" with nothing pending: say so instead of guessing what it answers.
      return { text: DEVANAGARI.test(text) ? NOTHING_PENDING_HI : NOTHING_PENDING };
    }
    const s = stateOf(text, history, system);
    const flow = VOICE_FLOWS.find(([test]) => test(s));
    const failed = last.find((r) => r.response?.error)?.response;
    if (flow && failed) return { text: `I couldn't finish that: ${plainError(failed.error)}.` };
    if (flow) return flow[1](s);
    const resolve = (raw) => (typeof raw === 'function' ? raw({ text, responses: last, turn, tools }) : raw);
    if (s.scripted) return resolve(scriptFor(text, tools)[turn] ?? { text: 'That is everything I found.' });
    const demo = demoStep({ text, history, system });
    if (demo && !(DEMO_HELP.test(demo.text ?? '') && !demo.calls?.length)) return demo;
    if (demo) return { text: s.hindi ? FALLBACK_HI : FALLBACK };
    const raw = scriptFor(text, tools)[turn];
    if (!raw || (turn === 0 && !raw.calls)) return { text: s.hindi ? FALLBACK_HI : FALLBACK };
    return resolve(raw);
  };

  const runTurn = async (text, g) => {
    busy = true;
    const history = [];
    let said = false;
    let promptChars = system.length + text.length;
    // A runaway script must not loop forever: the session's tool budget answers errors long before this.
    for (let i = 0; i < 20; i++) {
      const step = nextStep(text, history) ?? {};
      if (!step.calls?.length) {
        const speech = spoken(step.text ?? '');
        if (await speak(speech, g, said)) await finish(g, { promptChars, speech });
        break;
      }
      const before = spoken(beforeCalls(step.text));
      if (!(await speak(before, g, said))) break;
      said ||= Boolean(before);
      const calls = step.calls.map((c) => ({ id: `mock-fc-${++callNo}`, name: c.name, args: c.args ?? {} }));
      history.push({ role: 'model', parts: calls.map((c) => ({ functionCall: c })) });
      const answered = new Promise((resolve) => {
        waiting = { ids: calls.map((c) => c.id), got: new Map(), resolve };
      });
      if (!(await emit({ toolCall: { functionCalls: calls } }, g))) break;
      const responses = await answered;
      if (!responses || closed || g !== gen) break;
      history.push({ role: 'user', parts: responses.map((r) => ({ functionResponse: r })) });
      promptChars += JSON.stringify(responses).length;
    }
    if (g === gen) busy = false;
  };

  return {
    sendRealtimeInput: (input = {}) => {
      if (closed || typeof input.text !== 'string') return; // audio / audioStreamEnd: the mock cannot hear
      const text = input.text.trim();
      gen += 1;
      if (busy) {
        waiting?.resolve(null);
        deliver({ serverContent: { interrupted: true } });
        deliver({ serverContent: { turnComplete: true } });
      }
      waiting = null;
      if (APP_NOTE.test(text)) action = null;
      const g = gen;
      runTurn(text, g).catch(async () => {
        // A broken script or flow must never take the server down: say so and end the turn.
        const speech = 'Sorry, something went wrong in mock mode. Please try again.';
        if (await speak(speech, g)) await finish(g, { promptChars: text.length, speech });
        if (g === gen) busy = false;
      });
    },
    sendClientContent: () => {},
    sendToolResponse: ({ functionResponses = [] } = {}) => {
      if (!waiting) return;
      for (const r of functionResponses) if (waiting.ids.includes(r.id)) waiting.got.set(r.id, r);
      if (waiting.got.size < waiting.ids.length) return;
      const { ids, got, resolve } = waiting;
      waiting = null;
      resolve(ids.map((id) => got.get(id)));
    },
    close: () => {
      if (closed) return;
      closed = true;
      waiting?.resolve(null);
      waiting = null;
      setTimeout(() => callbacks.onclose?.({ code: 1000, reason: '' }), 0);
    },
  };
};

/** LiveClientLike for AI_MOCK=true: scripted turns over the real tools; audio input ignored; a soft tone as speech. */
export const mockLive = {
  connect: async ({ config, callbacks } = {}) => {
    await new Promise((r) => setTimeout(r, 0));
    return createSession({ config, callbacks });
  },
};
