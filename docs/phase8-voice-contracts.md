# Phase 8 contracts — SARA voice assistant (Gemini Live)

Builds on phase 3 (`docs/phase3-contracts.md` §1: settings, budget, models, mock) and phase 4 (`docs/phase4-contracts.md`:
tools, pending actions, history, chat SSE). Same conventions: ESM, arrow functions, zod 4, `lib/errors.js`, Biome
(`pnpm lint`), server tests `SARA_TEST_DB=<label> npx vitest run --maxWorkers=2 <files>` (labels `p8voice`, `p8mock`,
`p8int`; never `sara`, `cmms_*`, `admin`, `local`, `config`, `test`), client tests `pnpm --filter client test`.
`AI_MOCK=true` everywhere: **zero real Gemini calls, Live included** (`test/helpers/setup.js` forces it; tests inject
fakes). Never start servers on 5080/5173, never print the Gemini key, JWTs or connection strings, no git commits. The only
dependency change is promoting `ws` (already in the tree) to a direct server dependency (§1.1).

User requirement (verbatim): "add a voice assistant that will listen and work in realtime by sara voice ai. this voice ai
will talk to user. make sure the voice of sara ai must be a female voice assistant and support multi language audio. By
voice any work can be done like by chat. you can only use gemini api's"

## 0. Decisions and verified facts

### 0.1 Decisions

| # | Decision | Why |
|---|---|---|
| D1 | Speech in and out only through the **Gemini Live API** (`ai.live.connect`, native-audio model, `responseModalities: ['AUDIO']`); captions from Live's own `inputAudioTranscription` / `outputAudioTranscription`. No browser SpeechRecognition / speechSynthesis, no other STT/TTS. | "only Gemini APIs" |
| D2 | **Server proxy**: browser ⇄ `wss://<host>/api/voice` ⇄ SARA server ⇄ one Gemini Live connection per voice session, opened by the server. | Key never leaves the server; tool calls run server-side with the user's `ctx`, permissions, audit and pending actions; `usageMetadata` reaches the budget ledger; the mock plugs in at one point; tenancy is the chat's. |
| D3 | Rejected: ephemeral tokens + browser-direct Live. SDK 2.30 has `ai.authTokens.create` (v1alpha only, `BidiGenerateContentConstrained`, `uses` default 1, `expireTime` default 30 min, `newSessionExpireTime` default 60 s, `liveConnectConstraints` + `lockAdditionalFields` pin model/config). | Tool calls would land in the browser and need a REST relay the server cannot tie to a real model call; `usageMetadata` never reaches the server (no budget, no per-session usage); prompt and tools would have to be locked into every token; the mock would need a second, browser-side implementation. The proxy costs ~32 KB/s up + ~48 KB/s down per session. |
| D4 | **Auth = the user's JWT in the first message** (`start.token`, the bearer the SPA already sends to REST), Origin allow-list on the upgrade, 5 s deadline. No cookies, nothing in the URL, no ticket route. | A ticket only helps when auth must ride in the URL; here the first frame carries it. |
| D5 | **Tools = every permitted group at connect**: `toolsFor(ctx, groupsFor(ctx))` minus `load_tools`, plus voice-only `confirm_action` / `reject_action`. Today 40 + 2 = **42 declarations, ≈ 31.6k chars ≈ 8k tokens** (measured offline from the registry). | Live fixes `tools` at setup; the router needs an utterance that does not exist at connect, and reconnecting to swap tools costs ~1 s mid-conversation. 42 is far below Gemini's per-request function-declaration limit (documented as 128; re-check when this grows); a test keeps voice ≤ 64 (`MAX_VOICE_TOOLS`). Permissions are the chat's (`toolsFor` filter + runtime re-check). |
| D6 | **Writes keep chat's pending-action rule.** Server previews, stores the pending action, shows the confirm card and answers the model `awaiting_confirmation`; the user confirms by click or by voice (`confirm_action { actionId }`); the server accepts only the session's latest pending action, from a later turn. | §3.4 |
| D7 | **Persistence**: each voice turn = one user + one assistant `ai_messages` doc, chat-shaped (`parts` for the UI, replayable `gemini` contents), `channel: 'voice'`; conversation `voice: true`. | Shows in Chat history; text chat can continue it; `claimPendingAction`, `rejectPendingAction`, `expirePendingActions`, `buildContents` work unchanged. |
| D8 | **Audio**: in PCM16 LE mono 16 kHz, 40 ms frames (1280 B); out PCM16 LE mono 24 kHz, forwarded as received; raw binary WS frames both ways (no base64 to the browser). Audio is never stored. | Live formats |
| D9 | **Female voice only**: `voiceName` ∈ the 14 female prebuilt voices (§2.3), default **Kore**; per-user pick in the panel. | requirement |
| D10 | **Languages**: `auto` (default; native-audio models detect the language and answer in it, Hinglish included) or one fixed language enforced by the system instruction (`RESPOND IN HINDI. YOU MUST RESPOND UNMISTAKABLY IN HINDI…`). `speechConfig.languageCode` is never set. | Native-audio models pick the language themselves; the instruction works on every Live model. |
| D11 | **Models**: `GEMINI_MODEL_VOICE=gemini-3.1-flash-live-preview`, `GEMINI_FALLBACK_VOICE=gemini-2.5-flash-native-audio-preview-12-2025`, **not verified** (§0.2). Superadmin picks from the live `bidiGenerateContent` list. No `thinkingConfig` (latency; models default to minimal thinking). | |

### 0.2 Verified on 2026-10-17

- **Model list**: the one free `models.list` request (key read from `sara/.env` with `process.loadEnvFile`, sent in
  `x-goog-api-key`) returned **HTTP 401 UNAUTHENTICATED "API key not valid"**. Not retried. The ids in D11 are the
  best-known Live ids, not a listing. With a working key and `AI_MOCK=false`, `GET /api/voice/models` (§5) lists the real
  Live models (`supportedActions` ∋ `bidiGenerateContent`) and Superadmin → AI → Voice selects them; no code depends on
  the exact id.
- **SDK `@google/genai@2.30.0`** (`node_modules/.pnpm/@google+genai@2.30.0/node_modules/@google/genai/dist/node/`;
  `node.d.ts` types, `index.mjs` code):
  - `ai.live.connect({ model, config, callbacks })` (d.ts:10659, code index.mjs:14589) dials
    `…/GenerativeService.BidiGenerateContent?key=<API key>` (index.mjs:14683: **never log that URL**) and resolves only
    after `setupComplete` (index.mjs:14780). A failing setup (bad model, config or key) closes the socket and the promise
    **never settles** → always race it against `onclose`/`onerror` and a timeout.
  - `LiveConnectConfig` (d.ts:10874): `responseModalities`, `speechConfig { voiceConfig.prebuiltVoiceConfig.voiceName,
    languageCode }` (d.ts:15284, 18949, 13156), `systemInstruction`, `tools`, `thinkingConfig`,
    `inputAudioTranscription` / `outputAudioTranscription` (`AudioTranscriptionConfig` d.ts:877; `{}` = auto language),
    `realtimeInputConfig { automaticActivityDetection { disabled, startOfSpeechSensitivity, endOfSpeechSensitivity,
    prefixPaddingMs, silenceDurationMs }, activityHandling (default START_OF_ACTIVITY_INTERRUPTS = barge-in), turnCoverage }`
    (d.ts:13571, 1020, 13), `contextWindowCompression { triggerTokens, slidingWindow { targetTokens } }` (d.ts:2261),
    `sessionResumption { handle }` (d.ts:15080), `proactivity`, `enableAffectiveDialog`, `translationConfig`. In
    Developer-API mode `explicitVadSignal` (index.mjs:8611) and `sessionResumption.transparent` (index.mjs:9208) throw;
    `multiSpeakerVoiceConfig` throws (index.mjs:3652); `historyConfig` exists only on the raw setup type (d.ts:10844),
    connect cannot send it; `generationConfig` on connect is deprecated (console warning).
  - `Session` (d.ts:14933): `sendRealtimeInput({ audio: { data: base64, mimeType: 'audio/pcm;rate=16000' } | text |
    audioStreamEnd | activityStart | activityEnd })` (mimeType must start with `audio/`, index.mjs:3342),
    `sendClientContent({ turns, turnComplete })`, `sendToolResponse({ functionResponses: [{ id, name, response }] })`
    (`id` required in Developer-API mode, index.mjs:14546), `close()`.
  - `LiveServerMessage` (d.ts:11370): `setupComplete`, `serverContent` (d.ts:11322: `modelTurn.parts[].inlineData`
    = `audio/pcm;rate=24000` base64, `turnComplete`, `interrupted`, `generationComplete`, `inputTranscription` /
    `outputTranscription { text, finished, languageCode }` (d.ts:16317), `interimInputTranscription`,
    `turnCompleteReason`, `waitingForInput`), `toolCall.functionCalls[{ id, name, args }]` (d.ts:11436),
    `toolCallCancellation.ids` (d.ts:11446), `usageMetadata` (d.ts:18425: `promptTokenCount`, **`responseTokenCount`**
    (not candidatesTokenCount), `thoughtsTokenCount`, `toolUsePromptTokenCount`, `totalTokenCount`,
    `*TokensDetails[{ modality, tokenCount }]`), `goAway { timeLeft }` (d.ts:11364), `sessionResumptionUpdate
    { newHandle, resumable }` (d.ts:11411), `voiceActivity`.
  - NON_BLOCKING function `behavior`, response `scheduling` and `willContinue` exist (d.ts:1383, 5794, 5839): not used
    (model support varies; blocking calls suffice).
  - Ephemeral tokens: `ai.authTokens` (d.ts:7362), `Tokens.create` (d.ts:16020), `AuthToken` (d.ts:979).
  - Voices: `voiceName` is a free string (no enum). The SDK's `ai.voices.list()` (NextGen voices API) reports `gender`
    per prebuilt voice: a later way to re-check §2.3.
- **`ws`**: the SDK depends on `ws ^8.18.0` (lockfile: 8.22.0) and imports it itself (index.mjs:8 `import * as NodeWs
  from 'ws'`, wrapper index.mjs:25860). From `server/src` it is **not resolvable** (`MODULE_NOT_FOUND`: pnpm strict
  layout; only `@biomejs` is hoisted to the root). Node 26 ships a global `WebSocket` client, no server.
- **Tools measured**: `allTools()` = 41 in 10 groups — core 12 (incl. `load_tools`), maintenance 3, production 3, people 1,
  telemetry 6, health 2, write 5\*, planning 5 (`apply_plan`\*), cost 1, kpi 3 (`create_kpi`\*, `update_kpi`\*);
  \* = `requiresConfirmation`.

## 1. Packages and file ownership

### 1.1 Step 0 — integrator, before any builder starts (mechanical)

1. `pnpm --filter @sara/server add ws@^8.22.0` → `"ws": "^8.22.0"` in `server/package.json` (same version as the
   lockfile, nothing new downloaded). No `@types/ws`.
2. `server/src/auth/middleware.js`: move the body of `authenticate` into
   ```js
   /** Bearer token → { user, sessionId, tokenExpiresAt, ctx }; throws the same 401s as authenticate. */
   export const userFromToken = async (token) => { /* verifyToken → live Session → active user → buildUserContext */ };
   export const authenticate = async (req, _res, next) => {
     const [scheme, token] = (req.headers.authorization ?? '').split(' ');
     if (scheme !== 'Bearer' || !token) throw unauthorized('Sign in to continue');
     Object.assign(req, await userFromToken(token));
     next();
   };
   ```
   `stillSignedIn(x)` already reads only `x.tokenExpiresAt`, `x.sessionId`, `x.user._id`: it takes the voice auth object
   unchanged.
3. `server/src/agent/loop.js`: `export` on `const execute` and `const audit` (nothing else).

Then `SARA_TEST_DB=p8int npx vitest run --maxWorkers=2 test/auth.test.js test/agent-loop.test.js test/agent-routes.test.js`.

### 1.2 Packages

| Package | Owns |
|---|---|
| `V:server` | new: `server/src/voice/{protocol,liveClient,prompt,tools,persist,session,server}.js`, `server/src/routes/voice.js`, `server/test/voice-protocol.test.js`, `voice-session.test.js`, `voice-ws.test.js`, `server/test/helpers/fakeLive.js`; modify: `server/src/ai/settings.js` (voice part §2.3), `ai/budget.js` (§2.4), `ai/models.js` (`KNOWN_LIVE_MODELS`, `listLiveModels`), `db/models/{AiConversation,AiMessage,AiUsage}.js` (§2.1), `config/env.js` + `.env.example` (§2.2) |
| `V:mock` | new: `server/src/ai/mockLive.js`, `server/test/mock-live.test.js`, `server/test/voice-mock-e2e.test.js` |
| `V:client-audio` | new: `client/src/voice/audio/{captureWorklet,mic,player}.js`, `client/src/voice/audio/{capture,player}.test.js` |
| `V:client-ui` | new: `client/src/voice/{useVoice.js,VoicePanel.jsx,VoiceButton.jsx,Orb.jsx}`, `client/src/voice/{voice.test.jsx,aiTabVoice.test.jsx}`; modify: `client/src/superadmin/AiTab.jsx` (Voice section + `modelsInUse`, §6.4) |

Shared files only the integrator edits (§1.1, §10): `server/src/index.js`, `routes/conversations.js`,
`auth/middleware.js`, `agent/**`, `server/package.json`, `client/vite.config.js`, `client/nginx.conf`,
`client/src/layout/**`, `client/src/chat/**`, `README.md`, `docs/**`. Nobody edits `ai/gemini.js`, `ai/mock.js`,
`ai/mockChat.js`, `blocks/**`, `store/**`, `index.css`.

### 1.3 Allowed read-only imports

Server: `agent/loop.js` (`execute`, `audit`, `publicAction`), `agent/pendingActions.js` (`createPendingAction`,
`claimPendingAction`, `rejectPendingAction`, `expirePendingActions`, `stepResponses`), `agent/tools/registry.js`
(`toolsFor`, `groupsFor`, `getTool`), `agent/declarations.js` (`toDeclaration`), `agent/systemPrompt.js`
(`buildSystemPrompt`), `agent/history.js` (`loadTurns`), `agent/llm.js` (`friendlyAiError`, `isAbort`), `ai/gemini.js`
(`getClient`, `isMock`, `AiUnavailableError`), `ai/budget.js`, `ai/settings.js`, `auth/middleware.js` (`userFromToken`,
`stillSignedIn`, `requireSuperAdmin`), `lib/*`, `db/models/*`, `config/env.js`. `V:mock` also: `ai/mock.js`
(`mockScripts`, `scriptFor`), `ai/mockChat.js` (`demoStep`). Tests: `test/helpers/{db,mockGemini}.js`.
Client: `chat/MessageBubble.jsx` (`MessageBubble`), `store/streamStore.js` (`reduceEvent`, `newMessage`),
`assistant/useAssistant.js` (`contextFromPath`), `assistant/AskSara.jsx` (`MOD_KEY`), `api/client.js` (`api`, `apiUrl`,
`getToken`), `auth/useAuth.js` (`useSession`), `ui/*`, `lib/format.js`, `superadmin/parts.jsx`.

### 1.4 Order

Step 0 → `V:server` ∥ `V:mock` ∥ `V:client-audio` ∥ `V:client-ui` → integrator (§10). `V:mock`'s e2e test needs
`V:server`; `V:client-ui`'s tests `vi.mock` the audio modules, whose files must exist (`V:client-audio` is small: land it
first). A builder whose dependency is not there yet leaves the test in place and says so in its hand-off.

## 2. Data

### 2.1 Mongo models (V:server)

- `AiConversation`: `voice: { type: Boolean, default: false }`, set by the first persisted voice turn.
- `AiMessage`: `channel: { type: String, enum: ['text', 'voice'], default: 'text' }`. Voice assistant messages also carry
  `tier: 'voice'`, `model` = the Live model, `thinkingLevel: null`, `routerDecision: null`.
- `AiUsage`: `AI_PURPOSES` gains `'voice'`; new `audioSec: { in: { type: Number, default: 0 }, out: { type: Number,
  default: 0 } }` (seconds of audio sent to / received from Gemini on that connection).

Nothing else changes; validate-db stays clean (defaults).

### 2.2 Env (V:server)

`config/env.js`: `GEMINI_MODEL_VOICE: str('gemini-3.1-flash-live-preview')`, `GEMINI_FALLBACK_VOICE:
str('gemini-2.5-flash-native-audio-preview-12-2025')`. `.env.example`, in the Gemini block:
```
# Voice assistant (Gemini Live, native audio). Ids not verified yet: Superadmin → AI → Voice lists the models your
# key can use for Live (bidiGenerateContent) and changes them live.
GEMINI_MODEL_VOICE=gemini-3.1-flash-live-preview
GEMINI_FALLBACK_VOICE=gemini-2.5-flash-native-audio-preview-12-2025
```

### 2.3 Settings — `ai/settings.js` (V:server)

```js
/** Female prebuilt Gemini voices (shared by Live native audio and TTS); `style` is Google's one-word label. */
export const FEMALE_VOICES = Object.freeze([
  { name: 'Kore', style: 'Firm' }, { name: 'Aoede', style: 'Breezy' }, { name: 'Zephyr', style: 'Bright' },
  { name: 'Leda', style: 'Youthful' }, { name: 'Callirrhoe', style: 'Easy-going' }, { name: 'Autonoe', style: 'Bright' },
  { name: 'Despina', style: 'Smooth' }, { name: 'Erinome', style: 'Clear' }, { name: 'Laomedeia', style: 'Upbeat' },
  { name: 'Achernar', style: 'Soft' }, { name: 'Gacrux', style: 'Mature' }, { name: 'Pulcherrima', style: 'Forward' },
  { name: 'Vindemiatrix', style: 'Gentle' }, { name: 'Sulafat', style: 'Warm' },
]);
/** `auto` = answer in the speaker's language; a code pins one language through the system instruction. */
export const VOICE_LANGUAGES = Object.freeze([
  { code: 'auto', label: 'Auto (match the speaker)', name: null },
  { code: 'en-IN', label: 'English (India)', name: 'English' }, { code: 'hi-IN', label: 'हिन्दी · Hindi', name: 'Hindi' },
  { code: 'mr-IN', label: 'मराठी · Marathi', name: 'Marathi' }, { code: 'gu-IN', label: 'ગુજરાતી · Gujarati', name: 'Gujarati' },
  { code: 'ta-IN', label: 'தமிழ் · Tamil', name: 'Tamil' }, { code: 'te-IN', label: 'తెలుగు · Telugu', name: 'Telugu' },
  { code: 'kn-IN', label: 'ಕನ್ನಡ · Kannada', name: 'Kannada' }, { code: 'ml-IN', label: 'മലയാളം · Malayalam', name: 'Malayalam' },
  { code: 'bn-IN', label: 'বাংলা · Bengali', name: 'Bengali' }, { code: 'en-US', label: 'English (US)', name: 'English' },
  { code: 'en-GB', label: 'English (UK)', name: 'English' }, { code: 'de-DE', label: 'Deutsch · German', name: 'German' },
  { code: 'fr-FR', label: 'Français · French', name: 'French' }, { code: 'es-ES', label: 'Español · Spanish', name: 'Spanish' },
  { code: 'ar-XA', label: 'العربية · Arabic', name: 'Arabic' }, { code: 'ja-JP', label: '日本語 · Japanese', name: 'Japanese' },
]);
// DEFAULT_AI gains
voice: { enabled: true, model: env.GEMINI_MODEL_VOICE, fallback: env.GEMINI_FALLBACK_VOICE, voiceName: 'Kore',
  languageCode: 'auto', maxSessionMin: 10, maxConcurrent: 3 },
// aiPatchSchema gains, in the same change (the AI tab PUTs the whole settings object: without it every Save is a 400)
voice: z.strictObject({
  enabled: z.boolean().optional(), model: modelId.optional(), fallback: modelId.nullable().optional(),
  voiceName: z.enum(FEMALE_VOICES.map((v) => v.name)).optional(),
  languageCode: z.enum(VOICE_LANGUAGES.map((l) => l.code)).optional(),
  maxSessionMin: z.number().int().min(1).max(30).optional(),
  maxConcurrent: z.number().int().min(1).max(50).optional(),
}).optional(),
```
Settings are read once per session start; a change applies to the next session.

### 2.4 Budget, usage, model list (V:server)

- `budget.js`: `normalizeUsage` reads `candidates = u.candidatesTokenCount ?? u.responseTokenCount ?? u.candidates ?? 0`;
  `recordUsage({ …, audioSec })` stores it (default `{ in: 0, out: 0 }`); `usageToday()` counts `settings.voice.model` /
  `fallback` as configured models and adds `audioMin` per row (Σ(in + out) / 60, one decimal).
- `'voice'` is interactive: **not** in `BACKGROUND_PURPOSES` (full RPD, like chat). Each Gemini Live connection,
  resumption reconnects included, is one `canSpend(model, 'voice')` against `limits[model]` (RPM/RPD per model in
  Superadmin → AI → Quotas, as for every model). Its `ai_usage` row (`purpose: 'voice'`, summed tokens, `latencyMs` =
  connect time, `audioSec`) is written when that connection ends. Refused / failed attempts are recorded like
  `gemini.js` (`blocked`, `rate_limited`, `error`); mock sessions never call `canSpend` and record `status: 'mock'`.
- `models.js`: `export const KNOWN_LIVE_MODELS = ['gemini-3.1-flash-live-preview',
  'gemini-2.5-flash-native-audio-preview-12-2025', 'gemini-2.5-flash-native-audio-preview-09-2025'];` and
  `export const listLiveModels = async () => [{ id, displayName }]`: mock/keyless → `KNOWN_LIVE_MODELS` ∪ the configured
  voice models when `isMock()` (gemini.js, so an injected fake Live client never makes it call the API); else
  `(await getClient().models.list({ config: { pageSize: 1000 } })).page` (first page only) filtered by
  `supportedActions?.includes('bidiGenerateContent')`, cached 10 min; built-in list (cached 1 min) on failure, as
  `listModels` does.

## 3. Server engines

### 3.1 Live connection — `voice/liveClient.js`

```js
let injected = null;
/** Tests: a LiveClientLike instead of the SDK (fakeLive, mockLive); null restores it. */
export const _setLiveClient = (client) => { injected = client ?? null; };
export const isVoiceMock = () => !injected && (env.AI_MOCK || !env.GEMINI_API_KEY);
/** LiveClientLike = { connect({ model, config, callbacks }) → Promise<LiveSessionLike> }. */
export const liveApi = async () =>
  injected ?? (isVoiceMock() ? (await import('../ai/mockLive.js')).mockLive : getClient().live);
// LiveSessionLike = { sendRealtimeInput(p), sendToolResponse(p), close() }: the SDK Session subset SARA uses.
// callbacks = { onmessage(LiveServerMessage), onerror?(e), onclose?({ code, reason }) }

/** Start-of-speech sensitivity is the plant-floor noise knob: LOW = fewer false barge-ins from machine noise. */
export const VAD = Object.freeze({ startOfSpeechSensitivity: 'START_SENSITIVITY_LOW' });

export const buildLiveConfig = ({ system, declarations, voiceName, handle = null }) => ({
  responseModalities: ['AUDIO'],
  speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } },
  systemInstruction: system,
  tools: [{ functionDeclarations: declarations }],
  inputAudioTranscription: {},
  outputAudioTranscription: {},
  realtimeInputConfig: { automaticActivityDetection: VAD },
  contextWindowCompression: { slidingWindow: {} },
  sessionResumption: handle ? { handle } : {},
});

/**
 * Opens one Live connection. Not mock: canSpend(model, 'voice') per attempt; the primary, then settings.voice.fallback once
 * (when set and different) on a refusal or any connect failure. Each attempt races connect() against callbacks.onclose /
 * onerror and CONNECT_TIMEOUT_MS. Failure text /RESOURCE_EXHAUSTED|quota|429|rate/i → rate_limited (AI_QUOTA), else error
 * (AI_ERROR); both recorded in ai_usage. Throws AiUnavailableError('AI_QUOTA' | 'AI_ERROR').
 * @returns {Promise<{ session, model, connectMs, mock, fallbackFrom }>}
 */
export const openLive = async ({ settings, companyId, config, callbacks }) => {};
/** Adds one Live usageMetadata to { prompt (+ toolUsePromptTokenCount), thoughts, candidates (responseTokenCount), total }. */
export const addLiveUsage = (total, usageMetadata) => total;
```
Never sent: `thinkingConfig`, `speechConfig.languageCode`, `generationConfig`, `proactivity`, `enableAffectiveDialog`,
`explicitVadSignal`, `sessionResumption.transparent`, NON_BLOCKING `behavior`. User-facing errors go through
`friendlyAiError`; the raw close reason is logged at `warn` (never the URL). A fallback connection makes the session
send `notice { text: '<primary> is busy, so <fallback> answers this session.' }`.

### 3.2 System prompt — `voice/prompt.js`

```js
export const buildVoicePrompt = async ({ ctx, conversation, context, language, pendingAction, now }) => string;
```
= `buildSystemPrompt({ ctx, conversation, context, groups: groupsFor(ctx), now })` + `\n\n` + `VOICE_STYLE`
+ fixed language (not `auto`): `\nRESPOND IN <NAME>. YOU MUST RESPOND UNMISTAKABLY IN <NAME>, whatever language the user
speaks.` + continuing a conversation: `\nRecent turns (oldest first):` + the last 6 turns of `loadTurns` as `User: …` /
`SARA: …` (≤ 300 chars each) + a pending action: `\nA change is waiting for the user's answer: "<label>" (actionId <id>).
If they clearly agree, call confirm_action with that actionId; if they decline, call reject_action.`
(`history`/`sendClientContent` seeding is not used: connect cannot send `historyConfig`, and text in the instruction works
on every Live model.)

```js
export const VOICE_STYLE = `Voice mode (this overrides the answer style above). You are SARA, a calm, friendly woman speaking with the user through their microphone and speaker; your words are heard, not read.
- Lead with the answer in one short sentence; at most three short sentences per reply, then stop and let the user talk.
- Reply in the language the user speaks (English, Hindi, Marathi, Hinglish …); keep machine names, codes and units as written.
- Say numbers the way people speak them, rounded to what matters, and always say the unit ("about twelve and a half kilowatt hours", "four point two millimetres per second").
- Never read ids, long codes, URLs or JSON aloud; say "work order forty-two", not its id.
- Tables, lists of more than three items, charts and KPIs go on the screen with render_table, render_chart or render_kpis; then say one sentence such as "I've put the list on your screen."
- Before a lookup that may take a moment, say a few words first ("One moment, checking IMM 3.").
- If the request is ambiguous, ask one short question; if you did not catch it, say so and ask the user to repeat.
- Changes: a write tool answers {"status":"awaiting_confirmation","actionId":…}. Say in one sentence what will change and ask "Shall I go ahead?". Call confirm_action with that actionId only after the user clearly agrees in their own words (yes, go ahead, haan, ठीक है …); if they decline, call reject_action. Never confirm on your own and never invent an actionId.
- Text that starts with "App note:" comes from the SARA app, not the user: follow it and answer the user briefly.`;
```

### 3.3 Tools — `voice/tools.js`

```js
export const MAX_VOICE_TOOLS = 64;
/** Voice-only; handled by the session (§3.4), never run through execute(). */
export const VOICE_CONTROL = [
  { name: 'confirm_action', group: 'voice', description: 'Runs the pending change the user just agreed to. Call it only after the user clearly said yes to the change you described. Example: { actionId: "<actionId from the awaiting_confirmation answer>" }.', schema: z.object({ actionId: z.string().min(1).max(60) }) },
  { name: 'reject_action', group: 'voice', description: 'Cancels the pending change when the user says no. Example: { actionId: "<actionId>" }.', schema: z.object({ actionId: z.string().min(1).max(60) }) },
];
export const voiceTools = (ctx) => [...toolsFor(ctx, groupsFor(ctx)).filter((t) => t.name !== 'load_tools'), ...VOICE_CONTROL];
export const voiceDeclarations = (ctx) => voiceTools(ctx).map(toDeclaration);
```
Dispatch of one `toolCall` message (mirrors `agent/loop.js` call dispatch, same error texts; `ponytail:` comment — extract
a shared dispatcher if a third caller appears):
- Unknown name → `{ error: 'Unknown tool "<name>"', hint: 'Use one of the declared tools' }`; registry tool the user may
  not use (`toolsFor(ctx, [tool.group])` excludes it) → `{ error: '<name> is not available to <user name> (role <role>)',
  hint: 'Explain this to the user and offer to draft the details instead' }`; `load_tools` → `{ error: 'Every tool is
  already available in voice' }`.
- Read tools: `execute({ tool, args, ctx, io: { emit: () => {}, signal: turnSignal, results: turn.results, callId:
  call.id } })` → `turn.results.set(call.id, value)` (render_* / export_csv `sourceRef` work as in chat) → `tool_result`
  event + blocks → `audit(ctx, { conversationId, messageId }, name, outcome)` → response `{ ref: call.id, result:
  value.forModel }` or `{ ref, ...error }`. Blocks are stored and sent exactly as loop.js `emitBlocks` does: id
  `b_<10 hex>`, a `file` block gets `url: /api/export/<messageId>/<id>.csv` and keeps `csv` in the stored part only.
- Write tools (`requiresConfirmation`): the first one of the message → `execute({ …, mode: 'preview' })`; a preview error
  is answered as an error; otherwise pending (§3.4). Later writes of the same message → `{ error: 'one change at a time',
  hint: 'Ask for this change again after the user confirms the first one' }`.
- After a pending action was created in the turn, every later call of that turn → `{ error: 'A change is waiting for the
  user. Ask them to confirm or reject it first.' }` (live only, not stored).
- More than `env.MAX_TOOL_ITERATIONS` toolCall messages in one turn → every call `{ error: 'The tool budget of this
  answer is used up: answer now with what you have.' }`.
- `toolCallCancellation { ids }`: responses for those ids are never sent, and a pending action is not created for one.
- One `sendToolResponse({ functionResponses })` per toolCall message, in call order, each `{ id: call.id, name:
  call.name, response }`.
- Stored per round (`gemini`): `{ role: 'model', parts: [the message's non-control calls; the first part carries
  thoughtSignature: 'skip_thought_signature_validator'] }` then `{ role: 'user', parts: [their functionResponses] }`
  (same `ref`/`result` shapes as chat, so `history.js` shrinks them). `confirm_action` / `reject_action` never enter
  `gemini` or the tool trace.

### 3.4 Pending actions by voice and by click

A write previewed in turn N:
1. `expirePendingActions(conversationId)` (supersedes older ones, as a new chat message does).
2. Flush the round; `gemini` += the model content with the calls only — **no user content after it**: the write call
   stays unanswered in storage exactly like chat, so chat confirm/reject/expiry and `buildContents` stay valid.
3. `createPendingAction(message, { tool, args, callId: call.id, geminiId: call.id, callIndex, siblingResponses: [the
   other calls' responses, in call order], preview: preview.payload })` → message `status: 'awaiting_confirmation'`.
4. Browser: `block` with `data: { id, type: 'confirm', payload: { ...preview.payload, actionId, expiresAt, status:
   'pending' } }` (also stored as a block part) and `confirm { action: publicAction(action) }`.
5. Live answer for the write call (live only): `{ status: 'awaiting_confirmation', actionId, label: payload.label,
   expiresInMin: env.PENDING_ACTION_TTL_MIN, next: 'Say what will change in one sentence and ask the user to confirm.
   Call confirm_action only after they clearly agree.' }`.
6. `session.latestAction = { id, messageId, turnId, turnSeq: N, label }`. A session started on a conversation that has
   an unexpired pending action loads it with `turnSeq: 0` and names it in the prompt (§3.2).

Confirm — voice `confirm_action { actionId }` or browser `confirm { actionId }`:
- Accepted only when `actionId === latestAction.id` and, for voice, the call comes from a later turn
  (`turnSeq > latestAction.turnSeq`: the model cannot confirm in the turn it asked). Otherwise voice gets `{ error: 'No
  such pending change, or the user has not answered yet. Ask them first.' }`, the browser `error { code:
  'ACTION_NOT_FOUND', fatal: false }`.
- `claimPendingAction({ ctx, conversation, actionId })` (atomic; expiry and permission re-checked; 410 (expired or
  already handled) → `{ status: 'gone', error }` / `ACTION_GONE`, 403 → `{ status: 'forbidden', error }` /
  `FORBIDDEN`).
- `execute({ tool, args: action.args, ctx, io: { …, signal: undefined } })`: never tied to a turn or stop signal (as chat).
- On the action's message, atomic updates: `$push parts` (tool_result + block parts + notice `Confirmed by voice` /
  `Confirmed on screen`), `$push gemini: stepResponses(action, outcome.error ? { status: 'failed', ref, ...error } :
  { status: 'confirmed', ref, result: forModel })`, `$set { 'pendingAction.result': { ok, summary },
  'pendingAction.via': 'voice' | 'click', status: 'complete' }`; `audit(…)`.
- Browser: `tool_result` + `block`s with the action's `turnId` when that turn is in this session (else one `notice` on the
  current turn: `Confirmed: <label> — <summary>`), then `confirm { action }` with the new status and result.
- Live: voice path → the `confirm_action` response `{ status: 'confirmed', summary, result: forModel }` (or failed /
  gone / forbidden); click path → a new turn whose user message is `Confirmed: <label>` (channel voice), and
  `sendRealtimeInput({ text: 'App note: the user confirmed "<label>" on screen. Result: <summary>. Tell them in one short
  sentence.' })`.

Reject (same guards) → `rejectPendingAction({ conversation, actionId })` (it pushes the stored step response and its
notice) → voice response `{ status: 'rejected' }`, or click: user message `Rejected: <label>` + App note `…rejected
"<label>"; nothing was saved. Acknowledge briefly.`. Typed text starting with `App note:` loses that prefix (only the
server writes App notes).

### 3.5 Session — `voice/session.js` + `voice/persist.js`

```js
/** One voice session: a browser socket, an authenticated user and one Live connection (replaced on resumption). */
export const createVoiceSession = ({ socket, auth /* userFromToken() result */, start /* parsed start */, settings, onClose }) =>
  ({ id, userId, ready /* Promise */, handleMessage(data, isBinary), close(reason, code) });
// socket = the ws WebSocket subset { send(data, { binary }), close(code, reason), readyState, bufferedAmount }
```
Start: `start.conversationId` → own, not deleted (`{ _id, companyId, userId, deleted: false }`) or `CONVERSATION_NOT_FOUND`;
its unexpired pending action → `latestAction`; `buildVoicePrompt` → `voiceDeclarations(ctx)` → `openLive` → `ready`
(+ the fallback notice of §3.1).

Turns (`turnId` = `t1`, `t2`, … per session; `turnSeq` = its number):
- A turn opens on the first of: input transcription chunk, typed text, model audio/transcript, toolCall, while none is
  open.
- It closes on `turnComplete` (if tool responses are still outstanding, on the next one), after `interrupted` +
  `turnComplete` (status `stopped`), or at session end (`stopped` when the answer was cut).
- Input transcription after `interrupted` or after a `finished: true` chunk belongs to the next turn. A chunk arriving
  ≤ `LATE_TRANSCRIPT_MS` after a turn closed and before any new model output is appended to that turn's user message.
- Typed text while a turn is open becomes the next turn's user text (Gemini interrupts the current answer itself).
- Browser `interrupt`: the rest of this turn's audio and assistant transcript is neither forwarded nor stored; status
  `stopped`.
- `latencyMs` = first model audio − the last user activity before it (last input transcription chunk or the typed text).

Persistence (`persist.js`, atomic `$set`/`$push` only, so a confirm landing mid-turn interleaves safely):
```js
export const ensureConversation = async (ctx, session) => conversation;      // lazy at the first turn: { companyId, userId, plantId: ctx.plantId, title: '', voice: true }
export const openTurn = async (ctx, conversation, { userText, context, model }) =>
  ({ userMessageId, messageId });   // user msg first, then assistant { status: 'streaming', tier: 'voice', model, channel: 'voice', context }
export const flushRound = async (messageId, { parts, gemini }) => {};        // $push { parts: { $each }, gemini: { $each } }
export const closeTurn = async (ids, { userText, text, parts, usage, latencyMs, status, pending }) => {};
```
`closeTurn`: user `$set { text: userText || '(voice message)' }`; assistant `$set { text, usage, latencyMs }`, `$push`
the remaining `parts` and — only when `!pending` (no pending action created in this turn) — `gemini: { role: 'model',
parts: [{ text: text || '(no answer)' }] }`; then `updateOne({ _id, status: 'streaming' }, { $set: { status } })` (keeps
`awaiting_confirmation` / `complete` set by §3.4); conversation `$set { lastMessageAt: new Date(), voice: true }` and, when
`title` is empty, the first 6 words of the first user text (`Voice conversation` when none). Assistant `parts` are chat
parts in arrival order: transcript text (adjacent text merged), `tool_call`, `tool_result`, `block`, `notice`.

Audio:
- Browser binary → when live and not muted: `sendRealtimeInput({ audio: { data: buf.toString('base64'), mimeType:
  'audio/pcm;rate=16000' } })`; dropped before `ready`. `mute { muted: true }` → `sendRealtimeInput({ audioStreamEnd:
  true })`.
- Gemini `inlineData` audio → `socket.send(Buffer.from(data, 'base64'), { binary: true })`, unless the turn was
  interrupted by the browser or `socket.bufferedAmount > MAX_CLIENT_BUFFER` (slow client: drop, one notice per turn).
- `audioSec.in` = bytes in / 32000, `audioSec.out` = bytes out / 48000.

Resumption: keep the last `sessionResumptionUpdate.newHandle` when `resumable`. On `goAway`, or an unexpected Gemini close
while the browser is connected and time is left: `openLive` with `buildLiveConfig({ …, handle })` (without a handle, a
fresh prompt from the persisted turns), buffer ≤ `RESUME_BUFFER_MS` of browser audio meanwhile, swap, close the old one;
`notice { text: 'Reconnected' }` only when the context was rebuilt without a handle. One attempt; failure → `error
AI_ERROR` + `closed { reason: 'error' }`.

Timers: max duration `settings.voice.maxSessionMin` (`notice` "One minute left in this voice session." at max − 1 min,
then `closed max_duration`); idle `IDLE_SEC` without transcription, text, model output or tool activity → `closed idle`;
every `REVALIDATE_MS` and at `tokenExpiresAt`, `stillSignedIn(auth)` false → `closed signed_out`.

End (any reason): stop timers, close Live, close the open turn, `recordUsage({ model, purpose: 'voice', companyId,
status: mock ? 'mock' : 'ok', usage, latencyMs: connectMs, audioSec })` per Live connection, send `usage` then `closed
{ reason, conversationId }`, close the socket (§4.3), log one info line `{ sessionId, userId, companyId, model, mock,
seconds, turns, toolCalls, tokens, audioSec, reason }` — never transcripts, audio or URLs.

Gemini message → action:

| Live message | Server | Browser |
|---|---|---|
| `serverContent.inputTranscription { text, finished }` | open turn if needed; append user text | `transcript { role: 'user', text, final: Boolean(finished) }` |
| `serverContent.outputTranscription { text }` | append to the turn's text part and `text` | `transcript { role: 'assistant', text, final: false }` |
| `serverContent.modelTurn.parts[].inlineData` (audio) | count bytes; first-audio latency | binary frame |
| `modelTurn.parts[].text` (thought or not) | ignored | — |
| `serverContent.interrupted` | turn → stopped | `interrupted` |
| `serverContent.turnComplete` | close turn (§3.5) | `turn_complete`, `usage` |
| `toolCall` | dispatch (§3.3–3.4) | `tool_call`, `tool_result`, `block`, `confirm` |
| `toolCallCancellation` | drop those responses | — |
| `usageMetadata` | `addLiveUsage` to the turn and the session | (in `usage`) |
| `goAway` / `sessionResumptionUpdate` | resumption | `notice` only when rebuilt |
| `setupComplete`, `generationComplete`, `waitingForInput`, `interactionStatus`, `voiceActivity`, `interimInputTranscription` | ignored | — |

### 3.6 WebSocket server — `voice/server.js`

```js
/** Voice WebSocket on the HTTP server: upgrades for exactly /api/voice, Origin allow-list, auth from the first message. */
export const attachVoiceServer = (httpServer) => ({ close: async (reason = 'server_shutdown') => {}, size: () => 0 });
```
- `new WebSocketServer({ noServer: true, maxPayload: MAX_JSON_BYTES, perMessageDeflate: false })`.
- `upgrade`: pathname ≠ `/api/voice` → `socket.destroy()`; `Origin` missing or not one of
  `env.CLIENT_URL.split(',').map((o) => new URL(o.trim()).origin)` → write `HTTP/1.1 403 Forbidden\r\n\r\n` and destroy;
  else `handleUpgrade`.
- Connection: the first message must be a valid `start` within `AUTH_TIMEOUT_MS`; `userFromToken(start.token)` (401 →
  `UNAUTHORIZED` 4001); platform company or `settings.voice.enabled` false → `VOICE_DISABLED` 4003; > `MAX_STARTS_PER_MIN`
  starts per user → `RATE_LIMITED` 4008; the same user's live session → that one gets `closed { reason: 'replaced' }`
  (one session per user); ≥ `settings.voice.maxConcurrent` sessions server-wide → `VOICE_BUSY` 4029.
- Per connection: > `MAX_MSGS_PER_SEC` messages in a second, an invalid JSON message or an invalid binary frame →
  `error` (`RATE_LIMITED` / `BAD_MESSAGE`) + close 4008; typed text above `env.RATE_LIMIT_MESSAGES_PER_MIN` per user per
  minute → `error RATE_LIMITED` (non-fatal).
- Heartbeat: `ping` every `HEARTBEAT_MS`; no `pong` by the next ping → `terminate()` (session ends with `error`).
- `close()` (SIGINT/SIGTERM): every session → `closed server_shutdown`, persisted, sockets closed 1001.

### 3.7 Mock Live — `ai/mockLive.js` (V:mock)

```js
/** LiveClientLike for AI_MOCK=true: scripted turns over the real tools; audio input ignored; a soft tone as speech. */
export const mockLive = { connect: async ({ model, config, callbacks }) => MockLiveSession };
export const mockLiveTiming = { chunkMs: 20 };          // delay between emitted messages; tests set 0
export const toneFor = (text, { rate = 24000 } = {}) => Buffer;   // PCM16 LE mono
export const spoken = (markdown) => string;             // markdown → plain speech: no **, #, bullets or tables; ≤ 400 chars
export const VOICE_FLOWS = [];                          // [test(state), step(state)] pairs tried before the chat demo flows
```
- `connect` resolves on the next tick (setup implicit). `close()` → `onclose({ code: 1000, reason: '' })` once.
  `sendRealtimeInput({ audio | audioStreamEnd })` and `sendClientContent` are ignored (no transcription in mock).
- `sendRealtimeInput({ text })` = a user turn; if a turn is still being emitted, first `{ serverContent: { interrupted:
  true } }` and `{ serverContent: { turnComplete: true } }`.
- Step choice for each model step (`history` = this turn's model calls and function responses, built as `mockStream`
  does; `system` = `config.systemInstruction`; `tools` = `config.tools`):
  1. the last function response has `status: 'awaiting_confirmation'` → say `<label>. Shall I go ahead?`, end the turn,
     remember `{ actionId, label }`;
  2. the last response answers `confirm_action` / `reject_action` → say `Done: <summary>.` / `Okay, I won't make that
     change.` (failed / gone / forbidden → its error);
  3. a remembered `actionId` and the text starts with YES (`yes, yeah, yep, sure, ok, okay, go ahead, do it, confirm,
     haan, haan ji, हाँ, हां, जी, ठीक है, kar do`) or NO (`no, nope, cancel, don't, stop, nahi, नहीं, मत`) → call
     `confirm_action` / `reject_action { actionId }` (Devanagari-safe matching: no `\b` next to non-Latin words);
  4. `VOICE_FLOWS`, at least "how many machines are running" (also `मशीनें … चल`) → `mongo_aggregate { module: 'assets',
     pipeline: [{ $group: { _id: '$assetStatus', count: { $sum: 1 } } }, { $sort: { count: -1 } }] }` → `render_kpis`
     (a tile per status) → "N of M machines are running right now; …";
  5. a test script in `mockScripts` that matches → `scriptFor(text, tools)[turn]`, exactly as `mockStream`;
  6. `demoStep({ text, history, system })` (the chat demo flows: on in dev, off in tests);
  7. `scriptFor(text, tools)[turn]` (one-tool default), else `{ text: "I'm SARA in mock mode: type or use Say something." }`.
- Emitting: `calls` → `{ toolCall: { functionCalls: [{ id: 'mock-fc-<n>', name, args }] } }`, then wait for the
  `sendToolResponse` with those ids; `text` → `spoken(text)` as ≤ 3 `outputTranscription` chunks interleaved with
  `modelTurn.parts[{ inlineData: { mimeType: 'audio/pcm;rate=24000', data } }]` chunks of ≤ 200 ms from `toneFor`, then
  `{ serverContent: { generationComplete: true } }`, `{ usageMetadata: { promptTokenCount, responseTokenCount,
  totalTokenCount } }` (chars / 4), `{ serverContent: { turnComplete: true } }`, `{ sessionResumptionUpdate: { newHandle:
  'mock-<n>', resumable: true } }`. Thoughts are dropped.
- `toneFor`: per word 120 ms of a 220 Hz sine at amplitude 0.06 with 15 ms raised-cosine fades, 40 ms silence between
  words, ≥ 300 ms, ≤ 4 s total; deterministic.

## 4. Wire protocol (browser ⇄ server)

Text frames carry one JSON object `{ type, … }`; binary frames carry audio only (no header).

### 4.1 Browser → server

| type | shape | notes |
|---|---|---|
| `start` | `{ type: 'start', token: string 1–4096, conversationId?: 24-hex, language?: VOICE_LANGUAGES code, voice?: FEMALE_VOICES name, context?: { page?: ≤60, recordRef?: { module ≤60, id ≤60, label? ≤120 } } }` | first message, within `AUTH_TIMEOUT_MS`, once; defaults from settings |
| binary | PCM16 LE mono 16 kHz, even length, `FRAME_MIN_BYTES`–`FRAME_MAX_BYTES` (the client sends 1280 B = 40 ms) | only after `ready` |
| `text` | `{ type: 'text', text: 1–2000 chars }` | typed fallback and "Say something" |
| `mute` | `{ type: 'mute', muted: boolean }` | muted → `audioStreamEnd` |
| `interrupt` | `{ type: 'interrupt' }` | stop SARA's current answer |
| `confirm` / `reject` | `{ type: 'confirm' \| 'reject', actionId: string 1–60 }` | click on the card |
| `end` | `{ type: 'end' }` | graceful end |

zod: `z.discriminatedUnion('type', [...strictObject])` in `protocol.js`; `parseClientMessage(data, isBinary)` → `{ type:
'audio', data: Buffer }` or the parsed message, or throws `BAD_MESSAGE`.

### 4.2 Server → browser

`tool_call`, `tool_result`, `block` and `notice` carry the chat SSE payload unchanged in `data`, so the client folds them
with `reduceEvent(stream, type, data)` from `store/streamStore.js`.

| type | shape |
|---|---|
| `ready` | `{ sessionId, conversationId: string \| null, model, voice, language, mock, inputRate: 16000, outputRate: 24000, limits: { maxSessionMin, idleSec, maxTextChars }, pendingAction: publicAction \| null }` |
| binary | PCM16 LE mono 24 kHz, as Gemini sent it |
| `turn_start` | `{ turnId, conversationId, messageId, user: string \| null }` (`user` = typed text or `Confirmed: …` / `Rejected: …`; null for speech) |
| `transcript` | `{ turnId, role: 'user' \| 'assistant', text /* delta to append */, final }` (`final` only meaningful for the user) |
| `tool_call` | `{ turnId, data: { id, name, args } }` |
| `tool_result` | `{ turnId, data: { id, name, ok, summary, rowCount, ms, error? } }` |
| `block` | `{ turnId, data: { id, type, payload } }` (confirm cards are `type: 'confirm'` blocks) |
| `confirm` | `{ turnId: string \| null, action: publicAction }` (status `pending \| confirmed \| rejected \| expired`, `result`) |
| `notice` | `{ turnId: string \| null, data: { text } }` |
| `interrupted` | `{ turnId }` |
| `turn_complete` | `{ turnId, messageId, conversationId, status: 'complete' \| 'stopped' \| 'awaiting_confirmation' \| 'error', latencyMs }` |
| `usage` | `{ prompt, thoughts, candidates, total, audioSec: { in, out }, seconds }` (session totals) |
| `error` | `{ code, message, fatal: boolean }` |
| `closed` | `{ reason: 'ended' \| 'idle' \| 'max_duration' \| 'replaced' \| 'signed_out' \| 'error' \| 'server_shutdown', conversationId }` |

### 4.3 Errors and close codes

`error.code`: `BAD_MESSAGE`, `UNAUTHORIZED`, `VOICE_DISABLED`, `VOICE_BUSY`, `RATE_LIMITED`, `CONVERSATION_NOT_FOUND`,
`AI_QUOTA`, `AI_ERROR` (fatal, followed by `closed`), `ACTION_NOT_FOUND`, `ACTION_GONE`, `FORBIDDEN` (non-fatal).
Close codes (the client relies on `error`/`closed` first, codes as fallback): 1000 normal (`ended`, `idle`,
`max_duration`, `replaced`), 1001 `server_shutdown`, 1009 frame > `maxPayload` (sent by `ws`), 1011 internal, 4001
`UNAUTHORIZED` / `signed_out` / auth timeout, 4003 `VOICE_DISABLED`, 4004 `CONVERSATION_NOT_FOUND`, 4008 `BAD_MESSAGE` /
`RATE_LIMITED`, 4029 `VOICE_BUSY` / `AI_QUOTA`, 4502 `AI_ERROR`.

### 4.4 Limits — `voice/protocol.js`

```js
export const INPUT_RATE = 16_000; export const OUTPUT_RATE = 24_000;
export const FRAME_MIN_BYTES = 320; export const FRAME_MAX_BYTES = 8192;   // 10–256 ms of PCM16 at 16 kHz
export const MAX_JSON_BYTES = 16 * 1024;           // ws maxPayload
export const MAX_TEXT_CHARS = 2000;
export const AUTH_TIMEOUT_MS = 5000;
export const MAX_MSGS_PER_SEC = 100;               // audio is 25/s
export const MAX_STARTS_PER_MIN = 6;               // per user
export const IDLE_SEC = 90;
export const CONNECT_TIMEOUT_MS = 10_000;
export const RESUME_BUFFER_MS = 2000;
export const MAX_CLIENT_BUFFER = 1_000_000;        // bytes queued to a slow browser before audio is dropped
export const LATE_TRANSCRIPT_MS = 1500;
export const HEARTBEAT_MS = 20_000;
export const REVALIDATE_MS = 60_000;
```
Session length: `settings.voice.maxSessionMin` (default 10, 1–30). Concurrency: 1 per user (newest wins),
`settings.voice.maxConcurrent` server-wide (default 3). Reconnects: Gemini side by resumption (§3.5); browser side by the
client (§6.2), a new `start` with the same `conversationId`. Gemini ends connections with `goAway` (~10 min) and audio-only
sessions without compression (~15 min); compression + resumption cover both.

## 5. REST routes (`routes/voice.js`, mounted at `/api`, signed in)

| Route | Who | Response |
|---|---|---|
| `GET /api/voice/config` | any | `{ enabled: settings.voice.enabled && !ctx.company.isPlatform, mock: isVoiceMock(), voices: FEMALE_VOICES, languages: VOICE_LANGUAGES, defaults: { voice: settings.voice.voiceName, language: settings.voice.languageCode }, maxSessionMin }` |
| `GET /api/voice/models` | superAdmin (`requireSuperAdmin`) | `{ models: await listLiveModels(), voice: settings.voice }` |
| `PUT /api/admin/ai` | superAdmin | existing route; accepts `{ voice: { … } }` (§2.3) |
| WS `GET /api/voice` (Upgrade) | `start.token` | §4 |

## 6. Client

### 6.1 Audio — `client/src/voice/audio/**` (V:client-audio)

`captureWorklet.js`: an AudioWorklet module, self-contained (no imports), loaded with `import workletUrl from
'./captureWorklet.js?url'` and `context.audioWorklet.addModule(workletUrl)`:
```js
/** Streaming box-filter decimator: averages the input samples of each output period; state survives across chunks. */
export class Resampler { constructor(fromRate, toRate = 16000) {} push(float32) /* → Float32Array */ {} }
export const toPcm16 = (float32) => Int16Array;     // clamp to [-1, 1]; negative × 32768, positive × 32767, Math.round
export const rms = (float32) => number;
/** Hands out exact frames (640 samples = 40 ms at 16 kHz) whatever the input quantum. */
export class FrameBuffer { constructor(size = 640) {} push(float32) /* → Float32Array[] */ {} }
const Base = globalThis.AudioWorkletProcessor ?? class {};
class CaptureProcessor extends Base {
  // process(inputs): channel 0 → Resampler(sampleRate) → FrameBuffer →
  //   port.postMessage({ pcm: toPcm16(frame).buffer, level: rms(frame) }, [pcm]); return true
}
if (typeof registerProcessor === 'function') registerProcessor('sara-capture', CaptureProcessor);
```
`mic.js`:
```js
/** { ok: true } | { ok: false, reason: 'insecure' | 'no-media' | 'no-worklet' | 'no-websocket' } */
export const micSupport = () => {};
/** getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } }).
 *  Errors carry `code`: MIC_DENIED (NotAllowedError), NO_MIC (NotFoundError), MIC_ERROR. */
export const startMic = async ({ context, onFrame /* (ArrayBuffer, 1280 B) */, onLevel /* (0..1) */ }) => ({ setMuted(muted) {}, stop() {} });
```
The mic source connects to the worklet node only (never to `destination`); `stop()` stops every track.

`player.js`:
```js
export const LEAD_SEC = 0.06;
/** Gapless: a chunk starts where the previous ends, or LEAD_SEC from now after an underrun. */
export const scheduleChunk = ({ now, nextStart, duration, lead = LEAD_SEC }) => {
  const at = nextStart > now ? nextStart : now + lead;
  return { at, nextStart: at + duration };
};
/** Plays PCM16 LE mono chunks as AudioBuffers at `rate` on `context` (the browser resamples to its own rate). */
export const createPlayer = (context, { rate = 24000, onSpeaking } = {}) =>
  ({ enqueue(arrayBuffer) {}, stop() {}, get speaking() {}, level() /* 0..1 from an AnalyserNode */ {} });
/** Local barge-in: true once the mic level stays above `threshold` for `frames` frames in a row while SARA speaks. */
export const createBargeIn = ({ threshold = 0.06, frames = 3 } = {}) => (level, speaking) => false;
```
`stop()` stops and forgets every scheduled source and resets `nextStart`; `onSpeaking(true)` on the first chunk after
silence, `onSpeaking(false)` when the last source ends or on `stop()`. Samples are read with `Int16Array`
(`ponytail:` little-endian platforms; DataView if a big-endian client ever matters). One `AudioContext({ latencyHint:
'interactive' })`, created or resumed inside the click/shortcut gesture, serves both mic and player.

Latency targets (the server stores `AiMessage.latencyMs` per voice turn):

| Path | Target |
|---|---|
| click / shortcut → `ready` (mic permission already granted) | ≤ 2 s |
| end of speech → first SARA audio, no tool | p50 ≤ 1.2 s, p90 ≤ 2 s |
| same with one read tool | p50 ≤ 2.5 s |
| local barge-in → playback stopped | ≤ 150 ms |
| `interrupted` received → playback stopped | ≤ 50 ms |
| playback jitter lead | 60 ms |

### 6.2 Store and controller — `client/src/voice/useVoice.js` (V:client-ui)

```js
export const useVoice = create((set, get) => ({
  open: false, wide: false,
  phase: 'idle',               // idle | connecting | live | ended | error
  sessionId: null, conversationId: null, model: null, voice: null, language: null, mock: false, limits: null,
  startedAt: null, muted: false, textOnly: false, speaking: false,
  turns: [],                   // [{ id, user: { text, final }, assistant /* newMessage() shape + pendingAction */ }]
  usage: null, error: null /* { code, message } */, closedReason: null,
  toggle: (opts) => {},        // open + start, or end
  start: async ({ conversationId, context, qc, textOnly } = {}) => {},   // qc = useQueryClient() of the caller
  end: () => {}, sendText: (text) => {}, confirm: (actionId) => {}, reject: (actionId) => {},
  setMuted: (muted) => {}, interrupt: () => {}, setLanguage: (code) => {}, setVoice: (name) => {}, close: () => {},
}));
export const reduceVoice = (state, message) => state;   // pure: every §4.2 JSON message
export const phaseOf = (state) => 'idle';               // idle | connecting | listening | thinking | speaking | ended | error
export const voiceUrl = () => '';                       // apiUrl('/voice') resolved against location, http→ws / https→wss
export const voiceLevels = () => ({ mic: 0, sara: 0 }); // read by Orb in requestAnimationFrame (no re-render)
export const useVoiceConfig = () => {};                 // useQuery(['voice', 'config'], GET /voice/config, staleTime 5 min)
```
`reduceVoice`: `turn_start` appends `{ id, user: { text: user ?? '', final: user != null }, assistant: newMessage() }`;
`transcript` user → appends `text`, sets `final`; assistant → `reduceEvent(…, 'delta', { text })`; `tool_call` /
`tool_result` / `block` / `notice` → `reduceEvent(stream, type, data)` on that turn (`turnId: null` notices go to the last
turn); `confirm` → the turn's `assistant.pendingAction = action` (+ status `awaiting_confirmation` while pending);
`interrupted` → status `stopped`; `turn_complete` → `assistant.id = messageId`, `status`; `usage`; `error` (fatal → phase
`error`); `closed` → phase `ended`, `closedReason`. Unknown `turnId`s are ignored.
`phaseOf`: `listening` = live and nothing pending; `thinking` = an open turn with user text and no SARA audio yet;
`speaking` = player speaking.

Controller (`start`; the socket, mic, player and AudioContext live in module scope, never in the store):
1. `micSupport()`; `new AudioContext(…)` in the gesture. Unless `textOnly`: `startMic`; `MIC_DENIED` / `NO_MIC` → phase
   `error` with a "Use typing instead" action that calls `start({ textOnly: true })`.
2. `createPlayer(context, { onSpeaking })`; `createBargeIn()`.
3. `new WebSocket(voiceUrl())`, `binaryType = 'arraybuffer'`; on open send `start { token: getToken(), conversationId,
   language, voice, context: context ?? contextFromPath(location.pathname) }` (language / voice = the user's choice,
   kept in `localStorage` `voice.language` / `voice.voice`, try/catch).
4. JSON → `set(reduceVoice(get(), msg))` plus effects: `ready` → mic frames start flowing; `interrupted` → `player.stop()`
   and stop dropping; `turn_complete` → `qc.invalidateQueries(['conversation', conversationId])`, and `['conversations']`
   for a new conversation.
5. Binary → `player.enqueue(buf)` unless dropping. Barge-in: `bargeIn(level, player.speaking)` → `player.stop()` and drop
   incoming audio until `interrupted` or `turn_complete` (`interrupt` is NOT sent: Gemini's VAD decides).
6. Abnormal close (1006 / 1001) of a session live for > 3 s that the user did not end → one reconnect after 1.5 s with
   the same `conversationId` (notice "Reconnecting…"), else phase `error` (offline when `navigator.onLine === false`).
7. `end()` → send `end`, stop the mic, `player.stop()`; close the context after `closed` or 2 s. Language / voice changes
   while live restart the session on the same conversation. Signing out (`useSession()` → null) ends the session.

### 6.3 Panel, button, orb (V:client-ui)

`VoicePanel.jsx` (mounted once in `AppShell`): radix `Dialog` with `modal={false}`, no overlay,
`onInteractOutside={(e) => e.preventDefault()}` so the page stays usable while talking; Escape or × ends the session and
closes. Desktop: card fixed bottom-right `w-[min(26rem,calc(100vw-2rem))]`, max height `min(40rem, 100dvh − 6rem)`, a
"wide" toggle (`max-w-2xl`) for plan/table blocks; mobile: bottom sheet `max-h-[70dvh]`. It owns the shortcut:
**Ctrl/Cmd + Shift + Space** (`e.code === 'Space'`) toggles open + start / end (no conflict with ⌘J / ⌘K).
- Header: small `Orb`, "SARA", phase text, elapsed / max timer, language chip (`Select` of `VOICE_LANGUAGES`: Auto /
  हिन्दी …), voice menu (female voices with style), wide toggle, close.
- Body `role="log"`: per turn the user caption (italic until `final`) and `<MessageBubble message={turn.assistant}
  onConfirm={(_m, id) => confirm(id)} onReject={(id) => reject(id)} />` (tool trace, blocks via `BlockRenderer`,
  `ConfirmCard` with countdown); under a pending card: "Say yes or tap Confirm".
- Footer: large `Orb` as the mute toggle (`aria-pressed`), Stop (`interrupt`) while SARA speaks, End, typed input + Send
  (Enter), "Open in Chat" (`/chat/<conversationId>`). Mock mode (`ready.mock`): a hint "Mock mode: SARA can't hear audio;
  type or use Say something." and a **Say something** menu sending one of: `How many machines are running right now?`,
  `IMM 3 का vibration कैसा है?`, `How many open work orders?`, `Create a work order for Press 2: hydraulic leak, high
  priority`, `Yes, go ahead`, `Plan 5000 Housing-A parts due next Friday`.
- States: idle ("Talk to SARA"), connecting, listening ("Listening… ask anything"), thinking, speaking ("SARA is speaking
  — talk to interrupt"), ended (by reason: idle "Ended after 90 s of silence", max_duration "Session limit reached",
  replaced "Voice moved to another tab", signed_out, server_shutdown "SARA restarted"; actions Continue (same
  conversation) and Open in Chat), errors: MIC_DENIED ("Microphone blocked: allow it in the site settings next to the
  address bar, then try again" + Use typing instead), NO_MIC, unsupported ("This browser can't stream audio"), insecure
  ("Voice needs HTTPS or localhost"), offline, VOICE_BUSY, VOICE_DISABLED, AI_QUOTA / AI_ERROR (server message), each with
  Retry.
- Privacy line in the footer: "Audio isn't stored; transcripts are saved to your chat history."
- A11y: every control labelled; the last finished SARA sentence and phase changes announced in a `sr-only`
  `aria-live="polite"` region; initial focus on the mute control; Orb `aria-hidden`.

`VoiceButton.jsx({ conversationId, variant = 'header' | 'inline', className })`: `null` when `useVoiceConfig().data?.enabled`
is false or the company is the platform. Header: ghost icon button (`Mic`; spinner while connecting; `bg-ai/15 text-ai`
with a pulsing dot while live; `MicOff` + red dot on error), `aria-pressed`, `aria-keyshortcuts="Control+Shift+Space"`
(Meta on Mac), tooltip "Talk to SARA (Ctrl Shift Space)". Inline: "Continue by voice" `Button` that starts on
`conversationId`. Click → `toggle({ conversationId, qc })`.

`Orb.jsx({ phase, size: 'sm' | 'lg' })`: a round gradient (`--brand` → `--ai`) whose scale follows `voiceLevels()` (mic
level while listening, SARA level while speaking) through a CSS variable set in `requestAnimationFrame`; ring colour per
phase (listening teal, thinking slow pulse, speaking ai, error critical). Reduced motion (`matchMedia('(prefers-reduced-
motion: reduce)')`): no rAF, no scaling, the level shown as ring opacity steps. No `index.css` edits.

### 6.4 Superadmin → AI → Voice — `superadmin/AiTab.jsx` (V:client-ui)

New `Section id="ai-voice"` (icon `AudioLines`, title "Voice", description "SARA's spoken assistant on Gemini Live.
Female voices only; she answers in the speaker's language unless one is fixed.") after "Chat": Switch "Voice assistant"
(`voice.enabled`); Model and Fallback `Select`s from `GET /voice/models` (reuse `ModelOptions`; Fallback has None);
Voice `Select` from `GET /voice/config` voices as `Kore · Firm` (current value kept when unknown); Language `Select`
(`VOICE_LANGUAGES`); Max session (min, 1–30); Concurrent sessions (1–50); help: "Each voice connection counts as one
request of its model's quota (see Quotas). Audio is never stored." `modelsInUse` adds `settings?.voice?.model` and
`settings?.voice?.fallback`; `QuotaRow` shows `audioMin` when > 0. Saved by the existing Save (`PUT /admin/ai`). The
section works with `draft.voice` missing and with `/voice/*` failing (selects show the current value only) and never
writes the draft on mount.

## 7. Security and privacy

- Key: only the server reads `GEMINI_API_KEY`; the Live URL carries it, so it is never logged, returned or sent.
- Upgrade: exact path, Origin allow-list (`CLIENT_URL`), no auth in the URL or cookies; JWT in the first message within
  5 s, verified exactly as REST (`userFromToken`: signature, live `sessions` doc, active user, fresh `ctx`); revalidated
  every 60 s and at token expiry.
- Limits: `maxPayload` 16 KiB, frame sizes, ≤ 100 messages/s, ≤ 6 starts/min/user, typed text under the chat rate,
  1 session per user, `maxConcurrent` server-wide, `maxSessionMin`, 90 s idle, heartbeat.
- Tools: the chat's registry, `toolsFor` permission filter and runtime re-check, `records.js` tenancy, validators,
  `ai_tool_audit` row per call; writes only through pending actions; voice confirmation needs the latest pending action
  of the session and a later user turn; claim re-checks expiry and permission; App notes come only from the server.
- Privacy: audio is never stored or logged; transcripts are stored as the user's own `ai_messages` (deleted with the
  conversation); logs hold ids and counts only. Mic capture runs only while a session is live; the header button shows
  it.
- Platform (superadmin) accounts get no voice (no company data).

## 8. Tests per package

| Package | Files → must cover |
|---|---|
| V:server | `voice-protocol.test.js` (pure): every §4.1 shape parses; rejects unknown type, extra keys, text > 2000, voice `Puck` (male), unlisted language, bad `conversationId`, binary odd / < 320 / > 8192 B; `buildLiveConfig` exact shape (no `thinkingConfig` / `languageCode`; `handle` → `sessionResumption.handle`); `addLiveUsage` maps `responseTokenCount`; `normalizeUsage({ responseTokenCount: 7 }).candidates === 7`; `buildVoicePrompt` has `VOICE_STYLE`, the fixed-language line for `hi-IN`, recent turns, the pending line. `voice-session.test.js` (Mongo; `_setLiveClient(fakeLive.client)`; fake socket): (1) `ready` + connect config: `voiceDeclarations(ownerCtx)` count = `toolsFor(all) − load_tools + 2` and ≤ `MAX_VOICE_TOOLS`, `voiceName`, transcription configs, system with `VOICE_STYLE` and the page-context line; (2) audio both ways (base64 + mimeType in, decoded binary out, dropped before `ready`, mute → `audioStreamEnd`); (3) a spoken turn → `turn_start`, transcripts, `turn_complete`; user + assistant `ai_messages` (`channel` voice, `tier` voice, text, text part, gemini ending with model text), conversation `voice: true` + title, `latencyMs`; (4) read tool → `tool_call` / `tool_result`, `sendToolResponse [{ id, name, response: { ref, result } }]`, audit row, stored call (skip signature) + response; (5) write by voice: `create_record` → confirm block + `confirm` pending + live `awaiting_confirmation`, message `awaiting_confirmation` with the call unanswered in `gemini`; `confirm_action` in the same turn refused; wrong id refused; next turn right id → work order created, toolResponse `confirmed`, action message gets tool_result + notice + step response, `pendingAction.via` voice; (6) click confirm → same + user message `Confirmed: …` + App-note text sent; voice reject → nothing created, status rejected; (7) a viewer's write → permission error, no pending action; (8) `toolCallCancellation` → no response for those ids; (9) `interrupted` → event + status stopped; browser `interrupt` → audio no longer forwarded; (10) budget: `limits[voice model] = { rpm: 1, rpd: 1 }`, no fallback → second start `error AI_QUOTA` fatal + `closed`; `ai_usage` rows `purpose: 'voice'` (`ok`, `blocked`) with `audioSec`; (11) primary fails (`failNext({ close: { code: 1008, reason: 'model not found' } })`) → fallback model + notice; (12) `goAway` with a resumable handle → second connect has `sessionResumption.handle`, audio flows to it; (13) fake timers: notice at max − 1 min then `closed max_duration`; 90 s idle → `closed idle`; expired `sessions` doc → `closed signed_out`; (14) after 4–6, `buildContents(conversation)` is valid: every model content with calls is followed by a user content answering each call by id, no orphan response. `voice-ws.test.js` (real `http.Server` on port 0 + `createApp({ routers: [{ path: '/api', router: voiceRouter }] })` + `attachVoiceServer`, `ws` client with `origin`, fakeLive): wrong path destroyed; bad Origin 403; no `start` in time → 4001; bad token → `UNAUTHORIZED` + 4001; valid → `ready`; same user twice → first `closed replaced`; `maxConcurrent: 1` + another user → `VOICE_BUSY` 4029; > 100 msgs/s → 4008; `GET /api/voice/config` shape; `GET /api/voice/models` 403 for an owner, the mock list for the superadmin. `helpers/fakeLive.js`: `createFakeLive()` → `{ client, sessions, last(), failNext(...errOrClose) }` + message builders (`hear`, `say`, `toolCall`, `turnComplete`, `interrupted`, `usage`, `goAway`, `resumable`); a fake session records `sendRealtimeInput` / `sendToolResponse` / `close` and `emit(msg)` calls `callbacks.onmessage` |
| V:mock | `mock-live.test.js` (no Mongo, `mockLiveTiming.chunkMs = 0`): connect / close once; text → message order (transcription chunks, `inlineData` `audio/pcm;rate=24000` decoding to `toneFor` samples, `generationComplete`, `usageMetadata`, `turnComplete`, `sessionResumptionUpdate`); a `script()` with calls → `toolCall` ids, continues after `sendToolResponse`; awaiting response → "Shall I go ahead?"; `yes` / `हाँ` / `haan ji` → `confirm_action`, `no` / `नहीं` → `reject_action`; audio ignored; text mid-turn → `interrupted` + `turnComplete`; `toneFor` length, \|sample\| ≤ 0.06 × 32767, near-zero first/last samples; `spoken` strips markdown, caps 400; machines-running flow calls `mongo_aggregate` on `assets`. `voice-mock-e2e.test.js` (Mongo, real ws on port 0, no injection → mockLive, demo flows off, `script()`): owner session; "how many open work orders" (script → `work_orders_summary` → "You have N open work orders.") → `turn_start`, `tool_call`, `tool_result`, transcript, ≥ 1 binary frame, `turn_complete`, voice `ai_messages`; "Create a work order for Press 2: hydraulic leak, high priority" (script → `resolve` + `create_record`) → confirm card; "yes" → `confirm_action` → workorders +1, card confirmed; `end` → `closed ended` + `ai_usage` `purpose: 'voice'`, `status: 'mock'` |
| V:client-audio | `capture.test.js`: 48 k → 16 k length N/3 across arbitrary chunk splits; DC 0.5 kept; 1 kHz sine RMS ratio > 0.95 and same zero-crossing rate; 12 kHz sine (above the 8 kHz Nyquist) RMS ratio < 0.4; 44.1 k → 16 k length within ±1 of N·16000/44100; `toPcm16` (−1 → −32768, 1 → 32767, 2 → 32767, 0.5 → 16384); `FrameBuffer` turns 128-sample quanta into exact 640-sample frames; the module imports outside an AudioWorkletGlobalScope. `player.test.js`: `scheduleChunk` (first at now + lead, contiguous, re-lead after an underrun); `createPlayer` on a fake AudioContext (`currentTime`, `createBuffer`, `createBufferSource`, `createAnalyser`): back-to-back starts, durations = samples / 24000, `stop()` stops all and resets, `onSpeaking` transitions; `createBargeIn` fires only after `frames` loud frames in a row while speaking |
| V:client-ui | `voice.test.jsx`: `reduceVoice` for every §4.2 message and `phaseOf`; `VoicePanel` with `vi.mock('./audio/mic.js')`, `vi.mock('./audio/player.js')`, `vi.stubGlobal('WebSocket', FakeSocket)` and an AudioContext stub: start sends `start` with the token and the page context; `ready` → listening; captions render; Confirm on the card sends `{ type: 'confirm', actionId }`; typed text sends `{ type: 'text' }`; mock `ready` shows Say something and sends a canned text; mic denied → message + Use typing instead → text-only start; insecure / unsupported / offline messages; reduced motion → Orb without rAF scaling; Ctrl+Shift+Space toggles; `VoiceButton` hidden when `enabled` is false. `aiTabVoice.test.jsx`: the Voice section renders from `/admin/ai`, `/voice/config`, `/voice/models` (fetch mock as in `aiTab.test.jsx`), the voice select offers exactly the 14 female voices with styles, Save sends `voice: { … }`. `client/src/anomalies/aiTab.test.jsx` stays green unchanged |

## 9. Demo script

**Real run** (`AI_MOCK=false`, a working key, credits): put the key in `.env`, set `AI_MOCK=false`, restart the API.
Superadmin → AI → Voice: enabled, model and fallback from the list, voice Kore, language Auto, 10 min; Quotas: RPM/RPD of
the voice model. Chrome on `http://localhost:5173` (or HTTPS), a headset (echo cancellation is good, a headset is better).
1. Owner (Vikram Mehta) → Ctrl+Shift+Space (or the mic in the header) → allow the microphone → "Listening".
2. "SARA, how many machines are running right now?" → `mongo_aggregate` / `mongo_count` on `assets` by `assetStatus`
   (or `telemetry_latest`) → KPI tiles on screen; spoken: "Twelve of your twenty machines are running right now; three
   are idle and five are stopped." Talk over her to show barge-in.
3. Hindi: "IMM 3 का vibration कैसा है?" → `resolve` IMM 3 → `telemetry_latest` / `machine_health` → answer in Hindi with
   the unit ("IMM 3 का वाइब्रेशन अभी 4.2 मिलीमीटर प्रति सेकंड है, सामान्य सीमा में।") + tiles or a chart; the language
   chip stays Auto.
4. "Create a work order for Press 2 hydraulic leak, high priority" → `resolve` Press 2 → `create_record` preview →
   confirm card; spoken "I'll create a high-priority work order, hydraulic leak on Press 2. Shall I go ahead?" → "Yes,
   go ahead" → `confirm_action` → "Done, work order WO-n is created." The card turns Confirmed; the WO is in Work orders.
5. "Plan 5000 Housing-A parts due next Friday" → `resolve_time_range` → `plan_production` (+ `check_plan`) → plan block
   on screen; spoken verdict ("Doable: three job cards on IMM 5, IMM 3 and IMM 1, finishing on <day> with <n> hours to
   spare. Shall I create it?") → `apply_plan` card → "haan, kar do" → plan created (PP-n).
6. Open in Chat → the conversation has the mic badge, the captions as messages, tool trace, blocks and confirmed cards;
   type "export that list" to show text continues the same conversation.

**Mock rehearsal** (`AI_MOCK=true`, no credits; the mock ignores audio and answers with a soft tone): open the panel and
use Say something in order: How many machines are running right now? → IMM 3 का vibration कैसा है? (English reply) →
Create a work order for Press 2: hydraulic leak, high priority → Yes, go ahead → Plan 5000 Housing-A parts due next
Friday → Yes, go ahead → Open in Chat.

## 10. Integrator checklist

Step 0 is §1.1. After the builders:
1. `server/src/index.js`: import `attachVoiceServer` (`./voice/server.js`) and `voiceRouter` (`./routes/voice.js`); mount
   `{ path: '/api', router: voiceRouter }`; after `app.listen` resolves, `const voice = attachVoiceServer(server);`; in
   `shutdown`, `voice.close().finally(() => server.close(() => process.exit(0)))` instead of the bare `server.close`
   (upgraded sockets are not covered by `closeAllConnections`; the existing 10 s exit timer still bounds it).
2. `server/src/routes/conversations.js`: `publicConversation` + `voice: Boolean(c.voice)`; `publicMessage` + `channel:
   m.channel ?? 'text'`.
3. `client/vite.config.js`: `'/api': { target, changeOrigin: true, ws: true }` (Vite restarts itself).
4. `client/nginx.conf`, before `location /api/`:
   ```
   # Voice: WebSocket upgrade to the server (sessions last up to Superadmin → AI → Voice max minutes).
   location = /api/voice {
     proxy_pass http://server:5080;
     proxy_http_version 1.1;
     proxy_set_header Upgrade $http_upgrade;
     proxy_set_header Connection "upgrade";
     proxy_set_header Host $host;
     proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
     proxy_set_header X-Forwarded-Proto $scheme;
     proxy_read_timeout 1h;
     proxy_send_timeout 1h;
   }
   ```
5. `client/src/layout/Header.jsx`: `import { VoiceButton } from '../voice/VoiceButton.jsx';` and `{!ctx.company.isPlatform
   && <VoiceButton />}` right before `<AskSara shortcut />`.
6. `client/src/layout/AppShell.jsx`: `<VoicePanel />` inside the `company &&` fragment, next to `<AssistantDrawer />`.
7. `client/src/chat/ConversationList.jsx` row: `item.voice` → `<Mic className="size-3.5 shrink-0 text-ai"
   aria-label="Voice conversation" />` before the title. `chat/MessageBubble.jsx` `UserBubble`: `message.channel ===
   'voice'` → a small `Mic` icon + sr-only "Spoken". `chat/ChatPage.jsx`: `<VoiceButton conversationId={id}
   variant="inline" />` in the thread header when `id`; Shortcuts list `` ['Talk to SARA', `${MOD_KEY} Shift Space`] ``.
8. Routes / nav: none (no page; the header button and the shortcut are the entry points).
9. Docs: `README.md` (AI table: voice under `AI_MOCK`; a Voice section: entry points, HTTPS or localhost for the mic,
   headset tip, models from Superadmin), `docs/system-design.md` §5 "Voice (Gemini Live proxy)", `docs/demo-script.md`
   voice segment (§9).
10. Full suite: `SARA_TEST_DB=p8int npx vitest run --maxWorkers=2` in `server`, `pnpm --filter client test`, `pnpm lint`.
    Then the user tries the mock rehearsal in the running dev stack (the API reloads on `src` changes; `.env` changes
    need the user's restart).

## 11. Open questions

1. The Gemini key in `.env` is rejected (401 "API key not valid"), so the Live model ids in D11 are unverified. Before a
   real demo: a working AI Studio key, then pick the models in Superadmin → AI → Voice (the list call is free).
2. Defaults to confirm: voice Kore, language Auto, 10-minute sessions, 3 concurrent sessions, 90 s idle end.
3. Viewers (read-only role) get voice with read-only tools, like chat. Keep?
