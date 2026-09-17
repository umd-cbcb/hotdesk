/**
 * Verify a Google ID token (the JWT the "Sign in with Google" button hands us).
 *
 * Done locally against Google's published keys rather than by calling their
 * tokeninfo endpoint, so a sign-in costs no network round trip and does not fail
 * when Google is slow. Zero dependencies: node:crypto can verify RS256 and can
 * import a JWK directly.
 *
 * This only establishes WHO someone is. Whether they are allowed is decided by
 * the roster, in server/api.js — a verified Google account that is not on the
 * roster gets nothing.
 */
'use strict';

const crypto = require('node:crypto');

const CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);
// Google ID tokens live an hour; allow a little clock drift either way.
const CLOCK_SKEW_SECONDS = 120;

function b64urlToBuffer(s) {
  return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function decodeSegment(s) {
  return JSON.parse(b64urlToBuffer(s).toString('utf8'));
}

/**
 * Google's signing keys, cached for as long as they say. A key rotation mid-day
 * would otherwise start failing every sign-in until a restart.
 */
function createKeyStore({ fetchImpl = fetch, now = Date.now } = {}) {
  let cache = { keys: null, expiresAt: 0 };

  async function load(force) {
    if (!force && cache.keys && now() < cache.expiresAt) return cache.keys;
    const res = await fetchImpl(CERTS_URL);
    if (!res.ok) throw new Error('Could not fetch Google signing keys (' + res.status + ').');
    const body = await res.json();
    if (!body || !Array.isArray(body.keys)) throw new Error('Google signing keys were malformed.');
    const maxAge = /max-age=(\d+)/.exec(res.headers && res.headers.get
      ? (res.headers.get('cache-control') || '') : '');
    cache = {
      keys: body.keys,
      expiresAt: now() + (maxAge ? Number(maxAge[1]) * 1000 : 3600 * 1000),
    };
    return cache.keys;
  }

  return {
    async byKid(kid) {
      let keys = await load(false);
      let jwk = keys.find((k) => k.kid === kid);
      if (!jwk) {
        // Unknown kid almost always means Google rotated; refetch once before
        // rejecting, rather than failing every sign-in until someone restarts.
        keys = await load(true);
        jwk = keys.find((k) => k.kid === kid);
      }
      if (!jwk) throw new Error('Token was signed with a key Google does not publish.');
      return crypto.createPublicKey({ key: jwk, format: 'jwk' });
    },
  };
}

function createVerifier({ clientId, allowedDomains = [], fetchImpl, now = Date.now } = {}) {
  if (!clientId) throw new Error('A Google client id is required.');
  const store = createKeyStore({ fetchImpl, now });
  const domains = allowedDomains.map((d) => String(d).trim().toLowerCase()).filter(Boolean);

  return async function verify(idToken) {
    const parts = String(idToken || '').split('.');
    if (parts.length !== 3) throw new Error('That Google sign-in was malformed.');

    let header, payload;
    try {
      header = decodeSegment(parts[0]);
      payload = decodeSegment(parts[1]);
    } catch (err) {
      throw new Error('That Google sign-in was malformed.');
    }

    // Reject anything but RS256 explicitly: accepting the token's own choice is
    // how "alg: none" and HMAC-confusion attacks get in.
    if (header.alg !== 'RS256') throw new Error('Unsupported Google token algorithm.');

    const key = await store.byKid(header.kid);
    const signed = Buffer.from(parts[0] + '.' + parts[1], 'utf8');
    const signature = b64urlToBuffer(parts[2]);
    if (!crypto.verify('RSA-SHA256', signed, key, signature)) {
      throw new Error('That Google sign-in could not be verified.');
    }

    // A valid signature only proves Google minted it — for someone. Without the
    // audience check, a token issued to any other Google app would be accepted.
    if (payload.aud !== clientId) throw new Error('That Google sign-in was issued for another application.');
    if (!ISSUERS.has(payload.iss)) throw new Error('That Google sign-in came from an unexpected issuer.');

    const seconds = Math.floor(now() / 1000);
    if (!(Number(payload.exp) > seconds - CLOCK_SKEW_SECONDS)) {
      throw new Error('That Google sign-in has expired. Try again.');
    }
    if (Number(payload.iat) > seconds + CLOCK_SKEW_SECONDS) {
      throw new Error('That Google sign-in is not valid yet — check the server clock.');
    }

    const email = String(payload.email || '').trim().toLowerCase();
    if (!email) throw new Error('That Google account has no email address.');
    // An unverified address can be anything the account holder typed.
    if (payload.email_verified !== true && payload.email_verified !== 'true') {
      throw new Error('That Google account has an unverified email address.');
    }
    if (domains.length) {
      const domain = String(payload.hd || email.split('@')[1] || '').toLowerCase();
      if (!domains.includes(domain)) {
        throw new Error('Sign in with your ' + domains.join(' or ') + ' account.');
      }
    }

    return { email, name: String(payload.name || '').trim(), sub: String(payload.sub || ''),
             hd: String(payload.hd || '').toLowerCase() };
  };
}

module.exports = { createVerifier, createKeyStore, CERTS_URL };
