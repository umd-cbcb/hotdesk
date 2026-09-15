/**
 * Pure booking rules. No I/O, no database, no clock of its own beyond what is
 * passed in — so every rule below is directly testable.
 *
 * Ported from apps-script/Code.gs: windowFor_ (:281), sweepNoShows_ (:464),
 * reliabilityFor_ (:484) and normalizeTime_ (:179). Behaviour is deliberately
 * identical; where the old implementation was wrong the fix is called out.
 */
'use strict';

const TIME_KEYS = ['releaseTime', 'checkInDeadline'];

const DEFAULT_CONFIG = {
  siteTitle: 'CBCB Hotdesk',
  timezone: 'America/New_York',
  releaseTime: '17:00',
  horizonDays: '1',
  maxOpenClaims: '3',
  checkInDeadline: '11:00',
  checkInEnabled: 'TRUE',
  allowSameDayClaim: 'TRUE',
  noticeText: '',
};

const pad2 = (n) => (n < 10 ? '0' : '') + n;

/**
 * Google Sheets turned a typed "17:00" into a time value on the 1899 epoch, so
 * this has to accept a Date as well as the sensible forms. Kept for the CSV
 * import path, where those values still arrive.
 */
function normalizeTime(value) {
  if (value === null || value === undefined || value === '') return '';

  if (Object.prototype.toString.call(value) === '[object Date]') {
    return pad2(value.getHours()) + ':' + pad2(value.getMinutes());
  }
  if (typeof value === 'number' && isFinite(value)) {
    const minutes = Math.round((value % 1) * 1440);
    return pad2(Math.floor(minutes / 60) % 24) + ':' + pad2(minutes % 60);
  }

  const text = String(value).trim();
  let m = /^(\d{1,2}):(\d{2})(?::\d{2})?\s*([ap])\.?m\.?$/i.exec(text);
  if (m) {
    let h = Number(m[1]);
    if (m[3].toLowerCase() === 'p' && h < 12) h += 12;
    if (m[3].toLowerCase() === 'a' && h === 12) h = 0;
    return pad2(h) + ':' + m[2];
  }
  m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(text);
  if (m) return pad2(Number(m[1])) + ':' + m[2];
  m = /\b(\d{1,2}):(\d{2}):\d{2}\b/.exec(text);
  if (m) return pad2(Number(m[1])) + ':' + m[2];
  return '';
}

function minutesOfDay(hhmm, fallback) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
  if (!m) return fallback;
  return Number(m[1]) * 60 + Number(m[2]);
}

/**
 * Wall-clock date and minutes-since-midnight in one timezone, from one reading.
 * dev/demo-server.js derived the date in UTC and the minutes locally, which goes
 * wrong for several hours a day; both come from the same formatted instant here.
 */
function clock(timeZone, at) {
  const now = at instanceof Date ? at : new Date();
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(now);
  } catch (err) {
    throw new Error('Unknown timezone in config: ' + timeZone);
  }
  const f = {};
  for (const p of parts) f[p.type] = p.value;
  // hour12:false yields "24" for midnight in some ICU versions.
  const hour = f.hour === '24' ? 0 : Number(f.hour);
  return {
    date: `${f.year}-${f.month}-${f.day}`,
    minutes: hour * 60 + Number(f.minute),
    iso: now.toISOString(),
  };
}

function addDays(ymd, n) {
  const p = String(ymd).split('-').map(Number);
  const d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function dayDiff(a, b) {
  const utc = (s) => {
    const p = String(s).split('-').map(Number);
    return Date.UTC(p[0], p[1] - 1, p[2]);
  };
  return Math.round((utc(a) - utc(b)) / 86400000);
}

const isYmd = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

/**
 * A day D opens for claiming at `releaseTime` on day D - horizonDays.
 * With horizonDays = 1 that reads as "tomorrow unlocks at 5pm today".
 */
function windowFor(cfg, date, now) {
  const delta = dayDiff(date, now.date);
  if (delta < 0) return { claimable: false, reason: 'past' };
  if (delta === 0) {
    return cfg.allowSameDayClaim
      ? { claimable: true, reason: 'walkup' }
      : { claimable: false, reason: 'closed' };
  }
  if (delta > cfg.horizonDays) {
    return {
      claimable: false, reason: 'not_yet',
      opensOn: addDays(date, -cfg.horizonDays), opensAt: cfg.releaseTime,
    };
  }
  if (delta === cfg.horizonDays &&
      now.minutes < minutesOfDay(cfg.releaseTime, 17 * 60)) {
    return { claimable: false, reason: 'not_yet', opensOn: now.date, opensAt: cfg.releaseTime };
  }
  return { claimable: true, reason: 'open' };
}

/** Has the check-in deadline passed for today? */
function sweepDue(cfg, now) {
  return cfg.checkInEnabled && now.minutes >= minutesOfDay(cfg.checkInDeadline, 11 * 60);
}

/** Honoured = showed up; missed = swept as a no-show. Over all of a person's claims. */
function reliability(claims, email) {
  let honoured = 0, missed = 0;
  for (const c of claims) {
    if (c.email !== email) continue;
    if (c.status === 'noshow') missed++;
    else if (c.checkedInAt) honoured++;
  }
  return { honoured, missed };
}

const normCode = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/**
 * Apply the same coercions the sheet accessors did, so a config row typed by
 * hand behaves the same way it used to.
 */
function coerceConfig(raw) {
  const cfg = Object.assign({}, DEFAULT_CONFIG, raw || {});
  const warnings = [];
  for (const key of TIME_KEYS) {
    const time = normalizeTime(cfg[key]);
    if (!time) {
      // Never fall back silently: a wrong deadline nobody can see is worse than
      // a visible complaint. This exact failure shipped once already.
      warnings.push(`${key} is not a readable time ("${String(cfg[key])}"); ` +
                    `using the default ${DEFAULT_CONFIG[key]}.`);
      cfg[key] = DEFAULT_CONFIG[key];
    } else {
      cfg[key] = time;
    }
  }
  // A timezone typo used to take the whole board down: clock() throws, and
  // every endpoint calls it, so nobody could reach the admin panel to undo it.
  // Treat it like a bad time — fall back and say so.
  try {
    clock(cfg.timezone, new Date());
  } catch (err) {
    warnings.push(`timezone "${cfg.timezone}" is not a zone this server knows; ` +
                  `using ${DEFAULT_CONFIG.timezone}.`);
    cfg.timezone = DEFAULT_CONFIG.timezone;
  }
  // Capped: `state` builds one day (and one query) per horizon day, and this is
  // a single-threaded server. 30 is already far more than a lab plans ahead.
  cfg.horizonDays = Math.min(30, Math.max(0, parseInt(cfg.horizonDays, 10) || 0));
  cfg.maxOpenClaims = Math.min(60, Math.max(1, parseInt(cfg.maxOpenClaims, 10) || 1));
  cfg.checkInEnabled = String(cfg.checkInEnabled).toUpperCase() !== 'FALSE';
  cfg.allowSameDayClaim = String(cfg.allowSameDayClaim).toUpperCase() !== 'FALSE';
  cfg.warnings = warnings;
  return cfg;
}

module.exports = {
  DEFAULT_CONFIG, TIME_KEYS,
  normalizeTime, minutesOfDay, clock, addDays, dayDiff, isYmd,
  windowFor, sweepDue, reliability, normCode, coerceConfig,
};
