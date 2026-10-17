#!/usr/bin/env bash
# Weekly proof that the offsite backup chain restores; run by
# .github/workflows/restore-verify.yml on the homelab runner.
#
# Pulls the latest restic snapshot from R2, isolates the newest Immich
# PostgreSQL dump, restores it into a throwaway Postgres container, and
# checks that the schema is queryable. The heartbeat pings Uptime Kuma at the
# end so a missed verification fires the existing Telegram alert.
#
# Why immich-postgres: it is the one Postgres data service left in the
# fleet. Its dump needs the vchord extension, so the throwaway container
# runs the image that wrote it. The table threshold is intentionally low:
# we're proving the chain, not auditing data.
#
# Not covered: snapshot age (a stale snapshot still passes), the volume
# tarballs, and Vaultwarden's SQLite. See audit finding 10 in khe-meta.
set -euo pipefail

DUMP_NAME="immich-postgres.dump"
DB_NAME="immich"
SOURCE_CONTAINER="immich-postgres"
MIN_TABLES=20

ENV_FILE="$HOME/homelab/.env.offsite"
[ -f "$ENV_FILE" ] || { echo "missing $ENV_FILE"; exit 2; }
set -a
# shellcheck source=/dev/null
. "$ENV_FILE"
set +a

# shellcheck source=scripts/lib.sh
source "$(dirname "$0")/lib.sh"
heartbeat_init HEARTBEAT_URL_RESTORE_VERIFY
on_exit() {
  local code=$?
  docker rm -f pg-restore-verify >/dev/null 2>&1 || true
  rm -rf "$WORKDIR"
  if [ "$code" -eq 0 ]; then
    heartbeat up "tables=$TABLES"
  else
    heartbeat down "exit=$code stage=$STAGE"
  fi
}
STAGE="init"
TABLES=0
WORKDIR="$(mktemp -d)"
trap on_exit EXIT

STAGE="pg-image"
# The image that wrote the dump, already local. A copy here would
# drift from the compose pin.
PG_IMAGE="$(docker inspect -f '{{.Config.Image}}' "$SOURCE_CONTAINER")"
case "$PG_IMAGE" in
  ghcr.io/immich-app/postgres*) echo "Postgres image: $PG_IMAGE" ;;
  *) echo "FAIL: $SOURCE_CONTAINER runs '$PG_IMAGE', expected ghcr.io/immich-app/postgres"; exit 2 ;;
esac

STAGE="restic-restore"
# Restic snapshot path: /srv/backups/<date>/<dump-name>. Every
# dated copy carries the embeddings, so restore only the newest.
SNAPSHOT_LS="$(mktemp)"
restic ls latest --tag cron-daily > "$SNAPSHOT_LS"
SNAPSHOT_PATH="$(grep -E "^/srv/backups/[0-9]{4}-[0-9]{2}-[0-9]{2}/${DUMP_NAME}\$" "$SNAPSHOT_LS" \
  | sort | tail -1 || true)"
rm -f "$SNAPSHOT_LS"
[ -n "$SNAPSHOT_PATH" ] || { echo "no $DUMP_NAME in latest snapshot"; exit 3; }
restic restore latest \
  --target "$WORKDIR" \
  --include "$SNAPSHOT_PATH" \
  --tag cron-daily

DUMP_PATH="${WORKDIR}${SNAPSHOT_PATH}"
[ -s "$DUMP_PATH" ] || { echo "no dump restored"; exit 3; }
echo "Restored dump: $SNAPSHOT_PATH ($(du -h "$DUMP_PATH" | awk '{print $1}'))"

STAGE="docker-up"
docker run -d --rm \
  --name pg-restore-verify \
  --shm-size 512m \
  -e POSTGRES_PASSWORD=verify \
  "$PG_IMAGE"

# Wait for postgres ready — pg_isready returns 0 when accepting
# connections. 30s ceiling = generous; it starts in <5s.
STAGE="docker-wait"
for _ in $(seq 30); do
  if docker exec pg-restore-verify pg_isready -U postgres >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
docker exec pg-restore-verify pg_isready -U postgres

# The restore runs as the container's own postgres superuser, with
# --no-owner --no-acl, so no application role is needed.
STAGE="role-create"
docker exec pg-restore-verify psql -v ON_ERROR_STOP=1 -U postgres \
  -c "CREATE DATABASE ${DB_NAME};"

STAGE="pg-restore"
RESTORE_ERR="$WORKDIR/pg_restore.err"
if ! docker exec -i pg-restore-verify \
  pg_restore -U postgres -d "$DB_NAME" --no-owner --no-acl \
  < "$DUMP_PATH" 2> "$RESTORE_ERR"; then
  echo "FAIL: pg_restore exited non-zero. Last 20 lines of stderr:"
  tail -n 20 "$RESTORE_ERR"
  grep -i 'errors ignored on restore' "$RESTORE_ERR" || echo "(no 'errors ignored on restore' line)"
  exit 5
fi

STAGE="smoke-test"
TABLES="$(docker exec pg-restore-verify \
  psql -U postgres -d "$DB_NAME" -At -c \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")"
echo "Restored table count: $TABLES (threshold: $MIN_TABLES)"
if [ "$TABLES" -lt "$MIN_TABLES" ]; then
  echo "FAIL: too few tables — restore likely incomplete"
  exit 4
fi

STAGE="done"
echo "Restore verification OK."
