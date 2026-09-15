'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../server/domain');

test('normalizeTime accepts every shape the sheet could produce', () => {
  // The 1899-epoch Date is what Sheets turned a typed "17:00" into; it shipped
  // once as a silently-wrong deadline, so it stays pinned here.
  assert.equal(D.normalizeTime(new Date(1899, 11, 30, 17, 0)), '17:00');
  assert.equal(D.normalizeTime(new Date(1899, 11, 30, 9, 30)), '09:30');
  assert.equal(D.normalizeTime('17:00'), '17:00');
  assert.equal(D.normalizeTime('17:00:00'), '17:00');
  assert.equal(D.normalizeTime('5:00 PM'), '17:00');
  assert.equal(D.normalizeTime('9:15 am'), '09:15');
  assert.equal(D.normalizeTime('12:00 AM'), '00:00', 'midnight is 00, not 12');
  assert.equal(D.normalizeTime('12:00 PM'), '12:00', 'noon is 12, not 00');
  assert.equal(D.normalizeTime(0.5), '12:00');
  assert.equal(D.normalizeTime('Sat Dec 30 1899 10:00:00 GMT-0500'), '10:00');
  assert.equal(D.normalizeTime('lunchtime'), '');
  assert.equal(D.normalizeTime(''), '');
});

test('coerceConfig reports an unreadable time instead of silently defaulting', () => {
  const cfg = D.coerceConfig({ checkInDeadline: 'lunchtime', releaseTime: '16:30' });
  assert.equal(cfg.checkInDeadline, '11:00', 'falls back');
  assert.equal(cfg.releaseTime, '16:30');
  assert.equal(cfg.warnings.length, 1);
  assert.match(cfg.warnings[0], /checkInDeadline/);
});

test('coerceConfig types the values the frontend depends on', () => {
  const cfg = D.coerceConfig({ horizonDays: '3', maxOpenClaims: '2',
                               checkInEnabled: 'FALSE', allowSameDayClaim: 'true' });
  // app.js compares horizonDays === 1, so a string would break the rules line.
  assert.equal(typeof cfg.horizonDays, 'number');
  assert.equal(cfg.horizonDays, 3);
  assert.equal(cfg.maxOpenClaims, 2);
  assert.equal(cfg.checkInEnabled, false);
  assert.equal(cfg.allowSameDayClaim, true);
});

test('clock reads date and minutes from one instant in the configured zone', () => {
  // 00:30 UTC on the 16th is still 20:30 on the 15th in New York. Deriving the
  // date in UTC and the minutes locally (as dev/demo-server.js did) splits these.
  const c = D.clock('America/New_York', new Date('2026-09-16T00:30:00Z'));
  assert.equal(c.date, '2026-09-15');
  assert.equal(c.minutes, 20 * 60 + 30);
});

test('clock handles midnight without reporting hour 24', () => {
  const c = D.clock('America/New_York', new Date('2026-09-15T04:10:00Z'));
  assert.equal(c.date, '2026-09-15');
  assert.equal(c.minutes, 10);
});

test('clock rejects an unknown timezone loudly', () => {
  assert.throws(() => D.clock('Mars/Olympus', new Date()), /Unknown timezone/);
});

const CFG = D.coerceConfig({ horizonDays: '1', releaseTime: '17:00' });
const at = (date, minutes) => ({ date, minutes, iso: '' });

test('claim window: yesterday is closed', () => {
  assert.deepEqual(D.windowFor(CFG, '2026-09-14', at('2026-09-15', 600)),
                   { claimable: false, reason: 'past' });
});

test('claim window: today is always a walk-up', () => {
  const w = D.windowFor(CFG, '2026-09-15', at('2026-09-15', 1));
  assert.equal(w.claimable, true);
  assert.equal(w.reason, 'walkup');
});

test('claim window: today closes when walk-ups are disabled', () => {
  const cfg = D.coerceConfig({ allowSameDayClaim: 'FALSE' });
  assert.equal(D.windowFor(cfg, '2026-09-15', at('2026-09-15', 600)).claimable, false);
});

test('claim window: tomorrow opens exactly at releaseTime, not a minute before', () => {
  const before = D.windowFor(CFG, '2026-09-16', at('2026-09-15', 17 * 60 - 1));
  assert.equal(before.claimable, false);
  assert.equal(before.reason, 'not_yet');
  assert.equal(before.opensOn, '2026-09-15');
  assert.equal(before.opensAt, '17:00');

  const on = D.windowFor(CFG, '2026-09-16', at('2026-09-15', 17 * 60));
  assert.equal(on.claimable, true, 'open at exactly 17:00');
});

test('claim window: beyond the horizon says when it will open', () => {
  const w = D.windowFor(CFG, '2026-09-18', at('2026-09-15', 1200));
  assert.equal(w.claimable, false);
  assert.equal(w.reason, 'not_yet');
  assert.equal(w.opensOn, '2026-09-17', 'D minus horizonDays');
});

test('claim window: a wider horizon leaves nearer days open all day', () => {
  const cfg = D.coerceConfig({ horizonDays: '3' });
  assert.equal(D.windowFor(cfg, '2026-09-16', at('2026-09-15', 60)).claimable, true);
  assert.equal(D.windowFor(cfg, '2026-09-18', at('2026-09-15', 60)).claimable, false,
               'the far edge still waits for releaseTime');
});

test('sweep is due only after the deadline, and never when disabled', () => {
  assert.equal(D.sweepDue(CFG, at('2026-09-15', 10 * 60 + 59)), false);
  assert.equal(D.sweepDue(CFG, at('2026-09-15', 11 * 60)), true);
  const off = D.coerceConfig({ checkInEnabled: 'FALSE' });
  assert.equal(D.sweepDue(off, at('2026-09-15', 23 * 60)), false);
});

test('reliability counts show-ups and no-shows for one person only', () => {
  const claims = [
    { email: 'a@x', status: 'released', checkedInAt: 'yes' },
    { email: 'a@x', status: 'noshow',   checkedInAt: '' },
    { email: 'a@x', status: 'active',   checkedInAt: '' },   // today, undecided
    { email: 'b@x', status: 'noshow',   checkedInAt: '' },
  ];
  assert.deepEqual(D.reliability(claims, 'a@x'), { honoured: 1, missed: 1 });
});

test('addDays and dayDiff survive a daylight-saving boundary', () => {
  // US DST ends 2026-11-01; date arithmetic must not drift by an hour.
  assert.equal(D.addDays('2026-10-31', 2), '2026-11-02');
  assert.equal(D.dayDiff('2026-11-02', '2026-10-31'), 2);
});

test('normCode strips punctuation and case', () => {
  assert.equal(D.normCode(' rob-123 '), 'ROB123');
});
