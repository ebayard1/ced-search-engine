'use strict';
// Bolt answers in markdown; the chat drawer renders it as rich text. Small on
// purpose — headings, bold/italic/code, links, lists, quotes, tables, fenced
// code, rules — no library, no innerHTML surprises: every span of text goes
// through esc() before a tag is added, so nothing the model (or a tool result
// it quotes) emits can inject HTML.
// Dual-environment like lib/calc.js: node tests require() it, the browser gets
// it from /md.js.

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const LIST = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const leading = (line) => line.length - line.trimStart().length;

function inline(s) {
  // stash inline code first: **, _ and links inside a code span stay literal
  const code = [];
  let t = esc(s).replace(/`([^`\n]+)`/g, (_, c) => `\u0000${code.push(`<code>${c}</code>`) - 1}\u0000`);
  t = t
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>')
    .replace(/\*\*([^\n]+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])__([^\n_]+)__(?=[\s.,;:!?)]|$)/g, '$1<strong>$2</strong>')
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>')
    // catalog numbers are full of underscores — only pair them across word edges
    .replace(/(^|[\s(])_([^_\n]+)_(?=[\s.,;:!?)]|$)/g, '$1<em>$2</em>')
    .replace(/~~([^\n]+?)~~/g, '<del>$1</del>');
  return t.replace(/\u0000(\d+)\u0000/g, (_, i) => code[+i]);
}

function blocks(lines) {
  const out = [];
  let para = [];
  const flush = () => { if (para.length) { out.push(`<p>${para.map(inline).join('<br>')}</p>`); para = []; } };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*```/.test(line)) { // fenced code
      flush();
      i++;
      const buf = [];
      while (i < lines.length && !/^\s*```/.test(lines[i])) buf.push(lines[i++]);
      i++; // closing fence (missing one just runs to the end)
      out.push(`<pre><code>${esc(buf.join('\n'))}</code></pre>`);
      continue;
    }
    if (!line.trim()) { flush(); i++; continue; }
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { flush(); out.push('<hr>'); i++; continue; }
    const h = line.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*$/);
    if (h) { // start at h3: these live inside a chat bubble, not a page
      flush();
      const lvl = Math.min(h[1].length + 2, 6);
      out.push(`<h${lvl}>${inline(h[2])}</h${lvl}>`);
      i++;
      continue;
    }
    if (/^\s*>/.test(line)) {
      flush();
      const buf = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push(`<blockquote>${blocks(buf)}</blockquote>`);
      continue;
    }
    if (isTable(lines, i)) { i = table(lines, i, out); continue; }
    if (LIST.test(line)) { flush(); i = list(lines, i, out); continue; }
    para.push(line.trim());
    i++;
  }
  flush();
  return out.join('');
}

// header row + a |---|:--:| separator underneath
function isTable(lines, i) {
  return lines[i].includes('|') && i + 1 < lines.length
    && lines[i + 1].includes('-') && /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(lines[i + 1]);
}

function table(lines, start, out) {
  const cells = (r) => r.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
  const head = cells(lines[start]);
  let i = start + 2;
  const rows = [];
  while (i < lines.length && lines[i].trim() && lines[i].includes('|')) rows.push(cells(lines[i++]));
  out.push(`<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead>`
    + `<tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
  return i;
}

// One list, starting at lines[start]; returns the index just past it. Anything
// indented under an item (wrapped text, a nested list) is handed back to
// blocks(), so nesting falls out of the recursion.
function list(lines, start, out) {
  const first = lines[start].match(LIST);
  const indent = first[1].length;
  const ordered = /\d/.test(first[2]);
  const items = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    const m = line.match(LIST);
    if (m && m[1].length <= indent + 1) { items.push([m[3]]); i++; continue; }
    const own = items[items.length - 1];
    if (line.trim() && leading(line) > indent) { own.push(line.slice(Math.min(indent + 2, leading(line)))); i++; continue; }
    // a blank line only stays in the list if indented content follows it
    if (!line.trim() && i + 1 < lines.length && lines[i + 1].trim() && leading(lines[i + 1]) > indent) { own.push(''); i++; continue; }
    break;
  }
  // an item's first paragraph sits directly in the <li> — a bare <p> there
  // would add a line of air to every bullet
  const body = items.map((c) => `<li>${blocks(c).replace(/^<p>([\s\S]*?)<\/p>/, '$1')}</li>`).join('');
  out.push(ordered ? `<ol>${body}</ol>` : `<ul>${body}</ul>`);
  return i;
}

function mdToHtml(src) {
  return blocks(String(src ?? '').replace(/\r\n?/g, '\n').split('\n'));
}

const md = { toHtml: mdToHtml, inline };

if (typeof module !== 'undefined' && module.exports) module.exports = md;
if (typeof window !== 'undefined') window.md = md;
