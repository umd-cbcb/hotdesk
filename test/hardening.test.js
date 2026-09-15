'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeApi, data, error } = require('./helpers');

function withApi(opts, fn) {
  if (typeof opts === 'function') { fn = opts; opts = {}; }
  return async () => {
    const h = makeApi(opts);
    try { await fn(h); } finally { h.cleanup(); }
  };
}

/* --------------------- the token-signing secret ------------------------ */

test('adminState never returns the signing secret', withApi((h) => {
  // It lived in the config table once, and adminState returns config wholesale.
  // With it anyone can mint a token for any account, and there is no revocation.
  h.db.run("INSERT INTO server_state(key, value) VALUES('hmacSecret', 'LEAK-ME')");
  h.db.run("INSERT INTO config(key, value) VALUES('hmacSecret', 'ALSO-LEAK-ME')");
  const d = data(h.call({ action: 'adminState', token: h.login('ROB123') }));
  const body = JSON.stringify(d);
  assert.equal('hmacSecret' in d.config, false);
  assert.equal(body.includes('LEAK-ME'), false, 'no secret anywhere in the payload');
  assert.equal(body.includes('ALSO-LEAK-ME'), false);
}));

test('state never returns the signing secret either', withApi((h) => {
  h.db.run("INSERT INTO config(key, value) VALUES('hmacSecret', 'LEAK-ME')");
  const d = data(h.call({ action: 'state', token: h.login('ROB123') }));
  assert.equal(JSON.stringify(d).includes('LEAK-ME'), false);
}));

test('config keys outside the known set are neither read nor written', withApi((h) => {
  const token = h.login('ROB123');
  h.db.run("INSERT INTO config(key, value) VALUES('somethingElse', 'x')");
  const d = data(h.call({ action: 'adminState', token }));
  assert.equal('somethingElse' in d.config, false, 'not read out');

  assert.match(error(h.call({ action: 'adminSetConfig', token,
                              updates: { hmacSecret: 'pwned' } })),
               /Not a setting/);
  const row = h.db.get("SELECT value FROM config WHERE key = 'hmacSecret'");
  assert.equal(row, null, 'and not written in');
}));

/* ------------------------- configuration traps -------------------------- */

test('a mistyped timezone warns instead of taking the board down', withApi((h) => {
  // clock() throws on an unknown zone and every endpoint calls it, so this used
  // to lock everyone out of the admin panel needed to undo it.
  h.db.run("UPDATE config SET value = 'Amerika/New_York' WHERE key = 'timezone'");
  const d = data(h.call({ action: 'state', token: h.login('ROB123') }));
  assert.equal(d.config.timezone, 'America/New_York', 'falls back');
  assert.equal(d.config.warnings.length, 1);
  assert.match(d.config.warnings[0], /timezone/);
  assert.ok(h.call({ action: 'adminState', token: h.login('ROB123') }).ok,
            'the admin panel stays reachable, so it can be fixed in the UI');
}));

test('horizonDays is capped so one typo cannot hang the server', withApi((h) => {
  // state builds a day (and a query) per horizon day on a single thread.
  const token = h.login('ROB123');
  h.call({ action: 'adminSetConfig', token, updates: { horizonDays: '3650' } });
  const d = data(h.call({ action: 'state', token }));
  assert.equal(d.config.horizonDays, 30);
  assert.equal(d.days.length, 32);
}));

/* ---------------------------- check-in race ------------------------------ */

test('check-in loses cleanly to the sweep instead of lying', withApi(
  { at: '2026-09-15T10:00:00-04:00' }, (h) => {
    const token = h.login('MARC01');
    const claimId = data(h.call({ action: 'state', token }))
      .days[0].claims.find((c) => c.mine).claimId;

    // The sweep fires between reading the claim and updating it.
    h.setNow('2026-09-15T11:30:00-04:00');
    const { cfg, clock } = h.api.cfgAndClock();
    h.api.sweepNoShows(cfg, clock);

    assert.match(error(h.call({ action: 'checkin', token, claimId })),
                 /no longer active/);
    const row = h.db.get('SELECT status, checked_in_at FROM claims WHERE claim_id = :id',
                         { id: claimId });
    assert.equal(row.status, 'noshow');
    assert.equal(row.checked_in_at, '', 'and it did not half-apply');
  }));

test('the sweep also clears claims left over from a day the server was down', withApi(
  { at: '2026-09-15T14:00:00-04:00' }, (h) => {
    h.db.run("INSERT INTO claims(claim_id, date, desk_id, email, claimed_at, " +
             "checked_in_at, released_at, status) " +
             "VALUES('stale', '2026-09-11', 'IRB3112-03', 'lin@umd.edu', 'x', '', '', 'active')");
    h.call({ action: 'state', token: h.login('ROB123') });
    assert.equal(h.db.get("SELECT status FROM claims WHERE claim_id = 'stale'").status,
                 'noshow');
  }));

/* ------------------------- error surface -------------------------------- */

test('an internal failure does not leak its message to the browser', withApi((h) => {
  const token = h.login('ROB123');
  // A duplicate access code used to surface as "UNIQUE constraint failed:
  // roster.code" in the moderator's face.
  const msg = error(h.call({ action: 'adminSavePerson', token,
    person: { email: 'new@umd.edu', name: 'New', code: 'PRIYA1' } }));
  assert.equal(/UNIQUE|constraint|SQLITE/i.test(msg), false, 'no database internals: ' + msg);
  assert.match(msg, /already in use/);
}));

/* --------------------------- transactions -------------------------------- */

test('nested transactions throw rather than silently losing writes', withApi((h) => {
  // SQLite has no nested transactions: an inner ROLLBACK would unwind the outer
  // one and the outer COMMIT would then succeed as a no-op.
  assert.throws(() => h.db.tx(() => h.db.tx(() => 1)), /cannot be nested/);
}));

test('a failed transaction leaves nothing behind', withApi((h) => {
  const before = h.db.get('SELECT COUNT(*) AS n FROM claims').n;
  assert.throws(() => h.db.tx(() => {
    h.db.run("INSERT INTO claims(claim_id, date, desk_id, email, claimed_at, " +
             "checked_in_at, released_at, status) " +
             "VALUES('t1', '2026-09-20', 'IRB3112-03', 'lin@umd.edu', 'x', '', '', 'active')");
    throw new Error('boom');
  }));
  assert.equal(h.db.get('SELECT COUNT(*) AS n FROM claims').n, before);
}));

/* ---------------------------- claim ids ---------------------------------- */

test('claim ids are full uuids, not an 8-character prefix', withApi((h) => {
  const { claimId } = data(h.call({ action: 'claim', token: h.login('LINW01'),
                                    date: h.today, deskId: 'IRB3112-03' }));
  // A 32-bit id collides often enough to matter, and a collision surfaces as a
  // free desk that cannot be claimed.
  assert.match(claimId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
}));
