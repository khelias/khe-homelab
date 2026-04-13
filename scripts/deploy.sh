#!/usr/bin/env bash
# Deploy or update all services in correct order
set -euo pipefail

SERVICES_DIR="$(cd "$(dirname "$0")/../services" && pwd)"

# Deploy order matters: core first, then dependencies
DEPLOY_ORDER=(
  "core/nginx-proxy-manager"
  "core/adguard"
  "core/cloudflare-tunnel"
  "core/vaultwarden"
  "core/dockge"
  "core/uptime-kuma"
  "core/homepage"
  "media/immich"
  "media/jellyfin"
  "media/audiobookshelf"
  "productivity/nextcloud"
  "productivity/paperless-ngx"
  "ai/ollama"
  "ai/n8n"
  "ai/openclaw"
)

ACTION="${1:-up}"

case "$ACTION" in
  up)
    echo "=== Deploying all services ==="
    for service in "${DEPLOY_ORDER[@]}"; do
      dir="$SERVICES_DIR/$service"
      if [ -f "$dir/docker-compose.yml" ]; then
        echo "Starting $service..."
        docker compose -f "$dir/docker-compose.yml" up -d
      fi
    done
    ;;
  down)
    echo "=== Stopping all services ==="
    for service in $(printf '%s\n' "${DEPLOY_ORDER[@]}" | tac); do
      dir="$SERVICES_DIR/$service"
      if [ -f "$dir/docker-compose.yml" ]; then
        echo "Stopping $service..."
        docker compose -f "$dir/docker-compose.yml" down
      fi
    done
    ;;
  pull)
    echo "=== Pulling latest images ==="
    for service in "${DEPLOY_ORDER[@]}"; do
      dir="$SERVICES_DIR/$service"
      if [ -f "$dir/docker-compose.yml" ]; then
        echo "Pulling $service..."
        docker compose -f "$dir/docker-compose.yml" pull
      fi
    done
    ;;
  status)
    echo "=== Service Status ==="
    docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}" | sort
    ;;
  *)
    echo "Usage: $0 {up|down|pull|status}"
    exit 1
    ;;
esac

echo "Done."
