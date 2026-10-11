import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeWav,
  sttLanguage,
  sttUrl,
  azureTranscribe,
  convertToWav16k,
  VoiceRecorder,
  startBrowserListening,
  MAX_RECORD_MS,
} from '../extension/lib/listen.js';
import { SpeechError } from '../extension/lib/speech.js';

async function readBytes(blob) {
  return new Uint8Array(await blob.arrayBuffer());
}
const ascii = (bytes, from, to) => String.fromCharCode(...bytes.slice(from, to));

test('encodeWav writes a valid 16 kHz mono 16-bit WAV header', async () => {
  const samples = new Float32Array([0, 0.5, -0.5, 1, -1, 2, -2]); // last two clip
  const blob = encodeWav(samples, 16000);
  assert.equal(blob.type, 'audio/wav');
  const bytes = await readBytes(blob);
  const view = new DataView(bytes.buffer);
  assert.equal(ascii(bytes, 0, 4), 'RIFF');
  assert.equal(ascii(bytes, 8, 12), 'WAVE');
  assert.equal(ascii(bytes, 12, 16), 'fmt ');
  assert.equal(view.getUint16(20, true), 1, 'PCM');
  assert.equal(view.getUint16(22, true), 1, 'mono');
  assert.equal(view.getUint32(24, true), 16000, 'sample rate');
  assert.equal(view.getUint16(34, true), 16, 'bits per sample');
  assert.equal(ascii(bytes, 36, 40), 'data');
  assert.equal(view.getUint32(40, true), samples.length * 2, 'data size');
  assert.equal(bytes.length, 44 + samples.length * 2);
  assert.equal(view.getInt16(44 + 1 * 2, true), 16383, "0.5 scaled");
  assert.equal(view.getInt16(44 + 2 * 2, true), -16384, "-0.5 scaled");
  assert.equal(view.getInt16(44 + 4 * 2, true), -32768, '-1 is full negative scale');
  assert.equal(view.getInt16(44 + 5 * 2, true), 32767, '2 is clipped to max');
  assert.equal(view.getInt16(44 + 6 * 2, true), -32768, '-2 is clipped to min');
});

test('sttLanguage follows the reply language', () => {
  assert.equal(sttLanguage('si'), 'si-LK');
  assert.equal(sttLanguage('en'), 'en-US');
});

test('sttUrl points at the regional short-audio endpoint with format=simple', () => {
  assert.equal(
    sttUrl('eastus', 'si-LK'),
    'https://eastus.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=si-LK&format=simple',
  );
});

test('azureTranscribe sends WAV with the key and returns the recognized text', async () => {
  let captured;
  const wav = new Blob([new Uint8Array(10)], { type: 'audio/wav' });
  const fakeFetch = async (url, init) => {
    captured = { url, init };
    return new Response(JSON.stringify({ RecognitionStatus: 'Success', DisplayText: 'ගුරුත්වය මොකක්ද?' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  const text = await azureTranscribe({ wav, key: 'k1', region: 'eastus', language: 'si-LK', fetchImpl: fakeFetch });
  assert.equal(text, 'ගුරුත්වය මොකක්ද?');
  assert.match(captured.url, /language=si-LK/);
  assert.equal(captured.init.headers['Ocp-Apim-Subscription-Key'], 'k1');
  assert.match(captured.init.headers['Content-Type'], /audio\/wav; codecs=audio\/pcm; samplerate=16000/);
  assert.equal(captured.init.body, wav);
});

test('azureTranscribe explains silence and common failures', async () => {
  const wav = new Blob([new Uint8Array(4)]);
  const respond = (body, status = 200) => async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  await assert.rejects(azureTranscribe({ wav, key: 'k', region: 'eastus', language: 'si-LK', fetchImpl: respond({ RecognitionStatus: 'NoMatch' }) }), /could not hear any speech/);
  await assert.rejects(azureTranscribe({ wav, key: 'k', region: 'eastus', language: 'si-LK', fetchImpl: async () => new Response('no', { status: 401 }) }), /rejected the Speech key/);
  await assert.rejects(azureTranscribe({ wav, key: 'k', region: 'eastus', language: 'si-LK', fetchImpl: async () => new Response('', { status: 429 }) }), /limit reached/);
  await assert.rejects(azureTranscribe({ wav, key: '', region: 'eastus', language: 'si-LK', fetchImpl: async () => { throw new Error('should not call'); } }), /key and region/);
});

test('convertToWav16k resamples decoded audio to 16 kHz mono WAV', async () => {
  const rendered = new Float32Array(8000); // 0.5 s at 16 kHz
  const connected = [];
  const AudioContextCtor = class {
    async decodeAudioData(buf) {
      assert.ok(buf.byteLength > 0);
      return { duration: 0.5, numberOfChannels: 2 };
    }
    close() {}
  };
  const OfflineCtor = class {
    constructor(channels, length, rate) {
      this.args = { channels, length, rate };
      this.destination = { name: 'dest' };
    }
    createBufferSource() {
      return { connect: (d) => connected.push(d), start() {}, set buffer(v) { this._b = v; } };
    }
    async startRendering() {
      return { getChannelData: () => rendered };
    }
  };
  const blob = new Blob([new Uint8Array(100)], { type: 'audio/webm' });
  const wav = await convertToWav16k(blob, { AudioContextCtor, OfflineCtor });
  assert.equal(wav.type, 'audio/wav');
  assert.equal(wav.size, 44 + 8000 * 2);
  assert.deepEqual(connected, [{ name: 'dest' }]);
});

test('convertToWav16k reports unreadable recordings', async () => {
  const AudioContextCtor = class {
    async decodeAudioData() {
      throw new Error('bad');
    }
  };
  await assert.rejects(convertToWav16k(new Blob([new Uint8Array(4)]), { AudioContextCtor, OfflineCtor: class {} }), /could not be read/);
});

function fakeMicrophone() {
  const tracks = [];
  return {
    getUserMedia: async () => ({ getTracks: () => tracks.map((t) => ({ stop: () => (t.stopped = true) })) }),
    tracks,
  };
}

class FakeMediaRecorder {
  constructor(stream) {
    this.stream = stream;
    this.mimeType = 'audio/webm;codecs=opus';
  }
  start() {
    this.started = true;
    setTimeout(() => this.ondataavailable && this.ondataavailable({ data: new Blob([new Uint8Array(5)]) }), 1);
  }
  stop() {
    this.stopped = true;
    setTimeout(() => this.onstop && this.onstop(), 5);
  }
}

test('VoiceRecorder records and returns the audio blob', async () => {
  const mic = fakeMicrophone();
  const recorder = new VoiceRecorder({ getUserMedia: mic.getUserMedia, MediaRecorderCtor: FakeMediaRecorder });
  await recorder.start();
  assert.equal(recorder.recording, true);
  await new Promise((r) => setTimeout(r, 10));
  const blob = await recorder.stop();
  assert.equal(recorder.recording, false);
  assert.equal(blob.size, 5);
  assert.match(blob.type, /webm/);
});

test('VoiceRecorder explains a blocked microphone', async () => {
  const denied = async () => {
    const err = new Error('denied');
    err.name = 'NotAllowedError';
    throw err;
  };
  const recorder = new VoiceRecorder({ getUserMedia: denied, MediaRecorderCtor: FakeMediaRecorder });
  await assert.rejects(recorder.start(), (e) => e instanceof SpeechError && /Microphone access was blocked/.test(e.message));
  assert.equal(recorder.recording, false);
});

test('VoiceRecorder stops itself after the maximum length', async () => {
  let autoStopped = false;
  const mic = fakeMicrophone();
  const recorder = new VoiceRecorder({
    getUserMedia: mic.getUserMedia,
    MediaRecorderCtor: FakeMediaRecorder,
    maxMs: 20,
    onAutoStop: () => (autoStopped = true),
  });
  await recorder.start();
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(autoStopped, true);
  await recorder.stop();
  assert.ok(MAX_RECORD_MS <= 60000, 'stays within the 60 s Azure limit');
});

function fakeRecognitionClass(log) {
  return class {
    constructor() {
      log.instance = this;
    }
    start() {
      log.started = true;
    }
    stop() {
      log.stopped = true;
    }
    abort() {}
  };
}

test('browser listening streams interim text and resolves with the final text', async () => {
  const log = {};
  const seen = [];
  const session = startBrowserListening({
    lang: 'si-LK',
    onInterim: (t) => seen.push(t),
    SpeechRecognitionCtor: fakeRecognitionClass(log),
  });
  const rec = log.instance;
  assert.equal(rec.lang, 'si-LK');
  assert.equal(rec.interimResults, true);
  rec.onresult({ resultIndex: 0, results: [{ isFinal: false, 0: { transcript: 'ගුරුත්වය' } }] });
  rec.onresult({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: 'ගුරුත්වය මොකක්ද' } }] });
  rec.onend();
  assert.deepEqual(seen, ['ගුරුත්වය', 'ගුරුත්වය මොකක්ද']);
  assert.equal(await session.done, 'ගුරුත්වය මොකක්ද');
});

test('browser listening: silence is an empty result, permission problems are errors', async () => {
  const log = {};
  const silent = startBrowserListening({ lang: 'si-LK', SpeechRecognitionCtor: fakeRecognitionClass(log) });
  log.instance.onerror({ error: 'no-speech' });
  assert.equal(await silent.done, '');

  const log2 = {};
  const blocked = startBrowserListening({ lang: 'si-LK', SpeechRecognitionCtor: fakeRecognitionClass(log2) });
  log2.instance.onerror({ error: 'not-allowed' });
  await assert.rejects(blocked.done, /Microphone access was blocked/);
});

test('browser listening explains when the browser has no speech recognition', () => {
  assert.throws(() => startBrowserListening({ lang: 'si-LK', SpeechRecognitionCtor: undefined }), /no speech recognition/);
});
