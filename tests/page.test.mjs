import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { extractPageContent } from '../extension/lib/page.js';

// extractPageContent runs inside a real page in Chrome; here we give it a jsdom page.
function withDom(html, fn) {
  const dom = new JSDOM(html, { url: 'https://example.com/guide/photosynthesis' });
  const { window } = dom;
  const globals = { window, document: window.document, Node: window.Node, location: window.location };
  const saved = {};
  for (const key of Object.keys(globals)) {
    saved[key] = globalThis[key];
    globalThis[key] = globals[key];
  }
  try {
    return fn(window);
  } finally {
    for (const key of Object.keys(globals)) globalThis[key] = saved[key];
  }
}

const longParagraph = 'Plants convert light energy into chemical energy. '.repeat(10);

test('extracts main content, skipping nav, scripts and hidden elements', () => {
  const html = `<!doctype html><html><head><title>Photosynthesis</title>
    <meta name="description" content="How plants make food"></head>
    <body>
      <nav>Home | About | Login</nav>
      <script>var secret = 1;</script>
      <main>
        <h1>Photosynthesis</h1>
        <p>${longParagraph}</p>
        <div style="display:none">hidden text</div>
        <h2>Light reactions</h2>
        <ul><li>Chlorophyll absorbs light</li><li>Water is split</li></ul>
      </main>
      <footer>Copyright 2026</footer>
    </body></html>`;

  const result = withDom(html, () => extractPageContent(30000));
  assert.equal(result.title, 'Photosynthesis');
  assert.equal(result.url, 'https://example.com/guide/photosynthesis');
  assert.equal(result.description, 'How plants make food');
  assert.match(result.text, /# Photosynthesis/);
  assert.match(result.text, /Light reactions/);
  assert.match(result.text, /- Chlorophyll absorbs light/);
  assert.doesNotMatch(result.text, /Login/);
  assert.doesNotMatch(result.text, /secret/);
  assert.doesNotMatch(result.text, /hidden text/);
  assert.doesNotMatch(result.text, /Copyright/);
  assert.deepEqual(
    result.headings.map((h) => h.text),
    ['Photosynthesis', 'Light reactions'],
  );
  assert.equal(result.truncated, false);
});

test('reports the user selection', () => {
  const html = '<html><head><title>T</title></head><body><p id="p">Selected words here and more text.</p></body></html>';
  const result = withDom(html, (window) => {
    const range = window.document.createRange();
    range.selectNodeContents(window.document.getElementById('p'));
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(range);
    return extractPageContent(1000);
  });
  assert.equal(result.selection, 'Selected words here and more text.');
});

test('trims very long pages and flags truncation', () => {
  const html = `<html><body><article><p>${'word '.repeat(5000)}</p></article></body></html>`;
  const result = withDom(html, () => extractPageContent(500));
  assert.equal(result.truncated, true);
  assert.equal(result.text.length, 500);
  assert.ok(result.length > 500);
});
