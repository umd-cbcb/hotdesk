'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeApi, data, error } = require('./helpers');
const { parseCsv, parseTable } = require('../server/csv');

function withApi(opts, fn) {
  if (typeof opts === 'function') { fn = opts; opts = {}; }
  return async () => {
    const h = makeApi(opts);
    try { await fn(h); } finally { h.cleanup(); }
  };
}

/* ------------------------------- the parser ----------------------------- */

test('parseCsv handles what spreadsheets actually export', () => {
  const rows = parseCsv('a,b\r\n"O\'Brien, Sam",2\r\n"say ""hi""",3\r\n');
  assert.deepEqual(rows, [['a', 'b'], ["O'Brien, Sam", '2'], ['say "hi"', '3']]);
});

test('parseCsv drops a blank line without shifting the rows after it', () => {
  assert.deepEqual(parseCsv('a,b\n1,2\n\n3,4\n'), [['a', 'b'], ['1', '2'], ['3', '4']]);
});

test('parseTable is forgiving about header spelling and an Excel BOM', () => {
  // People paste these out of whatever their department sent them.
  const t = parseTable('﻿E-mail , Full Name ,LAB\nA@UMD.edu,Ada,Patro\n');
  assert.deepEqual(t.rows[0], { email: 'A@UMD.edu', fullname: 'Ada', lab: 'Patro' });
});

test('the import accepts the header spellings rosters actually arrive with', withApi((h) => {
  // "Full Name" is far more common than "name", and reading only `name` meant
  // everyone imported without one — silently, which is the worst kind of wrong.
  const d = data(h.call({ action: 'adminImportRoster', token: h.login('ROB123'), dryRun: true,
    csv: 'E-mail,Full Name,Advisor\nada@umd.edu,Ada Lovelace,Patro\n' }));
  assert.equal(d.added, 1);
  assert.equal(d.rows[0].name, 'Ada Lovelace');
  assert.equal(d.rows[0].lab, 'Patro');
}));

/* ------------------------------ roster import --------------------------- */

const CSV = [
  'email,name,lab,role',
  'ada@umd.edu,Ada Lovelace,Patro,student',
  'grace@umd.edu,Grace Hopper,Corrada,moderator',
  'priya@umd.edu,Priya Raman,Patro,student',        // already on the roster
  'not-an-email,Broken Row,,student',
  'ada@umd.edu,Duplicate Ada,,student',             // repeated in the file
  ',No Email,,student',
  'zed@umd.edu,Zed,,wizard',                        // bad role
].join('\n');

test('a dry run reports the plan and writes nothing', withApi((h) => {
  const token = h.login('ROB123');
  const before = data(h.call({ action: 'adminState', token })).roster.length;
  const d = data(h.call({ action: 'adminImportRoster', token, csv: CSV, dryRun: true }));

  assert.equal(d.dryRun, true);
  assert.equal(d.added, 2, 'ada and grace');
  assert.equal(d.updated, 1, 'priya already exists');
  assert.equal(d.skipped, 4);

  const reasons = d.rows.filter((r) => r.action === 'skip').map((r) => r.reason);
  assert.ok(reasons.some((r) => /not an email/.test(r)));
  assert.ok(reasons.some((r) => /repeated/.test(r)));
  assert.ok(reasons.some((r) => /no email/.test(r)));
  assert.ok(reasons.some((r) => /student or moderator/.test(r)));
  for (const row of d.rows) assert.equal(typeof row.line, 'number', 'line numbers to fix the file by');

  assert.equal(data(h.call({ action: 'adminState', token })).roster.length, before,
               'nothing written on a dry run');
}));

test('applying the import adds people, Google-first with no access code', withApi((h) => {
  const token = h.login('ROB123');
  const d = data(h.call({ action: 'adminImportRoster', token, csv: CSV, dryRun: false }));
  assert.equal(d.dryRun, false);

  const ada = d.rows.find((r) => r.email === 'ada@umd.edu' && r.action === 'add');
  assert.equal(ada.code, '', 'a cohort with UMD accounts needs no bearer secrets');

  const roster = data(h.call({ action: 'adminState', token })).roster;
  assert.equal(roster.find((r) => r.email === 'grace@umd.edu').role, 'moderator');
  assert.equal(roster.find((r) => r.email === 'ada@umd.edu').active, true);
  assert.equal(roster.some((r) => r.email === 'not-an-email'), false);
}));

test('a CSV that supplies codes creates visitors who can sign in with them', withApi((h) => {
  // The fallback path: someone without a UMD Google account.
  const token = h.login('ROB123');
  const d = data(h.call({ action: 'adminImportRoster', token, dryRun: false,
    csv: 'email,name,code\nvisitor@example.org,Visiting Scholar,VIS123\n' }));
  assert.equal(d.added, 1);
  assert.equal(d.rows[0].code, 'VIS123');
  assert.ok(h.call({ action: 'login', code: 'VIS123' }).ok);
}));

test('re-importing never disturbs an existing code', withApi((h) => {
  const token = h.login('ROB123');
  // Priya is already on the roster with PRIYA1 and appears in the file.
  const again = data(h.call({ action: 'adminImportRoster', token, csv: CSV, dryRun: false }));
  assert.equal(again.rows.find((r) => r.email === 'priya@umd.edu').code, 'PRIYA1');
  assert.ok(h.call({ action: 'login', code: 'PRIYA1' }).ok, 'the old code still works');

  const third = data(h.call({ action: 'adminImportRoster', token, csv: CSV, dryRun: false }));
  assert.equal(third.added, 0, 'and a third pass adds nobody');
}));

test('a code already in use is refused rather than silently stealing a login', withApi((h) => {
  const token = h.login('ROB123');
  const d = data(h.call({ action: 'adminImportRoster', token, dryRun: true,
    csv: 'email,name,code\nnew@umd.edu,New Person,PRIYA1\n' }));
  assert.equal(d.skipped, 1);
  assert.match(d.rows[0].reason, /already in use/);
}));

test('a file with no email column is refused with the header it saw', withApi((h) => {
  const msg = error(h.call({ action: 'adminImportRoster', token: h.login('ROB123'),
                             csv: 'name,lab\nAda,Patro\n' }));
  assert.match(msg, /No "email" column/);
  assert.match(msg, /name, lab/, 'shows what it did find, so the mistake is obvious');
}));

test('students cannot import a roster', withApi((h) => {
  assert.match(error(h.call({ action: 'adminImportRoster', token: h.login('SAM001'),
                              csv: CSV })), /Moderators only/);
}));

/* ------------------------------ deactivation ---------------------------- */

test('deactivating blocks sign-in and frees the desks they were holding', withApi(
  { at: '2026-09-15T10:00:00-04:00' }, (h) => {
    const token = h.login('ROB123');
    // Lin holds tomorrow; give her today as well, and keep her live session so
    // we can check an already-signed-in user is stopped too.
    const linToken = h.login('LINW01');
    h.call({ action: 'claim', token: linToken, date: h.today, deskId: 'IRB3112-03' });

    const d = data(h.call({ action: 'adminSetActive', token,
                            email: 'lin@umd.edu', active: false }));
    assert.equal(d.active, false);
    assert.equal(d.released, 2, 'today and tomorrow both freed');

    assert.match(error(h.call({ action: 'state', token: linToken })), /deactivated/,
                 'an open session stops working immediately, not at token expiry');

    // And the desks really are back in the pool.
    const board = data(h.call({ action: 'state', token }));
    assert.equal(board.days[0].claims.some((c) => c.deskId === 'IRB3112-03'), false);
  }));

test('a deactivated account cannot sign in at all', withApi((h) => {
  const token = h.login('ROB123');
  data(h.call({ action: 'adminSetActive', token, email: 'sam@umd.edu', active: false }));
  assert.match(error(h.call({ action: 'login', code: 'SAM001' })), /not recognised/);
}));

test('reactivating restores access without touching history', withApi((h) => {
  const token = h.login('ROB123');
  data(h.call({ action: 'adminSetActive', token, email: 'priya@umd.edu', active: false }));
  const d = data(h.call({ action: 'adminSetActive', token, email: 'priya@umd.edu', active: true }));
  assert.equal(d.active, true);
  assert.equal(d.released, 0);
  assert.ok(h.call({ action: 'login', code: 'PRIYA1' }).ok);
  // The claim history that the occupancy numbers rest on is still there.
  assert.ok(h.db.get("SELECT COUNT(*) AS n FROM claims WHERE email='priya@umd.edu'").n > 0);
}));

test('the last moderator cannot switch themselves off', withApi((h) => {
  // Otherwise nobody can turn anyone back on and the only way out is a shell.
  assert.match(error(h.call({ action: 'adminSetActive', token: h.login('ROB123'),
                              email: 'rob@umd.edu', active: false })),
               /last active moderator/);
}));

test('saving a person does not silently reactivate them', withApi((h) => {
  const token = h.login('ROB123');
  data(h.call({ action: 'adminSetActive', token, email: 'sam@umd.edu', active: false }));
  // The moderator form never sends `active`, so this used to switch them back on.
  data(h.call({ action: 'adminSavePerson', token,
                person: { email: 'sam@umd.edu', name: 'Sam Okafor', role: 'student' } }));
  const sam = data(h.call({ action: 'adminState', token })).roster
    .find((r) => r.email === 'sam@umd.edu');
  assert.equal(sam.active, false);
}));
