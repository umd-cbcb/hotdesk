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

## Two things the script cannot do itself

**Lingering** — without it systemd stops the service when the session ends:

```bash
sudo loginctl enable-linger hotdesk
loginctl show-user hotdesk -p Linger     # expect Linger=yes
```

**The firewall** — until port 8080 is open, reach it over SSH:

```bash
ssh -N -L 8080:localhost:8080 nomad@cbcb-hotdesk.umiacs.umd.edu
```

then open <http://localhost:8080>. The request arrives on the VM's loopback, so
this works with the port closed, and is the fastest way to debug later.

## Importing the Google Sheet

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

`tools/backup.js` uses `VACUUM INTO`, which produces a consistent snapshot while
the service is running. Copying the live `.db` file does not — it can catch a
torn page or miss the write-ahead log, giving you a backup that only fails when
you try to restore it. Ask the sysadmin to back up `~hotdesk/backups/`, not
`~hotdesk/data/`.

To restore: stop the service, copy a snapshot over `~hotdesk/data/hotdesk.db`,
remove any `-wal` and `-shm` siblings, start it again.

## When the load balancer arrives

Set `TRUST_PROXY=1` in the unit so rate limiting sees real client addresses
rather than the balancer's, and `BASE_PATH=/hotdesk` if it is mounted on a path
rather than its own subdomain. Then `systemctl --user daemon-reload && restart`.
