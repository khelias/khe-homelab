#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SERVICES_DIR="$ROOT_DIR/services"
CREATED_ENV_FILES=()

usage() {
  cat <<'USAGE'
Usage:
  scripts/validate-compose.sh all
  scripts/validate-compose.sh changed <before-sha> <after-sha>
USAGE
}

cleanup() {
  local file
  if [ "${#CREATED_ENV_FILES[@]}" -eq 0 ]; then
    return
  fi

  for file in "${CREATED_ENV_FILES[@]}"; do
    rm -f "$file"
  done
}
trap cleanup EXIT

add_unique() {
  local value="$1"
  shift
  local existing

  for existing in "$@"; do
    [ "$existing" = "$value" ] && return 0
  done

  printf '%s\n' "$value"
}

stack_from_path() {
  local path="${1#./}"
  local root group name rest

  IFS=/ read -r root group name rest <<< "$path"
  if [ "$root" != "services" ] || [ -z "${group:-}" ] || [ -z "${name:-}" ]; then
    return 0
  fi

  if [ -d "$SERVICES_DIR/$group/$name" ]; then
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

ensure_ci_env_file() {
  local dir="$1"
  local env_file="$dir/.env"
  local example_file="$dir/.env.example"

  if [ ! -f "$env_file" ] && [ -f "$example_file" ]; then
    cp "$example_file" "$env_file"
    CREATED_ENV_FILES+=("$env_file")
  fi
}

validate_stack() {
  local stack="$1"
  local dir="$SERVICES_DIR/$stack"
  local compose="$dir/docker-compose.yml"
  local dockerfile="$dir/Dockerfile"

  if [ -f "$compose" ]; then
    echo "::group::docker compose config $stack"
    ensure_ci_env_file "$dir"
    docker compose -f "$compose" config -q
    echo "::endgroup::"
  fi

  if [ -f "$dockerfile" ]; then
    echo "::group::docker build --check $stack"
    docker build --check "$dir"
    echo "::endgroup::"
  fi
}

main() {
  if [ "$#" -lt 1 ]; then
    usage >&2
    exit 1
  fi

  local mode="$1"
  shift
  local stacks=()
  local stack

  case "$mode" in
    all)
      while IFS= read -r stack; do
        stacks+=("${stack#"$SERVICES_DIR"/}")
      done < <(find "$SERVICES_DIR" -mindepth 2 -maxdepth 2 -type d | sort)
      ;;
    changed)
      if [ "$#" -ne 2 ]; then
        usage >&2
        exit 1
      fi
      while IFS= read -r stack; do
        [ -n "$stack" ] && stacks+=("$stack")
      done < <(changed_stacks "$1" "$2")
      ;;
    *)
      usage >&2
      exit 1
      ;;
  esac

  if [ "${#stacks[@]}" -eq 0 ]; then
    echo "No changed service stacks to validate."
    exit 0
  fi

  for stack in "${stacks[@]}"; do
    validate_stack "$stack"
  done
}

main "$@"
