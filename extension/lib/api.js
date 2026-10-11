// OpenAI-compatible chat client with streaming (Server-Sent Events).
// Works with any endpoint that implements POST {baseUrl}/chat/completions.
// Set baseUrl to your Arena API / gateway, e.g. https://your-host/v1

export class ApiError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

const DONE = Symbol('done');

export function chatCompletionsUrl(baseUrl) {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(base)) {
    throw new ApiError('Base URL must start with http:// or https://');
  }
  return `${base}/chat/completions`;
}

export function buildRequestBody({ model, messages, stream = true, temperature = 0.4 }) {
  return { model, messages, stream, temperature };
}

// Pulls the text fragment out of one chat-completion chunk (or full response).
export function extractDelta(json) {
  const choice = json?.choices?.[0];
  if (!choice) return '';
  const value = choice.delta?.content ?? choice.message?.content ?? choice.text ?? '';
  return typeof value === 'string' ? value : '';
}

function handleSSELine(line) {
  if (!line.startsWith('data:')) return null;
  const payload = line.slice(5).trim();
  if (!payload) return null;
  if (payload === '[DONE]') return DONE;

  let json;
  try {
    json = JSON.parse(payload);
  } catch {
    return null; // ignore keep-alive / malformed lines
  }
  if (json.error) {
    throw new ApiError(json.error.message || 'The server reported an error while streaming.');
  }
  return extractDelta(json) || null;
}

// Turns a ReadableStream of SSE bytes into a stream of text deltas.
export async function* parseEventStream(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline).replace(/\r$/, '');
      buffer = buffer.slice(newline + 1);
      const result = handleSSELine(line);
      if (result === DONE) {
        await reader.cancel();
        return;
      }
      if (result) yield result;
    }
  }

  buffer += decoder.decode();
  const rest = buffer.trim();
  if (rest) {
    const result = handleSSELine(rest);
    if (result && result !== DONE) yield result;
  }
}

async function describeHttpError(res) {
  let detail = '';
  try {
    const text = await res.text();
    try {
      const json = JSON.parse(text);
      detail = json.error?.message || json.message || text;
    } catch {
      detail = text;
    }
  } catch {
    // body unreadable; keep detail empty
  }
  detail = String(detail).slice(0, 300);

  if (res.status === 401 || res.status === 403) {
    return `Authentication failed (HTTP ${res.status}). Check your API key in Settings.${detail ? ` ${detail}` : ''}`;
  }
  if (res.status === 404) {
    return `Endpoint not found (HTTP 404). Check the Base URL and model name in Settings.${detail ? ` ${detail}` : ''}`;
  }
  if (res.status === 429) {
    return `Rate limited (HTTP 429). Wait a moment and try again.${detail ? ` ${detail}` : ''}`;
  }
  return `Request failed: HTTP ${res.status}${detail ? ` — ${detail}` : ''}`;
}

/**
 * Streams the assistant's reply as text deltas.
 * @param {{baseUrl: string, apiKey?: string, model: string, messages: Array<{role: string, content: string}>, signal?: AbortSignal, fetchImpl?: typeof fetch}} options
 */
export async function* streamChat({ baseUrl, apiKey, model, messages, signal, fetchImpl = globalThis.fetch }) {
  if (!model) throw new ApiError('Choose a model name in Settings.');

  const headers = { 'Content-Type': 'application/json', Accept: 'text/event-stream' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  let res;
  try {
    res = await fetchImpl(chatCompletionsUrl(baseUrl), {
      method: 'POST',
      headers,
      body: JSON.stringify(buildRequestBody({ model, messages, stream: true })),
      signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new ApiError(`Could not reach ${baseUrl}. Is the server running and is the URL correct? (${err.message})`);
  }

  if (!res.ok) {
    throw new ApiError(await describeHttpError(res), res.status);
  }

  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('text/event-stream') && res.body) {
    yield* parseEventStream(res.body);
    return;
  }

  // Server ignored `stream: true` and returned a single JSON document.
  const json = await res.json();
  if (json.error) throw new ApiError(json.error.message || 'The server returned an error.');
  const text = extractDelta(json);
  if (text) yield text;
}

// Sends a tiny request to verify the settings. Resolves with the model's reply.
export async function testConnection(settings, signal) {
  let reply = '';
  for await (const delta of streamChat({
    ...settings,
    messages: [{ role: 'user', content: 'Reply with exactly one word: OK' }],
    signal,
  })) {
    reply += delta;
  }
  return reply.trim();
}
