# Page Tutor AI

A Gemini-style AI assistant for Chrome. The web page stays on the **left**, and an AI side panel opens on the **right**. The assistant reads the page you are viewing, then answers questions about it, summarizes it, and teaches it step by step.

## Features

- **Side panel chat** (Chrome side panel, right side of the window) with streaming answers, Markdown formatting, and a Stop button.
- **Chat with or without the page**: the *Include page* toggle (above the input) decides whether the assistant reads the page you are viewing. The choice is remembered. With it off, you get a plain AI chat. On browser-internal pages where reading isn't possible, chat still works without the page. The ↻ button re-reads the page.
- **Modes** above the input:
  - **Chat**: ask anything about the page.
  - **Summarize**: overview plus key points.
  - **Teach me**: a structured lesson with concepts, examples, a glossary, and a short self-check.
  - **Quiz me**: one question at a time, with feedback and a final score.
  - **Explain simply**: plain-language explanation with analogies.
- **Reference the page**: select text on any page and choose *Ask Page Tutor about "…"* from the right-click menu, or press *Quote selection* in the panel. Right-click *Teach me this page* starts a lesson immediately.
- **Settings** (⚙): Base URL, API key, and model. *Test connection* checks them.

## Arena API

Arena does not publish a public chat API that I could find. The extension therefore talks to **any OpenAI-compatible `POST {base}/chat/completions` endpoint**. Put your Arena API gateway or bridge URL, key, and model name into Settings:

| Setting  | Example                          |
|----------|----------------------------------|
| Base URL | `https://your-arena-gateway/v1`  |
| API key  | your key (optional for local servers) |
| Model    | the model name your provider exposes |

If you already have an Arena endpoint in another format, tell me its request/response shape and I will adapt `extension/lib/api.js`.

## Install (Chrome, Edge, or any Chromium browser ≥ 116)

1. Clone the repository and open `chrome://extensions`.
2. Turn on **Developer mode**, then click **Load unpacked** and select the `extension/` folder.
3. Open any web page and click the **Page Tutor** toolbar icon. The side panel opens on the right.
4. Click ⚙, fill in Base URL / API key / model, press **Test connection**, then **Save**.

### Try it without an API key

```bash
npm install
npm run mock          # OpenAI-compatible fake server on http://localhost:8000/v1
```

In Settings use Base URL `http://localhost:8000/v1` and model `mock-model`.

## Project layout

```
extension/
  manifest.json          Manifest V3 config (side panel, context menus, storage)
  background.js          Opens the side panel, creates right-click menu items
  sidepanel/             Chat UI: index.html, sidepanel.css, sidepanel.js
  lib/api.js             Streaming OpenAI-compatible client (SSE parser, errors)
  lib/prompts.js         Teaching modes and system-prompt construction
  lib/page.js            Page text extractor injected into the active tab
  lib/markdown.js        Safe, dependency-free Markdown renderer
  lib/settings.js        Settings in chrome.storage.local
scripts/mock-server.mjs  Fake OpenAI-compatible server for development
tests/                   Unit and integration tests (node:test + jsdom)
```

## Development

```bash
npm install
npm test              # 27 tests: Markdown, streaming client, prompts, page extraction
```

No build step is needed. Edit files in `extension/` and click the reload icon on the extension in `chrome://extensions`.

## Privacy and limits

- Page text is sent only to the endpoint you configure, and only while *Include page* is on and you send a message. The page is re-read at each send.
- The API key is stored in `chrome.storage.local` on this browser. It is never sent anywhere except your Base URL.
- Browser-internal pages (`chrome://`, the Chrome Web Store) cannot be read. PDFs shown in Chrome's built-in viewer also expose no text to extensions.
- Very long pages are trimmed to about 30,000 characters, and the panel says so.
- The extension asks for access to all sites (`<all_urls>`) so it can read whichever page you are viewing.
- Community "bridges" that reverse-engineer the Arena website are unofficial. They can break at any time, and you should check their terms before using them.
