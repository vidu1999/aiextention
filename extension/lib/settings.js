// User settings are kept in chrome.storage.local (never sent anywhere except
// the API endpoint the user configured).

export const DEFAULT_SETTINGS = {
  baseUrl: 'http://localhost:8000/v1',
  apiKey: '',
  model: '',
};

export function normalizeSettings(input = {}) {
  return {
    baseUrl: String(input.baseUrl ?? DEFAULT_SETTINGS.baseUrl).trim().replace(/\/+$/, ''),
    apiKey: String(input.apiKey ?? '').trim(),
    model: String(input.model ?? '').trim(),
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
