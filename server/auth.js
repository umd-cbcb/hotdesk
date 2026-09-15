/**
 * Access codes and session tokens.
 *
 * Deliberately the same scheme as the Apps Script backend so the two can be
 * compared during cutover: a signed, expiring bearer token carrying the user's
 * email, kept in localStorage by the frontend. The improvements here are the
 * ones invisible to the wire protocol — constant-time signature comparison, and
 * rate limiting that can finally see a client address.
 *
 * Hashing codes at rest and moving to httpOnly cookies is a separate change.
 */
'use strict';

const crypto = require('node:crypto');

const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const b64url = (buf) => Buffer.from(buf).toString('base64url');

function sign(payload, secret) {
  return b64url(crypto.createHmac('sha256', secret).update(payload).digest());
}

function mintToken(email, secret, now = Date.now()) {
  const payload = String(email).toLowerCase() + '|' + (now + TOKEN_TTL_MS);
  return b64url(payload) + '.' + sign(payload, secret);
}

function emailFromToken(token, secret, now = Date.now()) {
  const parts = String(token || '').split('.');
  if (parts.length !== 2) return null;
  let payload;
  try {
    payload = Buffer.from(parts[0], 'base64url').toString('utf8');
  } catch (err) {
    return null;
  }
  const expected = sign(payload, secret);
  // Length check first: timingSafeEqual throws on a length mismatch.
  if (expected.length !== parts[1].length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(parts[1]))) return null;

  const [email, expiry] = payload.split('|');
  if (!email || !(Number(expiry) > now)) return null;
  return email;
}

/**
 * Sliding-window failure counter, keyed by client address and by code.
 *
 * The Apps Script version could only count globally, so one script hammering
 * the endpoint locked every student out. Here a wrong code costs the guesser
 * their own bucket; the global bucket remains as a backstop with a much higher
 * ceiling.
 */
class Throttle {
  constructor({ perKey = 10, globalMax = 200, windowMs = 600000 } = {}) {
    this.perKey = perKey;
    this.globalMax = globalMax;
    this.windowMs = windowMs;
    this.hits = new Map();
  }

  _prune(now) {
    for (const [key, times] of this.hits) {
      const live = times.filter((t) => now - t < this.windowMs);
      if (live.length) this.hits.set(key, live);
      else this.hits.delete(key);
    }
  }

  blocked(keys, now = Date.now()) {
    this._prune(now);
    for (const key of keys) {
      if ((this.hits.get(key) || []).length >= this.perKey) return true;
    }
    return (this.hits.get('*') || []).length >= this.globalMax;
  }

  fail(keys, now = Date.now()) {
    for (const key of [...keys, '*']) {
      const times = this.hits.get(key) || [];
      times.push(now);
      this.hits.set(key, times);
    }
  }

  clear(keys) {
    for (const key of keys) this.hits.delete(key);
  }
}

/** Ambiguous glyphs removed: these get read aloud and typed on phones. */
function makeCode(len = 6) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  const bytes = crypto.randomBytes(len);
  for (let i = 0; i < len; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

module.exports = { mintToken, emailFromToken, Throttle, makeCode, TOKEN_TTL_MS };
