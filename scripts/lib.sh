# shellcheck shell=bash
# Sourced as "$(dirname "$0")/lib.sh". validate.yml runs .base/scripts/, so a
# PR's own copy of this file is never sourced by the checks it is held to.
# Sets no shell options: backup.sh and offsite-backup.sh run without -e on
# purpose, so one failed item does not stop the rest.

# --- Stacks: callers set SERVICES_DIR -----------------------------------

add_unique() {
  local value="$1"
  shift
  local existing

  for existing in "$@"; do
    [ "$existing" = "$value" ] && return 0
  done

  printf '%s\n' "$value"
}

# A stack is a services/<group>/<name>/ directory with a docker-compose.yml,
# the same test deploy_stack and deploy.sh apply.
stack_from_path() {
  local path="${1#./}"
  local root group name rest

  IFS=/ read -r root group name rest <<< "$path"
  if [ "$root" != "services" ] || [ -z "${group:-}" ] || [ -z "${name:-}" ]; then
    return 0
  fi

  if [ -f "$SERVICES_DIR/$group/$name/docker-compose.yml" ]; then
    printf '%s/%s\n' "$group" "$name"
  fi
}

changed_stacks() {
  local before="$1"
  local after="$2"
  local stacks=()
  local file stack unique

  while IFS= read -r file; do
    stack="$(stack_from_path "$file")"
    if [ -n "$stack" ]; then
      if [ "${#stacks[@]}" -eq 0 ]; then
        stacks+=("$stack")
      else
        unique="$(add_unique "$stack" "${stacks[@]}")"
        if [ -n "$unique" ]; then
          stacks+=("$unique")
        fi
      fi
    fi
  done < <(git diff --name-only "$before" "$after" -- services)

  if [ "${#stacks[@]}" -gt 0 ]; then
    printf '%s\n' "${stacks[@]}"
  fi
}

# --- Heartbeats: optional Uptime Kuma push for a scheduled job ----------
# Setup: docs/operational-notes.md#backup-heartbeats.

# Sets HEARTBEAT_URL from the variable named $1 in ~/homelab/.env.heartbeat;
# empty, and every heartbeat a no-op, when the file or the variable is absent.
heartbeat_init() {
  local url_var="$1"
  local heartbeat_env="${HOME}/homelab/.env.heartbeat"

  HEARTBEAT_URL=""
  if [ -f "$heartbeat_env" ]; then
    # shellcheck source=/dev/null
    . "$heartbeat_env"
    HEARTBEAT_URL="${!url_var:-}"
  fi
}

heartbeat() {
  [ -n "$HEARTBEAT_URL" ] || return 0
  curl -fsS --max-time 5 -G \
    --data-urlencode "status=${1:-up}" \
    --data-urlencode "msg=${2:-}" \
    "$HEARTBEAT_URL" >/dev/null 2>&1 || true
}
