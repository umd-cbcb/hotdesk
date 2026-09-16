#!/usr/bin/env node
/**
 * Consistent snapshot of the database, safe to run while the service is up.
 *
 *   node tools/backup.js [--keep 14]
 *
 * VACUUM INTO, not `cp`: copying a live SQLite file can capture a torn page or
 * miss the write-ahead log, producing a backup that only fails when you try to
 * restore it. This is the file the sysadmin should back up, not the live one.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { open } = require('../server/db');

const config = require('../server/config');

const dbPath = config.dbPath;
const outDir = process.env.BACKUP_DIR || path.join(path.dirname(dbPath), '..', 'backups');
const keepArg = process.argv.indexOf('--keep');
const keepRaw = keepArg > -1 ? Number(process.argv[keepArg + 1]) : 14;
// A missing value made this NaN, and slice(0, NaN) silently stopped pruning.
const keep = Number.isFinite(keepRaw) && keepRaw > 0 ? Math.floor(keepRaw) : 14;

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const target = path.join(path.resolve(outDir), `hotdesk-${stamp}.db`);

// mustExist: a wrong DB_PATH would otherwise create an empty database and
// report a perfectly successful backup of nothing, every night, forever.
const db = open(dbPath, { mustExist: true });
db.backupTo(target);
db.close();

// Prove the snapshot opens and has the tables, so a broken backup is noticed
// now rather than during a restore.
const check = open(target, { mustExist: true });
const integrity = check.get('PRAGMA integrity_check');
const verdict = integrity && (integrity.integrity_check || Object.values(integrity)[0]);
if (verdict !== 'ok') {
  check.close();
  console.error('integrity_check on the snapshot said: ' + verdict);
  process.exit(1);
}
const n = check.get('SELECT COUNT(*) AS n FROM claims').n;
check.close();

const size = fs.statSync(target).size;
console.log(`${path.resolve(dbPath)}\n  -> ${target}  ${(size / 1024).toFixed(0)}KB  ` +
            `${n} claims  integrity ok`);

const snapshots = fs.readdirSync(path.resolve(outDir))
  .filter((f) => /^hotdesk-.*\.db$/.test(f)).sort();
for (const old of snapshots.slice(0, Math.max(0, snapshots.length - keep))) {
  fs.unlinkSync(path.join(path.resolve(outDir), old));
  console.log('removed old snapshot ' + old);
}
