#!/usr/bin/env bash
# Manual whole-fleet control on the VM: up, down (reverse order), pull, status.
# CI deploys go through deploy-stacks.sh, which also builds, pulls and removes
# orphans; `up` here is a plain `docker compose up -d` of every stack.
set -euo pipefail

SERVICES_DIR="$(cd "$(dirname "$0")/../services" && pwd)"

# shellcheck source=scripts/deploy-order.sh
source "$(dirname "$0")/deploy-order.sh"

ACTION="${1:-up}"

validate_deploy_order() {
  local missing=0

  for service in "${DEPLOY_ORDER[@]}"; do
    if [ ! -f "$SERVICES_DIR/$service/docker-compose.yml" ]; then
      echo "Missing compose file for $service: $SERVICES_DIR/$service/docker-compose.yml" >&2
      missing=1
    fi
  done

  if [ "$missing" -ne 0 ]; then
    exit 1
  fi
}

case "$ACTION" in
  up)
    validate_deploy_order
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
    validate_deploy_order
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
    validate_deploy_order
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
