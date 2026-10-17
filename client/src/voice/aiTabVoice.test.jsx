import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AiTab, modelsInUse } from '../superadmin/AiTab.jsx';

const FEMALE_VOICES = [
  ['Kore', 'Firm'],
  ['Aoede', 'Breezy'],
  ['Zephyr', 'Bright'],
  ['Leda', 'Youthful'],
  ['Callirrhoe', 'Easy-going'],
  ['Autonoe', 'Bright'],
  ['Despina', 'Smooth'],
  ['Erinome', 'Clear'],
  ['Laomedeia', 'Upbeat'],
  ['Achernar', 'Soft'],
  ['Gacrux', 'Mature'],
  ['Pulcherrima', 'Forward'],
  ['Vindemiatrix', 'Gentle'],
  ['Sulafat', 'Warm'],
].map(([name, style]) => ({ name, style }));
const LANGUAGES = [
  { code: 'auto', label: 'Auto (match the speaker)' },
  { code: 'hi-IN', label: 'हिन्दी · Hindi' },
  { code: 'en-IN', label: 'English (India)' },
];
const VOICE = {
  enabled: true,
  model: 'gemini-3.1-flash-live-preview',
  fallback: 'gemini-2.5-flash-native-audio-preview-12-2025',
  voiceName: 'Kore',
  languageCode: 'auto',
  maxSessionMin: 10,
  maxConcurrent: 3,
};
const settings = (voice) => ({
  tiers: { balanced: { model: 'gemini-3.8-flash', thinkingLevel: 'medium', fallback: null } },
  limits: {},
  chatReservePct: 40,
  showThoughts: true,
  anomaly: { enabled: false },
  costWatch: { enabled: false },
  ...(voice ? { voice } : {}),
});

let fx;
const reply = (status, data) => ({ ok: status < 400, status, json: async () => data });
const fetchMock = vi.fn(async (url, init = {}) => {
  const path = String(url).replace(/^.*?\/api/, '');
  const method = init.method ?? 'GET';
  if (path === '/admin/ai' && method === 'GET') {
    return reply(200, {
      settings: fx.settings,
      apiKeyConfigured: false,
      mock: true,
      quotaStretch: { at: 1, factor: 1 },
    });
  }
  if (path === '/admin/ai' && method === 'PUT') return reply(200, { settings: JSON.parse(init.body) });
  if (path === '/admin/ai/models') return reply(200, { models: [{ id: 'gemini-3.8-flash', thinking: [] }] });
  if (path === '/admin/ai/usage') return reply(200, { day: '2026-10-17', models: fx.usage });
  if (fx.voiceDown && path.startsWith('/voice/'))
    return reply(500, { error: { message: 'Voice routes down' } });
  if (path === '/voice/config') {
    return reply(200, {
      enabled: false,
      mock: true,
      voices: FEMALE_VOICES,
      languages: LANGUAGES,
      defaults: {},
    });
  }
  if (path === '/voice/models') {
    return reply(200, {
      models: [
        { id: 'gemini-3.1-flash-live-preview', displayName: 'Flash Live' },
        { id: 'gemini-2.5-flash-native-audio-preview-12-2025', displayName: 'Native audio' },
        { id: 'gemini-2.5-flash-native-audio-preview-09-2025', displayName: 'Native audio (Sep)' },
      ],
      voice: VOICE,
    });
  }
  return reply(404, { error: { message: `Unexpected ${method} ${path}` } });
});

const renderTab = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RouterProvider router={createMemoryRouter([{ path: '*', element: <AiTab /> }])} />
    </QueryClientProvider>,
  );
const voiceSection = async () => (await screen.findByRole('heading', { name: 'Voice' })).closest('section');
const putBody = () => {
  const call = fetchMock.mock.calls.find(
    ([u, i = {}]) => String(u).endsWith('/api/admin/ai') && i.method === 'PUT',
  );
  return call && JSON.parse(call[1].body);
};

beforeEach(() => {
  fx = { settings: settings(VOICE), usage: [], voiceDown: false };
  localStorage.setItem('token', 'test-token');
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  fetchMock.mockClear();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('AI tab → Voice', () => {
  it('counts the voice models as models in use', () => {
    expect(modelsInUse(settings(VOICE))).toEqual(
      expect.arrayContaining([VOICE.model, VOICE.fallback, 'gemini-3.8-flash']),
    );
    expect(modelsInUse(settings())).toEqual(['gemini-3.8-flash']);
  });

  it('renders from /admin/ai, /voice/config and /voice/models and saves voice changes', async () => {
    fx.usage = [{ model: VOICE.model, calls: 4, tokens: 900, audioMin: 3.5, limits: { rpm: 5, rpd: 50 } }];
    renderTab();
    const section = within(await voiceSection());
    const voice = section.getByLabelText("SARA's voice");
    await within(voice).findByText('Kore · Firm');
    expect(
      within(voice)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(FEMALE_VOICES.map((v) => `${v.name} · ${v.style}`));
    const model = section.getByLabelText('Voice model');
    await within(model).findByText('gemini-2.5-flash-native-audio-preview-09-2025');
    expect(within(section.getByLabelText('Voice language')).getByText('हिन्दी · Hindi')).toBeTruthy();
    expect(screen.getByText('3.5 min of audio')).toBeTruthy();
    expect(screen.queryByText('You have unsaved changes.')).toBeNull();

    fireEvent.change(voice, { target: { value: 'Aoede' } });
    fireEvent.change(model, { target: { value: 'gemini-2.5-flash-native-audio-preview-09-2025' } });
    fireEvent.change(section.getByLabelText('Voice fallback model'), { target: { value: '' } });
    fireEvent.change(section.getByLabelText('Voice language'), { target: { value: 'hi-IN' } });
    fireEvent.change(section.getByLabelText('Max session'), { target: { value: '15' } });
    fireEvent.change(section.getByLabelText('Concurrent sessions'), { target: { value: '5' } });
    fireEvent.click(section.getByLabelText('Voice assistant'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await vi.waitFor(() => expect(putBody()).toBeTruthy());
    expect(putBody().voice).toEqual({
      enabled: false,
      model: 'gemini-2.5-flash-native-audio-preview-09-2025',
      fallback: null,
      voiceName: 'Aoede',
      languageCode: 'hi-IN',
      maxSessionMin: 15,
      maxConcurrent: 5,
    });
  });

  it('works without draft.voice and with /voice/* failing', async () => {
    fx.settings = settings();
    fx.voiceDown = true;
    renderTab();
    const section = within(await voiceSection());
    await section.findByText(/Couldn't list voice models/);
    const voice = section.getByLabelText("SARA's voice");
    expect(
      within(voice)
        .getAllByRole('option')
        .map((o) => o.value),
    ).toEqual(['Kore']);
    expect(
      within(section.getByLabelText('Voice language'))
        .getAllByRole('option')
        .map((o) => o.value),
    ).toEqual(['auto']);
    expect(screen.queryByText('You have unsaved changes.')).toBeNull();
    fireEvent.change(section.getByLabelText('Max session'), { target: { value: '20' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await vi.waitFor(() => expect(putBody()).toBeTruthy());
    expect(putBody().voice).toEqual({ maxSessionMin: 20 });
  });
});
