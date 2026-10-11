// User settings are kept in chrome.storage.local. The API key and Azure key are
// only sent to the endpoints the user configured.

export const DEFAULT_SPEECH = {
  engine: 'azure', // 'azure' (neural, best for Sinhala) or 'browser'
  azureKey: '',
  azureRegion: '',
  voice: 'si-LK-ThiliniNeural',
  rate: -5, // slightly slower than normal, like a teacher
  autoSpeak: false, // "Oral mode": speak every answer
};

export const DEFAULT_SETTINGS = {
  baseUrl: 'http://localhost:8000/v1',
  apiKey: '',
  model: '',
  language: 'si', // language of replies: 'si' (Sinhala) or 'en'
  speech: DEFAULT_SPEECH,
};

function clampRate(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_SPEECH.rate;
  return Math.max(-50, Math.min(50, Math.round(n)));
}

export function normalizeSettings(input = {}) {
  const speech = { ...DEFAULT_SPEECH, ...(input.speech || {}) };
  return {
    baseUrl: String(input.baseUrl ?? DEFAULT_SETTINGS.baseUrl).trim().replace(/\/+$/, ''),
    apiKey: String(input.apiKey ?? '').trim(),
    model: String(input.model ?? '').trim(),
    language: input.language === 'en' ? 'en' : 'si',
    speech: {
      engine: speech.engine === 'browser' ? 'browser' : 'azure',
      azureKey: String(speech.azureKey ?? '').trim(),
      azureRegion: String(speech.azureRegion ?? '').trim().toLowerCase().replace(/\s+/g, ''),
      voice: String(speech.voice ?? DEFAULT_SPEECH.voice).trim() || DEFAULT_SPEECH.voice,
      rate: clampRate(speech.rate),
      autoSpeak: Boolean(speech.autoSpeak),
    },
  };
}

export async function loadSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return normalizeSettings({ ...DEFAULT_SETTINGS, ...(settings || {}) });
}

export async function saveSettings(settings) {
  const clean = normalizeSettings(settings);
  await chrome.storage.local.set({ settings: clean });
  return clean;
}
