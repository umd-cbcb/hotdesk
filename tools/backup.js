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

const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'hotdesk.db');
const outDir = process.env.BACKUP_DIR || path.join(path.dirname(dbPath), '..', 'backups');
const keepArg = process.argv.indexOf('--keep');
const keep = keepArg > -1 ? Number(process.argv[keepArg + 1]) : 14;

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const target = path.join(path.resolve(outDir), `hotdesk-${stamp}.db`);

const db = open(dbPath);
db.backupTo(target);
db.close();

// Prove the snapshot opens and has the tables, so a broken backup is noticed
// now rather than during a restore.
const check = open(target);
const n = check.get('SELECT COUNT(*) AS n FROM claims').n;
check.close();

const size = fs.statSync(target).size;
console.log(`${target}  ${(size / 1024).toFixed(0)}KB  ${n} claims  verified`);

const snapshots = fs.readdirSync(path.resolve(outDir))
  .filter((f) => /^hotdesk-.*\.db$/.test(f)).sort();
for (const old of snapshots.slice(0, Math.max(0, snapshots.length - keep))) {
  fs.unlinkSync(path.join(path.resolve(outDir), old));
  console.log('removed old snapshot ' + old);
}
