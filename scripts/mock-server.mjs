// A tiny OpenAI-compatible server for trying Page Tutor without any API key.
// Run:  npm run mock   (listens on http://localhost:8000/v1 by default)
import http from 'node:http';
import { pathToFileURL } from 'node:url';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

export function buildReply(messages) {
  const system = messages.find((m) => m.role === 'system')?.content || '';
  const last = [...messages].reverse().find((m) => m.role === 'user')?.content || '';
  const title = /Title: (.*)/.exec(system)?.[1];
  const mode = /Current mode: ([^.]+)\./.exec(system)?.[1] || 'Chat';

  const question = last.split('\n').slice(-1)[0].slice(0, 120);
  const pageLine = title
    ? `I can see the page **"${title}"**.`
    : 'No page is attached to this conversation.';

  return [
    `### ${mode} (mock reply)`,
    '',
    pageLine,
    '',
    `You asked: *${question}*`,
    '',
    '- This is a fake response from `scripts/mock-server.mjs`.',
    '- Point Settings → Base URL at a real OpenAI-compatible endpoint to get real answers.',
    '',
    '```js',
    'console.log("Hello from Page Tutor");',
    '```',
  ].join('\n');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...CORS });
  res.end(JSON.stringify(body));
}

export function createMockServer({ chunkDelayMs = 25 } = {}) {
  return http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS);
      return res.end();
    }

    if (req.method === 'GET' && req.url === '/v1/models') {
      return sendJson(res, 200, { object: 'list', data: [{ id: 'mock-model', object: 'model' }] });
    }

    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        return sendJson(res, 400, { error: { message: 'Invalid JSON body' } });
      }
      const reply = buildReply(body.messages || []);
      const id = `chatcmpl-mock-${Date.now()}`;

      if (!body.stream) {
        return sendJson(res, 200, {
          id,
          object: 'chat.completion',
          model: body.model,
          choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }],
        });
      }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        ...CORS,
      });
      const pieces = reply.match(/\S+\s*|\n/g) || [reply];
      for (const piece of pieces) {
        const chunk = { id, object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] };
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        await new Promise((r) => setTimeout(r, chunkDelayMs));
      }
      res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      return res.end();
    }

    sendJson(res, 404, { error: { message: `No route for ${req.method} ${req.url}` } });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT || 8000);
  createMockServer().listen(port, '0.0.0.0', () => {
    console.log(`Mock OpenAI-compatible API running at http://localhost:${port}/v1`);
  });
}
