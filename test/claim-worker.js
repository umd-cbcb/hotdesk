/**
 * One contender in the concurrency test: a separate process with its own SQLite
 * connection, so the contention is real OS-level locking rather than simulated.
 */
'use strict';
const { open } = require('../server/db');
const { createApi } = require('../server/api');

const [dbPath, code, deskId, date, startAtMs] = process.argv.slice(2);
const db = open(dbPath);
const api = createApi({ db, secret: 'test-secret' });

const login = api.dispatch({ action: 'login', code, clientIp: '10.0.0.' + process.pid % 250 });
if (!login.ok) {
  process.stdout.write(JSON.stringify({ ok: false, error: 'login: ' + login.error }));
  process.exit(0);
}

// Everybody swings at the same instant.
const wait = Number(startAtMs) - Date.now();
if (wait > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);

const res = api.dispatch({ action: 'claim', token: login.data.token, date, deskId });
process.stdout.write(JSON.stringify(res));
db.close();
