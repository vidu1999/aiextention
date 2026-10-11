// FREE teacher voice, no API key needed.
//
// Uses the same free read-aloud service that Microsoft Edge uses, with the
// Thilini (si-LK) neural voice. Protocol and token logic follow the open-source
// edge-tts project. This service is NOT an official public API: it can change
// or block requests at any time, so the player falls back to a Google voice and
// then to the device voice.
import { SpeechError } from './errors.js';

export const EDGE_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
export const EDGE_CHROMIUM_VERSION = '143.0.3650.75';
export const EDGE_WSS_BASE =
  `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=${EDGE_TOKEN}`;
export const EDGE_OUTPUT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3';

const WIN_EPOCH_SECONDS = 11644473600; // seconds between 1601-01-01 and 1970-01-01
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/* ---------- request signing ---------- */

// Sec-MS-GEC: SHA-256 of "<Windows file time, rounded to 5 minutes>" + token, upper-case hex.
export async function generateSecMsGec(unixSeconds = Date.now() / 1000, subtle = globalThis.crypto?.subtle) {
  if (!subtle) throw new SpeechError('This browser cannot create the free voice request (no crypto support).');
  let ticks = unixSeconds + WIN_EPOCH_SECONDS;
  ticks -= ticks % 300;
  ticks *= 1e7; // 100-nanosecond intervals
  const text = `${BigInt(ticks).toString()}${EDGE_TOKEN}`;
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}

export function connectId() {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

// Format used by the service's JavaScript-style timestamp header.
export function dateToString(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${DAYS[date.getUTCDay()]} ${MONTHS[date.getUTCMonth()]} ${p(date.getUTCDate())} ${date.getUTCFullYear()} ` +
    `${p(date.getUTCHours())}:${p(date.getUTCMinutes())}:${p(date.getUTCSeconds())} GMT+0000 (Coordinated Universal Time)`
  );
}

/* ---------- messages ---------- */

export function speechConfigMessage(timestamp) {
  const config = {
    context: {
      synthesis: {
        audio: {
          metadataoptions: { sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'false' },
          outputFormat: EDGE_OUTPUT_FORMAT,
        },
      },
    },
  };
  return (
    `X-Timestamp:${timestamp}\r\n` +
    'Content-Type:application/json; charset=utf-8\r\n' +
    'Path:speech.config\r\n\r\n' +
    `${JSON.stringify(config)}\r\n`
  );
}

function escapeXml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function buildEdgeSSML(text, { voice, rate }) {
  const n = Math.max(-50, Math.min(50, Math.round(Number(rate) || 0)));
  const rateText = n >= 0 ? `+${n}%` : `${n}%`;
  return (
    "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>" +
    `<voice name='${escapeXml(voice)}'>` +
    `<prosody pitch='+0Hz' rate='${rateText}' volume='+0%'>${escapeXml(text)}</prosody>` +
    '</voice></speak>'
  );
}

export function ssmlMessage(requestId, timestamp, ssml) {
  return (
    `X-RequestId:${requestId}\r\n` +
    'Content-Type:application/ssml+xml\r\n' +
    `X-Timestamp:${timestamp}Z\r\n` +
    'Path:ssml\r\n\r\n' +
    ssml
  );
}

function parseHeaderBlock(text) {
  const headers = {};
  for (const line of text.split('\r\n')) {
    const colon = line.indexOf(':');
    if (colon > 0) headers[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  return headers;
}

// Text frames: "Path:turn.start", "Path:response", "Path:turn.end" ...
export function parseTextFrame(text) {
  const end = text.indexOf('\r\n\r\n');
  const headerText = end === -1 ? text : text.slice(0, end);
  return { headers: parseHeaderBlock(headerText), body: end === -1 ? '' : text.slice(end + 4) };
}

// Binary frames: a 2-byte big-endian header length L, then L bytes of header
// lines ("Path:audio\r\n" ...), then the audio bytes. (Same layout as edge-tts.)
export function parseBinaryFrame(buffer) {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 2) return { headers: {}, body: new Uint8Array(0) };
  const headerLength = (bytes[0] << 8) | bytes[1];
  const headerEnd = Math.min(bytes.length, 2 + headerLength);
  const headerText = new TextDecoder().decode(bytes.subarray(2, headerEnd));
  return { headers: parseHeaderBlock(headerText), body: bytes.subarray(headerEnd) };
}

/* ---------- Edge neural voice (WebSocket) ---------- */

/**
 * Synthesizes one chunk of text with the free Thilini neural voice.
 * Resolves with an MP3 Blob.
 */
export async function synthesizeEdge(text, {
  voice = 'si-LK-ThiliniNeural',
  rate = -5,
  WebSocketCtor = globalThis.WebSocket,
  subtle = globalThis.crypto?.subtle,
  timeoutMs = 15000,
} = {}) {
  if (!WebSocketCtor) throw new SpeechError('This browser cannot open the free voice connection.');
  const gec = await generateSecMsGec(Date.now() / 1000, subtle);
  const url = `${EDGE_WSS_BASE}&ConnectionId=${connectId()}&Sec-MS-GEC=${gec}&Sec-MS-GEC-Version=1-${EDGE_CHROMIUM_VERSION}`;

  return new Promise((resolve, reject) => {
    const ws = new WebSocketCtor(url);
    ws.binaryType = 'arraybuffer';
    const audio = [];
    let audioBytes = 0;
    let settled = false;

    const finish = (error, blob) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        // already closed
      }
      if (error) reject(error);
      else resolve(blob);
    };
    const timer = setTimeout(() => finish(new SpeechError('The free voice timed out.')), timeoutMs);

    ws.onopen = () => {
      const now = dateToString();
      ws.send(speechConfigMessage(now));
      ws.send(ssmlMessage(connectId(), now, buildEdgeSSML(text, { voice, rate })));
    };
    ws.onmessage = (event) => {
      if (typeof event.data === 'string') {
        const { headers } = parseTextFrame(event.data);
        if (headers.Path === 'turn.end') {
          if (audioBytes === 0) finish(new SpeechError('The free voice returned no audio.'));
          else finish(null, new Blob(audio, { type: 'audio/mpeg' }));
        }
        return;
      }
      const frame = parseBinaryFrame(event.data);
      if (frame.headers.Path === 'audio' && frame.body.length) {
        audio.push(frame.body);
        audioBytes += frame.body.length;
      }
    };
    ws.onerror = () => finish(new SpeechError('The free voice connection failed.'));
    ws.onclose = () => finish(new SpeechError(audioBytes ? 'The free voice stopped early.' : 'The free voice closed without audio.'));
  });
}

/* ---------- Google voice (backup, also free) ---------- */

export function googleTtsUrl(text, lang = 'si') {
  return `https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=${encodeURIComponent(lang)}&q=${encodeURIComponent(text)}`;
}

export async function synthesizeGoogle(text, { lang = 'si', fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(googleTtsUrl(text, lang), { signal: controller.signal });
    if (!res.ok) throw new SpeechError(`The backup voice failed (HTTP ${res.status}).`, res.status);
    const blob = await res.blob();
    if (!blob.size) throw new SpeechError('The backup voice returned no audio.');
    return blob;
  } catch (err) {
    if (err instanceof SpeechError) throw err;
    throw new SpeechError(`The backup voice could not be reached (${err.message}).`);
  } finally {
    clearTimeout(timer);
  }
}
