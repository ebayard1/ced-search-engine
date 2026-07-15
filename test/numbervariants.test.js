'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { numberVariants, createEngine } = require('../lib/search');
const fx = require('./fixtures');

test('numberVariants maps decimals to fraction tokens', () => {
  assert.deepEqual([...numberVariants('.75 emt')], ['3/4', '3', '4']);
  assert.deepEqual([...numberVariants('0.5 conn')], ['1/2', '1', '2']);
  assert.ok(numberVariants('1.5 sealtight').has('1-1/2'));
  assert.equal(numberVariants('no sizes here').size, 0);
  assert.equal(numberVariants('9.99').size, 0); // not a trade size
});

test('query ".75" finds items described as 3/4', () => {
  const e = createEngine({
    catalog: fx.catalog, jargon: fx.jargon, synonyms: fx.synonyms,
    mfrMap: fx.mfr.map, overrides: { get: () => undefined }, webText: null,
  });
  const { results } = e.search('.75 emt connector');
  const top = results.slice(0, 2).map((r) => r.id);
  assert.ok(top.includes('BPT|231'), `expected the 3/4" connector in ${top}`);
});

test('query "3/4" finds items described with decimals', () => {
  const e = createEngine({
    catalog: { items: [{ id: 'X|1', mfr: 'X', cat: 'ABC75', desc: '0.75 IN FLEX CONN', upc: '', bins: [], lots: [] }] },
    jargon: { rules: [] }, synonyms: { slang: {}, abbrev: {} },
    mfrMap: {}, overrides: { get: () => undefined }, webText: null,
  });
  const { results } = e.search('3/4 flex conn');
  assert.equal(results[0] && results[0].id, 'X|1');
});
