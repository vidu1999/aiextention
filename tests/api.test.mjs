import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  streamChat,
  parseEventStream,
  chatCompletionsUrl,
  extractDelta,
  testConnection,
  ApiError,
} from '../extension/lib/api.js';
import { createMockServer } from '../scripts/mock-server.mjs';

function streamFrom(chunks) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function collect(iterable) {
  let out = '';
  for await (const part of iterable) out += part;
  return out;
}

test('chatCompletionsUrl appends /chat/completions and trims trailing slashes', () => {
  assert.equal(chatCompletionsUrl('https://x.test/v1/'), 'https://x.test/v1/chat/completions');
  assert.equal(chatCompletionsUrl(' http://localhost:8000/v1 '), 'http://localhost:8000/v1/chat/completions');
  assert.throws(() => chatCompletionsUrl('ftp://nope'), ApiError);
  assert.throws(() => chatCompletionsUrl(''), ApiError);
});

test('extractDelta reads streaming deltas and full messages', () => {
  assert.equal(extractDelta({ choices: [{ delta: { content: 'hi' } }] }), 'hi');
  assert.equal(extractDelta({ choices: [{ message: { content: 'full' } }] }), 'full');
  assert.equal(extractDelta({ choices: [{ delta: {} }] }), '');
  assert.equal(extractDelta({}), '');
});

test('parseEventStream handles chunks split across packets and CRLF', async () => {
  const body = streamFrom([
    'data: {"choices":[{"delta":{"content":"Hel"}}]}\r\n\r\ndata: {"choices":[{"del',
    'ta":{"content":"lo"}}]}\n\n: keep-alive\n\ndata: [DONE]\n\n',
  ]);
  assert.equal(await collect(parseEventStream(body)), 'Hello');
});

test('parseEventStream stops at [DONE] and ignores later data', async () => {
  const body = streamFrom(['data: {"choices":[{"delta":{"content":"a"}}]}\n\ndata: [DONE]\n\ndata: {"choices":[{"delta":{"content":"b"}}]}\n\n']);
  assert.equal(await collect(parseEventStream(body)), 'a');
});

test('parseEventStream surfaces streamed error objects', async () => {
  const body = streamFrom(['data: {"error":{"message":"quota exceeded"}}\n\n']);
  await assert.rejects(collect(parseEventStream(body)), (err) => err instanceof ApiError && /quota exceeded/.test(err.message));
});

test('streamChat sends the right request and yields text', async () => {
  let captured;
  const fakeFetch = async (url, init) => {
    captured = { url, init };
    return new Response(streamFrom(['data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n']), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });
  };
  const text = await collect(
    streamChat({ baseUrl: 'https://arena.test/v1', apiKey: 'sk-1', model: 'm1', messages: [{ role: 'user', content: 'hi' }], fetchImpl: fakeFetch }),
  );
  assert.equal(text, 'ok');
  assert.equal(captured.url, 'https://arena.test/v1/chat/completions');
  assert.equal(captured.init.headers.Authorization, 'Bearer sk-1');
  const body = JSON.parse(captured.init.body);
  assert.equal(body.model, 'm1');
  assert.equal(body.stream, true);
  assert.deepEqual(body.messages, [{ role: 'user', content: 'hi' }]);
});

test('streamChat omits Authorization when no key is set', async () => {
  let headers;
  const fakeFetch = async (_url, init) => {
    headers = init.headers;
    return new Response(JSON.stringify({ choices: [{ message: { content: 'local' } }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  const text = await collect(streamChat({ baseUrl: 'http://localhost:1/v1', model: 'm', messages: [], fetchImpl: fakeFetch }));
  assert.equal(text, 'local');
  assert.equal(headers.Authorization, undefined);
});

test('streamChat gives a helpful message for 401 responses', async () => {
  const fakeFetch = async () => new Response(JSON.stringify({ error: { message: 'bad key' } }), { status: 401 });
  await assert.rejects(
    collect(streamChat({ baseUrl: 'http://x/v1', model: 'm', messages: [], fetchImpl: fakeFetch })),
    (err) => err.status === 401 && /Check your API key/.test(err.message) && /bad key/.test(err.message),
  );
});

test('streamChat reports unreachable servers clearly', async () => {
  const fakeFetch = async () => {
    throw new TypeError('fetch failed');
  };
  await assert.rejects(
    collect(streamChat({ baseUrl: 'http://nowhere/v1', model: 'm', messages: [], fetchImpl: fakeFetch })),
    (err) => /Could not reach/.test(err.message),
  );
});

test('streamChat requires a model', async () => {
  await assert.rejects(collect(streamChat({ baseUrl: 'http://x/v1', model: '', messages: [] })), /Choose a model/);
});

test('works end-to-end against the bundled mock server', async (t) => {
  const server = createMockServer({ chunkDelayMs: 0 });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}/v1`;

  const messages = [
    { role: 'system', content: 'Current mode: Teach me.\n<page_content>\nTitle: Photosynthesis\n</page_content>' },
    { role: 'user', content: 'What is this page about?' },
  ];
  const reply = await collect(streamChat({ baseUrl, model: 'mock-model', messages }));
  assert.match(reply, /Photosynthesis/);
  assert.match(reply, /What is this page about\?/);

  const ping = await testConnection({ baseUrl, model: 'mock-model', apiKey: '' });
  assert.match(ping, /mock reply/);
});
