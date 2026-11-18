'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { toAnkiHtml, deckName } = require('../src/format.cjs');

test('plain single paragraph is unwrapped', () => {
  assert.equal(toAnkiHtml('What is **atomicity**?'), 'What is <strong>atomicity</strong>?');
});

test('inline and display math become MathJax delimiters, untouched by Markdown', () => {
  assert.equal(toAnkiHtml('Area is $\\pi r^2$ and $a_1 * b_2$'), 'Area is \\(\\pi r^2\\) and \\(a_1 * b_2\\)');
  const html = toAnkiHtml('Euler:\n\n$$\ne^{i\\pi} + 1 = 0\n$$\n\nDone.');
  assert.match(html, /<div>\\\[e\^\{i\\pi\} \+ 1 = 0\\\]<\/div>/);
  assert.match(html, /<p>Done\.<\/p>/);
});

test('math is HTML-escaped inside delimiters', () => {
  assert.equal(toAnkiHtml('$a < b$'), '\\(a &lt; b\\)');
});

test('escaped dollars and code keep literal dollars', () => {
  assert.equal(toAnkiHtml('Costs \\$20 and \\$30'), 'Costs $20 and $30');
  assert.equal(toAnkiHtml('Use `$HOME` here'), 'Use <code>$HOME</code> here');
  const fenced = toAnkiHtml('```sh\necho $HOME $PATH\n```');
  assert.match(fenced, /<pre><code class="language-sh">echo \$HOME \$PATH\n<\/code><\/pre>/);
});

test('unpaired or spaced dollars are not math', () => {
  assert.equal(toAnkiHtml('Between $ 5 and $ 6'), 'Between $ 5 and $ 6');
});

test('lists and tables render as HTML', () => {
  assert.match(toAnkiHtml('- one\n- two'), /<ul>\n<li>one<\/li>\n<li>two<\/li>\n<\/ul>/);
  assert.match(toAnkiHtml('| a | b |\n|---|---|\n| 1 | 2 |'), /<table>/);
});

test('raw HTML is escaped, unsafe links unwrapped, images reduced to alt text', () => {
  assert.equal(toAnkiHtml('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.equal(toAnkiHtml('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;');
  assert.equal(toAnkiHtml('a <b onclick="x()">bold</b>'), 'a &lt;b onclick=&quot;x()&quot;&gt;bold&lt;/b&gt;');
  assert.equal(toAnkiHtml('<div>\n<iframe src="http://evil"></iframe>\n</div>'), '&lt;div&gt;\n&lt;iframe src=&quot;http://evil&quot;&gt;&lt;/iframe&gt;\n&lt;/div&gt;');
  assert.equal(toAnkiHtml('[x](javascript:alert(1))'), 'x');
  assert.equal(toAnkiHtml('[x](  JaVaScRiPt:alert(1))'), 'x');
  assert.equal(toAnkiHtml('[x](data:text/html,<script>1</script>)'), 'x');
  assert.equal(toAnkiHtml('![pic <b>](http://evil/x.png)'), 'pic &lt;b&gt;');
  assert.doesNotMatch(toAnkiHtml('<http://evil/a"onmouseover="x>'), /a"onmouseover/);
});

test('safe links and math inside escaped HTML still render', () => {
  assert.equal(toAnkiHtml('[docs](https://example.com "T")'), '<a href="https://example.com" title="T">docs</a>');
  assert.equal(toAnkiHtml('[mail](mailto:a@b.c)'), '<a href="mailto:a@b.c">mail</a>');
  assert.equal(toAnkiHtml('<span>$x<y$</span>'), '&lt;span&gt;\\(x&lt;y\\)&lt;/span&gt;');
});

test('deck names nest one level per source; root may nest', () => {
  assert.equal(deckName('LearnHarness', 'Linear algebra'), 'LearnHarness::Linear algebra');
  assert.equal(deckName('Study :: LH', 'A::B "quoted"'), 'Study::LH::A:B quoted');
  assert.equal(deckName('', ''), 'LearnHarness::Untitled source');
});
