'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { decodeCat, tagKeywords } = require('../lib/cattags');
const { createEngine } = require('../lib/search');
const fx = require('./fixtures');

const val = (d, label) => (d.tags.find((t) => t.label === label) || {}).value;
const code = (d, label) => (d.tags.find((t) => t.label === label) || {}).code;

test('the sheet example decodes digit by digit: VH321NRB', () => {
  const d = decodeCat('SQD', 'VH321NRB');
  assert.ok(d, 'decoded');
  assert.equal(code(d, 'Type'), 'VH');
  assert.match(val(d, 'Type'), /Heavy-duty, fusible/);
  assert.equal(val(d, 'Poles'), 'Three-pole');
  assert.equal(val(d, 'Voltage'), '240 Vac');
  assert.equal(val(d, 'Amps'), '30 A');
  assert.match(val(d, 'Neutral'), /Factory-installed neutral/);
  assert.match(val(d, 'Enclosure'), /Type 3R with Type B hub/);
  assert.equal(d.unknown, '');
});

test('U means non-fusible', () => {
  assert.match(val(decodeCat('SQD', 'DU222RB'), 'Type'), /General-duty, non-fusible/);
  assert.match(val(decodeCat('SQD', 'VHU361'), 'Type'), /Heavy-duty, non-fusible/);
  assert.match(val(decodeCat('SQD', 'DTU324'), 'Type'), /Double-throw, non-fusible/);
  assert.match(val(decodeCat('SQD', 'D222N'), 'Type'), /General-duty, fusible/);
});

test('ampere and voltage digits follow the table', () => {
  assert.equal(val(decodeCat('SQD', 'VH361'), 'Voltage'), '600 Vac');
  assert.equal(val(decodeCat('SQD', 'VH361'), 'Amps'), '30 A');
  assert.equal(val(decodeCat('SQD', 'VH368'), 'Amps'), '1,200 A');
  assert.equal(val(decodeCat('SQD', 'L211'), 'Voltage'), '120 Vac (plug fuse)');
});

test('enclosure suffixes', () => {
  assert.match(val(decodeCat('SQD', 'VH322N'), 'Enclosure'), /Type 1/);
  assert.match(val(decodeCat('SQD', 'VH322NR'), 'Enclosure'), /Type 3R \(rainproof/);
  assert.match(val(decodeCat('SQD', 'VH322NRB'), 'Enclosure'), /Type B hub/);
  assert.match(val(decodeCat('SQD', 'VH322NAWK'), 'Enclosure'), /Type 12/);
  assert.match(val(decodeCat('SQD', 'VH322NDS'), 'Enclosure'), /304 stainless/);
  assert.match(val(decodeCat('SQD', 'VH322NSS'), 'Enclosure'), /316 stainless/);
});

test('bonded neutral, missing neutral, and option suffixes', () => {
  assert.match(val(decodeCat('SQD', 'D222B'), 'Neutral'), /bonded to the enclosure/);
  assert.match(val(decodeCat('SQD', 'D222'), 'Neutral'), /No factory neutral/);
  const opts = decodeCat('SQD', 'VH322NRGL').tags.filter((t) => t.label === 'Option');
  assert.deepEqual(opts.map((t) => t.code), ['GL']);
  const two = decodeCat('SQD', 'VH322NKIKI').tags.filter((t) => t.label === 'Option');
  assert.deepEqual(two.map((t) => t.value), ['Two-key interlock']);
});

test('the classic pre-VisiPacT H series decodes the same way', () => {
  assert.match(val(decodeCat('SQD', 'H361'), 'Type'), /Heavy-duty, fusible \(classic/);
  assert.match(val(decodeCat('SQD', 'HU361'), 'Type'), /Heavy-duty, non-fusible/);
});

test('numbers that are not safety switches decode to nothing', () => {
  assert.equal(decodeCat('SQD', 'QO120'), null, 'QO breaker');
  assert.equal(decodeCat('SQD', 'HOM120'), null, 'Homeline breaker');
  assert.equal(decodeCat('SQD', 'LAL36400'), null, 'L-frame breaker');
  assert.equal(decodeCat('SQD', 'D922N'), null, 'no 9-pole switch');
  assert.equal(decodeCat('SQD', 'D232N'), null, 'no voltage code 3');
  assert.equal(decodeCat('SQD', 'D229N'), null, 'no ampere code 9');
  assert.equal(decodeCat('SQD', 'VH322NLONGTAIL'), null, 'unexplained tail');
  assert.equal(decodeCat('BPT', 'D222N'), null, 'wrong manufacturer');
});

test('separators and lowercase in the catalog number still decode', () => {
  const d = decodeCat('sqd', 'vh-322-n-rb');
  assert.ok(d);
  assert.equal(val(d, 'Amps'), '60 A');
});

test('summary line is the counter shorthand', () => {
  assert.equal(decodeCat('SQD', 'VH322NRB').summary, '60A · 3P · 240V · fusible · Type 3R hub · neutral');
  assert.equal(decodeCat('SQD', 'DU222RB').summary, '60A · 2P · 240V · non-fusible · Type 3R hub');
});

test('decoded tags become searchable phrases', () => {
  const kws = tagKeywords('SQD', 'VH322NRB');
  for (const k of ['safety switch', 'disconnect', '60 amp', '3 pole', '240 volt', 'type 3r', 'fusible disconnect']) {
    assert.ok(kws.includes(k), `expected keyword "${k}" in ${JSON.stringify(kws)}`);
  }
});

// ---------- wired into the search engine ----------
function engine() {
  return createEngine({
    catalog: fx.catalog,
    jargon: fx.jargon,
    synonyms: fx.synonyms,
    mfrMap: fx.mfr.map,
    overrides: { get: () => undefined },
    webText: null,
  });
}

test('spoken specs find the switch even though the description lacks them', () => {
  const ids = engine().search('60 amp 3 pole fusible disconnect').results.map((r) => r.id);
  assert.equal(ids[0], 'SQD|VH322NRB', `got ${ids.slice(0, 3)}`);
});

test('non-fusible ask ranks the non-fusible switch first', () => {
  const ids = engine().search('60 amp 2 pole non fusible disconnect 3r').results.map((r) => r.id);
  assert.equal(ids[0], 'SQD|DU222RB', `got ${ids.slice(0, 3)}`);
});

test('results and item detail carry the decode', () => {
  const r = engine().search('VH322NRB').results[0];
  assert.equal(r.id, 'SQD|VH322NRB');
  assert.ok(r.decoded && r.decoded.tags.length >= 6);
  assert.match(r.decoded.title, /Square D safety switch/);
  assert.ok(r.autoKeywords.includes('safety switch'));
});

test('items with no decoder family are untouched', () => {
  const r = engine().search('QO120').results[0];
  assert.equal(r.decoded, null);
});
