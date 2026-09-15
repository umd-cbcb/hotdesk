/**
 * The only module that touches SQLite.
 *
 * Uses node:sqlite, which is built into Node 22.5+. That keeps the service at
 * zero runtime dependencies — nothing to npm install, no native module to
 * rebuild on a Node upgrade, no lockfile to rot. node:sqlite is still flagged
 * experimental, which is exactly why every call is funnelled through here:
 * swapping in better-sqlite3 means rewriting this file and nothing else.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (err) {
  throw new Error(
    'node:sqlite is unavailable on ' + process.version + '.\n' +
    'This service needs Node 22.5 or newer. See deploy/README.md for installing\n' +
    'a pinned Node into the service user\'s home without touching the system one.');
}

const SCHEMA = path.join(__dirname, 'schema.sql');

function open(dbPath) {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  // busy_timeout MUST be set first. Switching to WAL takes a lock of its own,
  // so without a timeout already in force a second process opening the database
  // at the same moment fails outright with SQLITE_BUSY instead of waiting.
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(fs.readFileSync(SCHEMA, 'utf8'));
  return wrap(db);
}

function wrap(db) {
  const api = {
    raw: db,
    all(sql, params = {}) { return db.prepare(sql).all(params); },
    get(sql, params = {}) { return db.prepare(sql).get(params) ?? null; },
    run(sql, params = {}) { return db.prepare(sql).run(params); },
    exec(sql) { return db.exec(sql); },
    close() { db.close(); },

    /**
     * BEGIN IMMEDIATE takes the write lock up front, so two concurrent claims
     * serialise here rather than discovering the conflict at COMMIT.
     */
    tx(fn) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const out = fn(api);
        db.exec('COMMIT');
        return out;
      } catch (err) {
        try { db.exec('ROLLBACK'); } catch (_) { /* already unwound */ }
        throw err;
      }
    },

    /** A consistent snapshot, safe to take while the service is running. */
    backupTo(file) {
      fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
      db.prepare('VACUUM INTO ?').run(file);
    },
  };
  return api;
}

/** True when an error is one of our two booking-rule indices firing. */
function isConflict(err) {
  const m = String(err && err.message || '');
  return m.includes('UNIQUE constraint failed') ||
         m.includes('one_claim_per_desk_per_day') ||
         m.includes('one_desk_per_person_per_day');
}

module.exports = { open, isConflict };
