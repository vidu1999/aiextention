// Small, dependency-free Markdown renderer for assistant replies.
// All input is HTML-escaped first, so model output can never inject markup.

export function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderInline(escaped) {
  const codes = [];
  let s = escaped.replace(/`([^`\n]+)`/g, (_, code) => {
    codes.push(code);
    return `\u0000${codes.length - 1}\u0000`;
  });

  s = s.replace(
    /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,
    (_, label, url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`,
  );
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>');
  s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[Number(i)]}</code>`);
  return s;
}

const isBlockStart = (line) =>
  /^```/.test(line) ||
  /^#{1,6}\s/.test(line) ||
  /^\s*[-*+]\s+/.test(line) ||
  /^\s*\d+[.)]\s+/.test(line) ||
  /^>\s?/.test(line) ||
  /^(\*\*\*|---|___)\s*$/.test(line);

export function renderMarkdown(source) {
  const lines = String(source ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let para = [];

  const flushParagraph = () => {
    if (para.length) {
      out.push(`<p>${para.map((l) => renderInline(escapeHtml(l))).join('<br>')}</p>`);
      para = [];
    }
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block (an unterminated fence runs to the end, which suits streaming).
    const fence = line.match(/^```\s*([\w+#.-]*)\s*$/);
    if (fence) {
      flushParagraph();
      const code = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        code.push(lines[i]);
        i++;
      }
      i++; // skip closing fence
      const cls = fence[1] ? ` class="language-${escapeHtml(fence[1])}"` : '';
      out.push(`<pre><code${cls}>${escapeHtml(code.join('\n'))}</code></pre>`);
      continue;
    }

    if (line.trim() === '') {
      flushParagraph();
      i++;
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushParagraph();
      const level = heading[1].length;
      out.push(`<h${level}>${renderInline(escapeHtml(heading[2].trim()))}</h${level}>`);
      i++;
      continue;
    }

    if (/^(\*\*\*|---|___)\s*$/.test(line)) {
      flushParagraph();
      out.push('<hr>');
      i++;
      continue;
    }

    if (/^>\s?/.test(line)) {
      flushParagraph();
      const quoted = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        quoted.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }
      out.push(`<blockquote>${renderInline(escapeHtml(quoted.join(' ')))}</blockquote>`);
      continue;
    }

    const bullet = /^\s*[-*+]\s+(.*)$/;
    const ordered = /^\s*\d+[.)]\s+(.*)$/;
    if (bullet.test(line) || ordered.test(line)) {
      flushParagraph();
      const tag = bullet.test(line) ? 'ul' : 'ol';
      const pattern = tag === 'ul' ? bullet : ordered;
      const items = [];
      while (i < lines.length && pattern.test(lines[i])) {
        items.push(`<li>${renderInline(escapeHtml(lines[i].match(pattern)[1]))}</li>`);
        i++;
      }
      out.push(`<${tag}>${items.join('')}</${tag}>`);
      continue;
    }

    para.push(line);
    i++;
    // A paragraph ends when the next line starts a different block.
    while (i < lines.length && lines[i].trim() !== '' && !isBlockStart(lines[i])) {
      para.push(lines[i]);
      i++;
    }
    flushParagraph();
  }

  flushParagraph();
  return out.join('\n');
}
