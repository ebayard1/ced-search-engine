'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { createEngine } = require('../lib/search');
const { rankImages } = require('../lib/web');
const fx = require('./fixtures');

test('every catalog number gets at least 5 prebuilt tags', () => {
  const e = createEngine({
    catalog: fx.catalog, jargon: fx.jargon, synonyms: fx.synonyms,
    mfrMap: fx.mfr.map, overrides: { get: () => undefined }, webText: null,
  });
  for (const it of e.items) {
    assert.ok(it.autoKeywords.length >= 5,
      `${it.id} has only ${it.autoKeywords.length} tags: ${JSON.stringify(it.autoKeywords)}`);
  }
});

test('desc-derived keywords expand abbreviations to plain words', () => {
  const e = createEngine({
    catalog: { items: [{ id: 'X|Z9', mfr: 'X', cat: 'Z9', desc: 'STEEL RECPT PLATE', upc: '', bins: [], lots: [] }] },
    jargon: { rules: [] }, synonyms: fx.synonyms,
    mfrMap: {}, overrides: { get: () => undefined }, webText: null,
  });
  const kws = e.byId.get('X|Z9').autoKeywords;
  assert.ok(kws.includes('receptacle'), `expected 'receptacle' in ${kws}`); // RECPT expanded
  // and the plain keyword is searchable
  assert.ok(e.search('receptacle plate').results.some((r) => r.id === 'X|Z9'));
});

test('rankImages: exact catalog number in title beats banners; suppliers beat unknowns', () => {
  const images = [
    { title: 'BE BRIDGEPORT BE COLORFUL', url: 'https://bridgeport-fittings.com/banner', source: 'bridgeport-fittings.com' },
    { title: 'random rug photo', url: 'https://example.com/x', source: 'example.com' },
    { title: 'Bridgeport T-46CG 2" Type-T Conduit Body', url: 'https://worldelectricsupply.com/p', source: 'worldelectricsupply.com' },
    { title: 'Bridgeport T46CG', url: 'https://unknownshop.biz/p', source: 'unknownshop.biz' },
  ];
  const ranked = rankImages(images, 'T46CG');
  assert.match(ranked[0].title, /Conduit Body/); // cat match + supplier
  assert.match(ranked[1].title, /^Bridgeport T46CG$/); // cat match only
  assert.match(ranked[2].title, /COLORFUL/); // supplier only (banner sinks below cat matches)
  assert.match(ranked[3].title, /rug/);
});

test('rankImages is stable for ties (keeps engine order)', () => {
  const images = [{ title: 'a', url: 'u1' }, { title: 'b', url: 'u2' }];
  assert.deepEqual(rankImages(images, 'ZZZ').map((i) => i.title), ['a', 'b']);
});
