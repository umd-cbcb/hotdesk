'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { open } = require('../server/db');

/**
 * These pin the failure that reached production: bootstrap wrote to
 * <app>/data/hotdesk.db while the service read ~/data/hotdesk.db, so the board
 * stayed empty and nothing reported an error.
 */

test('a tool refuses to invent a database at the wrong path', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hotdesk-path-'));
  const missing = path.join(dir, 'nope.db');
  assert.throws(() => open(missing, { mustExist: true }), /No database at/);
  assert.equal(fs.existsSync(missing), false, 'and it did not create one');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('.env supplies DB_PATH to anything that loads the shared config', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hotdesk-env-'));
  const envFile = path.join(dir, 'env');
  const dbPath = path.join(dir, 'service.db');
  fs.writeFileSync(envFile, [
    '# a comment, and a blank line follow',
    '',
    'DB_PATH=' + dbPath,
    'HOTDESK_SECRET="quoted-value"',
  ].join('\n'));

  const out = execFileSync(process.execPath, ['-e',
    'const c = require(' + JSON.stringify(path.join(__dirname, '..', 'server', 'config.js')) + ');' +
    'process.stdout.write(JSON.stringify({db: c.dbPath, secret: c.secret}));'
  ], { encoding: 'utf8',
       env: Object.assign({}, process.env, { HOTDESK_ENV: envFile, DB_PATH: '', HOTDESK_SECRET: '' }) });

  const cfg = JSON.parse(out);
  assert.equal(cfg.db, dbPath, 'the tools land on the service database');
  assert.equal(cfg.secret, 'quoted-value', 'quotes are stripped');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a real environment variable still beats the .env file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hotdesk-env2-'));
  const envFile = path.join(dir, 'env');
  fs.writeFileSync(envFile, 'DB_PATH=/from/file.db\n');
  const out = execFileSync(process.execPath, ['-e',
    'process.stdout.write(require(' +
    JSON.stringify(path.join(__dirname, '..', 'server', 'config.js')) + ').dbPath);'
  ], { encoding: 'utf8',
       env: Object.assign({}, process.env, { HOTDESK_ENV: envFile, DB_PATH: '/from/env.db' }) });
  assert.equal(out, '/from/env.db');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('bootstrap and the server agree on which database they mean', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hotdesk-boot-'));
  const envFile = path.join(dir, 'env');
  const dbPath = path.join(dir, 'service.db');
  fs.writeFileSync(envFile, 'DB_PATH=' + dbPath + '\n');
  const env = Object.assign({}, process.env, { HOTDESK_ENV: envFile, DB_PATH: '' });

  execFileSync(process.execPath,
    [path.join(__dirname, '..', 'tools', 'bootstrap.js'),
     '--moderator', 'boot@umd.edu', '--name', 'Boot'],
    { env, stdio: 'pipe' });

  assert.ok(fs.existsSync(dbPath), 'it wrote where the service reads');
  const db = open(dbPath, { mustExist: true });
  assert.equal(db.get('SELECT COUNT(*) AS n FROM desks').n, 29);
  const who = db.get("SELECT role, active FROM roster WHERE email = 'boot@umd.edu'");
  assert.equal(who.role, 'moderator');
  assert.equal(who.active, 1);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
