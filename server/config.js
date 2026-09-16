/** Environment configuration. Every value has a working default for local dev. */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Load <repo>/.env if it exists.
 *
 * The systemd unit already reads this file, so having the tools read it too is
 * what stops them drifting onto a different database from the service. They did
 * exactly that once: bootstrap wrote a second, unread copy while the running
 * server kept serving an empty one, and nothing reported an error.
 *
 * A real environment variable always wins over the file.
 */
(function loadEnvFile() {
  const file = process.env.HOTDESK_ENV || path.join(__dirname, '..', '.env');
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (err) { return; }
  for (const line of text.split('\n')) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    // An empty variable counts as unset: systemd and shells both hand one
    // through, and it should not shadow a real value in the file.
    if (process.env[m[1]] !== undefined && process.env[m[1]] !== '') continue;
    process.env[m[1]] = m[2].trim().replace(/^(['"])([\s\S]*)\1$/, '$2');
  }
})();

const bool = (v, dflt) =>
  v === undefined ? dflt : !['0', 'false', 'no', ''].includes(String(v).toLowerCase());

/** Normalise to '' or '/prefix' — never a trailing slash. */
function basePath(v) {
  const p = String(v || '').trim().replace(/\/+$/, '');
  if (!p) return '';
  return p.startsWith('/') ? p : '/' + p;
}

module.exports = {
  port: Number(process.env.PORT || 8080),
  host: process.env.HOST || '0.0.0.0',
  dbPath: process.env.DB_PATH || path.join(__dirname, '..', 'data', 'hotdesk.db'),
  staticDir: process.env.STATIC_DIR || path.join(__dirname, '..', 'docs'),
  // Set when the UMIACS load balancer fronts us, so client addresses are read
  // from X-Forwarded-For instead of the socket (which would be the balancer).
  trustProxy: bool(process.env.TRUST_PROXY, false),
  basePath: basePath(process.env.BASE_PATH),
  // The signing secret. Generated and persisted into the database on first run
  // if unset, so a fresh deploy works without ceremony.
  secret: process.env.HOTDESK_SECRET || '',
};
