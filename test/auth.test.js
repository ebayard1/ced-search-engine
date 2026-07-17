'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { createAuth, parseCookies } = require('../lib/auth');

test('disabled without a password: everything passes', () => {
  const a = createAuth({ password: '' });
  assert.equal(a.enabled, false);
  assert.equal(a.verify(undefined), true);
  assert.equal(a.verify('garbage'), true);
  assert.equal(a.checkPassword('anything'), true);
});

test('checkPassword: exact match only', () => {
  const a = createAuth({ password: 'counter-2026' });
  assert.equal(a.enabled, true);
  assert.equal(a.checkPassword('counter-2026'), true);
  assert.equal(a.checkPassword('counter-2027'), false);
  assert.equal(a.checkPassword(''), false);
  assert.equal(a.checkPassword(null), false);
});

test('issued tokens verify, expire, and reject tampering', () => {
  const a = createAuth({ password: 'pw', ttlMs: 1000 });
  const now = 1_700_000_000_000;
  const tok = a.issue(now);
  assert.equal(a.verify(tok, now), true);
  assert.equal(a.verify(tok, now + 999), true);
  assert.equal(a.verify(tok, now + 1001), false); // expired
  // tampered expiry keeps the old signature -> reject
  const [exp, sig] = tok.split('.');
  assert.equal(a.verify(`${Number(exp) + 99999}.${sig}`, now), false);
  assert.equal(a.verify(`${exp}.${'A'.repeat(43)}`, now), false);
  assert.equal(a.verify('', now), false);
  assert.equal(a.verify('not-a-token', now), false);
});

test('changing the password invalidates old sessions', () => {
  const now = 1_700_000_000_000;
  const tok = createAuth({ password: 'old' }).issue(now);
  assert.equal(createAuth({ password: 'old' }).verify(tok, now), true, 'restart with same password keeps sessions');
  assert.equal(createAuth({ password: 'new' }).verify(tok, now), false, 'new password logs everyone out');
});

test('login attempts rate-limit per ip and reset after the window', () => {
  const a = createAuth({ password: 'pw' });
  const now = 1_700_000_000_000;
  for (let i = 0; i < 20; i++) assert.equal(a.allowAttempt('1.2.3.4', now), true, `attempt ${i + 1}`);
  assert.equal(a.allowAttempt('1.2.3.4', now), false, 'attempt 21 blocked');
  assert.equal(a.allowAttempt('5.6.7.8', now), true, 'other ip unaffected');
  assert.equal(a.allowAttempt('1.2.3.4', now + 16 * 60 * 1000), true, 'window reset');
});

test('parseCookies handles the usual shapes', () => {
  assert.deepEqual(parseCookies('a=1; ced_session=x.y; b=2'), { a: '1', ced_session: 'x.y', b: '2' });
  assert.deepEqual(parseCookies(undefined), {});
  assert.deepEqual(parseCookies('noequals'), {});
  assert.deepEqual(parseCookies('v=hello%20there'), { v: 'hello there' });
});
