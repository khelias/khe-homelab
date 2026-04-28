#!/usr/bin/env bash
set -euo pipefail

IMAGE_UNTIL="${DOCKER_CLEANUP_IMAGE_UNTIL:-168h}"
BUILDER_UNTIL="${DOCKER_CLEANUP_BUILDER_UNTIL:-24h}"
AGGRESSIVE="${DOCKER_CLEANUP_AGGRESSIVE:-false}"
AGGRESSIVE_THRESHOLD="${DOCKER_CLEANUP_AGGRESSIVE_THRESHOLD:-85}"

root_usage_percent() {
  df -P / | awk 'NR == 2 { gsub("%", "", $5); print $5 }'
}

print_state() {
  local label="$1"

  echo "::group::Disk and Docker state $label"
  df -h /
  docker system df
  echo "::endgroup::"
}

print_state "before cleanup"

before_usage="$(root_usage_percent)"
echo "Root filesystem usage before cleanup: ${before_usage}%"

# Never prune Docker volumes here. Named volumes hold application data.
docker container prune -f --filter "until=24h"
docker builder prune -af --filter "until=${BUILDER_UNTIL}"

if [ "$AGGRESSIVE" = "true" ] || [ "$before_usage" -ge "$AGGRESSIVE_THRESHOLD" ]; then
  echo "Pruning all unused Docker images."
  docker image prune -af
else
  echo "Pruning unused Docker images older than ${IMAGE_UNTIL}."
  docker image prune -af --filter "until=${IMAGE_UNTIL}"
fi

after_usage="$(root_usage_percent)"
echo "Root filesystem usage after cleanup: ${after_usage}%"

print_state "after cleanup"
