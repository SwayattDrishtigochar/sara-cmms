import { Router } from 'express';
import { listLiveModels } from '../ai/models.js';
import { FEMALE_VOICES, getAiSettings, VOICE_LANGUAGES } from '../ai/settings.js';
import { requireSuperAdmin } from '../auth/middleware.js';
import { isVoiceMock } from '../voice/liveClient.js';

/** Voice assistant settings for the client and the Superadmin model list (phase 8 §5); mounted at /api. */
export const voiceRouter = Router();

voiceRouter.get('/voice/config', async (req, res) => {
  const { voice } = await getAiSettings();
  res.json({
    enabled: Boolean(voice.enabled) && !req.ctx.company?.isPlatform,
    mock: isVoiceMock(),
    voices: FEMALE_VOICES,
    languages: VOICE_LANGUAGES,
    defaults: { voice: voice.voiceName, language: voice.languageCode },
    maxSessionMin: voice.maxSessionMin,
  });
});

voiceRouter.get('/voice/models', requireSuperAdmin, async (_req, res) => {
  const [models, { voice }] = await Promise.all([listLiveModels(), getAiSettings()]);
  res.json({ models, voice });
});
