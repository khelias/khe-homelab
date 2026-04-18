#!/usr/bin/env bash
# Offsite backup: restic → Cloudflare R2.
# Runs after scripts/backup.sh (cron 03:00), assumes /srv/backups is fresh.
# Reads creds from ~/homelab/.env.offsite (mode 0600, *.env gitignored).
# One-time setup: see infrastructure/offsite-backup.md.
set -uo pipefail

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

if [ ! -d /srv/backups ]; then
  echo "FATAL: /srv/backups missing — run scripts/backup.sh first" >&2
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
# - /srv/backups   Etapp 1 daily output — primary payload
# - ~/homelab      VM-local .env files (not in git) needed for clean rebuild;
#                  .git is redundant (history lives on GitHub);
#                  service config dirs with root-owned files (adguard live
#                  yaml) are captured via /srv/backups tarballs — excluded
#                  here because restic runs as khe.
echo "-> restic backup"
if ! restic backup \
       --compression auto \
       --tag cron-daily \
       --exclude "${HOME}/homelab/.git" \
       --exclude "${HOME}/homelab/services/core/adguard/config" \
       "/srv/backups" \
       "${HOME}/homelab"; then
  echo "FAIL: restic backup" >&2
  exit 1
fi

echo "-> restic forget --prune"
if ! restic forget \
       --prune \
       --keep-daily 7 \
       --keep-weekly 4 \
       --keep-monthly 12; then
  echo "FAIL: restic forget/prune" >&2
  exit 1
fi

# Metadata integrity check. Full data verification (--read-data) is a
# separate monthly cron — too much egress for daily, even on R2 which
# doesn't bill egress.
echo "-> restic check (metadata)"
CHECK_EXIT=0
if ! restic check; then
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
