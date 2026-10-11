import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  stripForSpeech,
  splitForSpeech,
  buildSSML,
  escapeXml,
  formatRate,
  azureSynthesize,
  pickBrowserVoice,
  speakWithBrowser,
  OralPlayer,
  SpeechError,
} from '../extension/lib/speech.js';
import { normalizeSettings, DEFAULT_SPEECH } from '../extension/lib/settings.js';
import { buildSystemPrompt, buildMessages, LANGUAGE_INSTRUCTIONS, ORAL_INSTRUCTION } from '../extension/lib/prompts.js';

const SI = 'ගුරුවරිය'; // "teacher" in Sinhala

test('stripForSpeech removes Markdown and symbols but keeps Sinhala words', () => {
  const md = `## පාඩම\n\n**${SI}** කියයි: \`x = 1\`. See [the docs](https://example.com/a).\n\n- පළමු කරුණ\n- දෙවන කරුණ\n\n\`\`\`js\nconst a = 1;\n\`\`\`\n| a | b |\n|---|---|\n| 1 | 2 |`;
  const out = stripForSpeech(md);
  assert.match(out, new RegExp(SI));
  assert.match(out, /the docs/);
  assert.match(out, /පළමු කරුණ/);
  assert.doesNotMatch(out, /[#*`\[\]|]/);
  assert.doesNotMatch(out, /https?:/);
  assert.doesNotMatch(out, /const a/);
});

test('stripForSpeech removes emoji', () => {
  assert.equal(stripForSpeech('Great job 🎉 ✅ ආයුබෝවන්'), 'Great job ආයුබෝවන්');
});

test('splitForSpeech keeps sentences whole and respects the length limit', () => {
  const text = 'ආයුබෝවන්. අද අපි ගුරුත්වය ඉගෙන ගනිමු. ' + 'ඒ ගැන වැඩි විස්තර දැන ගමු. '.repeat(30);
  const chunks = splitForSpeech(text, 120);
  assert.ok(chunks.length > 1);
  for (const c of chunks) assert.ok(c.length <= 120, `chunk too long: ${c.length}`);
  // Greedy packing: chunks start on sentence boundaries and never split a sentence.
  assert.ok(chunks[0].startsWith('ආයුබෝවන්. අද අපි ගුරුත්වය ඉගෙන ගනිමු.'));
  assert.ok(chunks.every((c) => c.endsWith('.')));
});

test('splitForSpeech handles the Sinhala full stop (danda) and very long words', () => {
  const chunks = splitForSpeech('පළමු වාක්‍යය። දෙවන වාක්‍යය।', 500);
  assert.deepEqual(chunks, ['පළමු වාක්‍යය። දෙවන වාක්‍යය।']);
  const long = splitForSpeech('a'.repeat(1200), 500);
  assert.ok(long.every((c) => c.length <= 500));
  assert.equal(long.join(''), 'a'.repeat(1200));
});

test('splitForSpeech returns nothing for empty input', () => {
  assert.deepEqual(splitForSpeech('   '), []);
});

test('escapeXml and buildSSML protect the markup', () => {
  assert.equal(escapeXml(`a < b & "c" 'd'`), 'a &lt; b &amp; &quot;c&quot; &apos;d&apos;');
  const ssml = buildSSML('1 < 2 & ගුරුවරිය', { voice: 'si-LK-ThiliniNeural', rate: -5 });
  assert.match(ssml, /xml:lang="si-LK"/);
  assert.match(ssml, /<voice name="si-LK-ThiliniNeural">/);
  assert.match(ssml, /<prosody rate="-5%">1 &lt; 2 &amp; ගුරුවරිය<\/prosody>/);
});

test('buildSSML rejects odd voice names (no injection through the voice field)', () => {
  assert.throws(() => buildSSML('x', { voice: 'x"><evil/>' }), SpeechError);
});

test('formatRate clamps and signs the value', () => {
  assert.equal(formatRate(0), '+0%');
  assert.equal(formatRate(-5), '-5%');
  assert.equal(formatRate(999), '+50%');
  assert.equal(formatRate(-999), '-50%');
  assert.equal(formatRate('abc'), '+0%');
});

test('azureSynthesize posts SSML with the key, region URL and MP3 format', async () => {
  let captured;
  const fakeFetch = async (url, init) => {
    captured = { url, init };
    return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'Content-Type': 'audio/mpeg' } });
  };
  const blob = await azureSynthesize({
    text: SI,
    key: 'secret-key',
    region: 'eastus',
    voice: 'si-LK-SameeraNeural',
    rate: 0,
    fetchImpl: fakeFetch,
  });
  assert.equal(captured.url, 'https://eastus.tts.speech.microsoft.com/cognitiveservices/v1');
  assert.equal(captured.init.method, 'POST');
  assert.equal(captured.init.headers['Ocp-Apim-Subscription-Key'], 'secret-key');
  assert.equal(captured.init.headers['Content-Type'], 'application/ssml+xml');
  assert.match(captured.init.headers['X-Microsoft-OutputFormat'], /mp3/);
  assert.match(captured.init.body, /si-LK-SameeraNeural/);
  assert.match(captured.init.body, new RegExp(SI));
  assert.equal(blob.size, 3);
});

test('azureSynthesize explains common Azure errors', async () => {
  const make = (status) => async () => new Response('nope', { status });
  await assert.rejects(azureSynthesize({ text: 'a', key: 'k', region: 'eastus', fetchImpl: make(401) }), (e) => e instanceof SpeechError && /key/.test(e.message));
  await assert.rejects(azureSynthesize({ text: 'a', key: 'k', region: 'eastus', fetchImpl: make(404) }), (e) => /region/.test(e.message));
  await assert.rejects(azureSynthesize({ text: 'a', key: 'k', region: 'eastus', fetchImpl: make(429) }), (e) => /limit/.test(e.message));
});

test('azureSynthesize asks for a key and region before calling Azure', async () => {
  await assert.rejects(azureSynthesize({ text: 'a', key: '', region: 'eastus', fetchImpl: async () => { throw new Error('should not be called'); } }), /key and region/);
});

test('pickBrowserVoice prefers the exact Sinhala locale, then any Sinhala voice', () => {
  const voices = [{ lang: 'en-US', name: 'A' }, { lang: 'si_LK', name: 'B' }];
  assert.equal(pickBrowserVoice(voices, 'si-LK').name, 'B');
  assert.equal(pickBrowserVoice([{ lang: 'si-LK-x', name: 'C' }], 'si-LK').name, 'C');
  assert.equal(pickBrowserVoice([{ lang: 'en-US' }], 'si-LK'), null);
});

test('speakWithBrowser fails clearly when no Sinhala voice is installed', () => {
  const api = { getVoices: () => [{ lang: 'en-US' }], speak() {}, cancel() {} };
  assert.throws(() => speakWithBrowser('ආයුබෝවන්', { api, UtteranceCtor: class {} }), /no Sinhala voice/);
});

// Fake Audio element: "plays" for a few milliseconds, then fires onended.
function fakeAudioFactory(log) {
  return (src) => {
    const audio = {
      src,
      onended: null,
      onerror: null,
      play() {
        log.push(`play:${src}`);
        setTimeout(() => audio.onended && audio.onended(), 5);
        return Promise.resolve();
      },
      pause() {
        log.push(`pause:${src}`);
      },
    };
    return audio;
  };
}

function installBlobUrls() {
  let n = 0;
  const original = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
  URL.createObjectURL = (blob) => `blob:${++n}:${blob.size}`;
  URL.revokeObjectURL = () => {};
  return () => {
    URL.createObjectURL = original.create;
    URL.revokeObjectURL = original.revoke;
  };
}

test('OralPlayer plays chunks in order even when they download out of order', async (t) => {
  const restore = installBlobUrls();
  t.after(restore);
  const log = [];
  // Chunk N takes longer to download the earlier it is, so arrival order is reversed.
  let call = 0;
  const fetchImpl = async (_url, init) => {
    const text = /<prosody[^>]*>([^<]*)</.exec(init.body)[1];
    const index = Number(text.split(' ')[0].replace('S', ''));
    await new Promise((r) => setTimeout(r, (3 - index) * 15));
    call++;
    return new Response(new Uint8Array(index + 1), { status: 200 });
  };
  const player = new OralPlayer({ fetchImpl, createAudio: fakeAudioFactory(log), speechApi: null });
  const text = Array.from({ length: 3 }, (_, i) => `S${i} ${'x'.repeat(490)}.`).join('\n');
  await player.speak(text, { engine: 'azure', azureKey: 'k', azureRegion: 'eastus', voice: 'si-LK-ThiliniNeural', rate: -5 });
  const plays = log.filter((l) => l.startsWith('play:'));
  assert.equal(plays.length, 3);
  assert.deepEqual(plays.map((p) => p.match(/blob:(\d+):(\d+)/)[2]), ['1', '2', '3'], 'played in chunk order');
  assert.equal(call, 3);
});

test('OralPlayer.stop cancels the rest of the speech and reports idle', async (t) => {
  const restore = installBlobUrls();
  t.after(restore);
  const log = [];
  const states = [];
  const fetchImpl = async () => new Response(new Uint8Array(4), { status: 200 });
  const player = new OralPlayer({
    fetchImpl,
    createAudio: (src) => {
      const audio = {
        onended: null,
        play() {
          log.push(`play:${src}`);
          // never ends on its own: the test stops it
          return Promise.resolve();
        },
        pause() {
          log.push('pause');
        },
      };
      return audio;
    },
    speechApi: null,
    onChange: (playing) => states.push(playing),
  });
  const text = Array.from({ length: 4 }, (_, i) => `Part ${i} ${'y'.repeat(480)}.`).join('\n');
  const run = player.speak(text, { engine: 'azure', azureKey: 'k', azureRegion: 'eastus', voice: 'si-LK-ThiliniNeural', rate: 0 });
  await new Promise((r) => setTimeout(r, 30));
  player.stop();
  await run;
  assert.equal(log.filter((l) => l.startsWith('play:')).length, 1, 'only the first part started');
  assert.ok(log.includes('pause'));
  assert.equal(states.at(-1), false, 'UI told speaking stopped');
});

test('OralPlayer reports a clear error when Azure is not configured', async () => {
  const player = new OralPlayer({ fetchImpl: async () => new Response('', { status: 200 }), createAudio: fakeAudioFactory([]), speechApi: null });
  await assert.rejects(player.speak('ආයුබෝවන්', { engine: 'azure', azureKey: '', azureRegion: '', voice: 'si-LK-ThiliniNeural', rate: 0 }), /Azure Speech key and region/);
});

test('normalizeSettings adds Sinhala defaults and cleans speech values', () => {
  const s = normalizeSettings({});
  assert.equal(s.language, 'si');
  assert.deepEqual(s.speech, DEFAULT_SPEECH);

  const custom = normalizeSettings({
    language: 'xx',
    speech: { engine: 'browser', azureRegion: ' East US ', rate: 500, autoSpeak: 1, voice: '' },
  });
  assert.equal(custom.language, 'si');
  assert.equal(custom.speech.engine, 'browser');
  assert.equal(custom.speech.azureRegion, 'eastus');
  assert.equal(custom.speech.rate, 50);
  assert.equal(custom.speech.autoSpeak, true);
  assert.equal(custom.speech.voice, DEFAULT_SPEECH.voice);
  assert.equal(normalizeSettings({ language: 'en' }).language, 'en');

  // Free voice is the default; Azure is only used when chosen; unknown values fall back to free.
  assert.equal(DEFAULT_SPEECH.engine, 'free');
  assert.equal(normalizeSettings({ speech: { engine: 'azure' } }).speech.engine, 'azure');
  assert.equal(normalizeSettings({ speech: { engine: 'nonsense' } }).speech.engine, 'free');
  assert.equal(normalizeSettings({ speech: { engine: 'browser' } }).speech.engine, 'browser');
});

test('system prompt asks for Sinhala replies and teacher-style speech when oral is on', () => {
  const sinhala = buildSystemPrompt({ mode: 'chat', language: 'si', oral: true });
  assert.ok(sinhala.includes(LANGUAGE_INSTRUCTIONS.si));
  assert.ok(sinhala.includes(ORAL_INSTRUCTION));
  const english = buildSystemPrompt({ mode: 'chat', language: 'en', oral: false });
  assert.ok(english.includes('Reply in English.'));
  assert.ok(!english.includes(ORAL_INSTRUCTION));
});

test('buildMessages passes language and oral through to the system prompt', () => {
  const [system] = buildMessages({ history: [{ role: 'user', content: 'hi' }], language: 'si', oral: true });
  assert.match(system.content, /Sinhala script/);
  assert.match(system.content, /read aloud/);
});
