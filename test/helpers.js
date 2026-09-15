'use strict';
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { open } = require('../server/db');
const { createApi } = require('../server/api');
const { seed } = require('../tools/seed');
const D = require('../server/domain');

/**
 * A live API over a throwaway database, with the clock pinned so tests of the
 * 17:00 release and the 11:00 sweep are not flaky at those times of day.
 */
function makeApi({ at = '2026-09-15T14:00:00-04:00', config = {}, withClaims = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hotdesk-test-'));
  const db = open(path.join(dir, 'test.db'));
  let clockAt = new Date(at);
  const cfg = Object.assign({ timezone: 'America/New_York' }, config);
  const today = D.clock(cfg.timezone, clockAt).date;
  seed(db, { today, withClaims, config: cfg });

  const api = createApi({ db, secret: 'test-secret', now: () => clockAt });
  return {
    db, api, today,
    setNow: (iso) => { clockAt = new Date(iso); },
    call: (body) => api.dispatch(body),
    /** Sign in and return a token, failing loudly if the code is wrong. */
    login(code) {
      const res = api.dispatch({ action: 'login', code, clientIp: '10.0.0.1' });
      if (!res.ok) throw new Error('login failed: ' + res.error);
      return res.data.token;
    },
    cleanup() { db.close(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

/** Unwrap an envelope, failing the test with the server's own message. */
function data(res) {
  if (!res.ok) throw new Error('expected ok, got error: ' + res.error);
  return res.data;
}

function error(res) {
  if (res.ok) throw new Error('expected an error, got ok');
  return res.error;
}

module.exports = { makeApi, data, error };
