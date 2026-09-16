# Deploying to cbcb-hotdesk.umiacs.umd.edu

One Node process serves both the board and its API from SQLite. No reverse
proxy, no database server, no runtime dependencies.

## Why a private Node

The host ships **Node 16**, which is end-of-life and predates `node:sqlite`.
`install.sh` fetches a pinned Node 24 into `~hotdesk/.local/node`, verifying the
checksum first. Nothing outside the service user's home is touched, so the
system Node stays available for anything else on the box.

## First install

```bash
sudo /usr/bin/machinectl shell hotdesk@
git clone https://github.com/umd-cbcb/hotdesk.git ~/app
cd ~/app && ./deploy/install.sh
```

The script is idempotent — re-run it to deploy a new release. It refuses to
install if the tests fail.

Layout it creates:

| Path | Contents |
| --- | --- |
| `~hotdesk/app` | this repository |
| `~hotdesk/data/hotdesk.db` | the live database |
| `~hotdesk/backups/` | nightly snapshots — **this is what needs backing up** |
| `~hotdesk/app/.env` | the signing secret, mode 600 |

## The one thing the script cannot do itself

**Lingering** — without it systemd stops the service when the session ends and
it does not come back after a reboot. `install.sh` enables it for itself, which
needs no root because polkit's `set-self-linger` defaults to allow. Confirm:

```bash
loginctl show-user hotdesk -p Linger     # expect Linger=yes
```

If it ever reads `no`, ask the sysadmin to run `loginctl enable-linger hotdesk`.

**The firewall.** Until port 8080 is open, reach it over SSH:

```bash
ssh -N -L 8080:localhost:8080 nomad@cbcb-hotdesk.umiacs.umd.edu
```

then open <http://localhost:8080>. The request arrives on the VM's loopback, so
this works with the port closed, and is the fastest way to debug later.

## First run: load the desks and create yourself

A new database is empty, so nobody can sign in — including you.

```bash
~/.local/node/bin/node ~/app/tools/bootstrap.js \
    --moderator you@umd.edu --name "Your Name"
```

It loads the 29 desks from `docs/assets/desks.tsv`, creates you as a moderator
and prints your access code. Idempotent: re-running upserts the desks and leaves
an existing person's code alone, so it is safe after an upgrade.

Everyone else goes in from the Moderator panel — one at a time, or a whole cohort
from a CSV.

## Importing the Google Sheet (only if you want the old history)

Download each tab as CSV into one directory (`Config.csv`, `Roster.csv`,
`Desks.csv`, `Claims.csv`, `Audit.csv`), then:

```bash
node tools/import-sheets.js ~/export --db=$HOME/data/hotdesk.db
```

It reports what it loaded, and names any claim that referenced a desk or person
which no longer exists — those were invisible orphans in the sheet that still
counted against a person's one-desk-per-day limit.

## Day to day

```bash
systemctl --user status hotdesk            # is it up
journalctl --user -u hotdesk -f            # logs
systemctl --user restart hotdesk           # after a deploy
systemctl --user list-timers hotdesk-backup.timer
node tools/backup.js                       # snapshot right now
```

## Backups

`tools/backup.js` runs nightly at 03:30 from a systemd timer and writes a
consistent snapshot into `~hotdesk/backups/`, keeping 14 days. It uses
`VACUUM INTO`, which is safe while the service is running; copying the live
`.db` file is not, because it can catch a torn page or miss the write-ahead log
and give you a backup that only fails when you try to restore it.

### What to ask the sysadmin to back up

| | |
| --- | --- |
| **Back up** | `/home/hotdesk/backups/` |
| **Skip** | `/home/hotdesk/data/` — the live database |
| **Frequency** | nightly; anything daily or better is fine |
| **Size** | ~1 MB per academic year; a snapshot gzips under 200 KB; the 14 retained total ~13 MB |

The point worth making to them is that **nothing database-aware is required on
their side**. By the time their backup runs, the snapshots are ordinary static
files. There is no need to stop the service and no serialization problem for
them to solve — we have already handled it here.

What is not reproducible from the repository: the roster, each person's access
code, and the booking history. The desks and the floor plan can be regenerated
with `dev/import-floorplan.py`. Losing a day of bookings would be an
inconvenience; losing a semester of history would lose the occupancy evidence
this project exists to produce.

### Restoring

Stop the service, copy a snapshot over the live database, remove any stale
write-ahead files, start it again:

```bash
systemctl --user stop hotdesk
cp ~/backups/hotdesk-<timestamp>.db ~/data/hotdesk.db
rm -f ~/data/hotdesk.db-wal ~/data/hotdesk.db-shm
systemctl --user start hotdesk
curl -s localhost:8080/healthz     # the desk count confirms which database is live
```

## When the load balancer arrives

Set `TRUST_PROXY=1` in the unit so rate limiting sees real client addresses
rather than the balancer's, and `BASE_PATH=/hotdesk` if it is mounted on a path
rather than its own subdomain. Then `systemctl --user daemon-reload && restart`.
