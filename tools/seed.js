/**
 * Demo data for local development and tests: the real 29 desks from
 * docs/assets/desks.tsv plus a small cast whose situations cover the states the
 * board can be in (checked in, claimed-but-absent, booked ahead, nothing).
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DEFAULT_CONFIG, addDays } = require('../server/domain');

const DESKS_TSV = path.join(__dirname, '..', 'docs', 'assets', 'desks.tsv');

const PEOPLE = [
  { email: 'rob@umd.edu',    name: 'Rob',          code: 'ROB123', role: 'moderator', lab: '' },
  { email: 'priya@umd.edu',  name: 'Priya Raman',  code: 'PRIYA1', role: 'student', lab: 'Patro' },
  { email: 'marcus@umd.edu', name: 'Marcus Hale',  code: 'MARC01', role: 'student', lab: 'Patro' },
  { email: 'lin@umd.edu',    name: 'Lin Wei',      code: 'LINW01', role: 'student', lab: 'Corrada' },
  { email: 'sam@umd.edu',    name: 'Sam Okafor',   code: 'SAM001', role: 'student', lab: 'Corrada' },
];

function readDesks(file = DESKS_TSV) {
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  const header = lines[0].split('\t');
  return lines.slice(1).filter(Boolean).map((line, i) => {
    const cells = line.split('\t');
    const row = {};
    header.forEach((h, j) => { row[h] = cells[j] ?? ''; });
    return {
      deskId: row.deskId, label: row.label, room: row.room,
      x: row.x === '' ? null : Number(row.x),
      y: row.y === '' ? null : Number(row.y),
      status: row.status || 'active',
      reservedFor: row.reservedFor || '',
      notes: row.notes || '',
      sortKey: i,
    };
  });
}

function seed(db, { today, withClaims = true, config = {} } = {}) {
  const cfg = Object.assign({}, DEFAULT_CONFIG, config);
  db.tx(() => {
    for (const [key, value] of Object.entries(cfg)) {
      db.run('INSERT INTO config(key, value) VALUES(:k, :v) ' +
             'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
             { k: key, v: String(value) });
    }
    for (const p of PEOPLE) {
      db.run('INSERT INTO roster(email, name, code, role, lab, active) ' +
             'VALUES(:e, :n, :c, :r, :l, 1)',
             { e: p.email, n: p.name, c: p.code, r: p.role, l: p.lab });
    }
    for (const d of readDesks()) {
      db.run('INSERT INTO desks(desk_id, label, room, x, y, status, reserved_for, notes, sort_key) ' +
             'VALUES(:id, :label, :room, :x, :y, :status, :res, :notes, :sort)',
             { id: d.deskId, label: d.label, room: d.room, x: d.x, y: d.y,
               status: d.status, res: d.reservedFor, notes: d.notes, sort: d.sortKey });
    }
  });

  if (!withClaims || !today) return;
  const now = new Date().toISOString();
  const add = (date, deskId, email, checkedIn) =>
    db.run('INSERT INTO claims(claim_id, date, desk_id, email, claimed_at, ' +
           "checked_in_at, released_at, status) VALUES(:id, :d, :k, :e, :t, :ci, '', 'active')",
           { id: 'seed-' + deskId + '-' + date, d: date, k: deskId, e: email,
             t: now, ci: checkedIn ? now : '' });

  db.tx(() => {
    add(today, 'IRB3112-07', 'priya@umd.edu', true);    // in, checked in
    add(today, 'IRB3112-18', 'marcus@umd.edu', false);  // claimed, not arrived
    add(today, 'IRB3112-26', 'sam@umd.edu', true);
    add(addDays(today, 1), 'IRB3112-12', 'lin@umd.edu', false);  // booked ahead

    // A little history, so the "showed up for N of M" line has something to say.
    for (let i = 2; i <= 9; i++) {
      const date = addDays(today, -i);
      db.run('INSERT INTO claims(claim_id, date, desk_id, email, claimed_at, ' +
             'checked_in_at, released_at, status) VALUES(:id, :d, :k, :e, :t, :ci, :t, :s)',
             { id: 'hist-' + i, d: date, k: 'IRB3112-05', e: 'priya@umd.edu',
               t: now, ci: i === 4 ? '' : now,
               s: i === 4 ? 'noshow' : 'released' });
    }
  });
}

module.exports = { seed, readDesks, PEOPLE };
