/**
 * Action handlers and the response envelope.
 *
 * The wire contract is a faithful port of apps-script/Code.gs so the two can be
 * compared during cutover. Error *strings* are part of that contract: the
 * frontend matches the substring "expired" to decide whether to show an error
 * on the sign-in screen (docs/js/app.js, start()).
 */
'use strict';

const crypto = require('node:crypto');
const D = require('./domain');
const S = require('./store');
const { isConflict } = require('./db');
const { mintToken, emailFromToken, Throttle, makeCode } = require('./auth');
const { parseTable } = require('./csv');

class UserError extends Error {
  constructor(message) { super(message); this.isUserError = true; }
}

const EXPIRED = 'Your session expired. Please sign in again.';

function createApi({ db, secret, now = () => new Date() }) {
  const throttle = new Throttle();

  /* ----------------------------- helpers ------------------------------- */

  const cfgAndClock = () => {
    const cfg = S.getConfig(db);
    return { cfg, clock: D.clock(cfg.timezone, now()) };
  };

  function requireUser(p) {
    const email = emailFromToken(p.token, secret);
    if (!email) throw new UserError(EXPIRED);
    const person = S.personByEmail(db, email);
    // Distinguish "switched off" from "the address on your row changed", which
    // otherwise both read as a deactivation and send people to a moderator for
    // something a re-login fixes.
    if (!person) {
      throw new UserError('We could not find your account. Please sign in again with your code.');
    }
    if (!person.active) {
      throw new UserError('Your account has been deactivated. Ask a moderator.');
    }
    return person;
  }

  function requireModerator(p) {
    const user = requireUser(p);
    if (user.role !== 'moderator') throw new UserError('Moderators only.');
    return user;
  }

  /**
   * Release today's claims that were never checked in by the deadline. Runs
   * lazily on read as well as from the timer, so the board is correct even if
   * the timer misfired.
   */
  function sweepNoShows(cfg, clock) {
    if (!D.sweepDue(cfg, clock)) return;
    const stale = db.all(
      "SELECT claim_id, desk_id, email FROM claims " +
      // `<=` not `=`: a claim from a day the server was down would otherwise
      // stay active forever, invisible but polluting the occupancy numbers.
      "WHERE status = 'active' AND date <= :d AND checked_in_at = ''", { d: clock.date });
    if (!stale.length) return;
    db.tx(() => {
      for (const row of stale) {
        db.run("UPDATE claims SET status = 'noshow', released_at = :t " +
               "WHERE claim_id = :id AND status = 'active'",
               { t: clock.iso, id: row.claim_id });
        S.audit(db, 'system', 'noshow', `${row.claim_id} ${row.desk_id} ${row.email}`);
      }
    });
  }

  /* ------------------------------ actions ------------------------------ */

  const actions = {
    ping: () => ({ ok: true, service: 'cbcb-hotdesk', version: 2 }),

    login(p) {
      const keys = [`ip:${p.clientIp || 'unknown'}`];
      if (throttle.blocked(keys)) {
        throw new UserError('Too many failed sign-ins. Try again in a few minutes.');
      }
      const code = D.normCode(p.code);
      if (code.length < 4) throw new UserError('Enter your access code.');

      const matches = S.peopleByCode(db, code);
      if (matches.length !== 1) {
        throttle.fail([...keys, `code:${code}`]);
        throw new UserError('That code was not recognised.');
      }
      throttle.clear(keys);
      S.audit(db, matches[0].email, 'login', '');
      return { token: mintToken(matches[0].email, secret), user: S.publicUser(matches[0]) };
    },

    state(p) {
      const user = requireUser(p);
      const { cfg, clock } = cfgAndClock();
      sweepNoShows(cfg, clock);

      const names = new Map(S.roster(db).map((r) => [r.email, r.name]));
      const allDesks = S.desks(db);

      // horizonDays + 2 days: today, everything claimable, and one still-locked
      // day so the strip can show when it opens.
      const days = [];
      for (let i = 0; i < cfg.horizonDays + 2; i++) {
        const date = D.addDays(clock.date, i);
        days.push({
          date,
          window: D.windowFor(cfg, date, clock),
          claims: S.activeClaimsOn(db, date).map((c) => ({
            claimId: c.claimId,
            deskId: c.deskId,
            email: c.email,
            name: names.get(c.email) || c.email,
            checkedIn: !!c.checkedInAt,
            mine: c.email === user.email,
          })),
        });
      }

      const mine = S.claimsForEmail(db, user.email);
      const openClaims = mine.filter(
        (c) => c.status === 'active' && D.dayDiff(c.date, clock.date) > 0).length;

      return {
        user: S.publicUser(user),
        // A whitelist, not the raw config: access codes live in the same store.
        config: {
          siteTitle: cfg.siteTitle,
          timezone: cfg.timezone,
          releaseTime: cfg.releaseTime,
          horizonDays: cfg.horizonDays,
          maxOpenClaims: cfg.maxOpenClaims,
          checkInDeadline: cfg.checkInDeadline,
          checkInEnabled: cfg.checkInEnabled,
          allowSameDayClaim: cfg.allowSameDayClaim,
          noticeText: cfg.noticeText,
          warnings: user.role === 'moderator' ? cfg.warnings : [],
        },
        now: { date: clock.date, minutes: clock.minutes, timezone: cfg.timezone },
        desks: allDesks.map((d) => Object.assign({}, d, {
          reservedForName: d.reservedFor ? (names.get(d.reservedFor) || d.reservedFor) : '',
        })),
        days,
        me: { openClaims, reliability: D.reliability(mine, user.email) },
      };
    },

    claim(p) {
      const user = requireUser(p);
      const { cfg, clock } = cfgAndClock();
      const date = String(p.date || '').trim();
      const deskId = String(p.deskId || '').trim();
      if (!D.isYmd(date)) throw new UserError('Pick a valid date.');

      sweepNoShows(cfg, clock);

      const win = D.windowFor(cfg, date, clock);
      if (!win.claimable) {
        throw new UserError(win.reason === 'past'
          ? 'That day has already passed.'
          : 'Claiming for ' + date + ' is not open yet.');
      }

      const desk = S.deskById(db, deskId);
      if (!desk) throw new UserError('No such desk.');
      if (desk.status !== 'active') throw new UserError(desk.label + ' is out of service.');
      if (desk.reservedFor && desk.reservedFor !== user.email) {
        throw new UserError(desk.label + ' is reserved for someone else.');
      }

      // Full UUID: 8 hex characters is 32 bits, and isConflict() maps any
      // UNIQUE failure to "someone just claimed it", so a collision would
      // surface as a mysteriously unclaimable free desk.
      const claimId = crypto.randomUUID();
      const sameDay = D.dayDiff(date, clock.date) === 0;

      try {
        return db.tx(() => {
          const taken = db.get(
            "SELECT email FROM claims WHERE date = :d AND desk_id = :k AND status = 'active'",
            { d: date, k: deskId });
          if (taken) {
            throw new UserError(taken.email === user.email
              ? 'You already have that desk.'
              : desk.label + ' was just claimed by someone else.');
          }
          const mineThatDay = db.get(
            "SELECT 1 FROM claims WHERE date = :d AND email = :e AND status = 'active'",
            { d: date, e: user.email });
          if (mineThatDay) throw new UserError('You already hold a desk on ' + date + '.');

          if (!sameDay) {
            const open = db.get(
              "SELECT COUNT(*) AS n FROM claims " +
              "WHERE email = :e AND status = 'active' AND date > :today",
              { e: user.email, today: clock.date }).n;
            if (open >= cfg.maxOpenClaims) {
              throw new UserError('You already hold ' + cfg.maxOpenClaims +
                ' upcoming days, which is the limit. Release one first.');
            }
          }

          db.run(
            'INSERT INTO claims(claim_id, date, desk_id, email, claimed_at, ' +
            'checked_in_at, released_at, status) ' +
            "VALUES(:id, :d, :k, :e, :t, :ci, '', 'active')",
            { id: claimId, d: date, k: deskId, e: user.email, t: clock.iso,
              // A walk-up claim is self-evidently a check-in: you are standing there.
              ci: sameDay ? clock.iso : '' });
          S.audit(db, user.email, 'claim', date + ' ' + deskId);
          return { claimId };
        });
      } catch (err) {
        // The unique indices are the real arbiter under concurrency; translate a
        // constraint violation into the same message the pre-check would give.
        if (isConflict(err)) {
          throw new UserError(desk.label + ' was just claimed by someone else.');
        }
        throw err;
      }
    },

    release(p) {
      const user = requireUser(p);
      return releaseClaim(p.claimId, user, false);
    },

    checkin(p) {
      const user = requireUser(p);
      const { cfg, clock } = cfgAndClock();
      const claim = S.claimById(db, p.claimId);
      if (!claim) throw new UserError('No such claim.');
      if (claim.email !== user.email) throw new UserError('That is not your claim.');
      if (claim.date !== clock.date) {
        throw new UserError('You can only check in on the day itself.');
      }
      if (claim.checkedInAt) return { checkedIn: true };
      // Guard in the UPDATE, not just the read: the no-show sweep can flip this
      // row between the two. Without the guard we would report a successful
      // check-in on a desk that had just been released to someone else.
      const res = db.tx(() => db.run(
        "UPDATE claims SET checked_in_at = :t " +
        "WHERE claim_id = :id AND status = 'active' AND checked_in_at = ''",
        { t: clock.iso, id: claim.claimId }));
      if (!Number(res.changes)) {
        throw new UserError('That claim is no longer active — it may have just been released.');
      }
      S.audit(db, user.email, 'checkin', claim.date + ' ' + claim.deskId);
      return { checkedIn: true };
    },

    adminState(p) {
      requireModerator(p);
      const { cfg, clock } = cfgAndClock();
      const all = db.all('SELECT * FROM claims').map(S.toClaim);
      return {
        config: cfg,
        desks: S.desks(db),
        roster: S.roster(db).map((r) =>
          Object.assign({}, r, D.reliability(all, r.email))),
        upcoming: S.upcomingClaims(db, clock.date),
      };
    },

    adminSetConfig(p) {
      const mod = requireModerator(p);
      const { saved, rejected } = db.tx(() => S.setConfig(db, p.updates));
      S.audit(db, mod.email, 'config', p.updates);
      if (rejected.length) {
        throw new UserError('Not a setting this server has: ' + rejected.join(', '));
      }
      return { saved };
    },

    adminSaveDesk(p) {
      const mod = requireModerator(p);
      const d = p.desk || {};
      const deskId = String(d.deskId || '').trim();
      if (!deskId) throw new UserError('deskId is required.');
      const num = (v) => (v === '' || v === null || v === undefined ? null : Number(v));
      db.run(
        'INSERT INTO desks(desk_id, label, room, x, y, status, reserved_for, notes) ' +
        'VALUES(:id, :label, :room, :x, :y, :status, :res, :notes) ' +
        'ON CONFLICT(desk_id) DO UPDATE SET label = excluded.label, room = excluded.room, ' +
        'x = excluded.x, y = excluded.y, status = excluded.status, ' +
        'reserved_for = excluded.reserved_for, notes = excluded.notes',
        { id: deskId,
          label: String(d.label || deskId).trim(),
          room: String(d.room || '').trim(),
          x: num(d.x), y: num(d.y),
          status: String(d.status || 'active').trim().toLowerCase(),
          res: String(d.reservedFor || '').trim().toLowerCase(),
          notes: String(d.notes || '').trim() });
      S.audit(db, mod.email, 'save_desk', deskId);
      return { saved: deskId };
    },

    adminSavePerson(p) {
      const mod = requireModerator(p);
      const person = p.person || {};
      const email = String(person.email || '').trim().toLowerCase();
      if (!email) throw new UserError('email is required.');
      const existing = S.personByEmail(db, email);
      const code = D.normCode(person.code) || (existing && existing.code) || makeCode();
      const role = String(person.role || 'student').trim().toLowerCase();
      if (!['student', 'moderator'].includes(role)) {
        throw new UserError('Role must be student or moderator.');
      }
      const clash = db.get('SELECT email FROM roster WHERE code = :c AND email <> :e',
                           { c: code, e: email });
      if (clash) {
        throw new UserError('That access code is already in use by ' + clash.email + '.');
      }
      db.run(
        'INSERT INTO roster(email, name, code, role, lab, active) ' +
        'VALUES(:e, :n, :c, :r, :l, :a) ' +
        'ON CONFLICT(email) DO UPDATE SET name = excluded.name, code = excluded.code, ' +
        'role = excluded.role, lab = excluded.lab, active = excluded.active',
        { e: email, n: String(person.name || '').trim(), c: code, r: role,
          // Only an explicit flag changes this; otherwise keep what is there,
          // or default a brand-new person to active. The moderator form does not
          // send it, and re-saving someone used to quietly reactivate them.
          l: String(person.lab || '').trim(),
          a: person.active === undefined
               ? (existing ? (existing.active ? 1 : 0) : 1)
               : (person.active === false ? 0 : 1) });
      S.audit(db, mod.email, 'save_person', email);
      return { saved: email, code };
    },

    /**
     * Bulk-add people from a CSV.
     *
     * Always run with dryRun first from the UI: this is the one moderator action
     * that can touch the whole roster at once, and a mis-mapped column should be
     * visible before it is applied, not after.
     *
     * Recognised columns (case and punctuation insensitive): email, name, lab,
     * role, code. Only email is required.
     */
    adminImportRoster(p) {
      // Rosters arrive from whatever the department sent: "Full Name", "E-mail",
      // "Advisor". Accept the obvious synonyms rather than making someone edit
      // the header before the file will work.
      const FIELDS = {
        email: ['email', 'emailaddress', 'umdemail', 'mail'],
        name:  ['name', 'fullname', 'displayname', 'studentname', 'person'],
        lab:   ['lab', 'group', 'advisor', 'pi', 'supervisor'],
        role:  ['role', 'type', 'access'],
        code:  ['code', 'accesscode', 'logincode'],
      };
      const pick = (row, field) => {
        for (const key of FIELDS[field]) {
          if (row[key] !== undefined && String(row[key]).trim() !== '') return String(row[key]).trim();
        }
        return '';
      };
      const mod = requireModerator(p);
      const dryRun = p.dryRun !== false;
      const { header, rows } = parseTable(p.csv || '');
      if (!rows.length) throw new UserError('That file has no rows under its header.');
      const headerKeys = header.map((h) => h.toLowerCase().replace(/[^a-z0-9]/g, ''));
      if (!headerKeys.some((h) => FIELDS.email.includes(h))) {
        throw new UserError('No "email" column found. Header was: ' + header.join(', '));
      }

      const existingCodes = new Set(S.roster(db).map((r) => r.code));
      const seen = new Set();
      const plan = [];

      for (const [i, row] of rows.entries()) {
        const line = i + 2;                       // +1 header, +1 to 1-base
        const email = pick(row, 'email').toLowerCase();
        const entry = { line, email, name: pick(row, 'name'), lab: pick(row, 'lab') };

        if (!email) { plan.push(Object.assign(entry, { action: 'skip', reason: 'no email' })); continue; }
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          plan.push(Object.assign(entry, { action: 'skip', reason: 'not an email address' }));
          continue;
        }
        if (seen.has(email)) {
          plan.push(Object.assign(entry, { action: 'skip', reason: 'repeated in this file' }));
          continue;
        }
        seen.add(email);

        const role = (pick(row, 'role') || 'student').toLowerCase();
        if (!['student', 'moderator'].includes(role)) {
          plan.push(Object.assign(entry, { action: 'skip', reason: 'role must be student or moderator' }));
          continue;
        }
        entry.role = role;

        const existing = S.personByEmail(db, email);
        let code = D.normCode(pick(row, 'code'));
        if (code && code !== (existing && existing.code)) {
          if (existingCodes.has(code)) {
            plan.push(Object.assign(entry, { action: 'skip', reason: 'that access code is already in use' }));
            continue;
          }
        }
        if (!code) code = (existing && existing.code) || '';
        if (!code) {
          do { code = makeCode(); } while (existingCodes.has(code));
        }
        existingCodes.add(code);
        entry.code = code;
        // A name is only overwritten when the file actually supplies one.
        entry.action = existing ? 'update' : 'add';
        if (existing) {
          entry.name = entry.name || existing.name;
          entry.lab = entry.lab || existing.lab;
          entry.wasInactive = !existing.active;
        }
        plan.push(entry);
      }

      const applies = plan.filter((e) => e.action !== 'skip');
      if (!dryRun && applies.length) {
        db.tx(() => {
          for (const e of applies) {
            db.run(
              'INSERT INTO roster(email, name, code, role, lab, active) ' +
              'VALUES(:e, :n, :c, :r, :l, 1) ' +
              'ON CONFLICT(email) DO UPDATE SET name = excluded.name, ' +
              'code = excluded.code, role = excluded.role, lab = excluded.lab, ' +
              'active = 1',
              { e: e.email, n: e.name, c: e.code, r: e.role, l: e.lab });
          }
          S.audit(db, mod.email, 'import_roster',
                  `${applies.length} rows (${applies.filter((x) => x.action === 'add').length} new)`);
        });
      }

      return {
        dryRun,
        added: plan.filter((e) => e.action === 'add').length,
        updated: plan.filter((e) => e.action === 'update').length,
        skipped: plan.filter((e) => e.action === 'skip').length,
        rows: plan,
      };
    },

    /**
     * Turn an account on or off.
     *
     * Deactivating also releases that person's claims from today onward: a
     * student who has graduated should not still be holding desks, and nobody
     * would think to go and force-release them one by one.
     */
    adminSetActive(p) {
      const mod = requireModerator(p);
      const email = String(p.email || '').trim().toLowerCase();
      const active = p.active === true;
      const person = S.personByEmail(db, email);
      if (!person) throw new UserError('No such person.');

      if (!active) {
        // Losing every moderator means nobody can turn anyone back on, and the
        // only way out is a shell on the server.
        const others = S.roster(db).filter(
          (r) => r.role === 'moderator' && r.active && r.email !== email);
        if (person.role === 'moderator' && !others.length) {
          throw new UserError('That is the last active moderator — promote someone else first.');
        }
      }

      const { cfg, clock } = cfgAndClock();
      let released = 0;
      db.tx(() => {
        db.run('UPDATE roster SET active = :a WHERE email = :e',
               { a: active ? 1 : 0, e: email });
        if (!active) {
          const res = db.run(
            "UPDATE claims SET status = 'released', released_at = :t " +
            "WHERE email = :e AND status = 'active' AND date >= :today",
            { t: clock.iso, e: email, today: clock.date });
          released = Number(res.changes) || 0;
        }
        S.audit(db, mod.email, active ? 'reactivate' : 'deactivate',
                `${email}${released ? ` (released ${released} claim(s))` : ''}`);
      });
      return { email, active, released };
    },

    adminForceRelease(p) {
      const mod = requireModerator(p);
      return releaseClaim(p.claimId, mod, true);
    },
  };

  function releaseClaim(claimId, actor, force) {
    return db.tx(() => {
      const claim = S.claimById(db, claimId);
      if (!claim) throw new UserError('No such claim.');
      if (!force && claim.email !== actor.email) {
        throw new UserError('That is not your claim.');
      }
      if (claim.status !== 'active') return { released: false };
      db.run("UPDATE claims SET status = 'released', released_at = :t WHERE claim_id = :id",
             { t: new Date().toISOString(), id: claim.claimId });
      S.audit(db, actor.email, force ? 'force_release' : 'release',
              `${claim.date} ${claim.deskId} ${claim.email}`);
      return { released: true };
    });
  }

  /** Always resolves; failures are carried in the envelope, never as a status. */
  function dispatch(body) {
    const action = body && body.action;
    try {
      const handler = Object.prototype.hasOwnProperty.call(actions, action)
        ? actions[action] : null;
      if (!handler) throw new UserError('Unknown action: ' + action);
      return { ok: true, data: handler(body) };
    } catch (err) {
      if (err && err.isUserError) {
        return { ok: false, error: err.message };
      }
      // Never hand an internal message to the browser: a duplicate access code
      // would otherwise show a moderator "UNIQUE constraint failed: roster.code".
      console.error('[api]', action, err);
      return { ok: false, error: 'Something went wrong on the server. Try again, ' +
                                'and tell a moderator if it keeps happening.' };
    }
  }

  return { dispatch, actions, sweepNoShows, cfgAndClock, UserError };
}

module.exports = { createApi, UserError, EXPIRED };
