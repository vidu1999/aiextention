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
- **Voice input (free)**: press the 🎤 button and speak your question. The words appear in the message box, so you can check or edit them, then press Enter. Speak Sinhala when the reply language is Sinhala, and English when it is English.
- **Sinhala replies**: the 🇱🇰 *සිංහල / English* chip sets the language the AI answers in. Sinhala is the default.
- **Oral teacher (free)**: the 🔇 *Oral* chip turns on spoken answers. A warm female teacher voice (Microsoft's Thilini neural voice) reads each answer aloud in Sinhala. No key or payment is needed. Every answer also has a 🔊 *Listen* button, and you can stop playback at any time.
- **Settings** (⚙): Base URL, API key, and model. *Test connection* checks them. The voice section sets the voice engine, teacher voice, speed, and Oral mode. Azure keys are optional.

## Arena API

Arena does not publish a public chat API that I could find. The extension therefore talks to **any OpenAI-compatible `POST {base}/chat/completions` endpoint**. Put your Arena API gateway or bridge URL, key, and model name into Settings:

| Setting  | Example                          |
|----------|----------------------------------|
| Base URL | `https://your-arena-gateway/v1`  |
| API key  | your key (optional for local servers) |
| Model    | the model name your provider exposes |

If you already have an Arena endpoint in another format, tell me its request/response shape and I will adapt `extension/lib/api.js`.

## Free oral teacher and voice input (no paid key)

The default **Voice engine** is *Free voice (no key, recommended)*. It uses free services, so you do not need an Azure account, a card, or any other key for speaking or listening.

| Part | Free engine used first | If that fails |
|------|------------------------|---------------|
| Teacher speaks (Sinhala) | Microsoft's **Thilini** neural voice (`si-LK-ThiliniNeural`), using the same read-aloud service as Microsoft Edge | Google's translate voice (`tl=si`), then the device's own voice |
| You speak (🎤) | Chrome's built-in speech recognition, set to Sinhala (`si-LK`) or English (`en-US`) | Nothing else is needed. Chrome recognition is free. |

How it behaves:

- **The teacher starts quickly.** Answers are split into short pieces at sentence ends. While one piece plays, the next is fetched, so there are never more than two requests in flight.
- **The status line tells you** when a backup voice is used.
- **If the free voices are blocked**, for example on a restricted network, the panel reads with the device's Sinhala voice (if installed) and shows a message. After one failure, the Thilini voice is skipped for 10 minutes so the answer doesn't stall.
- **Voice input writes into the box** and does not send. Press Enter when you are happy with the text. The teacher stops when you start speaking.

Requirements and limits:

- **Internet is needed** for the free teacher voice. The device voice works offline only if the device has a Sinhala voice installed.
- **Chrome recognition needs internet** too, because Chrome sends the audio to Google's recognition service.
- **The free voices are unofficial.** Microsoft's read-aloud service and Google's translate voice are not public APIs for extensions. They can change or block requests at any time. The fallback chain keeps the feature working when that happens, but the best voice may sometimes be unavailable.
- **Recording is limited to 45 seconds** per question.

### Optional: Azure neural voice (paid)

Choose *Azure neural voice (optional, paid, needs your key)* only if you want Azure's official, supported voice. Azure is billed by usage, and its free tier has limits. Check the current Azure pricing page first.

1. In the Azure portal, create a **Speech** resource.
2. Open the resource, go to **Keys and Endpoint**, and copy **Key 1** and the **Location/Region** (for example `eastus`).
3. In Page Tutor, open ⚙ → *Oral teacher (voice)*, choose the Azure option, paste the key and region, and press **▶ Play sample**.

Azure is used for both speaking (Neural TTS) and listening (Speech-to-Text, 16 kHz WAV, Sinhala or English).

### Choosing the engine

| Setting | Speaks | Listens | Needs |
|---------|--------|---------|-------|
| *Free voice* (default) | Thilini neural voice, then Google, then device | Chrome recognition | Internet, no key |
| *Azure neural voice* | Azure neural voice | Azure speech-to-text | Azure key and region (paid) |
| *Device voice only* | Device Sinhala voice | Chrome recognition | Sinhala voice installed, for speaking |

### Free teacher voices in the code

Teacher voices are chosen in Settings. The female Thilini voice is the default. Sameera (male) is also offered and uses the same free service; it has not been tested live. The free voice code is in `extension/lib/edgetts.js`, and the fallback chain is in `extension/lib/speech.js`.

How the speech is prepared: Markdown, links, URLs, code blocks, and emoji are removed before speaking, so the voice reads words, not symbols.

### Free AI answers (optional)

The teacher's voice is free, but the AI that writes answers is separate and uses whichever endpoint you configure. Any OpenAI-compatible server works, including a free local server you run yourself (for example, Ollama at `http://localhost:11434/v1`, with a model name it provides). Quality for Sinhala depends on the model.

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
  lib/speech.js          Oral output: speech prep, free-voice chain, Azure client, device fallback, player
  lib/edgetts.js         Free Thilini neural voice (Edge read-aloud WebSocket) and Google backup voice
  lib/errors.js          Shared SpeechError type
  lib/listen.js          Voice input: recording, WAV conversion, Azure speech-to-text, browser recognition
scripts/mock-server.mjs  Fake OpenAI-compatible server for development
tests/                   Unit and integration tests (node:test + jsdom)
```

## Development

```bash
npm install
npm test              # 77 tests: Markdown, streaming client, prompts, page extraction, speech, free voice, voice input
```

No build step is needed. Edit files in `extension/` and click the reload icon on the extension in `chrome://extensions`.

## Privacy and limits

- Page text is sent only to the endpoint you configure, and only while *Include page* is on and you send a message. The page is re-read at each send.
- The API key is stored in `chrome.storage.local` on this browser. It is never sent anywhere except your Base URL.
- The free voices send only the text being read aloud to Microsoft's read-aloud service and to Google's translate voice. Your voice goes to Chrome's speech recognition only while you use 🎤.
- The optional Azure Speech key is stored the same way and is sent only to Azure's speech endpoint for your region, and only when you choose the Azure engine.
- Browser-internal pages (`chrome://`, the Chrome Web Store) cannot be read. PDFs shown in Chrome's built-in viewer also expose no text to extensions.
- Very long pages are trimmed to about 30,000 characters, and the panel says so.
- The extension asks for access to all sites (`<all_urls>`) so it can read whichever page you are viewing.
- Community "bridges" that reverse-engineer the Arena website are unofficial. They can break at any time, and you should check their terms before using them.
