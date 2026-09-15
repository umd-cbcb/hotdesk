# CBCB Hotdesk

A desk-booking board for a shared graduate lab: one Node service on a UMIACS VM,
serving both the page and its API from SQLite.

```
Browser  ──HTTP──▶  cbcb-hotdesk.umiacs.umd.edu:8080  ──▶  SQLite
                    one process: static files + /api        one file
```

Same origin for page and API, so there is no CORS and no mixed content, and it is
the shape the UMIACS load balancer will front at `hotdesk.cbcb.umd.edu`. No
runtime dependencies: SQLite is built into Node 22.5+, so there is nothing to
`npm install`, nothing to rebuild on a Node upgrade, and no lockfile to rot.

The booking rules that matter most under contention — one claim per desk per day,
one desk per person per day — are unique indices in the schema, not application
checks.

## Try it locally

```bash
npm run dev
```

Open <http://localhost:8080> and sign in with one of the codes it prints:

| Code | Who |
| --- | --- |
| `ROB123` | Rob — **moderator**, so the Moderator button appears |
| `PRIYA1` | Priya Raman — has desk 7 today and has checked in |
| `MARC01` | Marcus Hale — booked desk 18 today but never checked in |
| `LINW01` | Lin Wei — has desk 12 booked for tomorrow |
| `SAM001` | Sam Okafor — has desk 26 today, checked in |

This is the **same server that runs in production**, against a throwaway seeded
database in a temp directory. No VPN, no VM, nothing to install — SQLite is built
into Node. Two things worth doing while it runs:

- **Open a private window and sign in as someone else.** Claim the same desk from
  both and watch the loser get *"… was just claimed by someone else."*
- **Run it after 11am.** Marcus's desk 18 will already be back in the pool. That is
  the no-show sweep, and it is the whole reason this exists.

```bash
npm test        # 48 tests: the booking rules, the wire contract, and concurrency
```

## Setup

The service runs on `cbcb-hotdesk.umiacs.umd.edu`, a UMIACS VM reachable on the
VPN. See **[deploy/README.md](deploy/README.md)** for installing it, importing the
old Google Sheet, backups, and how to reach it over an SSH tunnel before the
firewall port is open.

## Managing people

The moderator panel does three things to the roster.

**Add one person** with the small form — they get a generated access code shown
once you save.

**Add a cohort from a CSV.** Drop in a file (or paste rows) with an `email`
column; `name`, `lab`, `role` and `code` are optional. Common header spellings
are accepted — `E-mail`, `Full Name`, `Advisor` all work, because rosters arrive
in whatever shape the department sent them.

It always previews first: every row is listed with what will happen to it —
**add**, **update**, or **skip** with the reason and the line number, so a
mis-mapped column is visible *before* anything is written. Nothing is saved
until you press Apply. People already on the roster keep their existing access
code, so re-importing a list never locks anyone out.

**Deactivate someone who has left.** Set them inactive rather than deleting the
row: deleting would destroy the claim history the occupancy numbers rest on, and
the foreign keys refuse it anyway. Deactivating

- stops them signing in, and ends any session they already have,
- **releases every desk they hold from today onward** — a graduating student
  should not keep a desk booked, and nobody would think to go and force-release
  them one at a time,
- keeps their history intact, and is reversible.

The last active moderator cannot switch themselves off, because the only way
back from that is a shell on the server.

## Look and feel

There is no established design system for desk booking, so this is a small
purpose-built one, defined entirely as tokens at the top of
[`docs/css/app.css`](docs/css/app.css). Two rules hold it together:

**Brand colour never competes with status colour.** UMD red and gold appear only
as the rule under the masthead and on destructive actions. If red also meant
"a desk", red would read as *unavailable* and the board would mislead you at a
glance — so desk states get their own semantic ramp.

**The scarce state is the loud one.** At ~10% occupancy nearly every desk is
free, so free is calm and legible while occupied reads as solidly blocked. Yours
gets a halo ring, because finding your own desk among 29 should take one sweep of
the eye.

**Status is never carried by hue alone.** Each state pairs colour with fill
density and a border treatment, so the board still parses with any form of colour
blindness, on a projector, or in sunlight by the window:

| State | Colour | Fill | Border |
| --- | --- | --- | --- |
| Free | green | tint | solid |
| Yours | blue | solid | solid + halo |
| In use | grey | solid | solid |
| Claimed, not arrived | amber | tint | **dashed** |
| Unavailable | grey | **hatched** | solid |

The desk markers are round tokens sized as a share of the *map* rather than the
viewport (`6.4cqw`), so they keep their proportions from a phone to the wall
display. The closest two desks are 9.16% of the plan's width apart, which is what
sets that number. Each carries a knockout ring in the plan's paper colour so it
stays crisp where it sits on the linework.

Every foreground/background pair is at least 4.5:1 in both themes (measured, not
estimated). A legend on the board teaches the key.

### Light, dark and system

The button in the masthead cycles **system → light → dark**. "System" is the
default and stores nothing; an explicit choice is saved to `localStorage` and
wins over the OS in both directions. A tiny script in `<head>` applies the stored
choice before first paint, so there is no flash of the wrong theme.

The floor plan is injected into the page as inline SVG rather than an `<img>`,
which lets its linework read the `--plan-ink` and `--plan-paper` tokens and follow
the theme. It is drawn deliberately light (3.9:1 light, 3.1:1 dark) because it is
*context*: the desks are the content, and a full-contrast CAD drawing competes
with them. Its
strokes use `vector-effect: non-scaling-stroke`, so the drawing stays a true
hairline on a phone and on a wall display alike. A raster plan cannot follow a
theme, so if one is ever configured instead it keeps a white sheet under it in
both themes — the same compromise maps make.

## How the booking rules work

| Setting | Default | Meaning |
| --- | --- | --- |
| `releaseTime` | `17:00` | When the far edge of the booking horizon unlocks |
| `horizonDays` | `1` | Day *D* opens at `releaseTime` on day *D − horizonDays*. At `1`, tomorrow unlocks at 5pm today |
| `maxOpenClaims` | `3` | Upcoming days one person may hold at once |
| `checkInDeadline` | `11:00` | Claims not checked in by then are auto-released |
| `checkInEnabled` | `TRUE` | Turn the no-show sweep off entirely |
| `allowSameDayClaim` | `TRUE` | Any free desk can be grabbed on the spot |

Plus, always: one desk per person per day, and a walk-up claim counts as its own
check-in — you are standing at the desk.

**The check-in rule is the part that matters.** Without it you rebuild the problem you
already have, just with a website in front of it: people claim optimistically on Sunday
night and the room is still empty on Tuesday. With it, an unclaimed desk becomes
available at 11am to whoever actually walked in.

### Suggestions worth considering

- **Start permissive.** `horizonDays: 1`, no cap enforcement in practice, check-in on.
  Tighten only if you see real contention. At 10% occupancy you may find you never do.
- **Keep a few reserved desks.** Set `reservedFor` on a desk to a student's email for
  people with a genuine fixed need — hardware, accommodation, thesis endgame. Naming
  the exceptions openly is what makes the rest politically survivable.
- **Lean on visibility, not enforcement.** Every desk shows who has it, and the
  moderator roster shows each person's shown-up ratio. In a group this size that is
  more effective than any penalty, and cheaper to administer.
- **Put the board on a wall display** by the door. It refreshes every minute on its own.
- **Revisit after one semester** with the `Claims` tab as evidence. You will have a real
  occupancy number instead of an estimate, which is the argument you actually need.

---

## Files

| Path | Purpose |
| --- | --- |
| `server/index.js` | HTTP: static files and `POST /api`, one origin |
| `server/api.js` | The action handlers and the response envelope |
| `server/domain.js` | Pure booking rules — claim windows, sweep, reliability |
| `server/db.js` | The only module touching SQLite |
| `server/schema.sql` | Tables, and the indices that enforce the booking rules |
| `server/auth.js` | Codes, signed tokens, per-client rate limiting |
| `test/` | 48 tests: rules, wire contract, and real multi-process concurrency |
| `tools/import-sheets.js` | One-time migration from the Google Sheet |
| `tools/backup.js` | Consistent snapshot via `VACUUM INTO` |
| `deploy/` | systemd units and the installer |
| `apps-script/` | The retired Sheets backend, kept until the VM is proven |
| `docs/index.html` | Single page: sign-in, board, moderator tools |
| `docs/js/config.js` | The only file you must edit — API URL and floor plan path |
| `docs/css/app.css` | Design tokens and components; the palette lives at the top |
| `docs/js/theme.js` | The light / dark / system control |
| `docs/js/api.js` | Request wrapper (kept "simple" so Apps Script CORS works) |
| `docs/js/app.js` | Board: day strip, floor plan, list, claim/release/check-in |
| `docs/js/admin.js` | Moderator settings, roster, desks, upcoming claims |
| `docs/tools/desk-mapper.html` | Click-to-place desk coordinate editor |
| `docs/robots.txt` | Keeps the board out of search results |
| `docs/assets/floorplan.svg` | The facilities plan of IRB 3112, imported (do not hand-edit) |
| `docs/assets/desks.tsv` | The 29 desks and their map positions, imported |
| `dev/import-floorplan.py` | Rebuilds both of the above from the facilities PDF |
| `dev/check-desks.py` | CI check that the desk list and the map agree |
| `.github/workflows/pages.yml` | Checks the bundle, injects the endpoint, deploys to Pages |

## Why this moved off Google Sheets

The Sheets backend worked, but the store kept leaking into the behaviour. Sheets
silently converted a typed `17:00` into a `Date` on the 1899 epoch, so a
check-in deadline of `10:00` quietly enforced `11:00`. Enforcing "one desk per
person per day" meant a 15-second global script lock around a row scan. And the
OAuth consent screen asked for access to *every spreadsheet in the owner's
Drive* until the scopes were pinned by hand.

None of those are Sheets being bad at being a spreadsheet; they are what happens
when a spreadsheet is asked to be a database. The two rules most likely to break
under contention are now unique indices, so the database refuses a double
booking rather than trusting the application to check first.

## Limits to know about

- The VM is reachable on the UMIACS VPN only until the load balancer fronts it.
  Until then, claiming a desk from home means connecting to the VPN first.
- `node:sqlite` is still flagged experimental. Every call goes through
  `server/db.js`, so moving to `better-sqlite3` means rewriting one file.
- Backups are snapshots in `~hotdesk/backups/`. The live database file is not
  itself backed up, and copying it while the service runs is not safe — use
  `tools/backup.js`.
- Access codes are bearer secrets. They are fine for a lab; they are not fine for
  anything involving grades, money, or personal data. If this ever needs to be
  stronger, the login step is the only piece that has to change.
- The failed-login throttle is global, not per person, so a determined nuisance
  could lock sign-in for ten minutes at a time. That is the right trade for a lab
  board; Apps Script cannot see client IPs, so per-user throttling is not
  available without adding real accounts.
