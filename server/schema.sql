-- CBCB Hotdesk schema.
--
-- Mirrors the five Google Sheet tabs it replaces, in snake_case; the API layer
-- maps to the camelCase the frontend expects. The interesting part is at the
-- bottom: the two rules most likely to be violated under concurrency are
-- constraints here rather than application checks.

-- Connection pragmas (journal_mode, foreign_keys, busy_timeout) are set in
-- server/db.js, in that order and before this file runs.

CREATE TABLE IF NOT EXISTS schema_version (
  version    INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);

-- Internal values the API must never hand out. The token-signing secret lived
-- in `config` once, and adminState returns the whole config object to
-- moderators — which is a key to mint a token for any account, forever.
CREATE TABLE IF NOT EXISTS server_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS roster (
  email  TEXT PRIMARY KEY,                     -- lowercased; the identity key
  name   TEXT NOT NULL DEFAULT '',
  code   TEXT NOT NULL,                        -- normalised A-Z0-9
  role   TEXT NOT NULL DEFAULT 'student'
         CHECK (role IN ('student', 'moderator')),
  lab    TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1
);

-- Sign-in matches on the code alone, so two people sharing one would make the
-- match ambiguous. The old backend could only notice that at login time.
CREATE UNIQUE INDEX IF NOT EXISTS roster_code_unique ON roster(code);

CREATE TABLE IF NOT EXISTS desks (
  desk_id      TEXT PRIMARY KEY,
  label        TEXT NOT NULL DEFAULT '',
  room         TEXT NOT NULL DEFAULT '',
  x            REAL,                           -- percent of the plan, NULL = unplaced
  y            REAL,
  status       TEXT NOT NULL DEFAULT 'active',
  reserved_for TEXT NOT NULL DEFAULT '',       -- lowercased email, or ''
  notes        TEXT NOT NULL DEFAULT '',
  sort_key     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS claims (
  claim_id      TEXT PRIMARY KEY,
  date          TEXT NOT NULL,                 -- YYYY-MM-DD, always text
  -- ON UPDATE CASCADE is the point of having a real database here: renaming a
  -- roster email or a desk id used to orphan that person's claims silently in
  -- the sheet, leaving a booking nobody could see or release while it still
  -- counted against their one-desk-per-day limit. Deletes stay restricted, so
  -- history cannot be dropped out from under the occupancy numbers.
  desk_id       TEXT NOT NULL REFERENCES desks(desk_id) ON UPDATE CASCADE,
  email         TEXT NOT NULL REFERENCES roster(email) ON UPDATE CASCADE,
  claimed_at    TEXT NOT NULL,
  checked_in_at TEXT NOT NULL DEFAULT '',
  released_at   TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('active', 'released', 'noshow'))
);

CREATE TABLE IF NOT EXISTS audit (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  actor     TEXT NOT NULL DEFAULT '',
  action    TEXT NOT NULL,
  detail    TEXT NOT NULL DEFAULT ''
);

-- The booking rules, as constraints. Apps Script needed a 15-second global
-- script lock to approximate these; here two students tapping the same desk at
-- 17:00:00 cannot both win even if the application checks race.
CREATE UNIQUE INDEX IF NOT EXISTS one_claim_per_desk_per_day
  ON claims(date, desk_id) WHERE status = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS one_desk_per_person_per_day
  ON claims(date, email)   WHERE status = 'active';

CREATE INDEX IF NOT EXISTS claims_by_date  ON claims(date, status);
CREATE INDEX IF NOT EXISTS claims_by_email ON claims(email, status);
CREATE INDEX IF NOT EXISTS audit_by_time   ON audit(timestamp);
