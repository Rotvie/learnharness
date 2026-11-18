'use strict';
// Markdown + $KaTeX$ → Anki HTML + MathJax \(...\) / \[...\].
// Math is lifted out before Markdown parsing so emphasis/escape rules cannot
// mangle TeX, then restored HTML-escaped inside Anki's MathJax delimiters.
const { Marked } = require('marked');

const escapeHtml = text => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const SAFE_LINK = /^(?:https?:|mailto:)/i;

// Anki executes JavaScript in card HTML, and card text derives from model output over
// possibly untrusted sources. Raw HTML is shown as text, links are limited to
// http(s)/mailto, and images (remote fetches on every review) become their alt text.
const marked = new Marked({ gfm: true, breaks: false, async: false });
marked.use({
  renderer: {
    html(token) { return escapeHtml(token.text); },
    link(token) {
      const text = this.parser.parseInline(token.tokens);
      const href = String(token.href ?? '').trim();
      if (!SAFE_LINK.test(href)) return text;
      const title = token.title ? ` title="${escapeHtml(token.title)}"` : '';
      return `<a href="${escapeHtml(href)}"${title}>${text}</a>`;
    },
    image(token) { return escapeHtml(token.text ?? ''); },
  },
});

// Returns { text, math } where math[i] = { display, tex } and text carries
// alphanumeric placeholders. Code fences, inline code and \$ are left untouched.
function extractMath(source) {
  const math = [];
  let out = '', i = 0;
  const placeholder = (display, tex) => { math.push({ display, tex }); return `LHMATH${math.length - 1}X`; };
  const atLineStart = index => index === 0 || source[index - 1] === '\n';
  while (i < source.length) {
    // Fenced code block: copy verbatim through the closing fence.
    if (atLineStart(i)) {
      const fence = /^( {0,3})(`{3,}|~{3,})[^\n]*/.exec(source.slice(i));
      if (fence) {
        const marker = fence[2], rest = source.slice(i + fence[0].length);
        const close = new RegExp(`\\n {0,3}${marker[0] === '`' ? '`' : '~'}{${marker.length},}[ \\t]*(?=\\n|$)`).exec(rest);
        const end = close ? i + fence[0].length + close.index + close[0].length : source.length;
        out += source.slice(i, end); i = end; continue;
      }
    }
    const ch = source[i];
    if (ch === '\\' && i + 1 < source.length) { out += source.slice(i, i + 2); i += 2; continue; }
    if (ch === '`') {
      const run = /^`+/.exec(source.slice(i))[0];
      const end = source.indexOf(run, i + run.length);
      if (end < 0) { out += run; i += run.length; continue; }
      out += source.slice(i, end + run.length); i = end + run.length; continue;
    }
    if (ch === '$') {
      if (source[i + 1] === '$') {
        const end = source.indexOf('$$', i + 2);
        if (end > i + 2) {
          const tex = source.slice(i + 2, end).trim();
          // Display math stands alone as its own block for Markdown.
          out += `\n\n${placeholder(true, tex)}\n\n`; i = end + 2; continue;
        }
      } else {
        // Inline: closing $ on the same line, not preceded by whitespace/backslash.
        let j = i + 1;
        while (j < source.length && source[j] !== '\n') {
          if (source[j] === '\\') { j += 2; continue; }
          if (source[j] === '$') break;
          j++;
        }
        const tex = source.slice(i + 1, j);
        if (source[j] === '$' && tex.length && !/^\s/.test(tex) && !/\s$/.test(tex)) {
          out += placeholder(false, tex); i = j + 1; continue;
        }
      }
    }
    out += ch; i++;
  }
  return { text: out, math };
}

function toAnkiHtml(markdown) {
  if (typeof markdown !== 'string') throw new Error('Card text must be a string.');
  const { text, math } = extractMath(markdown);
  let html = marked.parse(text).trim();
  html = html.replace(/<p>LHMATH(\d+)X<\/p>/g, (whole, n) => math[n]?.display ? `<div>\\[${escapeHtml(math[n].tex)}\\]</div>` : whole);
  html = html.replace(/LHMATH(\d+)X/g, (whole, n) => {
    const m = math[n]; if (!m) return whole;
    return m.display ? `\\[${escapeHtml(m.tex)}\\]` : `\\(${escapeHtml(m.tex)}\\)`;
  });
  // Single-paragraph cards read better in Anki without the wrapping <p>.
  const single = /^<p>([\s\S]*)<\/p>$/.exec(html);
  if (single && !single[1].includes('<p>')) html = single[1];
  return html;
}

// Deck names: '::' nests decks in Anki; keep source titles as one level.
function deckName(root, sourceTitle) {
  // The root may nest on purpose (e.g. 'Study::LearnHarness'); source titles may not.
  const clean = value => String(value ?? '').replace(/["\n\r\t]/g, ' ').replace(/\s+/g, ' ').trim();
  const r = clean(root).split('::').map(part => part.trim()).filter(Boolean).join('::') || 'LearnHarness';
  const s = clean(sourceTitle).replace(/::/g, ':') || 'Untitled source';
  return `${r}::${s}`;
}

module.exports = { toAnkiHtml, extractMath, deckName, escapeHtml };
