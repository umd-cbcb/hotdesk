/**
 * CBCB Hotdesk — Apps Script backend.
 *
 * Deploy this from the Google Sheet that holds the data:
 *   Extensions > Apps Script, paste this file, then Deploy > New deployment
 *   > Web app, "Execute as: Me", "Who has access: Anyone".
 * Run setupSheets() once from the editor to create the tabs.
 *
 * Everything the students must not see (access codes, the roster, the write
 * rules) stays here. The GitHub Pages frontend only ever holds the web app URL.
 *
 * PERMISSIONS — appsscript.json pins two OAuth scopes deliberately. Left
 * undeclared, Apps Script infers the widest scope that could cover this code and
 * asks you to approve "See, edit, create, and delete ALL your Google Sheets
 * spreadsheets", which is far more than this needs.
 *
 *   spreadsheets.currentonly  this sheet only, nothing else in your Drive
 *   script.scriptapp          the daily no-show sweep trigger
 *
 * The narrow Sheets scope is accurate because every read and write goes through
 * SpreadsheetApp.getActiveSpreadsheet() below — there is no openById, no
 * openByUrl, and no Drive access anywhere in this file. If you add any of those,
 * the narrow scope will stop being enough and you will have to widen it.
 *
 * The manifest itself cannot carry this note: Apps Script rejects any field it
 * does not recognise, including the "//" comment convention.
 */

const SHEETS = {
  config: 'Config',
  roster: 'Roster',
  desks: 'Desks',
  claims: 'Claims',
  audit: 'Audit',
};

const DEFAULT_CONFIG = {
  siteTitle: 'CBCB Hotdesk',
  timezone: 'America/New_York',
  releaseTime: '17:00',      // claims for the far edge of the horizon open at this time
  horizonDays: '1',          // 1 = "tomorrow opens at releaseTime today"
  maxOpenClaims: '3',        // cap on future (not-yet-arrived) active claims per person
  checkInDeadline: '11:00',  // unclaimed-by-then desks are auto-released
  checkInEnabled: 'TRUE',
  allowSameDayClaim: 'TRUE',
  noticeText: '',
};

/* -------------------------------------------------------------------------- */
/* HTTP entry points                                                          */
/* -------------------------------------------------------------------------- */

function doGet(e) {
  // Health check / sanity ping, and a GET fallback for `state` so the board can
  // be loaded without a preflight-triggering request.
  const action = (e && e.parameter && e.parameter.action) || 'ping';
  return respond_(function () {
    if (action === 'ping') return { ok: true, service: 'cbcb-hotdesk', version: 1 };
    return dispatch_(action, e.parameter || {});
  });
}

function doPost(e) {
  return respond_(function () {
    let body = {};
    try {
      body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    } catch (err) {
      throw new UserError('Malformed request body.');
    }
    return dispatch_(body.action, body);
  });
}

function dispatch_(action, p) {
  switch (action) {
    case 'ping':          return { ok: true };
    case 'login':         return apiLogin_(p);
    case 'state':         return apiState_(p);
    case 'claim':         return apiClaim_(p);
    case 'release':       return apiRelease_(p);
    case 'checkin':       return apiCheckIn_(p);
    case 'adminState':    return apiAdminState_(p);
    case 'adminSetConfig':return apiAdminSetConfig_(p);
    case 'adminSaveDesk': return apiAdminSaveDesk_(p);
    case 'adminSavePerson': return apiAdminSavePerson_(p);
    case 'adminForceRelease': return apiAdminForceRelease_(p);
    default:
      throw new UserError('Unknown action: ' + action);
  }
}

function UserError(message) { this.message = message; this.isUserError = true; }

function respond_(fn) {
  let payload;
  try {
    payload = { ok: true, data: fn() };
  } catch (err) {
    payload = { ok: false, error: err && err.message ? err.message : String(err) };
    if (!(err && err.isUserError)) console.error(err);
  }
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

/* -------------------------------------------------------------------------- */
/* Sheet helpers                                                              */
/* -------------------------------------------------------------------------- */

function book_() { return SpreadsheetApp.getActiveSpreadsheet(); }

function sheet_(name) {
  const sh = book_().getSheetByName(name);
  if (!sh) throw new UserError('Missing sheet tab "' + name + '". Run setupSheets() once.');
  return sh;
}

function readRows_(name) {
  const values = sheet_(name).getDataRange().getValues();
  if (values.length < 2) return [];
  const header = values[0].map(function (h) { return String(h).trim(); });
  const out = [];
  for (let i = 1; i < values.length; i++) {
    const raw = values[i];
    if (!raw.some(function (c) { return c !== '' && c !== null; })) continue;
    const obj = { _row: i + 1 };
    header.forEach(function (h, j) { if (h) obj[h] = raw[j]; });
    out.push(obj);
  }
  return out;
}

function writeCells_(name, row, updates) {
  const sh = sheet_(name);
  const header = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0]
    .map(function (h) { return String(h).trim(); });
  Object.keys(updates).forEach(function (key) {
    const col = header.indexOf(key);
    if (col < 0) throw new Error('No column "' + key + '" on ' + name);
    sh.getRange(row, col + 1).setValue(updates[key]);
  });
}

function appendRow_(name, obj) {
  const sh = sheet_(name);
  const header = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0]
    .map(function (h) { return String(h).trim(); });
  sh.appendRow(header.map(function (h) {
    return Object.prototype.hasOwnProperty.call(obj, h) ? obj[h] : '';
  }));
}

function audit_(actor, action, detail) {
  try {
    appendRow_(SHEETS.audit, {
      timestamp: new Date().toISOString(), actor: actor, action: action,
      detail: typeof detail === 'string' ? detail : JSON.stringify(detail),
    });
  } catch (err) { /* auditing must never break a booking */ }
}

/* -------------------------------------------------------------------------- */
/* Config + time                                                              */
/* -------------------------------------------------------------------------- */

function getConfig_() {
  const cfg = {};
  Object.keys(DEFAULT_CONFIG).forEach(function (k) { cfg[k] = DEFAULT_CONFIG[k]; });
  readRows_(SHEETS.config).forEach(function (r) {
    const key = String(r.key || '').trim();
    if (key) cfg[key] = String(r.value === undefined || r.value === null ? '' : r.value).trim();
  });
  cfg.horizonDays = Math.max(0, parseInt(cfg.horizonDays, 10) || 0);
  cfg.maxOpenClaims = Math.max(1, parseInt(cfg.maxOpenClaims, 10) || 1);
  cfg.checkInEnabled = String(cfg.checkInEnabled).toUpperCase() !== 'FALSE';
  cfg.allowSameDayClaim = String(cfg.allowSameDayClaim).toUpperCase() !== 'FALSE';
  return cfg;
}

function minutesOfDay_(hhmm, fallback) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
  if (!m) return fallback;
  return Number(m[1]) * 60 + Number(m[2]);
}

function clock_(cfg) {
  const tz = cfg.timezone || Session.getScriptTimeZone();
  const now = new Date();
  return {
    tz: tz,
    date: Utilities.formatDate(now, tz, 'yyyy-MM-dd'),
    minutes: Number(Utilities.formatDate(now, tz, 'H')) * 60 +
             Number(Utilities.formatDate(now, tz, 'm')),
    iso: now.toISOString(),
  };
}

function addDays_(ymd, n) {
  const p = String(ymd).split('-').map(Number);
  const d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function dayDiff_(a, b) {
  const toUTC = function (s) {
    const p = String(s).split('-').map(Number);
    return Date.UTC(p[0], p[1] - 1, p[2]);
  };
  return Math.round((toUTC(a) - toUTC(b)) / 86400000);
}

/**
 * A day D opens for claiming at `releaseTime` on day (D - horizonDays).
 * With horizonDays = 1 that reads exactly as "tomorrow unlocks at 5pm today".
 */
function windowFor_(cfg, date, now) {
  const delta = dayDiff_(date, now.date);
  if (delta < 0) return { claimable: false, reason: 'past' };
  if (delta === 0) {
    return cfg.allowSameDayClaim
      ? { claimable: true, reason: 'walkup' }
      : { claimable: false, reason: 'closed' };
  }
  if (delta > cfg.horizonDays) {
    return {
      claimable: false, reason: 'not_yet',
      opensOn: addDays_(date, -cfg.horizonDays), opensAt: cfg.releaseTime,
    };
  }
  if (delta === cfg.horizonDays &&
      now.minutes < minutesOfDay_(cfg.releaseTime, 17 * 60)) {
    return { claimable: false, reason: 'not_yet', opensOn: now.date, opensAt: cfg.releaseTime };
  }
  return { claimable: true, reason: 'open' };
}

/* -------------------------------------------------------------------------- */
/* Auth                                                                        */
/* -------------------------------------------------------------------------- */

function secret_() {
  const props = PropertiesService.getScriptProperties();
  let s = props.getProperty('HMAC_SECRET');
  if (!s) {
    s = Utilities.getUuid() + Utilities.getUuid();
    props.setProperty('HMAC_SECRET', s);
  }
  return s;
}

function mintToken_(email) {
  const payload = email.toLowerCase() + '|' + (Date.now() + 30 * 86400000);
  const sig = Utilities.base64EncodeWebSafe(
    Utilities.computeHmacSha256Signature(payload, secret_()));
  return Utilities.base64EncodeWebSafe(payload) + '.' + sig;
}

function emailFromToken_(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 2) return null;
  let payload;
  try {
    payload = Utilities.newBlob(Utilities.base64DecodeWebSafe(parts[0])).getDataAsString();
  } catch (err) { return null; }
  const expected = Utilities.base64EncodeWebSafe(
    Utilities.computeHmacSha256Signature(payload, secret_()));
  if (expected !== parts[1]) return null;
  const bits = payload.split('|');
  if (Number(bits[1]) < Date.now()) return null;
  return bits[0];
}

function normCode_(s) {
  return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function people_() {
  return readRows_(SHEETS.roster).map(function (r) {
    return {
      _row: r._row,
      email: String(r.email || '').trim().toLowerCase(),
      name: String(r.name || '').trim(),
      code: normCode_(r.code),
      role: String(r.role || 'student').trim().toLowerCase(),
      lab: String(r.lab || '').trim(),
      active: String(r.active === undefined ? 'TRUE' : r.active).toUpperCase() !== 'FALSE',
    };
  }).filter(function (p) { return p.email; });
}

function requireUser_(p) {
  const email = emailFromToken_(p.token);
  if (!email) throw new UserError('Your session expired. Please sign in again.');
  const found = people_().filter(function (x) { return x.email === email; })[0];
  if (!found || !found.active) throw new UserError('Your account is no longer active.');
  return found;
}

function requireModerator_(p) {
  const user = requireUser_(p);
  if (user.role !== 'moderator') throw new UserError('Moderators only.');
  return user;
}

function publicUser_(u) {
  return { email: u.email, name: u.name, role: u.role, lab: u.lab };
}

/**
 * The web app URL is public (it has to be, for a static site to reach it), so
 * the access code is the only thing standing in front of the roster. A six
 * character code from a 32 letter alphabet is ~1e9 combinations, which is fine
 * against a human but not against a script, so failures are also throttled
 * globally: 20 wrong codes in 10 minutes and logins stop for everyone until the
 * window rolls over. Legitimate students are not typing 20 wrong codes.
 */
const LOGIN_FAIL_LIMIT = 20;
const LOGIN_FAIL_WINDOW_SECONDS = 600;

function loginFailures_() {
  const cache = CacheService.getScriptCache();
  return Number(cache.get('login_failures') || 0);
}

function noteLoginFailure_() {
  const cache = CacheService.getScriptCache();
  const next = loginFailures_() + 1;
  cache.put('login_failures', String(next), LOGIN_FAIL_WINDOW_SECONDS);
  if (next === LOGIN_FAIL_LIMIT) audit_('system', 'login_lockout', next + ' failures');
  return next;
}

function apiLogin_(p) {
  if (loginFailures_() >= LOGIN_FAIL_LIMIT) {
    throw new UserError('Too many failed sign-ins. Try again in a few minutes.');
  }
  const code = normCode_(p.code);
  if (code.length < 4) throw new UserError('Enter your access code.');
  const matches = people_().filter(function (x) { return x.active && x.code && x.code === code; });
  if (matches.length !== 1) {
    noteLoginFailure_();
    Utilities.sleep(700);
    throw new UserError('That code was not recognised.');
  }
  audit_(matches[0].email, 'login', '');
  return { token: mintToken_(matches[0].email), user: publicUser_(matches[0]) };
}

/* -------------------------------------------------------------------------- */
/* Desks and claims                                                            */
/* -------------------------------------------------------------------------- */

function desks_() {
  return readRows_(SHEETS.desks).map(function (r) {
    return {
      _row: r._row,
      deskId: String(r.deskId || '').trim(),
      label: String(r.label || r.deskId || '').trim(),
      room: String(r.room || '').trim(),
      x: r.x === '' || r.x === null || r.x === undefined ? null : Number(r.x),
      y: r.y === '' || r.y === null || r.y === undefined ? null : Number(r.y),
      status: String(r.status || 'active').trim().toLowerCase(),
      reservedFor: String(r.reservedFor || '').trim().toLowerCase(),
      notes: String(r.notes || '').trim(),
    };
  }).filter(function (d) { return d.deskId; });
}

function claims_() {
  return readRows_(SHEETS.claims).map(function (r) {
    return {
      _row: r._row,
      claimId: String(r.claimId || '').trim(),
      // The date column is forced to plain text by setupSheets(). This branch is
      // only a safety net for sheets edited by hand, where Sheets may coerce the
      // string into a Date at midnight in the *spreadsheet's* timezone.
      date: r.date instanceof Date
        ? Utilities.formatDate(r.date, book_().getSpreadsheetTimeZone(), 'yyyy-MM-dd')
        : String(r.date || '').trim(),
      deskId: String(r.deskId || '').trim(),
      email: String(r.email || '').trim().toLowerCase(),
      claimedAt: String(r.claimedAt || '').trim(),
      checkedInAt: String(r.checkedInAt || '').trim(),
      releasedAt: String(r.releasedAt || '').trim(),
      status: String(r.status || 'active').trim().toLowerCase(),
    };
  }).filter(function (c) { return c.claimId; });
}

/**
 * Auto-release today's claims that were never checked in by the deadline.
 * Runs lazily on read (so it is correct even if the time trigger misfires) and
 * from a daily trigger (so desks free up even if nobody loads the page).
 */
function sweepNoShows_(cfg, now, allClaims) {
  if (!cfg.checkInEnabled) return allClaims;
  if (now.minutes < minutesOfDay_(cfg.checkInDeadline, 11 * 60)) return allClaims;
  allClaims.forEach(function (c) {
    if (c.status !== 'active' || c.date !== now.date || c.checkedInAt) return;
    c.status = 'noshow';
    c.releasedAt = now.iso;
    writeCells_(SHEETS.claims, c._row, { status: 'noshow', releasedAt: now.iso });
    audit_('system', 'noshow', c.claimId + ' ' + c.deskId + ' ' + c.email);
  });
  return allClaims;
}

function sweepNoShowsTrigger() {
  const cfg = getConfig_();
  sweepNoShows_(cfg, clock_(cfg), claims_());
}

function isActive_(c) { return c.status === 'active'; }

function reliabilityFor_(allClaims, email) {
  let honoured = 0, missed = 0;
  allClaims.forEach(function (c) {
    if (c.email !== email) return;
    if (c.status === 'noshow') missed++;
    else if (c.checkedInAt) honoured++;
  });
  return { honoured: honoured, missed: missed };
}

function apiState_(p) {
  const user = requireUser_(p);
  const cfg = getConfig_();
  const now = clock_(cfg);
  const all = sweepNoShows_(cfg, now, claims_());
  const allDesks = desks_();
  const roster = people_();
  const nameOf = {};
  roster.forEach(function (r) { nameOf[r.email] = r.name; });

  const span = cfg.horizonDays + 1;
  const days = [];
  for (let i = 0; i < span + 1; i++) {
    const date = addDays_(now.date, i);
    const win = windowFor_(cfg, date, now);
    const onDay = all.filter(function (c) { return c.date === date && isActive_(c); });
    days.push({
      date: date,
      window: win,
      claims: onDay.map(function (c) {
        return {
          claimId: c.claimId, deskId: c.deskId, email: c.email,
          name: nameOf[c.email] || c.email,
          checkedIn: !!c.checkedInAt,
          mine: c.email === user.email,
        };
      }),
    });
  }

  const myOpen = all.filter(function (c) {
    return c.email === user.email && isActive_(c) && dayDiff_(c.date, now.date) > 0;
  }).length;

  return {
    user: publicUser_(user),
    config: {
      siteTitle: cfg.siteTitle, timezone: cfg.timezone, releaseTime: cfg.releaseTime,
      horizonDays: cfg.horizonDays, maxOpenClaims: cfg.maxOpenClaims,
      checkInDeadline: cfg.checkInDeadline, checkInEnabled: cfg.checkInEnabled,
      allowSameDayClaim: cfg.allowSameDayClaim, noticeText: cfg.noticeText,
    },
    now: { date: now.date, minutes: now.minutes, timezone: now.tz },
    desks: allDesks.map(function (d) {
      return {
        deskId: d.deskId, label: d.label, room: d.room, x: d.x, y: d.y,
        status: d.status, notes: d.notes,
        reservedFor: d.reservedFor,
        reservedForName: d.reservedFor ? (nameOf[d.reservedFor] || d.reservedFor) : '',
      };
    }),
    days: days,
    me: { openClaims: myOpen, reliability: reliabilityFor_(all, user.email) },
  };
}

function apiClaim_(p) {
  const user = requireUser_(p);
  const date = String(p.date || '').trim();
  const deskId = String(p.deskId || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new UserError('Pick a valid date.');

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) throw new UserError('The system is busy. Try again in a moment.');
  try {
    const cfg = getConfig_();
    const now = clock_(cfg);
    const win = windowFor_(cfg, date, now);
    if (!win.claimable) {
      throw new UserError(win.reason === 'past'
        ? 'That day has already passed.'
        : 'Claiming for ' + date + ' is not open yet.');
    }

    const desk = desks_().filter(function (d) { return d.deskId === deskId; })[0];
    if (!desk) throw new UserError('No such desk.');
    if (desk.status !== 'active') throw new UserError(desk.label + ' is out of service.');
    if (desk.reservedFor && desk.reservedFor !== user.email) {
      throw new UserError(desk.label + ' is reserved for someone else.');
    }

    const all = sweepNoShows_(cfg, now, claims_());
    const taken = all.filter(function (c) {
      return c.date === date && c.deskId === deskId && isActive_(c);
    })[0];
    if (taken) {
      throw new UserError(taken.email === user.email
        ? 'You already have that desk.'
        : desk.label + ' was just claimed by someone else.');
    }

    const mineThatDay = all.filter(function (c) {
      return c.date === date && c.email === user.email && isActive_(c);
    })[0];
    if (mineThatDay) throw new UserError('You already hold a desk on ' + date + '.');

    if (dayDiff_(date, now.date) > 0) {
      const openCount = all.filter(function (c) {
        return c.email === user.email && isActive_(c) && dayDiff_(c.date, now.date) > 0;
      }).length;
      if (openCount >= cfg.maxOpenClaims) {
        throw new UserError('You already hold ' + cfg.maxOpenClaims +
          ' upcoming days, which is the limit. Release one first.');
      }
    }

    const claimId = Utilities.getUuid().slice(0, 8);
    const sameDay = dayDiff_(date, now.date) === 0;
    appendRow_(SHEETS.claims, {
      claimId: claimId, date: date, deskId: deskId, email: user.email,
      claimedAt: now.iso,
      // A walk-up claim is self-evidently a check-in: you are standing there.
      checkedInAt: sameDay ? now.iso : '',
      releasedAt: '', status: 'active',
    });
    audit_(user.email, 'claim', date + ' ' + deskId);
    return { claimId: claimId };
  } finally {
    lock.releaseLock();
  }
}

function apiRelease_(p) {
  const user = requireUser_(p);
  return releaseClaim_(p.claimId, user, false);
}

function apiAdminForceRelease_(p) {
  const mod = requireModerator_(p);
  return releaseClaim_(p.claimId, mod, true);
}

function releaseClaim_(claimId, actor, force) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) throw new UserError('The system is busy. Try again in a moment.');
  try {
    const c = claims_().filter(function (x) { return x.claimId === String(claimId || '').trim(); })[0];
    if (!c) throw new UserError('No such claim.');
    if (!force && c.email !== actor.email) throw new UserError('That is not your claim.');
    if (!isActive_(c)) return { released: false };
    const iso = new Date().toISOString();
    writeCells_(SHEETS.claims, c._row, { status: 'released', releasedAt: iso });
    audit_(actor.email, force ? 'force_release' : 'release', c.date + ' ' + c.deskId + ' ' + c.email);
    return { released: true };
  } finally {
    lock.releaseLock();
  }
}

function apiCheckIn_(p) {
  const user = requireUser_(p);
  const cfg = getConfig_();
  const now = clock_(cfg);
  const c = claims_().filter(function (x) {
    return x.claimId === String(p.claimId || '').trim();
  })[0];
  if (!c) throw new UserError('No such claim.');
  if (c.email !== user.email) throw new UserError('That is not your claim.');
  if (c.date !== now.date) throw new UserError('You can only check in on the day itself.');
  if (!isActive_(c)) throw new UserError('That claim is no longer active.');
  if (c.checkedInAt) return { checkedIn: true };
  writeCells_(SHEETS.claims, c._row, { checkedInAt: now.iso });
  audit_(user.email, 'checkin', c.date + ' ' + c.deskId);
  return { checkedIn: true };
}

/* -------------------------------------------------------------------------- */
/* Moderator surface                                                           */
/* -------------------------------------------------------------------------- */

function apiAdminState_(p) {
  requireModerator_(p);
  const cfg = getConfig_();
  const now = clock_(cfg);
  const all = claims_();
  const roster = people_();
  return {
    config: cfg,
    desks: desks_(),
    roster: roster.map(function (r) {
      const rel = reliabilityFor_(all, r.email);
      return {
        email: r.email, name: r.name, role: r.role, lab: r.lab, active: r.active,
        code: r.code, honoured: rel.honoured, missed: rel.missed,
      };
    }),
    upcoming: all.filter(function (c) {
      return isActive_(c) && dayDiff_(c.date, now.date) >= 0;
    }),
  };
}

function apiAdminSetConfig_(p) {
  const mod = requireModerator_(p);
  const updates = p.updates || {};
  const sh = sheet_(SHEETS.config);
  const rows = readRows_(SHEETS.config);
  Object.keys(updates).forEach(function (key) {
    const existing = rows.filter(function (r) { return String(r.key).trim() === key; })[0];
    if (existing) writeCells_(SHEETS.config, existing._row, { value: updates[key] });
    else sh.appendRow([key, updates[key]]);
  });
  audit_(mod.email, 'config', updates);
  if (Object.prototype.hasOwnProperty.call(updates, 'checkInDeadline')) installTriggers_();
  return { saved: Object.keys(updates).length };
}

function apiAdminSaveDesk_(p) {
  const mod = requireModerator_(p);
  const d = p.desk || {};
  const deskId = String(d.deskId || '').trim();
  if (!deskId) throw new UserError('deskId is required.');
  const fields = {
    deskId: deskId,
    label: String(d.label || deskId).trim(),
    room: String(d.room || '').trim(),
    x: d.x === null || d.x === undefined || d.x === '' ? '' : Number(d.x),
    y: d.y === null || d.y === undefined || d.y === '' ? '' : Number(d.y),
    status: String(d.status || 'active').trim().toLowerCase(),
    reservedFor: String(d.reservedFor || '').trim().toLowerCase(),
    notes: String(d.notes || '').trim(),
  };
  const existing = desks_().filter(function (x) { return x.deskId === deskId; })[0];
  if (existing) writeCells_(SHEETS.desks, existing._row, fields);
  else appendRow_(SHEETS.desks, fields);
  audit_(mod.email, 'save_desk', deskId);
  return { saved: deskId };
}

function apiAdminSavePerson_(p) {
  const mod = requireModerator_(p);
  const person = p.person || {};
  const email = String(person.email || '').trim().toLowerCase();
  if (!email) throw new UserError('email is required.');
  const existing = people_().filter(function (x) { return x.email === email; })[0];
  const code = normCode_(person.code) || (existing && existing.code) || makeCode_();
  const fields = {
    email: email,
    name: String(person.name || '').trim(),
    code: code,
    role: String(person.role || 'student').trim().toLowerCase(),
    lab: String(person.lab || '').trim(),
    active: person.active === false ? 'FALSE' : 'TRUE',
  };
  if (existing) writeCells_(SHEETS.roster, existing._row, fields);
  else appendRow_(SHEETS.roster, fields);
  audit_(mod.email, 'save_person', email);
  return { saved: email, code: code };
}

function makeCode_() {
  // Ambiguous glyphs removed: these get read aloud and typed on phones.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 6; i++) {
    out += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* One-time setup                                                              */
/* -------------------------------------------------------------------------- */

function setupSheets() {
  const book = book_();
  const spec = [
    [SHEETS.config, ['key', 'value']],
    [SHEETS.roster, ['email', 'name', 'code', 'role', 'lab', 'active']],
    [SHEETS.desks, ['deskId', 'label', 'room', 'x', 'y', 'status', 'reservedFor', 'notes']],
    [SHEETS.claims, ['claimId', 'date', 'deskId', 'email', 'claimedAt', 'checkedInAt', 'releasedAt', 'status']],
    [SHEETS.audit, ['timestamp', 'actor', 'action', 'detail']],
  ];
  spec.forEach(function (entry) {
    const name = entry[0], header = entry[1];
    let sh = book.getSheetByName(name);
    if (!sh) sh = book.insertSheet(name);
    sh.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');
    sh.setFrozenRows(1);
    if (name === SHEETS.claims) {
      // Otherwise Sheets turns "2026-08-21" into a Date and reading it back
      // depends on which timezone you ask, which is exactly one off-by-one-day
      // bug waiting to happen.
      sh.getRange('B:B').setNumberFormat('@');
    }
  });

  const cfg = book.getSheetByName(SHEETS.config);
  if (cfg.getLastRow() < 2) {
    const rows = Object.keys(DEFAULT_CONFIG).map(function (k) { return [k, DEFAULT_CONFIG[k]]; });
    cfg.getRange(2, 1, rows.length, 2).setValues(rows);
  }

  const roster = book.getSheetByName(SHEETS.roster);
  if (roster.getLastRow() < 2) {
    // Under the pinned narrow scopes this can come back empty; seeding a
    // placeholder is better than failing setup over a convenience.
    let me = '';
    try { me = Session.getActiveUser().getEmail() || ''; } catch (err) { me = ''; }
    roster.appendRow([me || 'you@umd.edu', 'Me', makeCode_(), 'moderator', '', 'TRUE']);
  }

  secret_();
  installTriggers_();
  var done = 'Setup complete.\n\nYour moderator code is in the Roster tab — check\n' +
    'that the email on that row is yours before you sign in.\n\n' +
    'Next: Deploy > New deployment > Web app (Execute as Me, Access: Anyone).';
  console.log(done);
  try { SpreadsheetApp.getUi().alert(done); } catch (err) { /* no UI when run headless */ }
}

function installTriggers_() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'sweepNoShowsTrigger') ScriptApp.deleteTrigger(t);
  });
  const cfg = getConfig_();
  const hour = Math.floor(minutesOfDay_(cfg.checkInDeadline, 11 * 60) / 60);
  ScriptApp.newTrigger('sweepNoShowsTrigger').timeBased().atHour(hour).everyDays(1).create();
}
