import { streamChat, testConnection } from '../lib/api.js';
import { loadSettings, saveSettings, normalizeSettings } from '../lib/settings.js';
import { MODES, DEFAULT_PROMPTS, buildMessages } from '../lib/prompts.js';
import { renderMarkdown } from '../lib/markdown.js';
import { extractPageContent, MAX_PAGE_CHARS } from '../lib/page.js';
import { OralPlayer, SpeechError } from '../lib/speech.js';
import { VoiceRecorder, convertToWav16k, azureTranscribe, startBrowserListening, sttLanguage } from '../lib/listen.js';

const $ = (id) => document.getElementById(id);

const ui = {
  chat: $('chat'),
  empty: $('empty'),
  composer: $('composer'),
  input: $('input'),
  sendBtn: $('sendBtn'),
  stopBtn: $('stopBtn'),
  usePage: $('usePage'),
  pageInfo: $('pageInfo'),
  refreshPage: $('refreshPage'),
  quoteBtn: $('quoteBtn'),
  quoteChip: $('quoteChip'),
  micBtn: $('micBtn'),
  voiceStatus: $('voiceStatus'),
  langChip: $('langChip'),
  oralChip: $('oralChip'),
  newChat: $('newChatBtn'),
  settingsBtn: $('settingsBtn'),
  settings: $('settings'),
  settingsForm: $('settingsForm'),
  baseUrl: $('baseUrl'),
  apiKey: $('apiKey'),
  model: $('model'),
  language: $('language'),
  engine: $('engine'),
  azureKey: $('azureKey'),
  azureRegion: $('azureRegion'),
  voice: $('voice'),
  rate: $('rate'),
  autoSpeak: $('autoSpeak'),
  speakTestBtn: $('speakTestBtn'),
  testBtn: $('testBtn'),
  closeSettings: $('closeSettings'),
  settingsStatus: $('settingsStatus'),
  modes: $('modes'),
  suggestions: document.querySelectorAll('.suggestion'),
};

const state = {
  history: [], // { role: 'user' | 'assistant', content: string }
  mode: 'chat',
  busy: false,
  controller: null,
  quote: null,
  page: null,
};

// Oral output: one player for the whole panel. `speakingBtn` is the button that
// is currently playing; `speakRun` ignores errors from runs that were superseded.
let speakingBtn = null;
let speakRun = 0;
const player = new OralPlayer({ onChange: handleSpeechChange, onNotice: handleSpeechNotice });

// Voice input state. `listenMode` is 'azure' or 'browser' while the microphone is on.
let listenMode = null;
let dictation = null; // { base, settings, browser }
const recorder = new VoiceRecorder({ onAutoStop: () => stopListening() });

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function scrollDown() {
  ui.chat.scrollTop = ui.chat.scrollHeight;
}

function hideEmpty() {
  ui.empty.hidden = true;
}

function autoGrow() {
  ui.input.style.height = 'auto';
  ui.input.style.height = `${Math.min(ui.input.scrollHeight, 160)}px`;
}

/* ---------- page reading ---------- */

async function getActivePage() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id) throw new Error('No active tab found.');
  if (!/^https?:\/\//i.test(tab.url || '')) {
    throw new Error('No page included: this browser page cannot be read. Chat still works; open a normal website to include it.');
  }

  const [injection] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: extractPageContent,
    args: [MAX_PAGE_CHARS],
  });
  if (!injection?.result) throw new Error('Could not read this page. Try reloading it.');
  return injection.result;
}

function describePage(page) {
  const name = page.title || page.url;
  const size = `${page.length.toLocaleString()} characters`;
  return `${name} · ${size}${page.truncated ? ' (trimmed)' : ''}`;
}

async function updatePageInfo() {
  if (!ui.usePage.checked) {
    state.page = null;
    ui.pageInfo.textContent = 'Chatting without the page. Tick “Include page” to ask about it.';
    ui.pageInfo.classList.remove('error');
    return null;
  }
  try {
    state.page = await getActivePage();
    ui.pageInfo.textContent = `Including: ${describePage(state.page)}`;
    ui.pageInfo.classList.remove('error');
    return state.page;
  } catch (err) {
    state.page = null;
    ui.pageInfo.textContent = err.message;
    ui.pageInfo.classList.add('error');
    return null;
  }
}

// Remember the "Include page" choice between sessions.
async function loadIncludePagePref() {
  const { includePage } = await chrome.storage.local.get('includePage');
  ui.usePage.checked = includePage !== false; // default: on
}

function saveIncludePagePref() {
  chrome.storage.local.set({ includePage: ui.usePage.checked });
}

/* ---------- modes & quotes ---------- */

function setMode(mode) {
  state.mode = MODES[mode] ? mode : 'chat';
  for (const button of ui.modes.querySelectorAll('button')) {
    button.classList.toggle('active', button.dataset.mode === state.mode);
  }
  ui.input.placeholder = MODES[state.mode].placeholder;
}

function renderQuote() {
  ui.quoteChip.replaceChildren();
  ui.quoteChip.hidden = !state.quote;
  if (!state.quote) return;

  const preview = state.quote.length > 120 ? `${state.quote.slice(0, 120)}…` : state.quote;
  const remove = el('button', 'icon-btn small', '✕');
  remove.title = 'Remove quote';
  remove.setAttribute('aria-label', 'Remove quote');
  remove.addEventListener('click', () => {
    state.quote = null;
    renderQuote();
  });
  ui.quoteChip.append(el('span', 'quote-text', `“${preview}”`), remove);
}

/* ---------- language & oral chips ---------- */

function renderChips(settings) {
  ui.langChip.textContent = settings.language === 'si' ? 'සිංහල' : 'English';
  ui.langChip.title = settings.language === 'si' ? 'Replies in Sinhala (tap for English)' : 'Replies in English (tap for Sinhala)';
  ui.oralChip.textContent = settings.speech.autoSpeak ? '🔊 Oral on' : '🔇 Oral off';
  ui.oralChip.classList.toggle('active', settings.speech.autoSpeak);
}

function speechReady(speech) {
  // The free and device engines need no key; only the optional Azure engine does.
  return speech.engine !== 'azure' || Boolean(speech.azureKey && speech.azureRegion);
}

/* ---------- voice input ---------- */

function setVoiceStatus(message, kind = '') {
  ui.voiceStatus.textContent = message || '';
  ui.voiceStatus.className = `voice-status ${kind}`.trim();
  ui.voiceStatus.hidden = !message;
}

function setMicState(stateName) {
  ui.micBtn.classList.toggle('recording', stateName === 'recording');
  ui.micBtn.classList.toggle('busy', stateName === 'busy');
  ui.micBtn.textContent = stateName === 'recording' ? '⏹' : '🎤';
  ui.micBtn.title = stateName === 'recording' ? 'Finish and write my question' : 'Speak your question';
  ui.micBtn.disabled = stateName === 'busy';
  ui.input.placeholder = stateName === 'recording' ? 'Listening… tap ⏹ when you are done' : MODES[state.mode].placeholder;
}

function joinSpoken(base, spoken) {
  return [base, spoken].filter(Boolean).join(' ');
}

async function startListening() {
  const settings = await loadSettings();
  player.stop(); // the teacher must not talk over the student
  setVoiceStatus('');
  dictation = { base: ui.input.value.trim(), settings, browser: null };
  try {
    if (settings.speech.engine !== 'azure') {
      // Free: the browser's built-in recognition (Chrome, no key).
      dictation.browser = startBrowserListening({
        lang: sttLanguage(settings.language),
        onInterim: (text) => {
          ui.input.value = joinSpoken(dictation.base, text);
          autoGrow();
        },
      });
      listenMode = 'browser';
      // The browser stops listening by itself after a pause: finish the dictation then.
      dictation.browser.done.then(
        () => {
          if (listenMode === 'browser') stopListening();
        },
        (err) => {
          if (listenMode !== 'browser') return;
          const base = dictation.base;
          listenMode = null;
          dictation = null;
          ui.input.value = base;
          setMicState('idle');
          setVoiceStatus(err.message, 'error');
        },
      );
    } else {
      if (!settings.speech.azureKey || !settings.speech.azureRegion) {
        throw new SpeechError('Add your Azure Speech key and region in Settings to use Azure voice input, or choose the free voice.');
      }
      await recorder.start();
      listenMode = 'azure';
    }
    setMicState('recording');
  } catch (err) {
    listenMode = null;
    dictation = null;
    setMicState('idle');
    setVoiceStatus(err.message, 'error');
  }
}

async function stopListening() {
  if (!listenMode || !dictation) return;
  const mode = listenMode;
  const { base, settings, browser } = dictation;
  listenMode = null;
  setMicState('busy');

  try {
    let text;
    if (mode === 'browser') {
      browser.stop();
      text = await browser.done;
    } else {
      const blob = await recorder.stop();
      setVoiceStatus('Writing down what you said…');
      const wav = await convertToWav16k(blob);
      text = await azureTranscribe({
        wav,
        key: settings.speech.azureKey,
        region: settings.speech.azureRegion,
        language: sttLanguage(settings.language),
      });
    }

    if (text) {
      ui.input.value = joinSpoken(base, text);
      autoGrow();
      ui.input.focus();
      const hint = 'Check the text, then press Enter to ask.';
      setVoiceStatus(hint);
      setTimeout(() => {
        if (ui.voiceStatus.textContent === hint) setVoiceStatus('');
      }, 4000);
    } else {
      ui.input.value = base;
      setVoiceStatus('I did not hear anything. Tap 🎤 and try again.', 'error');
    }
  } catch (err) {
    ui.input.value = base;
    setVoiceStatus(err.message, 'error');
  } finally {
    dictation = null;
    setMicState('idle');
  }
}

ui.micBtn.addEventListener('click', () => {
  if (listenMode) stopListening();
  else startListening();
});

/* ---------- messages ---------- */

function appendUserMessage(text, quote) {
  hideEmpty();
  const wrap = el('div', 'msg user');
  if (quote) {
    const preview = quote.length > 240 ? `${quote.slice(0, 240)}…` : quote;
    wrap.append(el('div', 'quote', preview));
  }
  wrap.append(el('div', 'bubble', text));
  ui.chat.append(wrap);
  scrollDown();
}

function appendAssistantMessage() {
  hideEmpty();
  const wrap = el('div', 'msg assistant');
  const column = el('div', 'col');
  const bubble = el('div', 'bubble md');
  bubble.innerHTML = '<span class="typing"><i></i><i></i><i></i></span>';
  column.append(bubble);
  wrap.append(el('div', 'avatar', '✦'), column);
  ui.chat.append(wrap);
  scrollDown();
  return { wrap, column, bubble };
}

// Adds the "Listen" button under a finished answer.
function addSpeakRow(column, answer) {
  const row = el('div', 'msg-actions');
  const button = el('button', 'speak-btn', '🔊 Listen');
  button.title = 'Read this answer aloud in the teacher’s voice';
  button.addEventListener('click', () => {
    if (button.classList.contains('playing')) player.stop();
    else speakAnswer(button, answer);
  });
  row.append(button);
  column.append(row);
  return button;
}

function setSpeakButton(button, playing) {
  button.textContent = playing ? '⏹ Stop' : '🔊 Listen';
  button.classList.toggle('playing', playing);
}

function showSpeakError(button, message) {
  const row = button.parentElement;
  row.querySelector('.speak-error')?.remove();
  row.append(el('span', 'speak-error', message));
}

function handleSpeechNotice(message) {
  const row = speakingBtn?.parentElement;
  if (!row) return;
  row.querySelector('.speak-note')?.remove();
  row.append(el('span', 'speak-note', message));
}

function handleSpeechChange(playing) {
  if (!playing && speakingBtn) {
    setSpeakButton(speakingBtn, false);
    speakingBtn = null;
  }
}

async function speakAnswer(button, text) {
  const settings = await loadSettings();
  const run = ++speakRun;
  if (speakingBtn) setSpeakButton(speakingBtn, false);
  speakingBtn = button;
  setSpeakButton(button, true);
  button.parentElement.querySelector('.speak-error')?.remove();
  button.parentElement.querySelector('.speak-note')?.remove();

  try {
    await player.speak(text, settings.speech);
  } catch (err) {
    if (run === speakRun) {
      const message = err instanceof SpeechError ? err.message : `Speech failed: ${err.message || err}`;
      showSpeakError(button, message);
    }
  }
}

function setBusy(busy) {
  state.busy = busy;
  ui.sendBtn.hidden = busy;
  ui.stopBtn.hidden = !busy;
}

async function ensureConfigured() {
  const settings = await loadSettings();
  if (settings.baseUrl && settings.model) return true;
  await openSettings('Add a Base URL and a model name to start chatting.');
  return false;
}

/* ---------- sending ---------- */

async function send(rawText, { mode = state.mode, quote = state.quote } = {}) {
  if (state.busy) return;
  const text = (rawText || '').trim() || DEFAULT_PROMPTS[mode] || '';
  if (!text) return;

  const settings = await loadSettings();
  if (!settings.baseUrl || !settings.model) {
    await openSettings('Add a Base URL and a model name to start chatting.');
    return;
  }

  player.stop(); // a new question stops the teacher from talking over the answer
  setMode(mode);
  const page = ui.usePage.checked ? await updatePageInfo() : null;

  state.quote = null;
  renderQuote();

  const content = quote ? `Selected text from the page:\n"""\n${quote}\n"""\n\n${text}` : text;
  state.history.push({ role: 'user', content });
  appendUserMessage(text, quote);

  const { wrap, column, bubble } = appendAssistantMessage();
  const controller = new AbortController();
  state.controller = controller;
  setBusy(true);

  const messages = buildMessages({
    history: state.history,
    mode,
    page,
    language: settings.language,
    oral: settings.speech.autoSpeak,
  });
  let answer = '';

  try {
    for await (const delta of streamChat({ ...settings, messages, signal: controller.signal })) {
      answer += delta;
      bubble.innerHTML = renderMarkdown(answer);
      scrollDown();
    }
    if (!answer.trim()) throw new Error('The model returned an empty response.');
    state.history.push({ role: 'assistant', content: answer });
    bubble.innerHTML = renderMarkdown(answer);

    const listenButton = addSpeakRow(column, answer);
    if (settings.speech.autoSpeak) speakAnswer(listenButton, answer);
  } catch (err) {
    if (err.name === 'AbortError') {
      if (answer.trim()) {
        state.history.push({ role: 'assistant', content: answer });
        bubble.innerHTML = renderMarkdown(`${answer}\n\n*(stopped)*`);
      } else {
        state.history.pop();
        bubble.textContent = 'Stopped.';
        bubble.classList.add('muted');
      }
    } else {
      state.history.pop(); // keep history valid so the user can simply retry
      bubble.textContent = err.message || String(err);
      bubble.classList.add('error');
    }
  } finally {
    state.controller = null;
    setBusy(false);
    scrollDown();
  }
}

async function submitPrompt(text, mode) {
  if (!(await ensureConfigured())) return;
  await send(text, { mode });
}

function newChat() {
  if (state.busy) state.controller?.abort();
  player.stop();
  state.history = [];
  state.quote = null;
  renderQuote();
  for (const node of ui.chat.querySelectorAll('.msg')) node.remove();
  ui.empty.hidden = false;
  setMode('chat');
}

/* ---------- settings ---------- */

function setSettingsStatus(message, kind = '') {
  ui.settingsStatus.textContent = message;
  ui.settingsStatus.className = `status ${kind}`.trim();
}

async function openSettings(message = '') {
  const settings = await loadSettings();
  ui.baseUrl.value = settings.baseUrl;
  ui.apiKey.value = settings.apiKey;
  ui.model.value = settings.model;
  ui.language.value = settings.language;
  ui.engine.value = settings.speech.engine;
  ui.azureKey.value = settings.speech.azureKey;
  ui.azureRegion.value = settings.speech.azureRegion;
  ui.voice.value = settings.speech.voice;
  ui.rate.value = settings.speech.rate;
  ui.autoSpeak.checked = settings.speech.autoSpeak;
  ui.settings.hidden = false;
  setSettingsStatus(message);
}

function readSettingsForm() {
  return {
    baseUrl: ui.baseUrl.value,
    apiKey: ui.apiKey.value,
    model: ui.model.value,
    language: ui.language.value,
    speech: {
      engine: ui.engine.value,
      azureKey: ui.azureKey.value,
      azureRegion: ui.azureRegion.value,
      voice: ui.voice.value,
      rate: ui.rate.value,
      autoSpeak: ui.autoSpeak.checked,
    },
  };
}

const SAMPLE_LINE = 'ආයුබෝවන්! මම ඔබේ ගුරුවරිය. අද අපි එකට ඉගෙන ගනිමු.';

/* ---------- lesson requests from the context menu ---------- */

async function handlePending(pending) {
  if (!pending) return;
  if (pending.type === 'selection' && pending.text) {
    state.quote = pending.text.slice(0, 4000);
    renderQuote();
    setMode('chat');
    await submitPrompt('Explain the selected text and how it relates to the rest of this page.', 'chat');
  } else if (pending.type === 'page') {
    await submitPrompt(DEFAULT_PROMPTS.teach, 'teach');
  }
}

async function checkPending() {
  const { pending } = await chrome.storage.session.get('pending');
  if (pending) {
    await chrome.storage.session.remove('pending');
    handlePending(pending);
  }
}

chrome.storage.session.onChanged.addListener((changes, area) => {
  const change = changes.pending;
  if (area === 'session' && change?.newValue) {
    chrome.storage.session.remove('pending');
    handlePending(change.newValue);
  }
});

/* ---------- wiring ---------- */

ui.composer.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (state.busy) return;
  const text = ui.input.value;
  if (!text.trim() && state.mode === 'chat') return;
  if (!(await ensureConfigured())) return;
  ui.input.value = '';
  autoGrow();
  await send(text);
});

ui.input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    ui.composer.requestSubmit();
  }
});
ui.input.addEventListener('input', autoGrow);

ui.stopBtn.addEventListener('click', () => state.controller?.abort());
ui.newChat.addEventListener('click', newChat);
ui.settingsBtn.addEventListener('click', () => openSettings());
ui.closeSettings.addEventListener('click', () => {
  ui.settings.hidden = true;
});

ui.modes.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-mode]');
  if (button) setMode(button.dataset.mode);
});

ui.langChip.addEventListener('click', async () => {
  const settings = await loadSettings();
  settings.language = settings.language === 'si' ? 'en' : 'si';
  await saveSettings(settings);
  renderChips(settings);
});

ui.oralChip.addEventListener('click', async () => {
  const settings = await loadSettings();
  if (!settings.speech.autoSpeak && !speechReady(settings.speech)) {
    await openSettings('Oral mode is free. Keep the Free voice engine, or add an Azure key if you chose Azure.');
    return;
  }
  settings.speech.autoSpeak = !settings.speech.autoSpeak;
  if (!settings.speech.autoSpeak) player.stop();
  await saveSettings(settings);
  renderChips(settings);
});

for (const suggestion of ui.suggestions) {
  suggestion.addEventListener('click', () => {
    submitPrompt(suggestion.dataset.prompt, suggestion.dataset.mode);
  });
}

ui.usePage.addEventListener('change', () => {
  saveIncludePagePref();
  updatePageInfo();
});
ui.refreshPage.addEventListener('click', updatePageInfo);

ui.quoteBtn.addEventListener('click', async () => {
  try {
    const page = await getActivePage();
    if (!page.selection) {
      ui.pageInfo.textContent = 'Select some text on the page first, then press “Quote selection”.';
      return;
    }
    state.quote = page.selection.slice(0, 4000);
    renderQuote();
    ui.input.focus();
  } catch (err) {
    ui.pageInfo.textContent = err.message;
    ui.pageInfo.classList.add('error');
  }
});

ui.settingsForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const saved = await saveSettings(readSettingsForm());
  renderChips(saved);
  setSettingsStatus('Saved.', 'ok');
});

ui.testBtn.addEventListener('click', async () => {
  const settings = readSettingsForm();
  setSettingsStatus('Testing connection…');
  try {
    const reply = await testConnection(settings);
    setSettingsStatus(`Connected. The model replied: “${reply.slice(0, 80)}”`, 'ok');
  } catch (err) {
    setSettingsStatus(err.message, 'error');
  }
});

ui.speakTestBtn.addEventListener('click', async () => {
  const clean = normalizeSettings(readSettingsForm()).speech;
  setSettingsStatus('Playing sample…');
  try {
    await player.speak(SAMPLE_LINE, clean);
    setSettingsStatus('Sample finished.', 'ok');
  } catch (err) {
    setSettingsStatus(err.message, 'error');
  }
});

chrome.tabs.onActivated.addListener(() => updatePageInfo());
chrome.tabs.onUpdated.addListener((_tabId, info) => {
  if (info.status === 'complete') updatePageInfo();
});

setMode('chat');
renderQuote();
loadSettings().then(renderChips);
loadIncludePagePref().then(updatePageInfo);
checkPending();
