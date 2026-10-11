// Voice input: the student speaks, the text appears in the message box.
// Engines (same setting as the teacher's voice):
//  - 'azure'   : record with MediaRecorder, convert to 16 kHz WAV, send to Azure
//                Speech-to-Text (REST, short audio). Works well for Sinhala.
//  - 'browser' : Chrome's built-in SpeechRecognition with live text. Sinhala
//                only works if the browser supports it.
import { SpeechError } from './speech.js';

export const MAX_RECORD_MS = 45000; // Azure short-audio requests are limited to 60 seconds
export const STT_SAMPLE_RATE = 16000;

// Sinhala speech when the reply language is Sinhala; English otherwise.
export function sttLanguage(language) {
  return language === 'en' ? 'en-US' : 'si-LK';
}

/* ---------- WAV encoding ---------- */

// Encodes mono Float32 samples as a 16-bit PCM WAV file.
export function encodeWav(samples, sampleRate = STT_SAMPLE_RATE) {
  const dataSize = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const writeText = (offset, text) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  writeText(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeText(8, 'WAVE');
  writeText(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeText(36, 'data');
  view.setUint32(40, dataSize, true);

  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

// Decodes any recorded audio (WebM/Opus from MediaRecorder) and returns a 16 kHz mono WAV.
export async function convertToWav16k(
  blob,
  { AudioContextCtor = globalThis.AudioContext, OfflineCtor = globalThis.OfflineAudioContext } = {},
) {
  if (!AudioContextCtor || !OfflineCtor) throw new SpeechError('This browser cannot process recorded audio.');

  const decodeContext = new AudioContextCtor();
  let decoded;
  try {
    decoded = await decodeContext.decodeAudioData(await blob.arrayBuffer());
  } catch {
    throw new SpeechError('The recording could not be read. Please try again.');
  } finally {
    decodeContext.close?.();
  }

  const length = Math.max(1, Math.ceil(decoded.duration * STT_SAMPLE_RATE));
  const offline = new OfflineCtor(1, length, STT_SAMPLE_RATE);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination); // multi-channel audio is mixed down to mono
  source.start(0);
  const rendered = await offline.startRendering();
  return encodeWav(rendered.getChannelData(0), STT_SAMPLE_RATE);
}

/* ---------- Azure Speech-to-Text ---------- */

export function sttUrl(region, language) {
  return (
    `https://${region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1` +
    `?language=${encodeURIComponent(language)}&format=simple`
  );
}

function azureSttError(status, detail) {
  if (status === 401 || status === 403) {
    return `Azure rejected the Speech key (HTTP ${status}). Check the key and region in Settings.`;
  }
  if (status === 404) return 'Azure region not found (HTTP 404). Check the region in Settings.';
  if (status === 429) return 'Azure speech limit reached (HTTP 429). Wait a moment and try again.';
  return `Azure speech-to-text failed: HTTP ${status}${detail ? ` — ${detail}` : ''}`;
}

/**
 * Sends a WAV recording to Azure and returns the recognized text.
 */
export async function azureTranscribe({
  wav,
  key,
  region,
  language,
  signal,
  fetchImpl = globalThis.fetch,
}) {
  if (!key || !region) throw new SpeechError('Add your Azure Speech key and region in Settings to use voice input.');

  let res;
  try {
    res = await fetchImpl(sttUrl(region, language), {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': key,
        'Content-Type': 'audio/wav; codecs=audio/pcm; samplerate=16000',
        Accept: 'application/json',
      },
      body: wav,
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
      // ignore unreadable bodies
    }
    throw new SpeechError(azureSttError(res.status, detail), res.status);
  }

  const json = await res.json();
  if (json.RecognitionStatus === 'Success') return String(json.DisplayText || '').trim();
  if (json.RecognitionStatus === 'NoMatch' || json.RecognitionStatus === 'InitialSilenceTimeout') {
    throw new SpeechError('I could not hear any speech. Try again, a little closer to the microphone.');
  }
  throw new SpeechError(`Speech was not recognized (${json.RecognitionStatus || 'unknown'}).`);
}

/* ---------- microphone recording ---------- */

export class VoiceRecorder {
  constructor({
    getUserMedia = (constraints) => globalThis.navigator.mediaDevices.getUserMedia(constraints),
    MediaRecorderCtor = globalThis.MediaRecorder,
    maxMs = MAX_RECORD_MS,
    onAutoStop = () => {},
  } = {}) {
    this.getUserMedia = getUserMedia;
    this.MediaRecorderCtor = MediaRecorderCtor;
    this.maxMs = maxMs;
    this.onAutoStop = onAutoStop;
    this.stream = null;
    this.recorder = null;
    this.chunks = [];
    this.timer = null;
  }

  get recording() {
    return Boolean(this.recorder);
  }

  async start() {
    if (this.recording) return;
    if (!this.MediaRecorderCtor) throw new SpeechError('This browser cannot record audio.');
    try {
      this.stream = await this.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
    } catch (err) {
      const denied = err?.name === 'NotAllowedError' || err?.name === 'SecurityError';
      throw new SpeechError(
        denied
          ? 'Microphone access was blocked. Allow the microphone for Page Tutor in the browser settings and try again.'
          : 'No microphone was found, or it is in use by another app.',
      );
    }
    this.chunks = [];
    this.recorder = new this.MediaRecorderCtor(this.stream);
    this.recorder.ondataavailable = (event) => {
      if (event.data && event.data.size) this.chunks.push(event.data);
    };
    this.recorder.start();
    this.timer = setTimeout(() => this.onAutoStop(), this.maxMs);
  }

  // Stops recording and resolves with the recorded audio Blob.
  stop() {
    return new Promise((resolve, reject) => {
      if (!this.recorder) return reject(new SpeechError('Nothing is being recorded.'));
      clearTimeout(this.timer);
      const recorder = this.recorder;
      recorder.onstop = () => {
        const type = recorder.mimeType || 'audio/webm';
        const blob = new Blob(this.chunks, { type });
        this.release();
        resolve(blob);
      };
      try {
        recorder.stop();
      } catch (err) {
        this.release();
        reject(new SpeechError(`Recording failed: ${err.message}`));
      }
    });
  }

  release() {
    clearTimeout(this.timer);
    this.stream?.getTracks?.().forEach((track) => track.stop());
    this.stream = null;
    this.recorder = null;
    this.chunks = [];
  }
}

/* ---------- browser speech recognition ---------- */

const BROWSER_ERRORS = {
  'not-allowed': 'Microphone access was blocked. Allow the microphone for Page Tutor and try again.',
  'service-not-allowed': 'The browser blocked speech recognition for this page.',
  'audio-capture': 'No microphone was found.',
  network: 'Browser speech recognition needs an internet connection.',
  'language-not-supported': 'This browser does not support speech recognition in this language. Use the Azure engine.',
};

/**
 * Starts Chrome's speech recognition. `onInterim` receives the text as it is heard.
 * Returns { done: Promise<string>, stop(), abort() }.
 */
export function startBrowserListening({
  lang,
  onInterim = () => {},
  SpeechRecognitionCtor = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition,
} = {}) {
  if (!SpeechRecognitionCtor) throw new SpeechError('This browser has no speech recognition. Use the Azure engine in Settings.');

  const recognition = new SpeechRecognitionCtor();
  recognition.lang = lang;
  recognition.interimResults = true;
  recognition.continuous = false;
  recognition.maxAlternatives = 1;

  let finalText = '';
  let interimText = '';
  let resolveDone;
  let rejectDone;
  const done = new Promise((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });

  recognition.onresult = (event) => {
    interimText = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      if (result.isFinal) finalText += result[0].transcript;
      else interimText += result[0].transcript;
    }
    onInterim(`${finalText}${interimText}`.trim());
  };
  recognition.onerror = (event) => {
    if (event.error === 'no-speech' || event.error === 'aborted') return resolveDone(`${finalText}${interimText}`.trim());
    rejectDone(new SpeechError(BROWSER_ERRORS[event.error] || `Speech recognition failed (${event.error}).`));
  };
  recognition.onend = () => resolveDone(`${finalText}${interimText}`.trim());

  recognition.start();
  return {
    done,
    stop: () => recognition.stop(),
    abort: () => recognition.abort(),
  };
}
