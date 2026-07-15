'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { createEngine } = require('../lib/search');
const fx = require('./fixtures');

function engine(overridesObj = {}) {
  return createEngine({
    catalog: fx.catalog,
    jargon: fx.jargon,
    synonyms: fx.synonyms,
    mfrMap: fx.mfr.map,
    overrides: { get: (id) => overridesObj[id] },
    webText: null,
  });
}

test('exact catalog number is the top hit', () => {
  const { results } = engine().search('QO120');
  assert.equal(results[0].id, 'SQD|QO120');
  assert.ok(results[0].why.includes('exact catalog #'));
});

test('catalog prefix matches', () => {
  const { results } = engine().search('FLNR');
  assert.equal(results[0].id, 'LF|FLNR060');
});

test('UPC digits find the item', () => {
  const { results } = engine().search('78633130231');
  assert.equal(results[0].id, 'BPT|231');
});

test('cheat-sheet rule maps jargon to catalog pattern', () => {
  const out = engine().search('emt connector 1/2');
  assert.ok(out.jargon.length >= 1, 'jargon banner present');
  const ids = out.results.slice(0, 3).map((r) => r.id);
  assert.ok(ids.includes('BPT|230'), `expected BPT|230 in ${ids}`);
});

test('slang expansion: jbox finds screw cover box', () => {
  const { results } = engine().search('jbox');
  assert.ok(results.some((r) => r.id === 'BLINE|SC060604NK'));
});

test('B-Line zero-padded dims searchable as 6x6', () => {
  const { results } = engine().search('6x6');
  assert.ok(results.some((r) => r.id === 'BLINE|SC060604NK'));
});

test('totalQty sums bins', () => {
  const e = engine();
  assert.equal(e.byId.get('BPT|230').totalQty, 200); // 120+30+50
  assert.equal(e.byId.get('LEV|GFWR1').totalQty, 0);
});

test('abbrev expansion: receptacle finds RECPT', () => {
  const { results } = engine().search('gfci receptacle');
  assert.ok(results.some((r) => r.id === 'LEV|GFWR1'));
});

test('overrides add searchable keywords and reindex applies them', () => {
  const ov = {};
  const e = createEngine({
    catalog: fx.catalog, jargon: fx.jargon, synonyms: fx.synonyms,
    mfrMap: fx.mfr.map, overrides: { get: (id) => ov[id] }, webText: null,
  });
  assert.ok(!e.search('sealtite').results.some((r) => r.id === 'BPT|230'));
  ov['BPT|230'] = { keywords: ['sealtite'] };
  e.reindex('BPT|230');
  assert.ok(e.search('sealtite').results.some((r) => r.id === 'BPT|230'));
});

test('browse mode: mfr filter with empty query lists alphabetically', () => {
  const { results } = engine().search('', 10, 'BPT');
  assert.deepEqual(results.map((r) => r.cat), ['230', '231', '250']);
});
