'use strict';
// The chat drawer drops this straight into innerHTML — the escaping tests are
// the important ones, the rest just pin the markdown subset Bolt actually uses.
const { test } = require('node:test');
const assert = require('node:assert');
const md = require('../lib/md');

test('paragraphs: blank line splits, single newline is a soft break', () => {
  assert.equal(md.toHtml('one\ntwo\n\nthree'), '<p>one<br>two</p><p>three</p>');
});

test('bold, italic, inline code, strikethrough', () => {
  assert.equal(md.toHtml('**231I** is *set screw* — see `R-01-B-2` ~~old~~'),
    '<p><strong>231I</strong> is <em>set screw</em> — see <code>R-01-B-2</code> <del>old</del></p>');
});

test('a bullet list like Bolt writes', () => {
  const out = md.toHtml('**Connectors** (EMT → box)\n- **231I** — set screw · R-01-B-2\n- **231SR** — reducing · R-01-A-4');
  assert.equal(out, '<p><strong>Connectors</strong> (EMT → box)</p>'
    + '<ul><li><strong>231I</strong> — set screw · R-01-B-2</li><li><strong>231SR</strong> — reducing · R-01-A-4</li></ul>');
});

test('ordered lists and nested lists', () => {
  assert.equal(md.toHtml('1. first\n2. second'), '<ol><li>first</li><li>second</li></ol>');
  assert.equal(md.toHtml('- outer\n  - inner\n- next'),
    '<ul><li>outer<ul><li>inner</li></ul></li><li>next</li></ul>');
});

test('a list item that wraps onto the next line stays one item', () => {
  assert.equal(md.toHtml('- 231I set screw\n  insulated throat\n- 241'),
    '<ul><li>231I set screw<br>insulated throat</li><li>241</li></ul>');
});

test('headings render inside the bubble as h3+, never h1', () => {
  assert.equal(md.toHtml('# Connectors'), '<h3>Connectors</h3>');
  assert.equal(md.toHtml('### Connectors'), '<h5>Connectors</h5>');
});

test('fenced code keeps its text verbatim', () => {
  assert.equal(md.toHtml('```\n<b>a & b</b>\n```'), '<pre><code>&lt;b&gt;a &amp; b&lt;/b&gt;</code></pre>');
});

test('tables, blockquotes, horizontal rules', () => {
  assert.equal(md.toHtml('| cat | bin |\n| --- | --- |\n| 231I | R-01-B-2 |'),
    '<table><thead><tr><th>cat</th><th>bin</th></tr></thead><tbody><tr><td>231I</td><td>R-01-B-2</td></tr></tbody></table>');
  assert.equal(md.toHtml('> check the bin'), '<blockquote><p>check the bin</p></blockquote>');
  assert.equal(md.toHtml('a\n\n---\n\nb'), '<p>a</p><hr><p>b</p>');
});

test('links open in a new tab; bare URLs autolink', () => {
  assert.equal(md.toHtml('[spec](https://x.test/a)'), '<p><a href="https://x.test/a" target="_blank" rel="noopener">spec</a></p>');
  assert.equal(md.toHtml('see https://x.test/a'), '<p>see <a href="https://x.test/a" target="_blank" rel="noopener">https://x.test/a</a></p>');
});

test('HTML in the reply is escaped, not executed', () => {
  assert.equal(md.toHtml('<img src=x onerror=alert(1)> & <script>bad()</script>'),
    '<p>&lt;img src=x onerror=alert(1)&gt; &amp; &lt;script&gt;bad()&lt;/script&gt;</p>');
});

test('HTML inside a markdown link or code span is escaped too', () => {
  assert.equal(md.toHtml('[<b>x</b>](https://x.test/"onmouseover="a)'),
    '<p><a href="https://x.test/&quot;onmouseover=&quot;a" target="_blank" rel="noopener">&lt;b&gt;x&lt;/b&gt;</a></p>');
  assert.equal(md.toHtml('`<b>x</b>`'), '<p><code>&lt;b&gt;x&lt;/b&gt;</code></p>');
});

test('javascript: URLs are left as plain text, not linked', () => {
  assert.ok(!md.toHtml('[click](javascript:alert(1))').includes('<a '));
  assert.ok(!md.toHtml('javascript:alert(1)').includes('<a '));
});

test('catalog numbers with underscores and asterisks survive intact', () => {
  assert.equal(md.toHtml('EGS_231_I and 2*3 stay literal'), '<p>EGS_231_I and 2*3 stay literal</p>');
});

test('empty and non-string input render as nothing', () => {
  assert.equal(md.toHtml(''), '');
  assert.equal(md.toHtml(null), '');
});
