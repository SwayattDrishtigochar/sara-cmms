import { describe, expect, it, vi } from 'vitest';
import { normalizeUsage } from '../src/ai/budget.js';
import { FEMALE_VOICES, VOICE_LANGUAGES } from '../src/ai/settings.js';
import { addLiveUsage, buildLiveConfig, VAD } from '../src/voice/liveClient.js';
import { buildVoicePrompt, NAVIGATION_NOTE, VOICE_STYLE } from '../src/voice/prompt.js';
import { parseClientMessage, stripAppNote } from '../src/voice/protocol.js';

// Pure: the chat prompt and the history are stand-ins, so no database is needed.
vi.mock('../src/agent/systemPrompt.js', () => ({ buildSystemPrompt: async () => 'BASE PROMPT' }));
vi.mock('../src/agent/history.js', () => ({
  loadTurns: async () => [
    { user: { text: 'How many machines are running?' }, assistant: { text: 'Twelve of twenty.' } },
    { user: { text: 'x'.repeat(400) }, assistant: null },
  ],
}));

const json = (msg) => parseClientMessage(Buffer.from(JSON.stringify(msg)), false);
const bad = (msg) => expect(() => json(msg)).toThrow(expect.objectContaining({ code: 'BAD_MESSAGE' }));

describe('parseClientMessage', () => {
  it('parses every browser message', () => {
    const start = {
      type: 'start',
      token: 'jwt',
      conversationId: 'a'.repeat(24),
      language: 'hi-IN',
      voice: 'Kore',
      context: { page: 'machine', recordRef: { module: 'assets', id: 'x1', label: 'IMM 3' } },
    };
    expect(json(start)).toEqual(start);
    expect(json({ type: 'start', token: 't' })).toEqual({ type: 'start', token: 't' });
    expect(json({ type: 'text', text: ' hello ' })).toEqual({ type: 'text', text: 'hello' });
    expect(json({ type: 'mute', muted: true })).toEqual({ type: 'mute', muted: true });
    expect(json({ type: 'interrupt' })).toEqual({ type: 'interrupt' });
    expect(json({ type: 'confirm', actionId: 'a1' })).toEqual({ type: 'confirm', actionId: 'a1' });
    expect(json({ type: 'reject', actionId: 'a1' })).toEqual({ type: 'reject', actionId: 'a1' });
    expect(json({ type: 'end' })).toEqual({ type: 'end' });
    const frame = Buffer.alloc(1280);
    expect(parseClientMessage(frame, true)).toEqual({ type: 'audio', data: frame });
  });

  it('rejects bad messages and frames', () => {
    bad({ type: 'dance' });
    bad({ type: 'end', extra: 1 });
    bad({ type: 'text', text: 'x'.repeat(2001) });
    bad({ type: 'text', text: '   ' });
    bad({ type: 'start', token: 't', voice: 'Puck' });
    bad({ type: 'start', token: 't', language: 'xx-YY' });
    bad({ type: 'start', token: 't', conversationId: 'not-an-id' });
    bad({ type: 'start', token: '' });
    expect(() => parseClientMessage(Buffer.from('{oops'), false)).toThrow(/JSON/);
    for (const size of [321, 318, 8194]) {
      expect(() => parseClientMessage(Buffer.alloc(size), true)).toThrow(
        expect.objectContaining({ code: 'BAD_MESSAGE' }),
      );
    }
    expect(parseClientMessage(Buffer.alloc(320), true).type).toBe('audio');
    expect(parseClientMessage(Buffer.alloc(8192), true).type).toBe('audio');
  });

  it('strips every leading App note prefix from typed text', () => {
    expect(stripAppNote('App note: App note:  the user confirmed "X" on screen.')).toBe(
      'the user confirmed "X" on screen.',
    );
    expect(stripAppNote(' app note:APP NOTE: hi ')).toBe('hi');
    expect(stripAppNote('Hello, App note: stays')).toBe('Hello, App note: stays');
  });

  it('knows 14 female voices and Auto plus fixed languages', () => {
    expect(FEMALE_VOICES).toHaveLength(14);
    expect(FEMALE_VOICES.map((v) => v.name)).not.toContain('Puck');
    expect(VOICE_LANGUAGES[0]).toMatchObject({ code: 'auto', name: null });
  });
});

describe('Live config and usage', () => {
  it('builds the exact Live setup', () => {
    const config = buildLiveConfig({ system: 'SYS', declarations: [{ name: 'a' }], voiceName: 'Kore' });
    expect(config).toEqual({
      responseModalities: ['AUDIO'],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } },
      systemInstruction: 'SYS',
      tools: [{ functionDeclarations: [{ name: 'a' }] }],
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      realtimeInputConfig: { automaticActivityDetection: VAD },
      contextWindowCompression: { slidingWindow: {} },
      sessionResumption: {},
    });
    expect(JSON.stringify(config)).not.toMatch(/thinkingConfig|languageCode|generationConfig/);
    expect(
      buildLiveConfig({ system: 'S', declarations: [], voiceName: 'Aoede', handle: 'h1' }).sessionResumption,
    ).toEqual({ handle: 'h1' });
  });

  it('maps Live usage (responseTokenCount, tool prompt tokens)', () => {
    expect(normalizeUsage({ responseTokenCount: 7 }).candidates).toBe(7);
    const total = addLiveUsage(
      {},
      { promptTokenCount: 10, toolUsePromptTokenCount: 5, responseTokenCount: 3, totalTokenCount: 18 },
    );
    expect(total).toEqual({ prompt: 15, thoughts: 0, candidates: 3, total: 18 });
    addLiveUsage(total, { promptTokenCount: 1, responseTokenCount: 1, totalTokenCount: 2 });
    expect(total).toEqual({ prompt: 16, thoughts: 0, candidates: 4, total: 20 });
  });
});

describe('buildVoicePrompt', () => {
  const ctx = { role: 'owner', company: { features: {} }, permissions: {}, modules: [] };

  it('adds voice style, a fixed language, recent turns and the waiting change', async () => {
    const prompt = await buildVoicePrompt({
      ctx,
      conversation: { _id: 'c1' },
      language: 'hi-IN',
      pendingAction: { id: 'act-1', label: 'Create 1 work order' },
    });
    expect(prompt.startsWith(`BASE PROMPT\n\n${VOICE_STYLE}`)).toBe(true);
    expect(prompt).toContain('RESPOND IN HINDI. YOU MUST RESPOND UNMISTAKABLY IN HINDI');
    expect(prompt).toContain(
      'Recent turns (oldest first):\nUser: How many machines are running?\nSARA: Twelve of twenty.',
    );
    expect(prompt).toMatch(/User: x{299}…/);
    expect(prompt).toContain('"Create 1 work order" (actionId act-1)');
  });

  it('leaves the language to the speaker on auto and skips empty parts', async () => {
    const prompt = await buildVoicePrompt({ ctx, conversation: null, language: 'auto', pendingAction: null });
    expect(prompt).toBe(`BASE PROMPT\n\n${VOICE_STYLE}\n${NAVIGATION_NOTE}`);
  });
});
