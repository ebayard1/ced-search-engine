'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { saveJSONAtomic, rotateBackup, loadJSONGuarded, newestBackup } = require('../lib/store');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ced-store-'));
}

test('saveJSONAtomic round-trips and leaves no temp file', () => {
  const dir = tmpdir();
  const file = path.join(dir, 'x.json');
  saveJSONAtomic(file, { a: 1, b: [2, 3] });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { a: 1, b: [2, 3] });
  assert.ok(!fs.existsSync(file + '.tmp'));
});

test('rotateBackup creates dated copy once per day and prunes', () => {
  const dir = tmpdir();
  const file = path.join(dir, 'overrides.json');
  saveJSONAtomic(file, { v: 1 });
  const dest = rotateBackup(file);
  assert.ok(fs.existsSync(dest));
  saveJSONAtomic(file, { v: 2 });
  assert.equal(rotateBackup(file), dest); // same day: no second copy
  assert.deepEqual(JSON.parse(fs.readFileSync(dest, 'utf8')), { v: 1 });
});

test('loadJSONGuarded: missing file returns fallback', () => {
  const dir = tmpdir();
  assert.deepEqual(loadJSONGuarded(path.join(dir, 'nope.json'), { d: true }), { d: true });
});

test('loadJSONGuarded: corrupt file restores from newest backup', () => {
  const dir = tmpdir();
  const file = path.join(dir, 'overrides.json');
  saveJSONAtomic(file, { good: 'data' });
  rotateBackup(file);
  fs.writeFileSync(file, '{"trunca'); // simulate a crash mid-write
  const obj = loadJSONGuarded(file, {});
  assert.deepEqual(obj, { good: 'data' });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { good: 'data' }); // repaired on disk
});

test('loadJSONGuarded: corrupt file with no backup throws instead of wiping', () => {
  const dir = tmpdir();
  const file = path.join(dir, 'overrides.json');
  fs.writeFileSync(file, 'not json');
  assert.throws(() => loadJSONGuarded(file, {}), /Refusing to start/);
});

test('newestBackup picks the latest date', () => {
  const dir = tmpdir();
  const file = path.join(dir, 'o.json');
  const bdir = path.join(dir, 'backups');
  fs.mkdirSync(bdir);
  fs.writeFileSync(path.join(bdir, 'o-2026-07-01.json'), '{}');
  fs.writeFileSync(path.join(bdir, 'o-2026-07-10.json'), '{}');
  assert.equal(newestBackup(file), path.join(bdir, 'o-2026-07-10.json'));
});
