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
  // How many trusted proxies sit in front of us; 1 for the UMIACS load
  // balancer. Read as a hop count so X-Forwarded-For can be walked from the
  // right, where entries our own proxy added live. `true`/`yes` means 1.
  trustProxy: (() => {
    const raw = String(process.env.TRUST_PROXY ?? '').trim().toLowerCase();
    if (raw === '' || raw === '0' || raw === 'false' || raw === 'no') return 0;
    if (raw === 'true' || raw === 'yes') return 1;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  })(),
  basePath: basePath(process.env.BASE_PATH),
  // The signing secret. Generated and persisted into the database on first run
  // if unset, so a fresh deploy works without ceremony.
  secret: process.env.HOTDESK_SECRET || '',

  // Sign in with Google. The client id is not a secret — it ships to the
  // browser so the button can render. Leave unset to run on access codes alone.
  googleClientId: (process.env.GOOGLE_CLIENT_ID || '').trim(),
  // Optional belt-and-braces. The roster is the real allowlist, so leaving this
  // empty is fine and lets a visitor sign in with any Google account you have
  // put on the roster.
  googleAllowedDomains: (process.env.GOOGLE_ALLOWED_DOMAINS || '')
    .split(',').map((d) => d.trim().toLowerCase()).filter(Boolean),
};
