#!/usr/bin/env node
/**
 * Local development: the real server, against a throwaway seeded database.
 *
 * This is the same process that runs on the VM — only the database and the
 * demo data differ — so "works locally" is a claim about the deployment, not
 * just about a laptop.
 */
'use strict';

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const dir = process.env.DEV_DIR ||
  fs.mkdtempSync(path.join(os.tmpdir(), 'hotdesk-dev-'));
process.env.DB_PATH = process.env.DB_PATH || path.join(dir, 'dev.db');
process.env.PORT = process.env.PORT || '8080';
process.env.HOTDESK_SECRET = process.env.HOTDESK_SECRET || 'dev-secret-not-for-production';

const fresh = !fs.existsSync(process.env.DB_PATH);

const { open } = require('../server/db');
const { seed, PEOPLE } = require('./seed');
const D = require('../server/domain');

if (fresh) {
  const db = open(process.env.DB_PATH);
  seed(db, { today: D.clock('America/New_York').date });
  db.close();
}

const { start } = require('../server/index');
start();

console.log('\n  demo data — sign in with any of these codes:\n');
for (const p of PEOPLE) {
  console.log('    ' + p.code + '   ' + p.name +
              (p.role === 'moderator' ? '  (moderator)' : ''));
}
console.log('\n  database: ' + process.env.DB_PATH +
            (fresh ? '  (seeded)' : '  (reused)') + '\n');
