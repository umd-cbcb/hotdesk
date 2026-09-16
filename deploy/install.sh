#!/usr/bin/env bash
#
# Install or update the hotdesk service. Run AS THE SERVICE USER:
#
#   sudo /usr/bin/machinectl shell hotdesk@
#   cd ~/app && ./deploy/install.sh
#
# Idempotent: safe to re-run to pick up a new release. Needs no root — the whole
# install lives in the service user's home, so the system Node 16 on this host
# is left alone.
set -euo pipefail

NODE_MAJOR="${NODE_MAJOR:-24}"
PREFIX="${PREFIX:-$HOME/.local/node}"
APP_DIR="${APP_DIR:-$HOME/app}"
DATA_DIR="${DATA_DIR:-$HOME/data}"
BACKUP_DIR="${BACKUP_DIR:-$HOME/backups}"

say() { printf '\n== %s\n' "$*"; }

say "Directories"
mkdir -p "$DATA_DIR" "$BACKUP_DIR" "$HOME/.config/systemd/user"
printf '  %s\n' "$APP_DIR" "$DATA_DIR" "$BACKUP_DIR"

if [ ! -x "$PREFIX/bin/node" ] || \
   ! "$PREFIX/bin/node" -e 'require("node:sqlite")' >/dev/null 2>&1; then
  say "Installing Node ${NODE_MAJOR}.x into $PREFIX"
  # The host ships Node 16, which is end-of-life and predates node:sqlite. This
  # is a private runtime for the service; nothing else on the box is touched.
  arch="$(uname -m)"; case "$arch" in
    x86_64) narch=x64 ;; aarch64|arm64) narch=arm64 ;;
    *) echo "unsupported architecture: $arch" >&2; exit 1 ;;
  esac

  version="${NODE_VERSION:-}"
  if [ -z "$version" ]; then
    version="$(curl -fsSL https://nodejs.org/dist/index.json \
      | tr '},' '\n' | grep -o '"version":"v'"$NODE_MAJOR"'\.[0-9.]*"' \
      | head -1 | cut -d'"' -f4)"
  fi
  [ -n "$version" ] || { echo "could not resolve a Node ${NODE_MAJOR} version" >&2; exit 1; }
  echo "  version $version ($narch)"

  tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
  tarball="node-${version}-linux-${narch}.tar.xz"
  curl -fsSL -o "$tmp/$tarball"  "https://nodejs.org/dist/${version}/${tarball}"
  curl -fsSL -o "$tmp/SHASUMS256.txt" "https://nodejs.org/dist/${version}/SHASUMS256.txt"

  # Verify before unpacking: this runs unattended on a machine we do not own.
  ( cd "$tmp" && grep " ${tarball}\$" SHASUMS256.txt | sha256sum -c - )
  echo "  checksum verified"

  rm -rf "$PREFIX"; mkdir -p "$PREFIX"
  tar -xJf "$tmp/$tarball" -C "$PREFIX" --strip-components=1
fi

NODE="$PREFIX/bin/node"
echo "  node $("$NODE" --version)"
"$NODE" -e 'require("node:sqlite")' || {
  echo "node:sqlite unavailable in this build — the service cannot run" >&2; exit 1; }
echo "  node:sqlite available"

say "Signing secret"
if [ ! -f "$APP_DIR/.env" ]; then
  # Persisted so restarts do not invalidate everyone's session.
  {
    printf 'HOTDESK_SECRET=%s\n' "$("$NODE" -e \
      'process.stdout.write(require("crypto").randomBytes(48).toString("base64url"))')"
    # Recorded here so the tools resolve the same database as the service. They
    # used to default to <app>/data, which silently created a second copy.
    printf 'DB_PATH=%s\n' "$DATA_DIR/hotdesk.db"
    printf 'BACKUP_DIR=%s\n' "$BACKUP_DIR"
  } > "$APP_DIR/.env"
  chmod 600 "$APP_DIR/.env"
  echo "  created $APP_DIR/.env"
else
  # An older .env has the secret but not the paths; add them without touching it.
  grep -q '^DB_PATH=' "$APP_DIR/.env" || printf 'DB_PATH=%s\n' "$DATA_DIR/hotdesk.db" >> "$APP_DIR/.env"
  grep -q '^BACKUP_DIR=' "$APP_DIR/.env" || printf 'BACKUP_DIR=%s\n' "$BACKUP_DIR" >> "$APP_DIR/.env"
  echo "  keeping existing $APP_DIR/.env"
fi

say "Tests"
( cd "$APP_DIR" && "$NODE" --test test/*.test.js >/dev/null ) \
  && echo "  all green" \
  || { echo "  TESTS FAILED — refusing to install a broken build" >&2; exit 1; }

say "systemd user units"
for unit in hotdesk.service hotdesk-backup.service hotdesk-backup.timer; do
  cp "$APP_DIR/deploy/$unit" "$HOME/.config/systemd/user/$unit"
  echo "  $unit"
done
systemctl --user daemon-reload
systemctl --user enable hotdesk.service
systemctl --user enable --now hotdesk-backup.timer

say "Restart"
# enable --now is a no-op on an already-running unit, so without this the new
# code is never loaded and the health check below would pass against the OLD
# process — a failed deploy that looks like a good one.
systemctl --user restart hotdesk.service

say "Health"
ok=""
for _ in $(seq 1 20); do
  if curl -fsS --max-time 2 localhost:8080/healthz > /tmp/hotdesk-health.$$ 2>/dev/null; then
    ok=1; break
  fi
  sleep 0.5
done
if [ -n "$ok" ]; then
  cat /tmp/hotdesk-health.$$; echo
  rm -f /tmp/hotdesk-health.$$
else
  echo "  service did not become healthy" >&2
  systemctl --user --no-pager status hotdesk.service | head -20 >&2
  journalctl --user -u hotdesk -n 30 --no-pager >&2
  exit 1
fi

say "Status"
systemctl --user --no-pager status hotdesk.service | head -8 || true

say "Next"
# A user may enable their own lingering without root: polkit's set-self-linger
# defaults to allow. Try it rather than telling the operator to find an admin.
if [ "$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null)" = "yes" ]; then
  echo "  lingering is on — the service survives logout and reboot"
else
  if loginctl enable-linger 2>/dev/null; then
    echo "  lingering enabled — the service survives logout and reboot"
  else
    echo "  LINGERING IS OFF. The service is running now, but it will stop when"
    echo "  this session ends and will not return after a reboot. Ask the"
    echo "  sysadmin to run:  loginctl enable-linger $(id -un)"
  fi
fi

cat <<NEXT

  If this is a fresh install the roster is empty, so nobody can sign in yet —
  including you. Load the desks and create your account with:

      $PREFIX/bin/node $APP_DIR/tools/bootstrap.js \\
          --moderator you@umd.edu --name "Your Name"

  Until the firewall port is open, reach the board over an SSH tunnel:

      ssh -N -L 8080:localhost:8080 nomad@$(hostname -f)

  then open http://localhost:8080
NEXT
