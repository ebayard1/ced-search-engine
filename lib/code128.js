'use strict';
// Code 128 barcode -> SVG. Pure function, zero deps, dual-environment
// (node tests + served to the browser as /code128.js).
// Set C for even-length digit strings (UPCs — twice as dense), set B otherwise.
// Verify output by scanning a printed sheet with a real scanner.

// bar/space module widths for values 0..106 (start A/B/C = 103/104/105), 6 digits each
const PATTERNS = (
  '212222 222122 222221 121223 121322 131222 122213 122312 132212 221213 ' +
  '221312 231212 112232 122132 122231 113222 123122 123221 223211 221132 ' +
  '221231 213212 223112 312131 311222 321122 321221 312212 322112 322211 ' +
  '212123 212321 232121 111323 131123 131321 112313 132113 132311 211313 ' +
  '231113 231311 112133 112331 132131 113123 113321 133121 313121 211331 ' +
  '231131 213113 213311 213131 311123 311321 331121 312113 312311 332111 ' +
  '314111 221411 431111 111224 111422 121124 121421 141122 141221 112214 ' +
  '112412 122114 122411 142112 142211 241211 221114 413111 241112 134111 ' +
  '111242 121142 121241 114212 124112 124211 411212 421112 421211 212141 ' +
  '214121 412121 111143 111341 131141 114113 114311 411113 411311 113141 ' +
  '114131 311141 411131 211412 211214 211232'
).split(' ');
const STOP = '2331112';

function encodeValues(text) {
  const s = String(text);
  if (!s.length || s.length > 48) throw new Error('code128: 1-48 characters');
  const values = [];
  if (/^\d+$/.test(s) && s.length % 2 === 0) {
    values.push(105); // start C: digit pairs
    for (let i = 0; i < s.length; i += 2) values.push(Number(s.slice(i, i + 2)));
  } else {
    values.push(104); // start B: printable ASCII
    for (const ch of s) {
      const code = ch.charCodeAt(0);
      if (code < 32 || code > 126) throw new Error(`code128: unsupported character "${ch}"`);
      values.push(code - 32);
    }
  }
  let sum = values[0];
  for (let i = 1; i < values.length; i++) sum += values[i] * i;
  values.push(sum % 103); // checksum
  return values;
}

// -> { svg, modules } ; svg is a standalone element sized in mm-ish units
function code128Svg(text, { height = 44, moduleWidth = 2, label = true } = {}) {
  const values = encodeValues(text);
  const widths = values.map((v) => PATTERNS[v]).join('') + STOP;
  const quiet = 10 * moduleWidth;
  let x = quiet;
  const bars = [];
  for (let i = 0; i < widths.length; i++) {
    const w = Number(widths[i]) * moduleWidth;
    if (i % 2 === 0) bars.push(`<rect x="${x}" y="0" width="${w}" height="${height}"/>`); // even index = bar
    x += w;
  }
  const totalW = x + quiet;
  const labelH = label ? 14 : 0;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${totalW} ${height + labelH}" width="${totalW}" height="${height + labelH}">
    <rect width="${totalW}" height="${height + labelH}" fill="#fff"/>
    <g fill="#000">${bars.join('')}</g>
    ${label ? `<text x="${totalW / 2}" y="${height + 11}" text-anchor="middle" font-family="monospace" font-size="11">${String(text).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))}</text>` : ''}
  </svg>`;
  return { svg, modules: widths.split('').reduce((a, b) => a + Number(b), 0) };
}

const api = { code128Svg, encodeValues, PATTERNS, STOP };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof window !== 'undefined') window.code128 = api;
