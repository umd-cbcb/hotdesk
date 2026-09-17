'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeApi, data, error } = require('./helpers');
const D = require('../server/domain');

/** Run a test with a fresh API, always cleaning up the temp database. */
function withApi(opts, fn) {
  if (typeof opts === 'function') { fn = opts; opts = {}; }
  return async () => {
    const h = makeApi(opts);
    try { await fn(h); } finally { h.cleanup(); }
  };
}

/* ------------------------------ auth ---------------------------------- */

test('login returns a token and the public user only', withApi((h) => {
  const d = data(h.call({ action: 'login', code: 'rob-123' }));   // normalised
  assert.ok(d.token);
  assert.deepEqual(Object.keys(d.user).sort(), ['email', 'lab', 'name', 'role']);
  assert.equal(d.user.role, 'moderator');
  assert.ok(!('code' in d.user), 'never hand the access code back out');
}));

test('a wrong code is refused', withApi((h) => {
  assert.match(error(h.call({ action: 'login', code: 'NOPE99' })), /not recognised/);
}));

test('an expired or forged token says "expired" verbatim', withApi((h) => {
  // docs/js/app.js matches this substring to decide whether to surface the
  // error on the sign-in screen. Changing the wording breaks that.
  assert.match(error(h.call({ action: 'state', token: 'garbage' })), /expired/);
}));

test('a deactivated account is told so, distinctly from a missing one', withApi((h) => {
  const token = h.login('SAM001');
  h.db.run("UPDATE roster SET active = 0 WHERE email = 'sam@umd.edu'");
  assert.match(error(h.call({ action: 'state', token })), /deactivated/);

  const token2 = h.login('LINW01');
  h.db.run("UPDATE roster SET email = 'lin2@umd.edu' WHERE email = 'lin@umd.edu'");
  assert.match(error(h.call({ action: 'state', token: token2 })), /could not find/);
}));

test('per-client throttling locks out a guesser, not everybody', withApi((h) => {
  for (let i = 0; i < 12; i++) {
    h.call({ action: 'login', code: 'WRONG' + i, clientIp: '10.0.0.9' });
  }
  assert.match(error(h.call({ action: 'login', code: 'ROB123', clientIp: '10.0.0.9' })),
               /Too many failed sign-ins/);
  // The old backend counted globally, so one attacker locked the whole lab out.
  assert.ok(h.call({ action: 'login', code: 'ROB123', clientIp: '10.0.0.2' }).ok,
            'a different client is unaffected');
}));

test('moderator-only actions are refused for students', withApi((h) => {
  const token = h.login('SAM001');
  assert.match(error(h.call({ action: 'adminState', token })), /Moderators only/);
}));

/* ------------------------------ state ---------------------------------- */

test('state returns exactly the shape the frontend reads', withApi((h) => {
  const d = data(h.call({ action: 'state', token: h.login('ROB123') }));

  assert.deepEqual(Object.keys(d).sort(),
    ['config', 'days', 'desks', 'me', 'now', 'user']);

  assert.equal(typeof d.config.horizonDays, 'number', 'app.js compares === 1');
  assert.equal(typeof d.config.maxOpenClaims, 'number');
  assert.equal(typeof d.config.checkInEnabled, 'boolean');
  assert.match(d.config.releaseTime, /^\d{2}:\d{2}$/);
  assert.match(d.now.date, /^\d{4}-\d{2}-\d{2}$/);

  assert.equal(d.desks.length, 29);
  const desk = d.desks[0];
  assert.deepEqual(Object.keys(desk).sort(),
    ['deskId', 'label', 'notes', 'reservedFor', 'reservedForName', 'room', 'status', 'x', 'y']);
  assert.equal(typeof desk.x, 'number', 'placed desks carry numeric coordinates');

  // horizonDays + 2, so the strip can show one still-locked day.
  assert.equal(d.days.length, d.config.horizonDays + 2);
  assert.equal(d.days[0].date, d.now.date);
  assert.equal(d.days.at(-1).window.claimable, false);

  const claim = d.days[0].claims[0];
  assert.deepEqual(Object.keys(claim).sort(),
    ['checkedIn', 'claimId', 'deskId', 'email', 'mine', 'name']);
  assert.equal(typeof claim.mine, 'boolean');
  assert.equal(typeof claim.checkedIn, 'boolean');

  assert.equal(typeof d.me.openClaims, 'number');
  assert.deepEqual(Object.keys(d.me.reliability).sort(), ['honoured', 'missed']);
}));

test('an unplaced desk reports null coordinates, never empty string', withApi((h) => {
  h.db.run("UPDATE desks SET x = NULL, y = NULL WHERE desk_id = 'IRB3112-00'");
  const d = data(h.call({ action: 'state', token: h.login('ROB123') }));
  const desk = d.desks.find((x) => x.deskId === 'IRB3112-00');
  // app.js tests `typeof d.x === 'number'`; '' would be silently unplaced.
  assert.equal(desk.x, null);
  assert.equal(desk.y, null);
}));

test('mine is true only for the caller', withApi((h) => {
  const priya = data(h.call({ action: 'state', token: h.login('PRIYA1') }));
  const today = priya.days[0].claims;
  assert.equal(today.find((c) => c.deskId === 'IRB3112-07').mine, true);
  assert.equal(today.find((c) => c.deskId === 'IRB3112-26').mine, false);
}));

test('config warnings reach moderators and not students', withApi((h) => {
  h.db.run("UPDATE config SET value = 'lunchtime' WHERE key = 'checkInDeadline'");
  const mod = data(h.call({ action: 'state', token: h.login('ROB123') }));
  assert.equal(mod.config.warnings.length, 1);
  const student = data(h.call({ action: 'state', token: h.login('SAM001') }));
  assert.deepEqual(student.config.warnings, []);
}));

/* ------------------------------ claiming -------------------------------- */

test('claiming a free desk works and shows up as mine', withApi((h) => {
  const token = h.login('LINW01');
  const { claimId } = data(h.call({ action: 'claim', token, date: h.today,
                                    deskId: 'IRB3112-03' }));
  assert.ok(claimId);
  const d = data(h.call({ action: 'state', token }));
  const mine = d.days[0].claims.find((c) => c.deskId === 'IRB3112-03');
  assert.equal(mine.mine, true);
  assert.equal(mine.checkedIn, true, 'a walk-up is its own check-in');
}));

test('a taken desk is refused', withApi((h) => {
  const token = h.login('LINW01');
  assert.match(error(h.call({ action: 'claim', token, date: h.today,
                              deskId: 'IRB3112-07' })), /just claimed by someone else/);
}));

test('one desk per person per day', withApi((h) => {
  const token = h.login('LINW01');
  data(h.call({ action: 'claim', token, date: h.today, deskId: 'IRB3112-03' }));
  assert.match(error(h.call({ action: 'claim', token, date: h.today,
                              deskId: 'IRB3112-04' })), /already hold a desk/);
}));

test('an out-of-service desk cannot be claimed', withApi((h) => {
  h.db.run("UPDATE desks SET status = 'broken' WHERE desk_id = 'IRB3112-03'");
  assert.match(error(h.call({ action: 'claim', token: h.login('LINW01'),
                              date: h.today, deskId: 'IRB3112-03' })), /out of service/);
}));

test('a reserved desk is claimable only by its owner', withApi((h) => {
  h.db.run("UPDATE desks SET reserved_for = 'sam@umd.edu' WHERE desk_id = 'IRB3112-03'");
  assert.match(error(h.call({ action: 'claim', token: h.login('LINW01'),
                              date: h.today, deskId: 'IRB3112-03' })), /reserved/);
  // Sam already holds 26 today, so use tomorrow to isolate the reservation rule.
  h.setNow('2026-09-15T18:00:00-04:00');
  assert.ok(h.call({ action: 'claim', token: h.login('SAM001'),
                     date: D.addDays(h.today, 1), deskId: 'IRB3112-03' }).ok);
}));

test('a past day is refused with its own message', withApi((h) => {
  assert.match(error(h.call({ action: 'claim', token: h.login('LINW01'),
                              date: D.addDays(h.today, -1), deskId: 'IRB3112-03' })),
               /already passed/);
}));

test('tomorrow is refused before 17:00 and allowed after', withApi((h) => {
  const tomorrow = D.addDays(h.today, 1);
  const token = h.login('SAM001');
  assert.match(error(h.call({ action: 'claim', token, date: tomorrow,
                              deskId: 'IRB3112-03' })), /not open yet/);
  h.setNow('2026-09-15T17:00:00-04:00');
  assert.ok(h.call({ action: 'claim', token, date: tomorrow, deskId: 'IRB3112-03' }).ok);
}));

test('the upcoming-days cap is enforced', withApi({ config: { horizonDays: '5' } }, (h) => {
  const token = h.login('SAM001');
  for (let i = 1; i <= 3; i++) {
    assert.ok(h.call({ action: 'claim', token, date: D.addDays(h.today, i),
                       deskId: 'IRB3112-0' + i }).ok, 'day ' + i);
  }
  assert.match(error(h.call({ action: 'claim', token, date: D.addDays(h.today, 4),
                              deskId: 'IRB3112-04' })), /which is the limit/);
}));

test('a malformed date is rejected before anything else', withApi((h) => {
  assert.match(error(h.call({ action: 'claim', token: h.login('LINW01'),
                              date: 'tomorrow', deskId: 'IRB3112-03' })), /valid date/);
}));

/* ------------------------ release, check-in, sweep ---------------------- */

test('release frees the desk; releasing twice is not an error', withApi((h) => {
  const token = h.login('PRIYA1');
  const before = data(h.call({ action: 'state', token }));
  const claimId = before.days[0].claims.find((c) => c.mine).claimId;

  assert.deepEqual(data(h.call({ action: 'release', token, claimId })), { released: true });
  assert.deepEqual(data(h.call({ action: 'release', token, claimId })), { released: false });

  const after = data(h.call({ action: 'state', token }));
  assert.equal(after.days[0].claims.some((c) => c.deskId === 'IRB3112-07'), false);
}));

test('you cannot release someone else claim, but a moderator can', withApi((h) => {
  const priya = data(h.call({ action: 'state', token: h.login('PRIYA1') }));
  const claimId = priya.days[0].claims.find((c) => c.mine).claimId;
  assert.match(error(h.call({ action: 'release', token: h.login('LINW01'), claimId })),
               /not your claim/);
  assert.ok(h.call({ action: 'adminForceRelease', token: h.login('ROB123'), claimId }).ok);
}));

// Before the deadline, so Marcus's claim has not been swept out from under us.
test('check-in only works on the day, and only on your own claim', withApi(
  { at: '2026-09-15T10:00:00-04:00' }, (h) => {
  const token = h.login('MARC01');
  const state = data(h.call({ action: 'state', token }));
  const claimId = state.days[0].claims.find((c) => c.mine).claimId;
  assert.deepEqual(data(h.call({ action: 'checkin', token, claimId })), { checkedIn: true });
  assert.deepEqual(data(h.call({ action: 'checkin', token, claimId })), { checkedIn: true },
                   'idempotent');

  const lin = data(h.call({ action: 'state', token: h.login('LINW01') }));
  const tomorrows = lin.days[1].claims.find((c) => c.mine).claimId;
  assert.match(error(h.call({ action: 'checkin', token: h.login('LINW01'),
                              claimId: tomorrows })), /on the day itself/);
  }));

test('the no-show sweep frees an un-checked-in desk after the deadline', withApi(
  { at: '2026-09-15T10:00:00-04:00' }, (h) => {
    const token = h.login('LINW01');
    const before = data(h.call({ action: 'state', token }));
    assert.ok(before.days[0].claims.some((c) => c.deskId === 'IRB3112-18'),
              'Marcus still holds it at 10:00');

    h.setNow('2026-09-15T11:00:00-04:00');
    const after = data(h.call({ action: 'state', token }));
    assert.equal(after.days[0].claims.some((c) => c.deskId === 'IRB3112-18'), false,
                 'swept at the deadline');
    assert.ok(after.days[0].claims.some((c) => c.deskId === 'IRB3112-07'),
              'a checked-in desk is left alone');

    // And the desk is genuinely claimable by whoever actually walked in.
    assert.ok(h.call({ action: 'claim', token, date: h.today, deskId: 'IRB3112-18' }).ok);
  }));

test('a swept claim counts against reliability', withApi(
  { at: '2026-09-15T12:00:00-04:00' }, (h) => {
    const d = data(h.call({ action: 'state', token: h.login('MARC01') }));
    assert.equal(d.me.reliability.missed, 1);
  }));

/* ------------------------------ admin ---------------------------------- */

test('adminState carries the fields the moderator panel renders', withApi((h) => {
  const d = data(h.call({ action: 'adminState', token: h.login('ROB123') }));
  assert.deepEqual(Object.keys(d).sort(), ['config', 'desks', 'roster', 'upcoming']);
  const person = d.roster[0];
  for (const key of ['email', 'name', 'code', 'role', 'lab', 'active', 'honoured', 'missed']) {
    assert.ok(key in person, 'roster row has ' + key);
  }
  const claim = d.upcoming[0];
  for (const key of ['claimId', 'date', 'deskId', 'email', 'checkedInAt']) {
    assert.ok(key in claim, 'upcoming row has ' + key);
  }
  assert.equal(typeof claim.date, 'string', 'admin.js localeCompares these');
}));

test('saving config round-trips through the strings the admin form posts', withApi((h) => {
  const token = h.login('ROB123');
  data(h.call({ action: 'adminSetConfig', token,
                updates: { releaseTime: '16:30', horizonDays: '2', checkInEnabled: 'FALSE' } }));
  const d = data(h.call({ action: 'state', token }));
  assert.equal(d.config.releaseTime, '16:30');
  assert.equal(d.config.horizonDays, 2);
  assert.equal(d.config.checkInEnabled, false);
}));

test('saving a person creates no access code by default', withApi((h) => {
  // Codes are the visitor fallback now, not the norm: anyone with a UMD Google
  // account needs none, and every code that exists is a bearer secret to leak.
  const token = h.login('ROB123');
  const d = data(h.call({ action: 'adminSavePerson', token,
    person: { email: 'New@UMD.edu', name: 'New Person', lab: 'x', role: 'student' } }));
  assert.equal(d.saved, 'new@umd.edu', 'email is lowercased');
  assert.equal(d.code, '', 'no code unless one is asked for');
  assert.match(error(h.call({ action: 'login', code: '' })), /Enter your access code/);
}));

test('a visitor can be given a code, and it works', withApi((h) => {
  const token = h.login('ROB123');
  const d = data(h.call({ action: 'adminSavePerson', token,
    person: { email: 'visitor@example.org', name: 'Visiting Scholar',
              role: 'student', needsCode: true } }));
  assert.match(d.code, /^[A-HJ-NP-Z2-9]{6}$/, 'no ambiguous glyphs');
  assert.ok(h.call({ action: 'login', code: d.code }).ok);

  // Re-saving must not churn the code out from under them.
  const again = data(h.call({ action: 'adminSavePerson', token,
    person: { email: 'visitor@example.org', name: 'Visiting Scholar', role: 'student' } }));
  assert.equal(again.code, d.code);
  assert.ok(h.call({ action: 'login', code: d.code }).ok);
}));

test('a code can be issued and revoked for an existing person', withApi((h) => {
  const token = h.login('ROB123');
  data(h.call({ action: 'adminSavePerson', token,
                person: { email: 'guest@example.org', name: 'Guest', role: 'student' } }));

  const issued = data(h.call({ action: 'adminSetCode', token, email: 'guest@example.org' }));
  assert.match(issued.code, /^[A-HJ-NP-Z2-9]{6}$/);
  assert.ok(h.call({ action: 'login', code: issued.code }).ok);

  const revoked = data(h.call({ action: 'adminSetCode', token,
                                email: 'guest@example.org', issue: false }));
  assert.equal(revoked.code, '');
  assert.match(error(h.call({ action: 'login', code: issued.code })), /not recognised/);
}));

test('several people with no code do not collide', withApi((h) => {
  // '' is not unique, so the index has to be partial or the second one fails.
  const token = h.login('ROB123');
  for (const e of ['a@umd.edu', 'b@umd.edu', 'c@umd.edu']) {
    assert.ok(h.call({ action: 'adminSavePerson', token,
                       person: { email: e, name: e, role: 'student' } }).ok, e);
  }
  const roster = data(h.call({ action: 'adminState', token })).roster;
  assert.equal(roster.filter((r) => !r.code).length, 3);
}));

test('saving a desk upserts and is visible immediately', withApi((h) => {
  const token = h.login('ROB123');
  data(h.call({ action: 'adminSaveDesk', token,
                desk: { deskId: 'IRB3112-03', label: '3', status: 'broken', notes: 'wobbly' } }));
  const d = data(h.call({ action: 'state', token }));
  const desk = d.desks.find((x) => x.deskId === 'IRB3112-03');
  assert.equal(desk.status, 'broken');
  assert.equal(desk.notes, 'wobbly');
}));

/* ---------------------------- envelope ---------------------------------- */

test('an unknown action is an envelope error, not a crash', withApi((h) => {
  assert.match(error(h.call({ action: 'nonsense' })), /Unknown action/);
  assert.match(error(h.call({})), /Unknown action/);
}));

test('ping needs no token', withApi((h) => {
  assert.equal(data(h.call({ action: 'ping' })).service, 'cbcb-hotdesk');
}));
