/**
 * Offline demo server — a faithful in-memory stand-in for the Apps Script API.
 *
 *   node dev/demo-server.js      then open http://localhost:8931
 *
 * It implements the same actions with the same rules (claim windows, one desk
 * per person per day, upcoming-claim cap, check-in, no-show sweep) so you can
 * judge the interaction design before touching Google. State lives in memory
 * and resets when you stop the process. No sheet, no deployment, no account.
 *
 * Sign in as any of the people below; open a second browser profile or a
 * private window to be two people at once and watch a desk get taken.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 8931);
const ROOT = path.join(__dirname, '..', 'docs');

/* ----------------------------- demo data ---------------------------------- */

const ROSTER = [
  { email: 'rob@umd.edu',    name: 'Rob',    code: 'ROB123', role: 'moderator', lab: '' },
  { email: 'priya@umd.edu',  name: 'Priya Raman',  code: 'PRIYA1', role: 'student', lab: 'Patro' },
  { email: 'marcus@umd.edu', name: 'Marcus Hale',  code: 'MARC01', role: 'student', lab: 'Patro' },
  { email: 'lin@umd.edu',    name: 'Lin Wei',      code: 'LINW01', role: 'student', lab: 'Corrada' },
  { email: 'sam@umd.edu',    name: 'Sam Okafor',   code: 'SAM001', role: 'student', lab: 'Corrada' },
];

const config = {
  siteTitle: 'IRB 3112 Hotdesk (demo)',
  timezone: 'America/New_York',
  releaseTime: '17:00',
  horizonDays: 1,
  maxOpenClaims: 3,
  checkInDeadline: '11:00',
  checkInEnabled: true,
  allowSameDayClaim: true,
  noticeText: 'Demo mode — nothing here is saved.',
};

const desks = fs.readFileSync(path.join(ROOT, 'assets', 'demo-desks.tsv'), 'utf8')
  .trim().split('\n').slice(1).map((line) => {
    const c = line.split('\t');
    return {
      deskId: c[0], label: c[1], room: c[2],
      x: Number(c[3]), y: Number(c[4]),
      status: c[5] || 'active', reservedFor: c[6] || '', notes: c[7] || '',
    };
  });

let claims = [];
let nextId = 1;

/* ------------------------------ date helpers ------------------------------ */

const today = () => new Date().toISOString().slice(0, 10);

function addDays(ymd, n) {
  const p = ymd.split('-').map(Number);
  const d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function dayDiff(a, b) {
  const utc = (s) => { const p = s.split('-').map(Number); return Date.UTC(p[0], p[1] - 1, p[2]); };
  return Math.round((utc(a) - utc(b)) / 86400000);
}

function minutesNow() {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}

function toMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  return m ? Number(m[1]) * 60 + Number(m[2]) : 0;
}

/** Mirrors windowFor_() in Code.gs. */
function windowFor(date) {
  const delta = dayDiff(date, today());
  if (delta < 0) return { claimable: false, reason: 'past' };
  if (delta === 0) {
    return config.allowSameDayClaim
      ? { claimable: true, reason: 'walkup' }
      : { claimable: false, reason: 'closed' };
  }
  if (delta > config.horizonDays) {
    return { claimable: false, reason: 'not_yet',
             opensOn: addDays(date, -config.horizonDays), opensAt: config.releaseTime };
  }
  if (delta === config.horizonDays && minutesNow() < toMinutes(config.releaseTime)) {
    return { claimable: false, reason: 'not_yet', opensOn: today(), opensAt: config.releaseTime };
  }
  return { claimable: true, reason: 'open' };
}

function sweepNoShows() {
  if (!config.checkInEnabled) return;
  if (minutesNow() < toMinutes(config.checkInDeadline)) return;
  claims.forEach((c) => {
    if (c.status === 'active' && c.date === today() && !c.checkedInAt) {
      c.status = 'noshow';
      c.releasedAt = new Date().toISOString();
    }
  });
}

/* -------------------------------- seeding --------------------------------- */

function seed() {
  const now = new Date().toISOString();
  const t = today();
  const add = (date, deskId, email, checkedIn) => claims.push({
    claimId: 'seed' + (nextId++), date, deskId, email,
    claimedAt: now, checkedInAt: checkedIn ? now : '', releasedAt: '', status: 'active',
  });
  // A morning that looks like a real one: a couple of people in, one who booked
  // but has not shown up yet, and one booking already placed for tomorrow.
  add(t, 'IRB3112-A1', 'priya@umd.edu', true);
  add(t, 'IRB3112-C3', 'marcus@umd.edu', false);
  add(t, 'IRB3112-R2', 'sam@umd.edu', true);
  add(addDays(t, 1), 'IRB3112-B4', 'lin@umd.edu', false);
  // Some history, so the "showed up for N of M" line has something to say.
  for (let i = 2; i <= 9; i++) {
    claims.push({
      claimId: 'hist' + (nextId++), date: addDays(t, -i), deskId: 'IRB3112-B1',
      email: 'priya@umd.edu', claimedAt: now,
      checkedInAt: i === 4 ? '' : now, releasedAt: '',
      status: i === 4 ? 'noshow' : 'released',
    });
  }
}
seed();

/* --------------------------------- API ------------------------------------ */

const sessions = new Map();
const personBy = (key, value) => ROSTER.find((p) => p[key] === value);

function fail(message) { const e = new Error(message); e.isUserError = true; throw e; }

function userFor(token) {
  const email = sessions.get(token);
  const person = email && personBy('email', email);
  if (!person) fail('Your session expired. Please sign in again.');
  return person;
}

function publicUser(u) { return { email: u.email, name: u.name, role: u.role, lab: u.lab }; }

function reliability(email) {
  let honoured = 0, missed = 0;
  claims.forEach((c) => {
    if (c.email !== email) return;
    if (c.status === 'noshow') missed++;
    else if (c.checkedInAt) honoured++;
  });
  return { honoured, missed };
}

const actions = {
  ping: () => ({ ok: true }),

  login({ code }) {
    const person = personBy('code', String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, ''));
    if (!person) fail('That code was not recognised.');
    const token = 'demo-' + person.email + '-' + Math.random().toString(36).slice(2);
    sessions.set(token, person.email);
    return { token, user: publicUser(person) };
  },

  state({ token }) {
    const user = userFor(token);
    sweepNoShows();
    const t = today();
    const days = [];
    for (let i = 0; i < config.horizonDays + 2; i++) {
      const date = addDays(t, i);
      days.push({
        date,
        window: windowFor(date),
        claims: claims.filter((c) => c.date === date && c.status === 'active').map((c) => ({
          claimId: c.claimId, deskId: c.deskId, email: c.email,
          name: (personBy('email', c.email) || {}).name || c.email,
          checkedIn: !!c.checkedInAt, mine: c.email === user.email,
        })),
      });
    }
    return {
      user: publicUser(user),
      config,
      now: { date: t, minutes: minutesNow(), timezone: config.timezone },
      desks: desks.map((d) => Object.assign({}, d, {
        reservedForName: d.reservedFor ? (personBy('email', d.reservedFor) || {}).name || d.reservedFor : '',
      })),
      days,
      me: {
        openClaims: claims.filter((c) =>
          c.email === user.email && c.status === 'active' && dayDiff(c.date, t) > 0).length,
        reliability: reliability(user.email),
      },
    };
  },

  claim({ token, date, deskId }) {
    const user = userFor(token);
    sweepNoShows();
    if (!windowFor(date).claimable) fail('Claiming for ' + date + ' is not open yet.');

    const desk = desks.find((d) => d.deskId === deskId);
    if (!desk) fail('No such desk.');
    if (desk.status !== 'active') fail(desk.label + ' is out of service.');
    if (desk.reservedFor && desk.reservedFor !== user.email) {
      fail(desk.label + ' is reserved for someone else.');
    }

    const taken = claims.find((c) => c.date === date && c.deskId === deskId && c.status === 'active');
    if (taken) {
      fail(taken.email === user.email
        ? 'You already have that desk.'
        : desk.label + ' was just claimed by someone else.');
    }
    if (claims.some((c) => c.date === date && c.email === user.email && c.status === 'active')) {
      fail('You already hold a desk on ' + date + '.');
    }
    if (dayDiff(date, today()) > 0) {
      const open = claims.filter((c) =>
        c.email === user.email && c.status === 'active' && dayDiff(c.date, today()) > 0).length;
      if (open >= config.maxOpenClaims) {
        fail('You already hold ' + config.maxOpenClaims +
             ' upcoming days, which is the limit. Release one first.');
      }
    }

    const now = new Date().toISOString();
    const claimId = 'c' + (nextId++);
    claims.push({
      claimId, date, deskId, email: user.email, claimedAt: now,
      checkedInAt: dayDiff(date, today()) === 0 ? now : '',
      releasedAt: '', status: 'active',
    });
    return { claimId };
  },

  release({ token, claimId }) {
    const user = userFor(token);
    const c = claims.find((x) => x.claimId === claimId);
    if (!c) fail('No such claim.');
    if (c.email !== user.email) fail('That is not your claim.');
    c.status = 'released';
    c.releasedAt = new Date().toISOString();
    return { released: true };
  },

  checkin({ token, claimId }) {
    const user = userFor(token);
    const c = claims.find((x) => x.claimId === claimId);
    if (!c) fail('No such claim.');
    if (c.email !== user.email) fail('That is not your claim.');
    if (c.date !== today()) fail('You can only check in on the day itself.');
    c.checkedInAt = new Date().toISOString();
    return { checkedIn: true };
  },

  adminState({ token }) {
    const user = userFor(token);
    if (user.role !== 'moderator') fail('Moderators only.');
    return {
      config,
      desks,
      roster: ROSTER.map((r) => Object.assign({ active: true }, r, reliability(r.email))),
      upcoming: claims.filter((c) => c.status === 'active' && dayDiff(c.date, today()) >= 0),
    };
  },

  adminSetConfig({ token, updates }) {
    const user = userFor(token);
    if (user.role !== 'moderator') fail('Moderators only.');
    Object.keys(updates || {}).forEach((k) => {
      const v = updates[k];
      if (k === 'horizonDays' || k === 'maxOpenClaims') config[k] = Number(v);
      else if (k === 'checkInEnabled' || k === 'allowSameDayClaim') {
        config[k] = String(v).toUpperCase() !== 'FALSE';
      } else config[k] = v;
    });
    return { saved: Object.keys(updates || {}).length };
  },

  adminSavePerson({ token, person }) {
    const user = userFor(token);
    if (user.role !== 'moderator') fail('Moderators only.');
    const email = String(person.email || '').toLowerCase();
    const code = 'D' + String(nextId++).padStart(5, '0');
    const existing = personBy('email', email);
    if (existing) Object.assign(existing, { name: person.name, lab: person.lab, role: person.role });
    else ROSTER.push({ email, name: person.name, code, role: person.role, lab: person.lab });
    return { saved: email, code: existing ? existing.code : code };
  },

  adminForceRelease({ token, claimId }) {
    const user = userFor(token);
    if (user.role !== 'moderator') fail('Moderators only.');
    const c = claims.find((x) => x.claimId === claimId);
    if (!c) fail('No such claim.');
    c.status = 'released';
    c.releasedAt = new Date().toISOString();
    return { released: true };
  },
};

/* -------------------------------- server ---------------------------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.tsv': 'text/plain; charset=utf-8', '.json': 'application/json',
};

http.createServer((req, res) => {
  if (req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let payload;
      try {
        const parsed = JSON.parse(body || '{}');
        const handler = actions[parsed.action];
        if (!handler) throw new Error('Unknown action: ' + parsed.action);
        payload = { ok: true, data: handler(parsed) };
      } catch (err) {
        payload = { ok: false, error: err.message };
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    });
    return;
  }

  // Serve docs/, but hand the browser a config pointed at this server so the
  // checked-in config.js keeps its placeholder URL.
  let rel = decodeURIComponent(req.url.split('?')[0]);
  if (rel.endsWith('/')) rel += 'index.html';
  if (rel === '/js/config.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript' });
    res.end('window.HOTDESK_CONFIG = { apiUrl: "/api", floorplan: "assets/floorplan.svg" };\n');
    return;
  }
  const file = path.join(ROOT, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(PORT, () => {
  console.log('\n  CBCB Hotdesk demo — http://localhost:' + PORT + '\n');
  console.log('  Sign in with any of these codes:\n');
  ROSTER.forEach((p) => {
    console.log('    ' + p.code + '   ' + p.name + (p.role === 'moderator' ? '  (moderator)' : ''));
  });
  console.log('\n  In-memory only. Stop with Ctrl-C and everything resets.\n');
});
