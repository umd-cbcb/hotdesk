'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { open } = require('../server/db');
const { seed, PEOPLE } = require('../tools/seed');
const D = require('../server/domain');

const WORKER = path.join(__dirname, 'claim-worker.js');

function race(dbPath, codes, deskId, date) {
  const startAt = Date.now() + 400;
  return Promise.all(codes.map((code) => new Promise((resolve) => {
    execFile(process.execPath,
      [WORKER, dbPath, code, deskId, date, String(startAt)],
      { timeout: 20000 },
      (err, stdout, stderr) => {
        if (err && !stdout) return resolve({ ok: false, error: String(stderr || err) });
        try { resolve(JSON.parse(stdout)); }
        catch (e) { resolve({ ok: false, error: 'unparseable: ' + stdout + stderr }); }
      });
  })));
}

test('five people claiming one desk at once: exactly one wins', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hotdesk-race-'));
  const dbPath = path.join(dir, 'race.db');
  const db = open(dbPath);
  const today = D.clock('America/New_York').date;
  seed(db, { today, withClaims: false });
  db.close();

  const codes = PEOPLE.map((p) => p.code);
  const results = await race(dbPath, codes, 'IRB3112-03', today);

  const winners = results.filter((r) => r.ok);
  const losers = results.filter((r) => !r.ok);

  assert.equal(winners.length, 1,
    'exactly one claim should succeed, got ' + winners.length +
    '\n' + JSON.stringify(results, null, 1));
  assert.equal(losers.length, codes.length - 1);
  for (const l of losers) {
    assert.match(l.error, /just claimed by someone else|already/,
      'a loser should get the contention message, not a database error: ' + l.error);
  }

  // And the database agrees there is exactly one active claim on that desk.
  const check = open(dbPath);
  const rows = check.all(
    "SELECT * FROM claims WHERE desk_id = 'IRB3112-03' AND status = 'active'");
  assert.equal(rows.length, 1);
  check.close();

  fs.rmSync(dir, { recursive: true, force: true });
});

test('one person claiming five desks at once still gets only one', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hotdesk-race2-'));
  const dbPath = path.join(dir, 'race.db');
  const db = open(dbPath);
  const today = D.clock('America/New_York').date;
  seed(db, { today, withClaims: false });
  db.close();

  const startAt = Date.now() + 400;
  const desks = ['IRB3112-03', 'IRB3112-04', 'IRB3112-05', 'IRB3112-06', 'IRB3112-08'];
  const results = await Promise.all(desks.map((deskId) => new Promise((resolve) => {
    execFile(process.execPath,
      [WORKER, dbPath, 'LINW01', deskId, today, String(startAt)],
      { timeout: 20000 },
      (err, stdout, stderr) => {
        try { resolve(JSON.parse(stdout)); }
        catch (e) { resolve({ ok: false, error: String(stderr || err) }); }
      });
  })));

  assert.equal(results.filter((r) => r.ok).length, 1,
    'the one-desk-per-person-per-day rule must hold under concurrency too\n' +
    JSON.stringify(results, null, 1));

  const check = open(dbPath);
  assert.equal(check.all(
    "SELECT * FROM claims WHERE email = 'lin@umd.edu' AND status = 'active'").length, 1);
  check.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
