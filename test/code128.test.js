'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { encodeValues, code128Svg, PATTERNS, STOP } = require('../lib/code128');

test('pattern table is complete and well-formed', () => {
  assert.equal(PATTERNS.length, 106); // values 0..105
  for (const p of PATTERNS) {
    assert.match(p, /^[1-4]{6}$/);
    // every symbol is 11 modules wide — the Code 128 invariant
    assert.equal(p.split('').reduce((a, b) => a + Number(b), 0), 11);
  }
  assert.equal(STOP.split('').reduce((a, b) => a + Number(b), 0), 13);
});

test('set B encoding with known checksum', () => {
  // "ABC": start B(104) + 33,34,35 -> checksum (104 + 33*1 + 34*2 + 35*3) % 103 = 310 % 103 = 1
  assert.deepEqual(encodeValues('ABC'), [104, 33, 34, 35, 1]);
});

test('even digit strings use set C (denser)', () => {
  // "1234": start C(105) + 12, 34 -> checksum (105 + 12*1 + 34*2) % 103 = 185 % 103 = 82
  assert.deepEqual(encodeValues('1234'), [105, 12, 34, 82]);
});

test('odd digit strings fall back to set B', () => {
  assert.equal(encodeValues('123')[0], 104);
});

test('svg output has bars and total module count', () => {
  const { svg, modules } = code128Svg('QO120');
  // 5 chars set B: (1 start + 5 data + 1 check) * 11 + 13 stop = 90
  assert.equal(modules, 90);
  assert.match(svg, /<svg /);
  assert.ok((svg.match(/<rect /g) || []).length > 10);
  assert.match(svg, /QO120<\/text>/);
});

test('rejects unencodable input', () => {
  assert.throws(() => encodeValues(''));
  assert.throws(() => encodeValues('héllo'));
  assert.throws(() => encodeValues('x'.repeat(49)));
});
