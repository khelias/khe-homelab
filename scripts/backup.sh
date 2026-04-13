#!/usr/bin/env bash
# Backup Docker volumes and databases
set -euo pipefail

BACKUP_DIR="/srv/backups/$(date +%Y-%m-%d)"
mkdir -p "$BACKUP_DIR"

echo "=== Backup $(date +%Y-%m-%d) ==="

# Backup PostgreSQL databases (each has its own user)
declare -A DB_USERS=(
  ["immich-postgres"]="postgres"
  ["nextcloud-db"]="nextcloud"
  ["paperless-db"]="paperless"
  ["n8n-db"]="n8n"
)

for db_container in "${!DB_USERS[@]}"; do
  if docker ps -q -f name="^${db_container}$" | grep -q .; then
    echo "Backing up $db_container..."
    docker exec "$db_container" pg_dumpall -U "${DB_USERS[$db_container]}" | gzip > "$BACKUP_DIR/${db_container}.sql.gz"
  fi
done

# Backup Vaultwarden data
if docker ps -q -f name=vaultwarden | grep -q .; then
  echo "Backing up Vaultwarden..."
  docker run --rm \
    -v vaultwarden_data:/data:ro \
    -v "$BACKUP_DIR":/backup \
    alpine tar czf /backup/vaultwarden-data.tar.gz -C /data .
fi

# Backup NPM config
if docker ps -q -f name=nginx-proxy-manager | grep -q .; then
  echo "Backing up Nginx Proxy Manager..."
  docker run --rm \
    -v npm_data:/data:ro \
    -v "$BACKUP_DIR":/backup \
    alpine tar czf /backup/npm-data.tar.gz -C /data .
fi

# Encrypt backups (if GPG key is configured)
GPG_RECIPIENT="${BACKUP_GPG_KEY:-}"
if [ -n "$GPG_RECIPIENT" ]; then
  echo "Encrypting backups..."
  for file in "$BACKUP_DIR"/*.{sql.gz,tar.gz}; do
    [ -f "$file" ] || continue
    gpg --batch --yes -e -r "$GPG_RECIPIENT" "$file" && rm "$file"
  done
  echo "Backups encrypted."
else
  echo "WARNING: Backups are NOT encrypted. Set BACKUP_GPG_KEY to enable."
fi

# Cleanup old backups (keep 7 days)
find /srv/backups -maxdepth 1 -type d -mtime +7 -exec rm -rf {} +

echo "=== Backup complete: $BACKUP_DIR ==="
ls -lh "$BACKUP_DIR"
