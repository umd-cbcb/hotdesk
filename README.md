# CBCB Hotdesk

A desk-booking board for a shared graduate lab: static frontend on GitHub Pages,
Google Sheet as the database, Apps Script as the API.

```
Browser (GitHub Pages, docs/)  ──HTTPS──▶  Apps Script Web App  ──▶  Google Sheet
        no secrets in the repo                all the rules here      the data
```

Nothing sensitive ships in the repo. Access codes, the roster and every write rule
live in Apps Script, which is the only thing that ever touches the sheet.

---

## Try it first, without Google

```bash
node dev/demo-server.js
```

Open <http://localhost:8931> and sign in with one of the codes it prints:

| Code | Who |
| --- | --- |
| `ROB123` | Rob — **moderator**, so the Moderator button appears |
| `PRIYA1` | Priya Raman — has A1 today and has checked in |
| `MARC01` | Marcus Hale — booked C3 today but never checked in |
| `LINW01` | Lin Wei — has B4 booked for tomorrow |
| `SAM001` | Sam Okafor — has R2 today, checked in |

This is a faithful in-memory stand-in for the Apps Script API: the same claim
windows, the same one-desk-per-person-per-day rule, the same cap, the same
check-in and no-show sweep. Nothing is saved — stop it and it resets.

Two things worth doing while it is running:

- **Open a private window and sign in as someone else.** Claim the same desk from
  both and watch the loser get *"… was just claimed by someone else."* That is
  the contention case, which is the one people will ask you about.
- **Run it after 11am.** Marcus's C3 will already be back in the pool when you
  load the board. That is the no-show sweep, and it is the whole reason the
  system does anything your current spreadsheet does not.

The real access codes come from the `Roster` tab once you do the setup below —
`setupSheets()` generates yours and puts you in as a moderator.

---

## Setup (about 20 minutes)

### 1. Create the sheet and the API

1. Make a new Google Sheet. Name it something like `CBCB Hotdesk Data`.
2. **Extensions → Apps Script**. Delete the placeholder file and paste in
   [`apps-script/Code.gs`](apps-script/Code.gs). Rename the project from
   *Untitled project* to `CBCB Hotdesk` — the project name is what the consent
   screen shows, and "Untitled project wants access to your Google Account" is
   needlessly alarming.
3. **Pin the permissions before you authorise anything.** In the editor, gear
   icon → tick *Show "appsscript.json" manifest file in editor*, open the file
   that appears, and replace its whole contents with
   [`apps-script/appsscript.json`](apps-script/appsscript.json). Paste it
   verbatim — Apps Script rejects the manifest outright if it contains any field
   it does not recognise, so do not add comments to it. See
   [What the script is allowed to touch](#what-the-script-is-allowed-to-touch)
   for why this matters.
4. Run the `setupSheets` function once (pick it from the dropdown, press Run,
   approve the permission prompt). It creates the `Config`, `Roster`, `Desks`,
   `Claims` and `Audit` tabs, seeds sensible defaults, adds you to the roster as a
   moderator, and installs the daily no-show sweep. Check that the email on your
   roster row is right before signing in.
5. **Deploy → New deployment → Web app**
   - *Execute as*: **Me**
   - *Who has access*: **Anyone**
   - Copy the `…/exec` URL.

> **"Anyone" is required — do not change it to a UMD-only setting.** It sounds
> alarming, but it only means the endpoint is reachable without a *Google* login.
> Every request still has to present a valid access code, checked server-side
> against the roster.
>
> Restricting access to the university domain looks like an upgrade and is
> actually a break. Two things fail:
>
> 1. An unauthenticated `fetch` is redirected to `accounts.google.com`, so the
>    page receives an HTML login screen instead of JSON.
> 2. Apps Script only sends `Access-Control-Allow-Origin: *` for anonymous
>    deployments, and `*` is invalid for credentialed cross-origin requests. A
>    browser on `umd-cbcb.github.io` therefore cannot send Google's cookies to
>    `script.google.com` at all. No setting fixes this; it is how CORS works.
>
> Wanting real UMD identity is reasonable — shared codes never expire and never
> offboard. The way to get it *without* breaking the static site is Google
> Sign-In on the page (the page obtains an ID token; Apps Script verifies its
> signature and checks the email domain before issuing a session), with the web
> app still deployed as "Anyone". That needs an OAuth client ID, and it needs
> your students to actually live in one Google Workspace domain — worth checking
> with campus IT, since UMD has historically split Google and Microsoft across
> populations. Deferred for the pilot.

### 2. Publish the frontend

1. **Settings → Pages → Source: GitHub Actions.**
2. **Settings → Secrets and variables → Actions → Variables → New variable:**
   `HOTDESK_API_URL` = the `/exec` URL from step 1.
   (Optional: `HOTDESK_FLOORPLAN`, if your plan is not `assets/floorplan.svg`.)
3. Push anything to `main`, or run the **Deploy board** workflow by hand.
   The site appears at <https://umd-cbcb.github.io/hotdesk/>.

The endpoint is injected at deploy time, so it never lives in the source. That is
not secrecy — anyone who loads the site can read it in devtools — but it keeps the
URL out of GitHub code search and off the scrapers that trawl public repositories,
and rotating it later is a settings change rather than a commit.

The workflow also refuses to deploy a bundle whose floor plan and desk coordinates
disagree with their generator, which is the one way a hand-edit could silently put
every pin in the wrong place. That check stands down by itself once you drop in a
real floor plan (see step 3).

> **The repository has to be public.** GitHub Pages only builds from a private
> repository on a paid plan, and `umd-cbcb` is on the free org plan. Note also
> that a Pages site is publicly reachable on *every* plan below Enterprise Cloud
> — paying would hide the source, not the site. Since the repo holds no secrets
> by design, public is the honest choice rather than a compromise.
>
> Because the site is public, `apiLogin_` throttles failures globally: 20 wrong
> codes in 10 minutes and sign-in pauses for everyone until the window rolls
> over. A student mistyping their code never gets near that.

### 3. Add your floor plan and desks

A placeholder plan of **IRB 3112** ships with the repo — 29 desks, laid out as
4 along the left wall, two back-to-back rows of 10 down the middle, and 5 along
the right wall. Desks are labelled `L1`–`L4`, `A1`–`A5` / `B1`–`B5` (row 1),
`C1`–`C5` / `D1`–`D5` (row 2), and `R1`–`R5`, so a desk is one short thing you
can say out loud. The full ids carry the room (`IRB3112-C3`) in case a second
room joins later.

To adjust the placeholder — different counts, a different arrangement — edit
`LAYOUT` at the top of `dev/make-floorplan.py` and re-run it:

```bash
python3 dev/make-floorplan.py
```

It rewrites both the SVG and `docs/assets/demo-desks.tsv` from the same
description, so the picture and the coordinates cannot drift apart.

When the real plan arrives:

1. Save it as `docs/assets/floorplan.png` and set the `HOTDESK_FLOORPLAN`
   repository variable to `assets/floorplan.png`.
2. Open `tools/desk-mapper.html`, load the same image, click each desk, name it,
   drag to nudge.
3. Copy the generated rows into cell **A1** of the `Desks` tab.
4. Delete `docs/assets/floorplan.svg`, or just remove its
   `generated by dev/make-floorplan.py` marker line. That tells CI you have taken
   the plan over by hand and it stops checking it against the generator.

Coordinates are percentages, so the map stays correct on a phone and on the
wall-mounted display.

### A note on times in the Config tab

Type `17:00` into a Sheets cell and Sheets helpfully converts it into a *time
value*, which the script then receives as a `Date` on the spreadsheet epoch
(30 December 1899). `setupSheets()` now pins the Config `value` column to plain
text so this cannot happen, and the script normalises anything it is given —
`17:00`, `5:00 PM`, `17:00:00`, or a coerced Date — down to `HH:mm`.

If your sheet predates that fix, run **`repairConfigTimes`** once from the Apps
Script editor. It pins the column and rewrites the values in place.

An unreadable time is now reported rather than silently replaced with the
built-in default: moderators see it on the board as *"Check the Config tab: …"*.
The earlier behaviour was worse than the cosmetic bug it came with — a
`checkInDeadline` of `10:00` that failed to parse quietly enforced `11:00`
instead, with nothing on screen to say so.

### Editing the roster later

The roster is read live on every request, so edits to the `Roster` tab take
effect immediately — nothing to redeploy, no cache to clear.

Two things to watch:

- **`email` is the identity key.** Claims, the audit log and the shown-up ratio
  are all keyed on it. Changing someone's address orphans their existing rows, so
  if they already hold desks, update the `email` column in `Claims` to match, or
  release those claims first. Keep addresses unique across the roster.
- **Changing an address logs that person out.** Their session token carries the
  old address, so the next request fails and they simply sign in again with the
  same code. The code itself does not change.

To retire someone, set `active` to `FALSE` rather than deleting the row — that
keeps their history intact for the occupancy numbers.

### 4. Add students

Sign in with your own code (it is in the `Roster` tab), open **Moderator**, and add
people one at a time — each gets a generated 6-character code. For a whole cohort it
is faster to paste rows straight into the `Roster` tab; leave `code` blank and fill it
in with `=UPPER(LEFT(BASE(RANDBETWEEN(1000000,99999999),32),6))`, then paste-special
as values.

---

## Local preview against the real data

```bash
python3 -m http.server 8000 --directory docs
```

Then open `http://localhost:8000/`. The API is remote, so this hits your live
sheet — use `dev/demo-server.js` instead if you just want to poke at the UI.

---

## What the script is allowed to touch

Apps Script infers OAuth scopes from your code, and it is deliberately
conservative: a project that declares nothing gets asked to approve **"See, edit,
create, and delete all your Google Sheets spreadsheets."** That is far more than
this needs, and you should not wave it through.

The code only ever reaches its own container, through
`SpreadsheetApp.getActiveSpreadsheet()`. It never calls `openById` or
`openByUrl`, and it never touches Drive, Gmail, or Calendar — you can check with:

```bash
grep -nE '\b(DriveApp|GmailApp|MailApp|CalendarApp|UrlFetchApp|openById|openByUrl)\b' apps-script/Code.gs
```

So [`appsscript.json`](apps-script/appsscript.json) pins the two accurate scopes
instead of letting them be guessed:

| Scope | Consent screen wording | Why |
| --- | --- | --- |
| `spreadsheets.currentonly` | "only the specific spreadsheet this application is used in" | Read and write the hotdesk sheet — and nothing else in your Drive |
| `script.scriptapp` | "run when you are not present" | The daily 11am no-show sweep |

**Verify it took.** Before authorising, the consent screen should say *only the
specific spreadsheet*, not *all your Google Sheets spreadsheets*. If it still says
"all", the manifest did not save — re-check step 3 and make sure you replaced the
file rather than adding a second one.

**If the narrow scope turns out not to work** (you would see an authorisation
error the first time the deployed web app tries to read the sheet, not at setup
time), widen just the first entry to
`https://www.googleapis.com/auth/spreadsheets` and re-deploy. That is the exact
permission Google was going to ask for anyway, so you lose nothing by trying the
narrow one first.

**If you would rather not grant the trigger scope at all**, drop
`script.scriptapp` from the manifest and delete `installTriggers_` and
`sweepNoShowsTrigger` from `Code.gs`. The no-show sweep also runs lazily whenever
anyone loads the board, so desks still free up; you would only lose the case where
nobody opens the page all morning.

Two things worth knowing regardless. Changing scopes requires a **new
deployment** and a fresh authorisation — an existing grant does not shrink on its
own, so revoke the old one at
[myaccount.google.com/permissions](https://myaccount.google.com/permissions).
And this consent screen is yours alone: the web app runs as you, so students never
see it and never grant anything.

## Look and feel

There is no established design system for desk booking, so this is a small
purpose-built one, defined entirely as tokens at the top of
[`docs/css/app.css`](docs/css/app.css). Two rules hold it together:

**Brand colour never competes with status colour.** UMD red and gold appear only
as the rule under the masthead and on destructive actions. If red also meant
"a desk", red would read as *unavailable* and the board would mislead you at a
glance — so desk states get their own semantic ramp.

**Status is never carried by hue alone.** Each state pairs a colour with a border
treatment and a glyph, so the board still parses with any form of colour
blindness, on a projector, or in sunlight by the window:

| State | Colour | Border | Glyph |
| --- | --- | --- | --- |
| Free | green | solid | — |
| Yours | solid blue fill | solid | ★ |
| In use | grey | solid | ● |
| Claimed, not arrived | amber | **dashed** | ○ |
| Unavailable | grey | **hatched** | ✕ |

Every foreground/background pair is at least 4.5:1 in both themes (measured, not
estimated). A legend on the board teaches the key.

### Light, dark and system

The button in the masthead cycles **system → light → dark**. "System" is the
default and stores nothing; an explicit choice is saved to `localStorage` and
wins over the OS in both directions. A tiny script in `<head>` applies the stored
choice before first paint, so there is no flash of the wrong theme.

The placeholder floor plan is injected into the page as inline SVG rather than an
`<img>`, which lets it read the same `--plan-*` tokens and follow the theme. A
raster plan cannot do that, so when you swap in a photo or scan of the real room
it keeps a white sheet under it in both themes — the same compromise maps make.

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
| `apps-script/Code.gs` | The whole backend: auth, claiming, no-show sweep, moderator API |
| `apps-script/appsscript.json` | Web app deployment manifest |
| `docs/index.html` | Single page: sign-in, board, moderator tools |
| `docs/js/config.js` | The only file you must edit — API URL and floor plan path |
| `docs/css/app.css` | Design tokens and components; the palette lives at the top |
| `docs/js/theme.js` | The light / dark / system control |
| `docs/js/api.js` | Request wrapper (kept "simple" so Apps Script CORS works) |
| `docs/js/app.js` | Board: day strip, floor plan, list, claim/release/check-in |
| `docs/js/admin.js` | Moderator settings, roster, desks, upcoming claims |
| `docs/tools/desk-mapper.html` | Click-to-place desk coordinate editor |
| `docs/robots.txt` | Keeps the board out of search results |
| `docs/assets/floorplan.svg` | Placeholder plan of IRB 3112 (generated) |
| `docs/assets/demo-desks.tsv` | The 29 desks, with coordinates matching that plan (generated) |
| `dev/make-floorplan.py` | Regenerates both of the above from one layout description |
| `dev/demo-server.js` | Offline stand-in for the API, for trying the site out |
| `.github/workflows/pages.yml` | Checks the bundle, injects the endpoint, deploys to Pages |

## Limits to know about

- Apps Script allows ~20,000 web app calls and 90 minutes of runtime per day on a
  consumer account, and more on Workspace. A 100-student lab uses a small fraction.
- Requests take roughly 0.5–1.5s. That is Apps Script, not the code.
- Claiming is serialised with `LockService`, so two people tapping the same desk at
  5:00:00pm cannot both get it.
- Access codes are bearer secrets. They are fine for a lab; they are not fine for
  anything involving grades, money, or personal data. If this ever needs to be
  stronger, the login step is the only piece that has to change.
- The failed-login throttle is global, not per person, so a determined nuisance
  could lock sign-in for ten minutes at a time. That is the right trade for a lab
  board; Apps Script cannot see client IPs, so per-user throttling is not
  available without adding real accounts.
