#!/usr/bin/env bash
# Daily local backup: PostgreSQL dumps + named volumes + small host bind mounts.
# Continues on per-item failures so one broken target can't mask the rest;
# exits non-zero if anything failed so cron mail / monitoring surfaces it.
#
# Encryption is NOT applied here — offsite tier (restic) handles that.
# Large user data (Immich uploads, Jellyfin media) is deliberately excluded:
#   - Immich: already mirrored to iCloud + Google Photos
#   - Jellyfin / Audiobookshelf media: re-rippable
#
# Known risk: volumes containing live SQLite (uptime-kuma, npm, n8n, dockge,
# audiobookshelf) are tarred while the writing process is running. SQLite
# journal replay handles most crashes on restore, but a snapshot captured
# mid-transaction is not guaranteed consistent. Acceptable for this homelab
# — fixing it properly requires per-service quiesce or SQLite .backup API.
set -uo pipefail

BACKUP_ROOT="${BACKUP_ROOT:-/srv/backups}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-7}"
BACKUP_DIR="${BACKUP_ROOT}/$(date +%Y-%m-%d)"

if ! mkdir -p "$BACKUP_DIR"; then
  echo "FATAL: cannot create $BACKUP_DIR" >&2
  exit 2
fi
if [ ! -w "$BACKUP_DIR" ]; then
  echo "FATAL: $BACKUP_DIR not writable" >&2
  exit 2
fi

echo "=== Backup $(date -Iseconds) ==="
START_TS=$(date +%s)

FAILURES=()
fail() {
  FAILURES+=("$1")
  echo "FAIL: $1" >&2
}

# Pre-prune old dated dirs BEFORE writing today's backup so a near-full disk
# doesn't fail today's run when yesterday's copy could have been freed.
find "$BACKUP_ROOT" -maxdepth 1 -type d -name '????-??-??' \
  ! -path "$BACKUP_DIR" -mtime +"$RETENTION_DAYS" -exec rm -rf {} +

container_running() {
  docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null | grep -q '^true$'
}

volume_exists() {
  docker volume inspect "$1" >/dev/null 2>&1
}

# Run tar inside alpine so we don't depend on host permissions or host tar.
# Daemon runs as root, so the mounted source is always readable regardless
# of on-disk ownership. Writes stderr to a sidecar .err file we only keep
# if the archive fails — matches the pg_dump pattern below.
tar_via_alpine() {
  local src="$1" name="$2"
  local out="$BACKUP_DIR/${name}.tar.gz"
  local err="$BACKUP_DIR/${name}.err"
  if docker run --rm \
       -v "$src":/data:ro \
       -v "$BACKUP_DIR":/backup \
       alpine:3 tar czf "/backup/${name}.tar.gz" -C /data . 2>"$err"; then
    rm -f "$err"
    return 0
  fi
  rm -f "$out"    # avoid leaving a partial archive that looks valid
  return 1
}

# --- PostgreSQL: pg_dump per database (not pg_dumpall — that needs superuser
#     access to pg_authid, which breaks for non-superuser DB owners like the
#     Nextcloud role created via init-db.sh without CREATEROLE). User/DB are
#     hardcoded here rather than read from container env: nextcloud-db only
#     sets POSTGRES_PASSWORD and provisions its role+db through init-db.sh,
#     so env lookup returns nothing for that container.
POSTGRES_JOBS=(
  "immich-postgres:postgres:immich"
  "nextcloud-db:nextcloud:nextcloud"
  "paperless-db:paperless:paperless"
  "n8n-db:n8n:n8n"
)

for entry in "${POSTGRES_JOBS[@]}"; do
  container="${entry%%:*}"
  rest="${entry#*:}"
  user="${rest%%:*}"
  db="${rest##*:}"
  if ! container_running "$container"; then
    fail "postgres container not running: $container"
    continue
  fi
  echo "-> postgres: $container (user=$user db=$db)"
  dump_file="$BACKUP_DIR/${container}.dump"
  err_file="$BACKUP_DIR/${container}.err"
  if ! docker exec "$container" pg_dump -U "$user" -Fc "$db" \
         > "$dump_file" 2> "$err_file"; then
    rm -f "$dump_file"
    fail "pg_dump failed: $container (see $(basename "$err_file"))"
    continue
  fi
  # Post-validate: pg_restore -l parses the archive TOC. Catches truncated
  # dumps (daemon died mid-stream, disk full) that completed exit 0 in rare
  # edge cases.
  if ! docker exec -i "$container" pg_restore -l >/dev/null \
         < "$dump_file" 2>>"$err_file"; then
    fail "pg_dump TOC invalid: $container (see $(basename "$err_file"))"
    continue
  fi
  rm -f "$err_file"
done

# --- Docker named volumes (small, critical runtime state).
#     pgdata volumes are NOT listed here: pg_dump above is the source of truth
#     and a file-level tar of a live pgdata is unsafe. Model caches (Immich
#     ML, Ollama) are excluded — redownloadable.
NAMED_VOLUMES=(
  "nginx-proxy-manager_npm_data:npm-data"
  "nginx-proxy-manager_npm_letsencrypt:npm-letsencrypt"
  "uptime-kuma_uptime_kuma_data:uptime-kuma-data"
  "n8n_n8n_data:n8n-data"
  "adguard_adguard_work:adguard-work"
  "dockge_dockge_data:dockge-data"
  "openclaw_openclaw_config:openclaw-config"
  "jellyfin_jellyfin_config:jellyfin-config"
  "audiobookshelf_audiobookshelf_config:audiobookshelf-config"
  "audiobookshelf_audiobookshelf_metadata:audiobookshelf-metadata"
  "nextcloud_nextcloud_html:nextcloud-html"
)

for entry in "${NAMED_VOLUMES[@]}"; do
  volume="${entry%%:*}"
  name="${entry##*:}"
  if ! volume_exists "$volume"; then
    fail "volume missing: $volume"
    continue
  fi
  echo "-> volume: $volume"
  tar_via_alpine "$volume" "$name" \
    || fail "tar failed: $volume (see ${name}.err)"
done

# --- Host bind mounts (config + small user data on /srv).
#     Nextcloud user files (/srv/data/nextcloud) and Paperless docs
#     (/srv/data/paperless) are covered here — both are small today.
#     The repo-tracked config dirs (homepage, adguard) are also tar'd because
#     the live state may include runtime changes not yet committed.
BIND_MOUNTS=(
  "/srv/data/vaultwarden:vaultwarden-data"
  "/srv/data/paperless:paperless-files"
  "/srv/data/nextcloud:nextcloud-files"
  "/home/khe/homelab/services/core/adguard/config:adguard-config"
  "/home/khe/homelab/services/core/homepage/config:homepage-config"
)

for entry in "${BIND_MOUNTS[@]}"; do
  path="${entry%%:*}"
  name="${entry##*:}"
  if [ ! -e "$path" ]; then
    fail "bind path missing: $path"
    continue
  fi
  echo "-> bind: $path"
  tar_via_alpine "$path" "$name" \
    || fail "tar failed: $path (see ${name}.err)"
done

# --- Summary ---
DURATION=$(( $(date +%s) - START_TS ))
TOTAL_SIZE=$(du -sh "$BACKUP_DIR" | awk '{print $1}')

echo
echo "=== Summary ==="
echo "Target:   $BACKUP_DIR"
echo "Size:     $TOTAL_SIZE"
echo "Duration: ${DURATION}s"
ls -lh "$BACKUP_DIR"
echo

if [ "${#FAILURES[@]}" -gt 0 ]; then
  echo "FAILURES (${#FAILURES[@]}):" >&2
  printf '  - %s\n' "${FAILURES[@]}" >&2
  exit 1
fi

echo "All backup targets succeeded."
