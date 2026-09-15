/** Environment configuration. Every value has a working default for local dev. */
'use strict';

const path = require('node:path');

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
