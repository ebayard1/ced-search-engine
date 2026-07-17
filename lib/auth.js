'use strict';
// Shared-password gate — zero-dep, opt-in.
// Password: CED_PASSWORD env var, or data/config.json {"password": "..."}.
// No password configured -> auth disabled, app behaves exactly as before (open LAN).
//
// Sessions are stateless: a signed `<expiry>.<hmac>` cookie whose key is derived
// from the password, so changing the password instantly logs every station out
// and a restart never drops anyone.

const crypto = require('crypto');

const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days — counter stations log in once a month
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const ATTEMPTS_PER_WINDOW = 20;

function createAuth({ password, ttlMs = DEFAULT_TTL_MS } = {}) {
  const enabled = !!(password && String(password).length);
  const key = enabled
    ? crypto.createHmac('sha256', 'ced-session-v1').update(String(password)).digest()
    : null;

  function sign(exp) {
    return crypto.createHmac('sha256', key).update(String(exp)).digest('base64url');
  }

  function issue(now = Date.now()) {
    const exp = now + ttlMs;
    return `${exp}.${sign(exp)}`;
  }

  function verify(token, now = Date.now()) {
    if (!enabled) return true;
    const m = /^(\d{1,16})\.([A-Za-z0-9_-]{20,100})$/.exec(String(token || ''));
    if (!m) return false;
    const exp = Number(m[1]);
    if (!(exp > now)) return false;
    const want = Buffer.from(sign(exp));
    const got = Buffer.from(m[2]);
    return want.length === got.length && crypto.timingSafeEqual(want, got);
  }

  function checkPassword(attempt) {
    if (!enabled) return true;
    // hash both sides so timingSafeEqual gets equal-length buffers
    const a = crypto.createHash('sha256').update(String(attempt || '')).digest();
    const b = crypto.createHash('sha256').update(String(password)).digest();
    return crypto.timingSafeEqual(a, b);
  }

  // Login attempts per IP: ATTEMPTS_PER_WINDOW tries per rolling window, so a
  // typo'd counter password never locks anyone out but scripted guessing stalls.
  const attempts = new Map(); // ip -> { n, resetAt }
  function allowAttempt(ip, now = Date.now()) {
    const e = attempts.get(ip);
    if (!e || now > e.resetAt) {
      attempts.set(ip, { n: 1, resetAt: now + ATTEMPT_WINDOW_MS });
      if (attempts.size > 10000) { // bound memory under address-spoofing floods
        for (const [k, v] of attempts) if (now > v.resetAt) attempts.delete(k);
      }
      return true;
    }
    e.n++;
    return e.n <= ATTEMPTS_PER_WINDOW;
  }

  return { enabled, ttlMs, issue, verify, checkPassword, allowAttempt };
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

module.exports = { createAuth, parseCookies, DEFAULT_TTL_MS };
