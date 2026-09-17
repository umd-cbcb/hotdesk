'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createVerifier } = require('../server/google');

/**
 * A mistake in here means anyone can sign in as anyone, so these lean on the
 * attacks rather than the happy path: wrong audience, wrong issuer, expired,
 * re-signed with an attacker's key, algorithm swapped, unverified address.
 */

const CLIENT_ID = '1234567890-abcdef.apps.googleusercontent.com';
const NOW = Date.UTC(2026, 8, 17, 12, 0, 0);
const nowFn = () => NOW;
const seconds = Math.floor(NOW / 1000);

const google = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const attacker = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });

const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o))
  .toString('base64url');

function makeToken(claims = {}, { key = google.privateKey, header = {} } = {}) {
  const h = b64(Object.assign({ alg: 'RS256', kid: 'test-key', typ: 'JWT' }, header));
  const p = b64(Object.assign({
    iss: 'https://accounts.google.com',
    aud: CLIENT_ID,
    sub: '110000000000000000001',
    email: 'ada@umd.edu',
    email_verified: true,
    name: 'Ada Lovelace',
    hd: 'umd.edu',
    iat: seconds - 30,
    exp: seconds + 3600,
  }, claims));
  if (header.alg === 'none') return `${h}.${p}.`;
  const sig = crypto.sign('RSA-SHA256', Buffer.from(`${h}.${p}`), key).toString('base64url');
  return `${h}.${p}.${sig}`;
}

/** Serve our test key where Google's JWKS would be, counting the fetches. */
function keyServer(jwks) {
  const state = { calls: 0 };
  const fetchImpl = async () => {
    state.calls++;
    return {
      ok: true,
      headers: { get: () => 'public, max-age=3600' },
      json: async () => jwks(),
    };
  };
  return { fetchImpl, state };
}

const defaultJwks = () => ({
  keys: [Object.assign({ kid: 'test-key', alg: 'RS256', use: 'sig' },
                       google.publicKey.export({ format: 'jwk' }))],
});

function verifier(opts = {}) {
  const ks = keyServer(opts.jwks || defaultJwks);
  return {
    verify: createVerifier({
      clientId: CLIENT_ID, now: nowFn, fetchImpl: ks.fetchImpl,
      allowedDomains: opts.allowedDomains,
    }),
    keys: ks.state,
  };
}

async function rejects(promise, re) {
  await assert.rejects(promise, (err) => {
    assert.match(err.message, re, 'unexpected message: ' + err.message);
    return true;
  });
}

test('a well-formed Google token yields the verified identity', async () => {
  const v = verifier();
  const who = await v.verify.call(null, makeToken());
  assert.equal(who.email, 'ada@umd.edu');
  assert.equal(who.name, 'Ada Lovelace');
  assert.equal(who.hd, 'umd.edu');
  assert.ok(who.sub);
});

test('a token minted for a different application is refused', async () => {
  // Without this check, any Google app's token would sign you in here.
  await rejects(verifier().verify(makeToken({ aud: 'someone-else.apps.googleusercontent.com' })),
                /issued for another application/);
});

test('a token signed with the wrong key is refused', async () => {
  await rejects(verifier().verify(makeToken({}, { key: attacker.privateKey })),
                /could not be verified/);
});

test('re-signing a tampered payload with the attacker key does not help', async () => {
  // The classic: take a real token, change the email, sign it yourself.
  await rejects(
    verifier().verify(makeToken({ email: 'rob@umd.edu' }, { key: attacker.privateKey })),
    /could not be verified/);
});

test('alg:none is refused outright', async () => {
  await rejects(verifier().verify(makeToken({}, { header: { alg: 'none' } })),
                /Unsupported Google token algorithm/);
});

test('an HMAC-signed token is refused rather than verified with the public key', async () => {
  // HMAC confusion: sign with Google's public key as the HMAC secret.
  const h = b64({ alg: 'HS256', kid: 'test-key', typ: 'JWT' });
  const p = b64({ iss: 'https://accounts.google.com', aud: CLIENT_ID,
                  email: 'rob@umd.edu', email_verified: true,
                  iat: seconds - 30, exp: seconds + 3600 });
  const pub = google.publicKey.export({ type: 'spki', format: 'pem' });
  const sig = crypto.createHmac('sha256', pub).update(`${h}.${p}`).digest('base64url');
  await rejects(verifier().verify(`${h}.${p}.${sig}`), /Unsupported Google token algorithm/);
});

test('an expired token is refused', async () => {
  await rejects(verifier().verify(makeToken({ exp: seconds - 3600 })), /expired/);
});

test('a token from the future is refused', async () => {
  await rejects(verifier().verify(makeToken({ iat: seconds + 3600 })), /not valid yet/);
});

test('small clock drift is tolerated', async () => {
  const v = verifier();
  assert.ok(await v.verify(makeToken({ exp: seconds - 30 })), 'just expired is still accepted');
  assert.ok(await v.verify(makeToken({ iat: seconds + 30 })), 'slightly ahead is accepted');
});

test('an unexpected issuer is refused', async () => {
  await rejects(verifier().verify(makeToken({ iss: 'https://evil.example' })),
                /unexpected issuer/);
});

test('an unverified email address is refused', async () => {
  // Otherwise someone types any address into an account and is believed.
  await rejects(verifier().verify(makeToken({ email_verified: false })), /unverified email/);
});

test('a malformed token is refused without throwing something ugly', async () => {
  for (const bad of ['', 'not-a-token', 'a.b', 'a.b.c.d', '...']) {
    await rejects(verifier().verify(bad), /malformed|Unsupported|could not be verified/);
  }
});

test('domain restriction, when configured, is enforced', async () => {
  const v = verifier({ allowedDomains: ['umd.edu', 'terpmail.umd.edu'] });
  assert.ok(await v.verify(makeToken()));
  assert.ok(await v.verify(makeToken({ email: 'x@terpmail.umd.edu', hd: 'terpmail.umd.edu' })));
  await rejects(v.verify(makeToken({ email: 'someone@gmail.com', hd: '' })),
                /Sign in with your/);
});

test('signing keys are cached, not fetched on every sign-in', async () => {
  const v = verifier();
  await v.verify(makeToken());
  await v.verify(makeToken());
  await v.verify(makeToken());
  assert.equal(v.keys.calls, 1, 'one fetch for three sign-ins');
});

test('an unknown key id triggers exactly one refetch, then gives up', async () => {
  // Google rotates keys; without the refetch every sign-in would fail until
  // someone noticed and restarted the service.
  let rotated = false;
  const v = verifier({
    jwks: () => {
      if (!rotated) return { keys: [] };
      return defaultJwks();
    },
  });
  await rejects(v.verify(makeToken()), /key Google does not publish/);
  assert.equal(v.keys.calls, 2, 'tried again before failing');

  rotated = true;
  const v2 = verifier({ jwks: () => (rotated ? defaultJwks() : { keys: [] }) });
  assert.ok(await v2.verify(makeToken()), 'recovers once the new key is published');
});

test('a client id is mandatory', () => {
  assert.throws(() => createVerifier({}), /client id is required/);
});

/* ---------------- the full sign-in path, through the API ----------------- */

const { makeApi, data, error } = require('./helpers');

function apiWithGoogle(opts = {}) {
  const h = makeApi();
  const ks = keyServer(defaultJwks);
  h.api = require('../server/api').createApi({
    db: h.db, secret: 'test-secret',
    now: () => new Date(NOW),
    google: createVerifier({ clientId: CLIENT_ID, now: nowFn, fetchImpl: ks.fetchImpl,
                             allowedDomains: opts.allowedDomains }),
  });
  h.call = (body) => h.api.dispatch(body);
  return h;
}

test('a verified Google account on the roster is signed in', async () => {
  const h = apiWithGoogle();
  try {
    h.db.run("INSERT INTO roster(email, name, code, role, lab, active) " +
             "VALUES('ada@umd.edu', 'Ada', '', 'student', '', 1)");
    const d = data(await h.call({ action: 'loginGoogle', credential: makeToken() }));
    assert.ok(d.token);
    assert.equal(d.user.email, 'ada@umd.edu');
    // Signing in with Google must actually get you a working session.
    const board = data(await h.call({ action: 'state', token: d.token }));
    assert.equal(board.desks.length, 29);
  } finally { h.cleanup(); }
});

test('a verified Google account NOT on the roster gets nothing', async () => {
  // This is what keeps the board from being open to every Google user alive.
  const h = apiWithGoogle();
  try {
    const msg = error(await h.call({ action: 'loginGoogle', credential: makeToken() }));
    assert.match(msg, /not on the roster/);
    assert.match(msg, /ada@umd\.edu/, 'says which account, so the fix is obvious');
  } finally { h.cleanup(); }
});

test('a deactivated person cannot come back in through Google', async () => {
  const h = apiWithGoogle();
  try {
    h.db.run("INSERT INTO roster(email, name, code, role, lab, active) " +
             "VALUES('ada@umd.edu', 'Ada', '', 'student', '', 0)");
    assert.match(error(await h.call({ action: 'loginGoogle', credential: makeToken() })),
                 /not on the roster/);
  } finally { h.cleanup(); }
});

test('Google refreshes the display name but never the role', async () => {
  const h = apiWithGoogle();
  try {
    h.db.run("INSERT INTO roster(email, name, code, role, lab, active) " +
             "VALUES('ada@umd.edu', 'Old Name', '', 'student', '', 1)");
    const d = data(await h.call({ action: 'loginGoogle',
      credential: makeToken({ name: 'Ada Lovelace' }) }));
    assert.equal(d.user.name, 'Ada Lovelace');
    assert.equal(d.user.role, 'student', 'Google does not get to promote anyone');
  } finally { h.cleanup(); }
});

test('the access-code path still works alongside Google', async () => {
  const h = apiWithGoogle();
  try {
    // A visiting scholar with no Google account at the university.
    h.db.run("INSERT INTO roster(email, name, code, role, lab, active) " +
             "VALUES('visitor@example.org', 'Visitor', 'VIS123', 'student', '', 1)");
    const d = data(await h.call({ action: 'login', code: 'VIS123' }));
    assert.equal(d.user.email, 'visitor@example.org');
  } finally { h.cleanup(); }
});

test('with Google unconfigured, the action says so instead of failing oddly', async () => {
  const h = makeApi();
  try {
    assert.match(error(await h.call({ action: 'loginGoogle', credential: 'x' })),
                 /not configured/);
  } finally { h.cleanup(); }
});
