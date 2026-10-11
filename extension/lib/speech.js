// Oral output: the teacher reads answers aloud.
// Engines (speech.engine in Settings):
//   'free'    (default) Edge neural Thilini voice (no key) -> Google voice -> device voice
//   'azure'   Azure AI Speech neural voice (paid, optional, needs your own key)
//   'browser' the device's own voices only (works offline if Sinhala is installed)

import { SpeechError } from './errors.js';
import { synthesizeEdge, synthesizeGoogle } from './edgetts.js';

export { SpeechError };

export const ENGINES = ['free', 'azure', 'browser'];
export const DEFAULT_ENGINE = 'free';
export const FREE_CHUNK_CHARS = 180; // Google's free voice rejects longer requests
export const AZURE_CHUNK_CHARS = 500;
export const EDGE_RETRY_MS = 10 * 60 * 1000; // after a failure, skip the Edge voice for 10 minutes

export function normalizeEngine(value) {
  return ENGINES.includes(value) ? value : DEFAULT_ENGINE;
}

export const SINHALA_VOICES = {
  'si-LK-ThiliniNeural': 'Thilini (female teacher)',
  'si-LK-SameeraNeural': 'Sameera (male)',
};

export const DEFAULT_VOICE = 'si-LK-ThiliniNeural';
export const SPEECH_LANG = 'si-LK';
export const AZURE_OUTPUT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3';
const VOICE_NAME = /^[a-z]{2,3}(-[A-Za-z0-9]+)+Neural$/;
const SENTENCE_END = /(?<=[.!?।\u0964])\s+|\n+/;

/* ---------- text preparation ---------- */

// Removes Markdown and symbols so the voice reads words, not formatting.
export function stripForSpeech(markdown) {
  let s = String(markdown ?? '').replace(/\r\n?/g, '\n');
  s = s.replace(/```[\s\S]*?(```|$)/g, ' '); // code blocks, including unterminated ones
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, ' '); // images
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1'); // links keep their text
  s = s.replace(/https?:\/\/\S+/g, ' '); // bare URLs
  s = s.replace(/`([^`]*)`/g, '$1');
  s = s.replace(/^\s*\|?[\s:|-]+\|[\s:|-]*$/gm, ' '); // table separator rows
  s = s.replace(/\|/g, ' ');
  s = s.replace(/^\s{0,3}#{1,6}\s+/gm, ''); // headings
  s = s.replace(/^\s*>\s?/gm, ''); // quotes
  s = s.replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, ''); // list markers
  s = s.replace(/^\s*(?:[-*_]\s*){3,}$/gm, ' '); // horizontal rules
  s = s.replace(/(\*\*|__)(.+?)\1/g, '$2'); // bold
  s = s.replace(/(^|[\s(])[*_]([^*_\n]+)[*_](?=[\s).,!?:;]|$)/g, '$1$2'); // italics
  s = s.replace(/[*#_~<>{}[\]\\^]/g, ' ');
  s = s.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, ''); // emoji
  s = s.replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{2,}/g, '\n');
  return s.trim();
}

function hardSplit(text, maxLen) {
  const parts = [];
  let rest = text;
  while (rest.length > maxLen) {
    let cut = rest.lastIndexOf(' ', maxLen);
    if (cut <= 0) cut = maxLen;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

// Groups whole sentences into chunks of at most maxLen characters, so each
// request is short (fast) but still ends on natural sentence boundaries.
export function splitForSpeech(text, maxLen = 500) {
  const sentences = String(text ?? '')
    .split(SENTENCE_END)
    .map((s) => s.trim())
    .filter(Boolean);

  const chunks = [];
  let current = '';
  for (const sentence of sentences) {
    const pieces = sentence.length > maxLen ? hardSplit(sentence, maxLen) : [sentence];
    for (const piece of pieces) {
      if (current && `${current} ${piece}`.length > maxLen) {
        chunks.push(current);
        current = piece;
      } else {
        current = current ? `${current} ${piece}` : piece;
      }
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/* ---------- Azure ---------- */

export function escapeXml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Speaking rate as an SSML percentage: -50 (much slower) .. +50 (faster).
export function formatRate(rate) {
  const n = Math.max(-50, Math.min(50, Math.round(Number(rate) || 0)));
  return n >= 0 ? `+${n}%` : `${n}%`;
}

export function buildSSML(text, { voice = DEFAULT_VOICE, lang = SPEECH_LANG, rate = -5 } = {}) {
  if (!VOICE_NAME.test(voice)) throw new SpeechError(`Unknown voice name: ${voice}`);
  return (
    `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${lang}">` +
    `<voice name="${voice}">` +
    `<prosody rate="${formatRate(rate)}">${escapeXml(text)}</prosody>` +
    `</voice></speak>`
  );
}

function azureErrorMessage(status, detail) {
  if (status === 401 || status === 403) {
    return `Azure rejected the Speech key (HTTP ${status}). Check the key and region in Settings.`;
  }
  if (status === 404) {
    return 'Azure region not found (HTTP 404). Check the region name in Settings, for example "eastus".';
  }
  if (status === 429) {
    return 'Azure speech limit reached (HTTP 429). Wait a moment, or check your Azure plan.';
  }
  if (status === 400) {
    return `Azure could not read this text (HTTP 400).${detail ? ` ${detail}` : ''}`;
  }
  return `Azure speech failed: HTTP ${status}${detail ? ` — ${detail}` : ''}`;
}

/**
 * Converts one chunk of text to an MP3 Blob with an Azure neural voice.
 */
export async function azureSynthesize({
  text,
  key,
  region,
  voice = DEFAULT_VOICE,
  rate = -5,
  endpoint,
  signal,
  fetchImpl = globalThis.fetch,
}) {
  if (!key || !region) throw new SpeechError('Add your Azure Speech key and region in Settings to hear the teacher.');

  const url = endpoint || `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`;
  let res;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': key,
        'Content-Type': 'application/ssml+xml',
        'X-Microsoft-OutputFormat': AZURE_OUTPUT_FORMAT,
        'User-Agent': 'PageTutorAI',
      },
      body: buildSSML(text, { voice, rate }),
      signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new SpeechError(`Could not reach Azure Speech (${err.message}).`);
  }

  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.text()).slice(0, 200);
    } catch {
      // ignore unreadable error bodies
    }
    throw new SpeechError(azureErrorMessage(res.status, detail), res.status);
  }
  return res.blob();
}

/* ---------- browser voices (fallback) ---------- */

export function pickBrowserVoice(voices, lang = SPEECH_LANG) {
  const wanted = lang.toLowerCase();
  const primary = wanted.split('-')[0];
  const list = Array.from(voices || []);
  return (
    list.find((v) => (v.lang || '').toLowerCase().replace('_', '-') === wanted) ||
    list.find((v) => (v.lang || '').toLowerCase().startsWith(primary)) ||
    null
  );
}

export function speakWithBrowser(text, { lang = SPEECH_LANG, rate = -5, api = globalThis.speechSynthesis, UtteranceCtor = globalThis.SpeechSynthesisUtterance } = {}) {
  if (!api || !UtteranceCtor) throw new SpeechError('This browser cannot speak text.');
  const voice = pickBrowserVoice(api.getVoices(), lang);
  if (!voice) {
    throw new SpeechError(
      'This device has no Sinhala voice installed. Keep "Free voice" selected in Settings (needs internet) for natural Sinhala.',
    );
  }
  return new Promise((resolve, reject) => {
    const utterance = new UtteranceCtor(text);
    utterance.voice = voice;
    utterance.lang = voice.lang;
    utterance.rate = Math.max(0.5, Math.min(2, 1 + (Number(rate) || 0) / 100));
    utterance.onend = () => resolve();
    utterance.onerror = (event) => {
      // Cancelling (Stop button) is not an error.
      if (event?.error === 'interrupted' || event?.error === 'canceled') resolve();
      else reject(new SpeechError(`The browser could not speak the text (${event?.error || 'unknown error'}).`));
    };
    api.speak(utterance);
  });
}

/* ---------- free voice chain ---------- */

/**
 * Tries the free voices in order for one chunk:
 *   1. Edge neural Thilini voice (no key)
 *   2. Google translate voice (no key)
 *   3. device voice (returned as { device: true }; the player speaks it)
 * Never throws for network problems; the caller decides what to show.
 */
export async function synthesizeFree(text, {
  voice = DEFAULT_VOICE,
  rate = -5,
  skipEdge = false,
  fetchImpl = globalThis.fetch,
  WebSocketCtor = globalThis.WebSocket,
  subtle = globalThis.crypto?.subtle,
} = {}) {
  const problems = [];
  let edgeFailed = false;
  if (!skipEdge) {
    try {
      const blob = await synthesizeEdge(text, { voice, rate, WebSocketCtor, subtle });
      return { blob, via: 'edge', edgeFailed: false };
    } catch (err) {
      edgeFailed = true;
      problems.push(err.message);
    }
  }
  try {
    const blob = await synthesizeGoogle(text, { fetchImpl });
    return { blob, via: 'google', edgeFailed };
  } catch (err) {
    problems.push(err.message);
  }
  return { device: true, via: 'device', edgeFailed, reason: problems.join(' ') };
}

/* ---------- player ---------- */

/**
 * Speaks text chunk by chunk. While chunk N is playing, chunk N+1 is fetched
 * (one-chunk lookahead), so the teacher starts quickly and never floods the
 * free services with parallel requests.
 */
export class OralPlayer {
  constructor({
    fetchImpl = globalThis.fetch,
    createAudio = (src) => new Audio(src),
    speechApi = globalThis.speechSynthesis,
    WebSocketCtor = globalThis.WebSocket,
    onChange = () => {},
    onNotice = () => {},
  } = {}) {
    this.fetchImpl = fetchImpl;
    this.createAudio = createAudio;
    this.speechApi = speechApi;
    this.WebSocketCtor = WebSocketCtor;
    this.onChange = onChange;
    this.onNotice = onNotice;
    this.token = 0;
    this.current = null;
    this.finishCurrent = null;
    this.edgeDownUntil = 0;
  }

  // Cancels whatever is playing without notifying the UI.
  halt() {
    this.token++;
    if (this.current) {
      try {
        this.current.pause();
      } catch {
        // ignore
      }
    }
    if (this.finishCurrent) this.finishCurrent();
    this.speechApi?.cancel?.();
  }

  stop() {
    this.halt();
    this.onChange(false);
  }

  play(blob, token) {
    return new Promise((resolve, reject) => {
      if (token !== this.token) return resolve();
      const url = URL.createObjectURL(blob);
      const audio = this.createAudio(url);
      const finish = () => {
        if (this.current === audio) this.current = null;
        if (this.finishCurrent === finish) this.finishCurrent = null;
        URL.revokeObjectURL(url);
        resolve();
      };
      this.current = audio;
      this.finishCurrent = finish;
      audio.onended = finish;
      audio.onerror = () => {
        finish();
        reject(new SpeechError('The audio could not be played.'));
      };
      Promise.resolve(audio.play()).catch(() => {
        finish();
        reject(new SpeechError('The browser blocked audio playback. Click the speaker button again.'));
      });
    });
  }

  // Returns { blob, via } for audio, or { device: true } when the device voice must speak.
  async fetchChunk(chunk, speech, engine) {
    if (engine === 'azure') {
      const blob = await azureSynthesize({
        text: chunk,
        key: speech.azureKey,
        region: speech.azureRegion,
        voice: speech.voice,
        rate: speech.rate,
        fetchImpl: this.fetchImpl,
      });
      return { blob, via: 'azure' };
    }

    const result = await synthesizeFree(chunk, {
      voice: speech.voice,
      rate: speech.rate,
      skipEdge: Date.now() < this.edgeDownUntil,
      fetchImpl: this.fetchImpl,
      WebSocketCtor: this.WebSocketCtor,
    });
    if (result.edgeFailed) this.edgeDownUntil = Date.now() + EDGE_RETRY_MS;
    return result;
  }

  /**
   * @param {string} text  Markdown or plain text from the assistant
   * @param {{engine: 'free'|'azure'|'browser', azureKey: string, azureRegion: string, voice: string, rate: number}} speech
   */
  async speak(text, speech) {
    this.halt();
    const token = this.token;
    const engine = normalizeEngine(speech.engine);
    const chunks = splitForSpeech(stripForSpeech(text), engine === 'azure' ? AZURE_CHUNK_CHARS : FREE_CHUNK_CHARS);
    if (!chunks.length) return;

    this.onChange(true);
    try {
      if (engine === 'browser') {
        for (const chunk of chunks) {
          if (token !== this.token) return;
          await speakWithBrowser(chunk, { rate: speech.rate, api: this.speechApi });
        }
        return;
      }

      const notice = (message) => this.onNotice(message);

      let pending = this.fetchChunk(chunks[0], speech, engine);
      pending.catch(() => {}); // errors are handled when awaited below
      for (let i = 0; i < chunks.length; i++) {
        const item = await pending;
        if (token !== this.token) return;
        if (i + 1 < chunks.length) {
          pending = this.fetchChunk(chunks[i + 1], speech, engine);
          pending.catch(() => {});
        }

        if (item.device) {
          notice('Free voices are unreachable right now, so the device voice is reading. Check your internet connection.');
          await speakWithBrowser(chunks[i], { rate: speech.rate, api: this.speechApi });
        } else {
          if (item.via === 'google') notice('The main free voice is unavailable. Using the backup Google voice.');
          await this.play(item.blob, token);
        }
        if (token !== this.token) return;
      }
    } finally {
      if (token === this.token) this.onChange(false);
    }
  }
}
