#!/usr/bin/env node
/**
 * CBCB Hotdesk server: one process serving both the board and its API.
 *
 * Same origin for page and API, which removes CORS and the mixed-content
 * problem, and is the shape the UMIACS load balancer will front. Everything is
 * base-path agnostic, so it works unchanged at hotdesk.cbcb.umd.edu or under
 * www.cbcb.umd.edu/hotdesk.
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const config = require('./config');
const { open } = require('./db');
const { createApi } = require('./api');
const S = require('./store');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.tsv': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
};

const MAX_BODY = 256 * 1024;

/**
 * The signing secret lives in the database unless one is supplied, so a fresh
 * deploy works without ceremony and sessions survive a restart.
 */
function resolveSecret(db) {
  // An older build kept this in `config`, which adminState returns wholesale to
  // moderators. Move any such value out and delete it on sight.
  const stale = db.get("SELECT value FROM config WHERE key = 'hmacSecret'");
  if (stale && stale.value) {
    S.setServerState(db, 'hmacSecret', stale.value);
    db.run("DELETE FROM config WHERE key = 'hmacSecret'");
    console.warn('[secret] moved hmacSecret out of the config table');
  }
  if (config.secret) return config.secret;

  const existing = S.getServerState(db, 'hmacSecret');
  if (existing) {
    console.warn('[secret] HOTDESK_SECRET is unset; using the one stored in the ' +
                 'database. Sessions survive restarts, but set it in .env.');
    return existing;
  }
  const secret = crypto.randomBytes(48).toString('base64url');
  S.setServerState(db, 'hmacSecret', secret);
  console.warn('[secret] no HOTDESK_SECRET and none stored — generated a new one. ' +
               'Everyone has been signed out. Set HOTDESK_SECRET in .env.');
  return secret;
}

function clientIp(req) {
  if (config.trustProxy) {
    const fwd = req.headers['x-forwarded-for'];
    if (fwd) return String(fwd).split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('Request body too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, payload, status = 200) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    // Same-origin in production, but permissive here keeps the old Pages
    // frontend usable against this server during cutover.
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

function serveStatic(req, res, urlPath) {
  let rel = urlPath === '/' ? '/index.html' : urlPath;
  const full = path.join(config.staticDir, path.normalize(rel));
  // Refuse anything that escapes the static root.
  if (!full.startsWith(path.resolve(config.staticDir))) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  fs.readFile(full, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
      return;
    }
    const ext = path.extname(full).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': data.length,
      // The bundle is small and changes on deploy; never serve a stale board.
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(data);
  });
}

const VERSION = (() => {
  try {
    return require('../package.json').version;
  } catch (err) { return 'unknown'; }
})();

function createServer({ db, api }) {
  return http.createServer(async (req, res) => {
    let urlPath;
    try {
      urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    } catch (err) {
      res.writeHead(400).end('Bad request');
      return;
    }

    // Strip the deployment prefix so the app is identical at any mount point.
    if (config.basePath && urlPath.startsWith(config.basePath)) {
      urlPath = urlPath.slice(config.basePath.length) || '/';
    }

    if (urlPath === '/api') {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '86400',
        }).end();
        return;
      }
      if (req.method === 'GET') {
        sendJson(res, api.dispatch({ action: 'ping' }));
        return;
      }
      if (req.method !== 'POST') {
        sendJson(res, { ok: false, error: 'Use POST.' }, 405);
        return;
      }
      let body;
      try {
        body = JSON.parse((await readBody(req)) || '{}');
      } catch (err) {
        sendJson(res, { ok: false, error: 'Malformed request body.' });
        return;
      }
      body.clientIp = clientIp(req);
      sendJson(res, api.dispatch(body));
      return;
    }

    // The checked-in docs/js/config.js carries a placeholder for the Pages
    // build. Served from here the API is same-origin, so generate it instead
    // and the placeholder never reaches a browser.
    if (urlPath === '/js/config.js') {
      const body = '/* Generated by the hotdesk server; same-origin API. */\n' +
        'window.HOTDESK_CONFIG = ' + JSON.stringify({
          apiUrl: (config.basePath || '') + '/api',
          floorplan: 'assets/floorplan.svg',
        }, null, 2) + ';\n';
      res.writeHead(200, {
        'Content-Type': 'text/javascript; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-cache',
      });
      res.end(body);
      return;
    }

    if (urlPath === '/healthz') {
      // Touch the database: a health check that cannot fail is worthless to the
      // load balancer precisely when the disk is full or the file is corrupt.
      try {
        const n = db.get('SELECT COUNT(*) AS n FROM desks').n;
        sendJson(res, { ok: true, uptime: Math.round(process.uptime()),
                        desks: n, version: VERSION });
      } catch (err) {
        console.error('[healthz]', err);
        sendJson(res, { ok: false, error: 'database unavailable' }, 503);
      }
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end('Method not allowed');
      return;
    }
    serveStatic(req, res, urlPath);
  });
}

function start() {
  const db = open(config.dbPath);
  const secret = resolveSecret(db);
  const api = createApi({ db, secret });
  const server = createServer({ db, api });

  // The sweep also runs lazily on read; this is so desks free up even when
  // nobody opens the board all morning.
  const timer = setInterval(() => {
    try {
      const { cfg, clock } = api.cfgAndClock();
      api.sweepNoShows(cfg, clock);
    } catch (err) {
      console.error('[sweep]', err);
    }
  }, 5 * 60 * 1000);
  timer.unref();

  server.listen(config.port, config.host, () => {
    console.log(`hotdesk listening on http://${config.host}:${config.port}` +
                (config.basePath ? ` (base path ${config.basePath})` : ''));
    console.log(`database ${config.dbPath}`);
  });

  const shutdown = (signal) => {
    console.log(`\n${signal}: shutting down`);
    server.close(() => { db.close(); process.exit(0); });
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  return { server, db, api };
}

module.exports = { createServer, start, resolveSecret };

if (require.main === module) start();
