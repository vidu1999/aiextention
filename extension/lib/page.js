// Page reader. `extractPageContent` is injected into the active tab with
// chrome.scripting.executeScript, so it must be fully self-contained: it must
// not reference anything outside its own body.

export const MAX_PAGE_CHARS = 30000;

export function extractPageContent(maxChars = 30000) {
  const SKIP = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'CANVAS', 'IFRAME', 'OBJECT',
    'NAV', 'FOOTER', 'ASIDE', 'FORM', 'BUTTON', 'SELECT', 'TEXTAREA', 'INPUT',
    'DIALOG', 'VIDEO', 'AUDIO',
  ]);
  const BLOCK = new Set([
    'P', 'DIV', 'SECTION', 'ARTICLE', 'MAIN', 'HEADER', 'UL', 'OL', 'LI', 'TABLE',
    'TR', 'BLOCKQUOTE', 'PRE', 'FIGURE', 'FIGCAPTION', 'DL', 'DT', 'DD', 'HR', 'BR',
  ]);
  const HEADING = { H1: '# ', H2: '## ', H3: '### ', H4: '#### ', H5: '##### ', H6: '###### ' };

  const out = [];

  function walk(node) {
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        out.push(child.nodeValue);
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;

      const tag = child.tagName;
      if (SKIP.has(tag) || child.hidden || child.getAttribute('aria-hidden') === 'true') continue;

      let style = null;
      try {
        style = window.getComputedStyle(child);
      } catch (e) {
        style = null;
      }
      if (style && (style.display === 'none' || style.visibility === 'hidden')) continue;

      const isBlock = BLOCK.has(tag) || Boolean(HEADING[tag]);
      if (isBlock) out.push('\n');
      if (HEADING[tag]) out.push(HEADING[tag]);
      if (tag === 'LI') out.push('- ');
      if (tag === 'TD' || tag === 'TH') out.push(' | ');

      walk(child);

      if (isBlock) out.push('\n');
    }
  }

  // Prefer the main article area when it has real content; otherwise the whole body.
  const candidates = [
    ...document.querySelectorAll('main, [role="main"]'),
    ...document.querySelectorAll('article'),
  ];
  const root =
    candidates.find((n) => (n.textContent || '').trim().length > 300) ||
    document.body ||
    document.documentElement;

  walk(root);

  let text = out
    .join('')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const length = text.length;
  const truncated = length > maxChars;
  if (truncated) text = text.slice(0, maxChars);

  const headings = Array.from(document.querySelectorAll('h1, h2, h3'))
    .map((h) => ({ level: h.tagName, text: (h.textContent || '').replace(/\s+/g, ' ').trim() }))
    .filter((h) => h.text)
    .slice(0, 60);

  const description =
    document.querySelector('meta[name="description"]')?.getAttribute('content') || '';

  const selection = window.getSelection ? window.getSelection().toString().trim() : '';

  return {
    url: location.href,
    title: document.title || '',
    description: description.trim(),
    headings,
    text,
    length,
    truncated,
    selection: selection.slice(0, 8000),
  };
}
