import { streamChat, testConnection } from '../lib/api.js';
import { loadSettings, saveSettings } from '../lib/settings.js';
import { MODES, DEFAULT_PROMPTS, buildMessages } from '../lib/prompts.js';
import { renderMarkdown } from '../lib/markdown.js';
import { extractPageContent, MAX_PAGE_CHARS } from '../lib/page.js';

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
  newChat: $('newChatBtn'),
  settingsBtn: $('settingsBtn'),
  settings: $('settings'),
  settingsForm: $('settingsForm'),
  baseUrl: $('baseUrl'),
  apiKey: $('apiKey'),
  model: $('model'),
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
    throw new Error('This is a browser page, so it cannot be read. Open a normal website to use Page Tutor.');
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
    ui.pageInfo.textContent = 'Page context is off.';
    ui.pageInfo.classList.remove('error');
    return null;
  }
  try {
    state.page = await getActivePage();
    ui.pageInfo.textContent = describePage(state.page);
    ui.pageInfo.classList.remove('error');
    return state.page;
  } catch (err) {
    state.page = null;
    ui.pageInfo.textContent = err.message;
    ui.pageInfo.classList.add('error');
    return null;
  }
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
  const bubble = el('div', 'bubble md');
  bubble.innerHTML = '<span class="typing"><i></i><i></i><i></i></span>';
  wrap.append(el('div', 'avatar', '✦'), bubble);
  ui.chat.append(wrap);
  scrollDown();
  return bubble;
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

  setMode(mode);
  const page = ui.usePage.checked ? await updatePageInfo() : null;

  state.quote = null;
  renderQuote();

  const content = quote ? `Selected text from the page:\n"""\n${quote}\n"""\n\n${text}` : text;
  state.history.push({ role: 'user', content });
  appendUserMessage(text, quote);

  const bubble = appendAssistantMessage();
  const controller = new AbortController();
  state.controller = controller;
  setBusy(true);

  const messages = buildMessages({ history: state.history, mode, page });
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
  ui.settings.hidden = false;
  setSettingsStatus(message);
}

function readSettingsForm() {
  return { baseUrl: ui.baseUrl.value, apiKey: ui.apiKey.value, model: ui.model.value };
}

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

for (const suggestion of ui.suggestions) {
  suggestion.addEventListener('click', () => {
    submitPrompt(suggestion.dataset.prompt, suggestion.dataset.mode);
  });
}

ui.usePage.addEventListener('change', updatePageInfo);
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
  await saveSettings(readSettingsForm());
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

chrome.tabs.onActivated.addListener(() => updatePageInfo());
chrome.tabs.onUpdated.addListener((_tabId, info) => {
  if (info.status === 'complete') updatePageInfo();
});

setMode('chat');
renderQuote();
updatePageInfo();
checkPending();
