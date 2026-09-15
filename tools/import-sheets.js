#!/usr/bin/env node
/**
 * Import the Google Sheet into SQLite.
 *
 *   File > Download > Comma-separated values, once per tab, into one directory:
 *     Config.csv  Roster.csv  Desks.csv  Claims.csv  Audit.csv
 *
 *   node tools/import-sheets.js ~/Downloads/hotdesk-export --db data/hotdesk.db
 *
 * Normalisation matches the Apps Script accessors exactly (people_, desks_,
 * claims_, getConfig_) so the imported rows behave as they did: lowercased
 * emails, `active` defaulting to true, `status` defaulting to active, empty
 * coordinates becoming NULL rather than 0, and times run through the same
 * parser that copes with Sheets' 1899-epoch dates.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const D = require('../server/domain');
const { open } = require('../server/db');
const { parseCsv } = require('../server/csv');

/**
 * Claims dates should already be plain YYYY-MM-DD text, but a sheet created
 * before that column was pinned to text may hand back a formatted date string.
 */
function normalizeDate(value) {
  const text = String(value ?? '').trim();
  if (D.isYmd(text)) return text;
  const m = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(text);
  if (m) return m[0];
  const parsed = new Date(text);
  if (!isNaN(parsed.getTime())) {
    return parsed.getFullYear() + '-' +
           String(parsed.getMonth() + 1).padStart(2, '0') + '-' +
           String(parsed.getDate()).padStart(2, '0');
  }
  return '';
}

function readTab(dir, name) {
  const wanted = name.toLowerCase() + '.csv';
  const file = fs.readdirSync(dir).find((f) => f.toLowerCase() === wanted);
  if (!file) return null;
  const rows = parseCsv(fs.readFileSync(path.join(dir, file), 'utf8'));
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.trim());
  return rows.slice(1).map((cells) => {
    const o = {};
    header.forEach((h, i) => { if (h) o[h] = (cells[i] ?? '').trim(); });
    return o;
  });
}

function main() {
  const args = process.argv.slice(2);
  const dir = args.find((a) => !a.startsWith('--'));
  const dbPath = (args.find((a) => a.startsWith('--db=')) || '').slice(5) ||
                 process.env.DB_PATH || path.join(__dirname, '..', 'data', 'hotdesk.db');
  const force = args.includes('--force');
  if (!dir) {
    console.error(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^\/\*\*?/, ''));
    process.exit(1);
  }

  const db = open(dbPath);
  const existing = db.get('SELECT COUNT(*) AS n FROM roster').n +
                   db.get('SELECT COUNT(*) AS n FROM claims').n;
  if (existing && !force) {
    console.error(`${dbPath} already holds data (${existing} roster+claim rows).\n` +
                  'Re-run with --force to import on top of it.');
    process.exit(1);
  }

  const counts = {};
  db.tx(() => {
    for (const r of readTab(dir, 'Config') || []) {
      const key = String(r.key || '').trim();
      if (!key || key === 'hmacSecret') continue;   // never carry a secret across
      db.run('INSERT INTO config(key, value) VALUES(:k, :v) ' +
             'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
             { k: key, v: D.TIME_KEYS.includes(key)
                 ? (D.normalizeTime(r.value) || String(r.value ?? ''))
                 : String(r.value ?? '') });
      counts.config = (counts.config || 0) + 1;
    }

    for (const r of readTab(dir, 'Roster') || []) {
      const email = String(r.email || '').trim().toLowerCase();
      if (!email) continue;
      db.run('INSERT INTO roster(email, name, code, role, lab, active) ' +
             'VALUES(:e, :n, :c, :r, :l, :a) ' +
             'ON CONFLICT(email) DO UPDATE SET name = excluded.name, code = excluded.code, ' +
             'role = excluded.role, lab = excluded.lab, active = excluded.active',
             { e: email, n: String(r.name || '').trim(),
               c: D.normCode(r.code),
               r: String(r.role || 'student').trim().toLowerCase() === 'moderator'
                  ? 'moderator' : 'student',
               l: String(r.lab || '').trim(),
               // Anything except a literal FALSE is active, as before.
               a: String(r.active ?? 'TRUE').toUpperCase() === 'FALSE' ? 0 : 1 });
      counts.roster = (counts.roster || 0) + 1;
    }

    let sort = 0;
    for (const r of readTab(dir, 'Desks') || []) {
      const deskId = String(r.deskId || '').trim();
      if (!deskId) continue;
      const num = (v) => (String(v ?? '').trim() === '' ? null : Number(v));
      db.run('INSERT INTO desks(desk_id, label, room, x, y, status, reserved_for, notes, sort_key) ' +
             'VALUES(:id, :label, :room, :x, :y, :status, :res, :notes, :sort) ' +
             'ON CONFLICT(desk_id) DO UPDATE SET label = excluded.label, room = excluded.room, ' +
             'x = excluded.x, y = excluded.y, status = excluded.status, ' +
             'reserved_for = excluded.reserved_for, notes = excluded.notes',
             { id: deskId, label: String(r.label || deskId).trim(),
               room: String(r.room || '').trim(), x: num(r.x), y: num(r.y),
               status: String(r.status || 'active').trim().toLowerCase(),
               res: String(r.reservedFor || '').trim().toLowerCase(),
               notes: String(r.notes || '').trim(), sort: sort++ });
      counts.desks = (counts.desks || 0) + 1;
    }

    const skipped = [];
    for (const r of readTab(dir, 'Claims') || []) {
      const claimId = String(r.claimId || '').trim();
      if (!claimId) continue;
      const date = normalizeDate(r.date);
      const email = String(r.email || '').trim().toLowerCase();
      const deskId = String(r.deskId || '').trim();
      // The foreign keys are the point of moving to a database; a claim whose
      // desk or person no longer exists is exactly the orphan the sheet hid.
      const known = db.get('SELECT 1 AS n FROM roster WHERE email = :e', { e: email }) &&
                    db.get('SELECT 1 AS n FROM desks WHERE desk_id = :d', { d: deskId });
      if (!known || !D.isYmd(date)) { skipped.push({ claimId, date, deskId, email }); continue; }
      db.run('INSERT INTO claims(claim_id, date, desk_id, email, claimed_at, ' +
             'checked_in_at, released_at, status) VALUES(:id, :d, :k, :e, :t, :ci, :rl, :s) ' +
             'ON CONFLICT(claim_id) DO NOTHING',
             { id: claimId, d: date, k: deskId, e: email,
               t: String(r.claimedAt || '').trim(),
               ci: String(r.checkedInAt || '').trim(),
               rl: String(r.releasedAt || '').trim(),
               s: ['active', 'released', 'noshow']
                    .includes(String(r.status || '').trim().toLowerCase())
                  ? String(r.status).trim().toLowerCase() : 'released' });
      counts.claims = (counts.claims || 0) + 1;
    }
    counts.skippedClaims = skipped;

    for (const r of readTab(dir, 'Audit') || []) {
      if (!String(r.action || '').trim()) continue;
      db.run('INSERT INTO audit(timestamp, actor, action, detail) VALUES(:t, :a, :c, :d)',
             { t: String(r.timestamp || '').trim(), a: String(r.actor || '').trim(),
               c: String(r.action).trim(), d: String(r.detail || '').trim() });
      counts.audit = (counts.audit || 0) + 1;
    }
  });

  console.log('Imported into ' + dbPath);
  for (const key of ['config', 'roster', 'desks', 'claims', 'audit']) {
    console.log(`  ${key.padEnd(8)} ${counts[key] || 0}`);
  }
  const skipped = counts.skippedClaims || [];
  if (skipped.length) {
    console.log(`\n  ${skipped.length} claim(s) skipped — they referenced a desk or a`);
    console.log('  person that no longer exists. These were invisible orphans in the');
    console.log('  sheet, still counting against a one-desk-per-day limit:');
    for (const s of skipped.slice(0, 10)) {
      console.log(`    ${s.claimId}  ${s.date}  ${s.deskId}  ${s.email}`);
    }
    if (skipped.length > 10) console.log(`    ... and ${skipped.length - 10} more`);
  }
  db.close();
}

if (require.main === module) main();
