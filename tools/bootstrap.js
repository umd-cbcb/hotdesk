#!/usr/bin/env node
/**
 * Make a fresh database usable: load the desks and create the first moderator.
 *
 *   node tools/bootstrap.js --moderator you@umd.edu --name "Your Name"
 *
 * A new install has no roster, so nobody can sign in — including you. This is
 * the way in. It is idempotent: desks are upserted, and an existing person keeps
 * their access code rather than being handed a new one.
 *
 * Options:
 *   --moderator <email>   who to create (required on an empty roster)
 *   --name <name>         their display name
 *   --title <text>        site title, default "IRB 3112 Hotdesk"
 *   --no-desks            skip loading desks.tsv
 */
'use strict';

const path = require('node:path');
const { open } = require('../server/db');
const { readDesks } = require('./seed');
const { DEFAULT_CONFIG, normCode } = require('../server/domain');
const { makeCode } = require('../server/auth');
const S = require('../server/store');

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1] : dflt;
}
const has = (name) => process.argv.includes('--' + name);

function main() {
  const dbPath = arg('db', process.env.DB_PATH ||
    path.join(__dirname, '..', 'data', 'hotdesk.db'));
  const email = String(arg('moderator', '')).trim().toLowerCase();
  const name = String(arg('name', '')).trim();
  const title = String(arg('title', 'IRB 3112 Hotdesk'));

  const db = open(dbPath);
  const roster = S.roster(db);

  if (!email && !roster.length) {
    console.error('The roster is empty and no --moderator was given, so there would\n' +
                  'be no way to sign in. Re-run with:\n\n' +
                  '  node tools/bootstrap.js --moderator you@umd.edu --name "Your Name"\n');
    process.exit(1);
  }

  db.tx(() => {
    // Defaults only: never overwrite a setting someone has already chosen.
    for (const [key, value] of Object.entries(
        Object.assign({}, DEFAULT_CONFIG, { siteTitle: title }))) {
      db.run('INSERT INTO config(key, value) VALUES(:k, :v) ' +
             'ON CONFLICT(key) DO NOTHING', { k: key, v: String(value) });
    }

    if (!has('no-desks')) {
      let n = 0;
      readDesks().forEach((d, i) => {
        db.run('INSERT INTO desks(desk_id, label, room, x, y, status, reserved_for, ' +
               'notes, sort_key) VALUES(:id, :label, :room, :x, :y, :status, :res, :notes, :sort) ' +
               'ON CONFLICT(desk_id) DO UPDATE SET label = excluded.label, ' +
               'room = excluded.room, x = excluded.x, y = excluded.y, sort_key = excluded.sort_key',
               { id: d.deskId, label: d.label, room: d.room, x: d.x, y: d.y,
                 status: d.status, res: d.reservedFor, notes: d.notes, sort: i });
        n++;
      });
      console.log(`desks     ${n} loaded from docs/assets/desks.tsv`);
    }

    if (email) {
      const existing = S.personByEmail(db, email);
      const code = existing ? existing.code : makeCode();
      db.run('INSERT INTO roster(email, name, code, role, lab, active) ' +
             "VALUES(:e, :n, :c, 'moderator', '', 1) " +
             'ON CONFLICT(email) DO UPDATE SET name = excluded.name, ' +
             "role = 'moderator', active = 1",
             { e: email, n: name || email, c: code });
      S.audit(db, 'bootstrap', existing ? 'promote' : 'create_moderator', email);
      console.log(`moderator ${email}`);
      console.log('');
      console.log('  ACCESS CODE:  ' + code);
      console.log('');
      console.log(existing
        ? '  (this account already existed, so it kept its code)'
        : '  Sign in with this. Add everyone else from the Moderator panel.');
    }
  });

  const counts = {
    desks: db.get('SELECT COUNT(*) AS n FROM desks').n,
    people: db.get('SELECT COUNT(*) AS n FROM roster').n,
  };
  console.log(`\nnow: ${counts.desks} desks, ${counts.people} on the roster`);
  db.close();
}

if (require.main === module) main();
