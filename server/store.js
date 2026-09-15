/**
 * Row mapping between the database (snake_case) and the wire contract
 * (camelCase). Kept separate from the action handlers so the shapes the
 * frontend depends on are all visible in one place.
 */
'use strict';

const { coerceConfig } = require('./domain');

const toDesk = (r) => ({
  deskId: r.desk_id,
  label: r.label || r.desk_id,
  room: r.room || '',
  // app.js tests `typeof x === 'number'`, so an unplaced desk must be null,
  // never '' — see docs/js/app.js renderMap.
  x: r.x === null || r.x === undefined ? null : Number(r.x),
  y: r.y === null || r.y === undefined ? null : Number(r.y),
  status: String(r.status || 'active').toLowerCase(),
  reservedFor: String(r.reserved_for || '').toLowerCase(),
  notes: r.notes || '',
});

const toPerson = (r) => ({
  email: r.email,
  name: r.name || '',
  code: r.code || '',
  role: r.role || 'student',
  lab: r.lab || '',
  active: !!r.active,
});

const toClaim = (r) => ({
  claimId: r.claim_id,
  date: r.date,
  deskId: r.desk_id,
  email: r.email,
  claimedAt: r.claimed_at || '',
  checkedInAt: r.checked_in_at || '',
  releasedAt: r.released_at || '',
  status: r.status,
});

const publicUser = (p) => ({ email: p.email, name: p.name, role: p.role, lab: p.lab });

function getConfig(db) {
  const raw = {};
  for (const row of db.all('SELECT key, value FROM config')) raw[row.key] = row.value;
  return coerceConfig(raw);
}

function setConfig(db, updates) {
  let saved = 0;
  for (const [key, value] of Object.entries(updates || {})) {
    db.run(
      'INSERT INTO config(key, value) VALUES(:k, :v) ' +
      'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      { k: String(key), v: String(value ?? '') });
    saved++;
  }
  return saved;
}

const desks = (db) =>
  db.all('SELECT * FROM desks ORDER BY sort_key, desk_id').map(toDesk);

const deskById = (db, deskId) => {
  const r = db.get('SELECT * FROM desks WHERE desk_id = :id', { id: String(deskId) });
  return r ? toDesk(r) : null;
};

const roster = (db) =>
  db.all('SELECT * FROM roster ORDER BY name, email').map(toPerson);

const personByEmail = (db, email) => {
  const r = db.get('SELECT * FROM roster WHERE email = :e',
                   { e: String(email || '').toLowerCase() });
  return r ? toPerson(r) : null;
};

/**
 * Sign-in matches on the code alone, so an ambiguous match must fail rather
 * than pick one. A unique index makes that impossible, but the check stays as a
 * belt-and-braces against a database restored from elsewhere.
 */
const peopleByCode = (db, code) =>
  db.all('SELECT * FROM roster WHERE code = :c AND active = 1', { c: String(code) })
    .map(toPerson);

const activeClaimsOn = (db, date) =>
  db.all("SELECT * FROM claims WHERE date = :d AND status = 'active'", { d: date })
    .map(toClaim);

const claimsForEmail = (db, email) =>
  db.all('SELECT * FROM claims WHERE email = :e', { e: email }).map(toClaim);

const claimById = (db, claimId) => {
  const r = db.get('SELECT * FROM claims WHERE claim_id = :id', { id: String(claimId) });
  return r ? toClaim(r) : null;
};

const upcomingClaims = (db, today) =>
  db.all("SELECT * FROM claims WHERE status = 'active' AND date >= :d " +
         'ORDER BY date, desk_id', { d: today }).map(toClaim);

function audit(db, actor, action, detail) {
  try {
    db.run('INSERT INTO audit(timestamp, actor, action, detail) ' +
           'VALUES(:t, :a, :c, :d)',
           { t: new Date().toISOString(), a: String(actor || ''), c: String(action),
             d: typeof detail === 'string' ? detail : JSON.stringify(detail ?? '') });
  } catch (err) {
    // Auditing must never be the reason a booking fails.
  }
}

module.exports = {
  toDesk, toPerson, toClaim, publicUser,
  getConfig, setConfig, desks, deskById, roster, personByEmail, peopleByCode,
  activeClaimsOn, claimsForEmail, claimById, upcomingClaims, audit,
};
