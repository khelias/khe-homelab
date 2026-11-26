#!/usr/bin/env bash
# Offsite backup: restic → Cloudflare R2.
# Runs after scripts/backup.sh (cron 03:00), assumes /srv/backups is fresh.
# Reads creds from ~/homelab/.env.offsite (mode 0600, .env.* gitignored).
# One-time setup: see infrastructure/offsite-backup.md.
set -uo pipefail

# Optional heartbeat ping — silently disabled if no URL configured.
# Setup: docs/operational-notes.md#backup-heartbeats. Source format:
#   HEARTBEAT_URL_OFFSITE=https://uptime-kuma.lan/api/push/<token>
# shellcheck source=scripts/lib.sh
source "$(dirname "$0")/lib.sh"
heartbeat_init HEARTBEAT_URL_OFFSITE
on_exit() {
  local code=$?
  if [ "$code" -eq 0 ]; then
    heartbeat up "OK"
  else
    heartbeat down "exit=$code"
  fi
}
trap on_exit EXIT

# Serialize: cron run at 03:00 + a manual run would contend on the restic
# repo lock. flock makes the late-comer exit cleanly instead of aborting
# deep inside restic with a confusing stale-lock trace.
LOCK_FILE="/tmp/offsite-backup.lock"
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "Another offsite-backup run holds $LOCK_FILE — exiting." >&2
  exit 3
fi

ENV_FILE="${HOME}/homelab/.env.offsite"
if [ ! -f "$ENV_FILE" ]; then
  echo "FATAL: missing $ENV_FILE — see infrastructure/offsite-backup.md" >&2
  exit 2
fi
if [ "$(stat -c %a "$ENV_FILE")" != "600" ]; then
  echo "FATAL: $ENV_FILE must be mode 0600" >&2
  exit 2
fi
set -a
# shellcheck source=/dev/null
source "$ENV_FILE"
set +a

: "${RESTIC_REPOSITORY:?not set in $ENV_FILE}"
: "${RESTIC_PASSWORD:?not set in $ENV_FILE}"
: "${AWS_ACCESS_KEY_ID:?not set in $ENV_FILE}"
: "${AWS_SECRET_ACCESS_KEY:?not set in $ENV_FILE}"

TODAY_DIR="/srv/backups/$(date +%Y-%m-%d)"
if [ ! -d "$TODAY_DIR" ]; then
  echo "FATAL: $TODAY_DIR missing — run scripts/backup.sh first" >&2
  exit 2
fi

echo "=== Offsite backup $(date -Iseconds) ==="
START_TS=$(date +%s)

# Repo must already exist. `restic init` is an intentional one-time step so
# we don't silently create a new repo on broken creds (which would look like
# everything worked right up until restore time).
if ! restic cat config >/dev/null 2>&1; then
  echo "FATAL: repo unreachable or not initialised." >&2
  echo "       Run once: restic init   (after loading $ENV_FILE)" >&2
  exit 2
fi

# Targets:
# - $TODAY_DIR     Etapp 1 output of today only: older dated dirs are in
#                  earlier snapshots already, and carrying them would make
#                  every kept snapshot hold a week of distinct days.
# - ~/homelab      VM-local .env files (not in git) needed for clean rebuild;
#                  .git is redundant (history lives on GitHub);
#                  service config dirs with root-owned files (adguard live
#                  yaml, mosquitto passwd) are captured via
#                  /srv/backups tarballs — excluded here because restic runs
#                  as khe, and one unreadable file makes restic exit 3, which
#                  skips the check below. mosquitto/data is only the
#                  broker's retained-message cache, rebuilt by its clients.
# - /srv/data/stories/audio  the bedtime stories' audio store (estate ADR-031),
#                  kept outside git, so this is its only copy off the VM.
echo "-> restic backup"
if ! restic backup \
       --compression auto \
       --tag cron-daily \
       --exclude "${HOME}/homelab/.git" \
       --exclude "${HOME}/homelab/services/core/adguard/config" \
       --exclude "${HOME}/homelab/services/home/mosquitto/config" \
       --exclude "${HOME}/homelab/services/home/mosquitto/data" \
       "$TODAY_DIR" \
       "${HOME}/homelab" \
       /srv/data/stories/audio; then
  echo "FAIL: restic backup" >&2
  exit 1
fi

# No forget or prune here: the R2 bucket lock refuses deletes outside locks/.
# Pruning is the attended quarterly step in infrastructure/offsite-backup.md.

# Reads one of 28 groups of packs a night, picked by days since the epoch, so
# every pack is read back every four weeks (R2 does not bill egress).
SUBSET=$(( $(date +%s) / 86400 % 28 + 1 ))
echo "-> restic check --read-data-subset=${SUBSET}/28"
CHECK_EXIT=0
if ! restic check --read-data-subset="${SUBSET}/28"; then
  echo "FAIL: restic check reported issues — inspect before next run" >&2
  CHECK_EXIT=1
fi

DURATION=$(( $(date +%s) - START_TS ))
echo
echo "=== Summary ==="
echo "Duration: ${DURATION}s"
restic snapshots --compact | tail -15

if [ "$CHECK_EXIT" -ne 0 ]; then
  exit 1
fi
echo "Offsite backup complete."
