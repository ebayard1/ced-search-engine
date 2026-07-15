'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createQueue } = require('../lib/pending');

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ced-pending-'));
  fs.writeFileSync(path.join(dir, 'jargon.json'), JSON.stringify({ rules: [] }));
  fs.writeFileSync(path.join(dir, 'synonyms.json'), JSON.stringify({ slang: {}, abbrev: {} }));
  fs.writeFileSync(path.join(dir, 'knowledge.json'), JSON.stringify({ entries: [] }));
  const applied = [];
  const q = createQueue({
    dataDir: dir,
    itemExists: (id) => ['BPT|230', 'LEV|GFWR1', 'HUBW|GFRST15W'].includes(id),
    applyOverride: (x) => applied.push(x),
  });
  return { dir, q, applied };
}

test('file + approve jargon-rule merges into jargon.json', () => {
  const { dir, q } = setup();
  const s = q.file('test', 'jargon-rule', { term: 'wuznut', match: '^WN\\d', hint: 'sizes' }, 'because');
  assert.equal(q.pending().length, 1);
  q.decide(s.id, true);
  const rules = JSON.parse(fs.readFileSync(path.join(dir, 'jargon.json'), 'utf8')).rules;
  assert.equal(rules.length, 1);
  assert.equal(rules[0].term, 'wuznut');
  assert.equal(q.pending().length, 0);
});

test('reject leaves target files untouched', () => {
  const { dir, q } = setup();
  const s = q.file('test', 'synonym', { type: 'slang', key: 'minis', values: ['mini breaker'] }, 'r');
  q.decide(s.id, false);
  const syn = JSON.parse(fs.readFileSync(path.join(dir, 'synonyms.json'), 'utf8'));
  assert.deepEqual(syn.slang, {});
});

test('synonym approve merges without clobbering existing values', () => {
  const { dir, q } = setup();
  fs.writeFileSync(path.join(dir, 'synonyms.json'), JSON.stringify({ slang: { minis: ['tandem'] }, abbrev: {} }));
  const s = q.file('test', 'synonym', { type: 'slang', key: 'minis', values: ['mini breaker'] }, 'r');
  q.decide(s.id, true);
  const syn = JSON.parse(fs.readFileSync(path.join(dir, 'synonyms.json'), 'utf8'));
  assert.deepEqual(syn.slang.minis, ['tandem', 'mini breaker']);
});

test('item-keywords approve goes through applyOverride', () => {
  const { q, applied } = setup();
  const s = q.file('test', 'item-keywords', { id: 'BPT|230', keywords: ['pushin'] }, 'r');
  q.decide(s.id, true);
  assert.deepEqual(applied, [{ id: 'BPT|230', keywords: ['pushin'] }]);
});

test('invalid suggestions are rejected at filing time', () => {
  const { q } = setup();
  assert.throws(() => q.file('t', 'jargon-rule', { term: 'x', match: '([bad' }, 'r'), /invalid/i);
  assert.throws(() => q.file('t', 'item-keywords', { id: 'NOPE|1', keywords: ['x'] }, 'r'), /unknown item/);
  assert.throws(() => q.file('t', 'xref-group', { ids: ['BPT|230'] }, 'r'), /2\+/);
});

test('duplicate pending suggestions are not re-queued', () => {
  const { q } = setup();
  const a = q.file('t', 'item-note', { id: 'BPT|230', note: 'n' }, 'r');
  const b = q.file('t', 'item-note', { id: 'BPT|230', note: 'n' }, 'r');
  assert.ok(a);
  assert.equal(b, null);
  assert.equal(q.pending().length, 1);
});

test('xref-group approve appends to xref.json', () => {
  const { dir, q } = setup();
  const s = q.file('t', 'xref-group', { ids: ['LEV|GFWR1', 'HUBW|GFRST15W'], note: '15A GFCI' }, 'r');
  q.decide(s.id, true);
  const x = JSON.parse(fs.readFileSync(path.join(dir, 'xref.json'), 'utf8'));
  assert.equal(x.groups.length, 1);
  assert.deepEqual(x.groups[0].ids, ['LEV|GFWR1', 'HUBW|GFRST15W']);
});

test('queue persists across restarts', () => {
  const { dir, q } = setup();
  q.file('t', 'item-note', { id: 'BPT|230', note: 'hello' }, 'r');
  const q2 = createQueue({ dataDir: dir, itemExists: () => true, applyOverride: () => {} });
  assert.equal(q2.pending().length, 1);
});
