import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown, escapeHtml } from '../extension/lib/markdown.js';

test('escapes raw HTML so model output cannot inject markup', () => {
  const html = renderMarkdown('<img src=x onerror=alert(1)> & "quotes"');
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
  assert.match(html, /&amp;/);
});

test('renders headings, bold, italics and inline code', () => {
  const html = renderMarkdown('## Title\n\nSome **bold**, *italic* and `code`.');
  assert.match(html, /<h2>Title<\/h2>/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<em>italic<\/em>/);
  assert.match(html, /<code>code<\/code>/);
});

test('renders unordered and ordered lists', () => {
  const ul = renderMarkdown('- one\n- two');
  assert.equal(ul, '<ul><li>one</li><li>two</li></ul>');
  const ol = renderMarkdown('1. first\n2. second');
  assert.equal(ol, '<ol><li>first</li><li>second</li></ol>');
});

test('fenced code keeps its content literal and escaped', () => {
  const html = renderMarkdown('```js\nif (a < b) { **x** }\n```');
  assert.match(html, /<pre><code class="language-js">if \(a &lt; b\) \{ \*\*x\*\* \}<\/code><\/pre>/);
});

test('an unterminated fence renders as code while streaming', () => {
  const html = renderMarkdown('```\nconst a = 1;');
  assert.match(html, /<pre><code>const a = 1;<\/code><\/pre>/);
});

test('only http(s) links become anchors', () => {
  const ok = renderMarkdown('[docs](https://example.com/a?b=1&c=2)');
  assert.match(ok, /<a href="https:\/\/example.com\/a\?b=1&amp;c=2" target="_blank" rel="noopener noreferrer">docs<\/a>/);
  const bad = renderMarkdown('[x](javascript:alert(1))');
  assert.doesNotMatch(bad, /<a /);
});

test('consecutive lines form one paragraph with line breaks', () => {
  assert.equal(renderMarkdown('a\nb'), '<p>a<br>b</p>');
});

test('escapeHtml handles all special characters', () => {
  assert.equal(escapeHtml(`<&>"'`), '&lt;&amp;&gt;&quot;&#39;');
});
