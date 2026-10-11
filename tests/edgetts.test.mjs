import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateSecMsGec,
  dateToString,
  speechConfigMessage,
  buildEdgeSSML,
  ssmlMessage,
  parseTextFrame,
  parseBinaryFrame,
  synthesizeEdge,
  synthesizeGoogle,
  googleTtsUrl,
  EDGE_TOKEN,
} from '../extension/lib/edgetts.js';
import { synthesizeFree, OralPlayer, SpeechError } from '../extension/lib/speech.js';

const enc = new TextEncoder();

// Builds a binary frame the way the service does: 2-byte header length L, L bytes of
// header lines (each ending in CRLF), then the audio bytes.
function binaryFrame(headerLines, body) {
  const h = enc.encode(headerLines);
  const out = new Uint8Array(2 + h.length + body.length);
  out[0] = (h.length >> 8) & 0xff;
  out[1] = h.length & 0xff;
  out.set(h, 2);
  out.set(body, 2 + h.length);
  return out.buffer;
}

// Minimal WebSocket stand-in. `script(ws)` runs once the socket opens and decides the replies.
function fakeWebSocketFactory(script) {
  const sockets = [];
  class FakeWS {
    constructor(url) {
      this.url = url;
      this.sent = [];
      this.closed = false;
      sockets.push(this);
      setTimeout(() => {
        this.onopen?.();
        script?.(this);
      }, 0);
    }
    send(message) {
      this.sent.push(message);
    }
    close() {
      this.closed = true;
    }
  }
  return { FakeWS, sockets };
}

test('Sec-MS-GEC matches the reference values from the edge-tts project', async () => {
  // Reference values computed with the same formula (rounding to 5 minutes, then SHA-256 of ticks + token).
  assert.equal(
    await generateSecMsGec(1767225723.0),
    '42D1947403FD94975436C65DBFCA8003073F9CB5C3F1CE25AF8961A11D7C3DFE',
  );
  assert.equal(
    await generateSecMsGec(1767226023.0),
    'D1555CE75F459479ED05B765B3F720D547F27509AD68D10106360D2A35FAE324',
  );
});

test('Sec-MS-GEC is the same for every second inside one 5-minute window', async () => {
  const a = await generateSecMsGec(1767225723.0);
  const b = await generateSecMsGec(1767225723.0 + 120);
  assert.equal(a, b);
  assert.notEqual(a, await generateSecMsGec(1767225723.0 + 300));
});

test('dateToString uses the service format in UTC', () => {
  assert.equal(
    dateToString(new Date(Date.UTC(2026, 0, 4, 12, 0, 0))),
    'Sun Jan 04 2026 12:00:00 GMT+0000 (Coordinated Universal Time)',
  );
});

test('speech.config message asks for MP3 output without word boundaries', () => {
  const msg = speechConfigMessage('TS');
  const { headers, body } = parseTextFrame(msg);
  assert.equal(headers.Path, 'speech.config');
  assert.equal(headers['Content-Type'], 'application/json; charset=utf-8');
  const json = JSON.parse(body);
  assert.equal(json.context.synthesis.audio.outputFormat, 'audio-24khz-48kbitrate-mono-mp3');
});

test('SSML escapes the text and keeps the Sinhala voice and rate', () => {
  const ssml = buildEdgeSSML('<a> & "b"', { voice: 'si-LK-ThiliniNeural', rate: -5 });
  assert.match(ssml, /<voice name='si-LK-ThiliniNeural'>/);
  assert.match(ssml, /rate='-5%'/);
  assert.match(ssml, /&lt;a&gt; &amp; &quot;b&quot;/);
  assert.equal(buildEdgeSSML('x', { voice: 'v', rate: 999 }).includes("rate='+50%'"), true);
});

test('ssml message is a text frame with the right path', () => {
  const { headers, body } = parseTextFrame(ssmlMessage('ID', 'TS', '<speak/>'));
  assert.equal(headers.Path, 'ssml');
  assert.equal(headers['X-RequestId'], 'ID');
  assert.equal(body, '<speak/>');
});

test('parseBinaryFrame separates headers from audio bytes', () => {
  const audio = new Uint8Array([0xff, 0xfb, 0x90, 0x00, 0x0d, 0x0a, 0x0d, 0x0a, 0x01]); // audio can contain CRLF bytes
  const frame = parseBinaryFrame(binaryFrame('X-RequestId:abc\r\nContent-Type:audio/mpeg\r\nPath:audio\r\n', audio));
  assert.equal(frame.headers.Path, 'audio');
  assert.equal(frame.headers['Content-Type'], 'audio/mpeg');
  assert.deepEqual(Array.from(frame.body), Array.from(audio));
});

test('parseBinaryFrame handles an audio-less end-of-stream frame', () => {
  const frame = parseBinaryFrame(binaryFrame('Path:turn.end\r\n', new Uint8Array(0)));
  assert.equal(frame.headers.Path, 'turn.end');
  assert.equal(frame.body.length, 0);
});

test('synthesizeEdge streams audio frames and resolves an MP3 blob', async () => {
  const { FakeWS, sockets } = fakeWebSocketFactory((ws) => {
    ws.onmessage({ data: 'X-RequestId:r\r\nPath:turn.start\r\n\r\n{}' });
    ws.onmessage({ data: binaryFrame('Path:audio\r\nContent-Type:audio/mpeg\r\n', new Uint8Array([1, 2, 3])) });
    ws.onmessage({ data: binaryFrame('Path:audio\r\nContent-Type:audio/mpeg\r\n', new Uint8Array([4, 5])) });
    ws.onmessage({ data: 'X-RequestId:r\r\nPath:turn.end\r\n\r\n{}' });
  });
  const blob = await synthesizeEdge('ආයුබෝවන්', { WebSocketCtor: FakeWS, subtle: globalThis.crypto.subtle });
  assert.equal(blob.type, 'audio/mpeg');
  assert.deepEqual(Array.from(new Uint8Array(await blob.arrayBuffer())), [1, 2, 3, 4, 5]);

  const ws = sockets[0];
  assert.match(ws.url, /^wss:\/\/speech\.platform\.bing\.com\/consumer\/speech\/synthesize\/readaloud\/edge\/v1\?/);
  assert.ok(ws.url.includes(`TrustedClientToken=${EDGE_TOKEN}`));
  assert.match(ws.url, /Sec-MS-GEC=[0-9A-F]{64}/);
  assert.equal(ws.sent.length, 2);
  assert.match(ws.sent[1], /Path:ssml/);
  assert.ok(ws.sent[1].includes('si-LK-ThiliniNeural'));
  assert.equal(ws.closed, true);
});

test('synthesizeEdge rejects when the service returns no audio', async () => {
  const { FakeWS } = fakeWebSocketFactory((ws) => {
    ws.onmessage({ data: 'X-RequestId:r\r\nPath:turn.end\r\n\r\n{}' });
  });
  await assert.rejects(
    synthesizeEdge('x', { WebSocketCtor: FakeWS, subtle: globalThis.crypto.subtle }),
    (err) => err instanceof SpeechError && /no audio/.test(err.message),
  );
});

test('synthesizeEdge rejects on connection error and on timeout', async () => {
  const { FakeWS } = fakeWebSocketFactory((ws) => ws.onerror?.(new Error('boom')));
  await assert.rejects(
    synthesizeEdge('x', { WebSocketCtor: FakeWS, subtle: globalThis.crypto.subtle }),
    (err) => err instanceof SpeechError && /connection failed/.test(err.message),
  );
  const silent = fakeWebSocketFactory(() => {}).FakeWS;
  await assert.rejects(
    synthesizeEdge('x', { WebSocketCtor: silent, subtle: globalThis.crypto.subtle, timeoutMs: 20 }),
    (err) => err instanceof SpeechError && /timed out/.test(err.message),
  );
});

test('googleTtsUrl encodes the text and uses Sinhala', () => {
  const url = googleTtsUrl('ආයුබෝවන් & hi', 'si');
  assert.match(url, /^https:\/\/translate\.google\.com\/translate_tts\?/);
  assert.ok(url.includes('tl=si'));
  assert.ok(url.includes(encodeURIComponent('ආයුබෝවන් & hi')));
});

test('synthesizeGoogle returns the audio blob, and a SpeechError on failure', async () => {
  const ok = await synthesizeGoogle('hi', {
    fetchImpl: async () => new Response(new Uint8Array([9, 9]), { status: 200 }),
  });
  assert.equal(ok.size, 2);
  await assert.rejects(
    synthesizeGoogle('hi', { fetchImpl: async () => new Response('', { status: 429 }) }),
    (err) => err instanceof SpeechError && err.status === 429,
  );
  await assert.rejects(
    synthesizeGoogle('hi', { fetchImpl: async () => { throw new TypeError('offline'); } }),
    (err) => err instanceof SpeechError && /could not be reached/.test(err.message),
  );
});

test('synthesizeFree falls back Edge -> Google -> device', async () => {
  const failingWS = fakeWebSocketFactory((ws) => ws.onerror?.(new Error('blocked'))).FakeWS;
  const googleOk = async () => new Response(new Uint8Array([7]), { status: 200 });

  const viaGoogle = await synthesizeFree('hi', {
    WebSocketCtor: failingWS,
    subtle: globalThis.crypto.subtle,
    fetchImpl: googleOk,
  });
  assert.equal(viaGoogle.via, 'google');
  assert.equal(viaGoogle.edgeFailed, true);

  const device = await synthesizeFree('hi', {
    WebSocketCtor: failingWS,
    subtle: globalThis.crypto.subtle,
    fetchImpl: async () => new Response('', { status: 500 }),
  });
  assert.equal(device.device, true);
  assert.equal(device.edgeFailed, true);
  assert.match(device.reason, /connection failed/);
});

test('synthesizeFree skips Edge when asked and uses Google directly', async () => {
  let sockets = 0;
  class NeverWS {
    constructor() {
      sockets++;
    }
  }
  const result = await synthesizeFree('hi', {
    skipEdge: true,
    WebSocketCtor: NeverWS,
    fetchImpl: async () => new Response(new Uint8Array([1]), { status: 200 }),
  });
  assert.equal(sockets, 0);
  assert.equal(result.via, 'google');
  assert.equal(result.edgeFailed, false);
});

function installBlobUrls() {
  const previous = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
  let n = 0;
  URL.createObjectURL = () => `blob:${++n}`;
  URL.revokeObjectURL = () => {};
  return () => Object.assign(URL, { createObjectURL: previous.create, revokeObjectURL: previous.revoke });
}

function fakeAudio(log) {
  return (src) => {
    const audio = {
      onended: null,
      onerror: null,
      play() {
        log.push(`play:${src}`);
        queueMicrotask(() => audio.onended?.());
        return Promise.resolve();
      },
      pause() {},
    };
    return audio;
  };
}

test('free engine: one Edge failure switches later chunks to Google without retrying Edge', async (t) => {
  const restore = installBlobUrls();
  t.after(restore);
  const { FakeWS, sockets } = fakeWebSocketFactory((ws) => ws.onerror?.(new Error('blocked')));
  const notices = [];
  const log = [];
  let googleCalls = 0;
  const player = new OralPlayer({
    WebSocketCtor: FakeWS,
    fetchImpl: async () => {
      googleCalls++;
      return new Response(new Uint8Array([1, 2]), { status: 200 });
    },
    createAudio: fakeAudio(log),
    speechApi: null,
    onNotice: (m) => notices.push(m),
  });
  const text = 'ආයුබෝවන්. ' + 'අද අපි ඉගෙන ගනිමු. '.repeat(20);
  await player.speak(text, { engine: 'free', voice: 'si-LK-ThiliniNeural', rate: -5 });

  assert.ok(googleCalls >= 2, 'several chunks were read');
  assert.equal(sockets.length, 1, 'Edge is tried once, then skipped for the rest of the reply');
  assert.ok(log.length >= 2, 'audio played');
  assert.ok(notices.some((m) => /backup Google voice/.test(m)));
});

test('free engine: device voice is used, with a clear notice, when every free voice fails', async (t) => {
  const restore = installBlobUrls();
  t.after(restore);
  const { FakeWS } = fakeWebSocketFactory((ws) => ws.onerror?.(new Error('blocked')));
  const spoken = [];
  const notices = [];
  const speechApi = {
    getVoices: () => [{ lang: 'si-LK', name: 'Sinhala' }],
    speak: (u) => {
      spoken.push(u.text);
      queueMicrotask(() => u.onend?.());
    },
    cancel() {},
  };
  class Utt {
    constructor(text) {
      this.text = text;
    }
  }
  const previous = globalThis.SpeechSynthesisUtterance;
  globalThis.SpeechSynthesisUtterance = Utt;
  t.after(() => {
    globalThis.SpeechSynthesisUtterance = previous;
  });

  const player = new OralPlayer({
    WebSocketCtor: FakeWS,
    fetchImpl: async () => new Response('', { status: 503 }),
    createAudio: fakeAudio([]),
    speechApi,
    onNotice: (m) => notices.push(m),
  });
  await player.speak('ආයුබෝවන්. අද අපි ඉගෙන ගනිමු.', { engine: 'free', voice: 'si-LK-ThiliniNeural', rate: -5 });
  assert.equal(spoken.length >= 1, true);
  assert.ok(notices.some((m) => /device voice is reading/.test(m)));
});

test('free engine: no Sinhala device voice and no network gives a clear error', async (t) => {
  const restore = installBlobUrls();
  t.after(restore);
  const { FakeWS } = fakeWebSocketFactory((ws) => ws.onerror?.(new Error('blocked')));
  class Utt {
    constructor(text) {
      this.text = text;
    }
  }
  const previous = globalThis.SpeechSynthesisUtterance;
  globalThis.SpeechSynthesisUtterance = Utt;
  t.after(() => {
    globalThis.SpeechSynthesisUtterance = previous;
  });
  const player = new OralPlayer({
    WebSocketCtor: FakeWS,
    fetchImpl: async () => new Response('', { status: 503 }),
    createAudio: fakeAudio([]),
    speechApi: { getVoices: () => [], speak() {}, cancel() {} },
  });
  await assert.rejects(
    player.speak('hello', { engine: 'free', voice: 'si-LK-ThiliniNeural', rate: -5 }),
    (err) => err instanceof SpeechError && /no Sinhala voice/.test(err.message),
  );
});
