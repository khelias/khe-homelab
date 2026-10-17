#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SERVICES_DIR="$ROOT_DIR/services"

# shellcheck source=scripts/deploy-order.sh
source "$(dirname "$0")/deploy-order.sh"
# shellcheck source=scripts/lib.sh
source "$(dirname "$0")/lib.sh"

usage() {
  cat <<'USAGE'
Usage:
  scripts/deploy-stacks.sh all [--force-recreate] [--dry-run]
  scripts/deploy-stacks.sh changed <before-sha> <after-sha> [--force-recreate] [--dry-run]
  scripts/deploy-stacks.sh stack <services/group/name|group/name>... [--force-recreate] [--dry-run]
USAGE
}

normalize_stack() {
  local input="${1#./}"
  input="${input#services/}"

  if [ -f "$SERVICES_DIR/$input/docker-compose.yml" ]; then
    printf '%s\n' "$input"
    return 0
  fi

  echo "Unknown stack: $1" >&2
  return 1
}

ordered_stacks() {
  local requested=("$@")
  local service target

  for service in "${DEPLOY_ORDER[@]}"; do
    for target in "${requested[@]}"; do
      if [ "$service" = "$target" ]; then
        printf '%s\n' "$service"
        break
      fi
    done
  done
}

deploy_stack() {
  local service="$1"
  shift
  local dir="$SERVICES_DIR/$service"
  local compose="$dir/docker-compose.yml"

  if [ ! -f "$compose" ]; then
    echo "Missing compose file for $service: $compose" >&2
    return 1
  fi

  echo "::group::Deploy $service"
  docker compose -f "$compose" config -q
  docker compose -f "$compose" build --pull
  docker compose -f "$compose" up -d --build --pull missing --remove-orphans "$@"
  docker compose -f "$compose" ps
  echo "::endgroup::"
}

main() {
  if [ "$#" -lt 1 ]; then
    usage >&2
    exit 1
  fi

  local mode="$1"
  shift
  local force_flags=()
  local dry_run=false
  local targets=()
  local stack

  case "$mode" in
    all)
      targets=("${DEPLOY_ORDER[@]}")
      ;;
    changed)
      if [ "$#" -lt 2 ]; then
        usage >&2
        exit 1
      fi
      while IFS= read -r stack; do
        [ -n "$stack" ] && targets+=("$stack")
      done < <(changed_stacks "$1" "$2")
      shift 2
      ;;
    stack)
      if [ "$#" -lt 1 ]; then
        usage >&2
        exit 1
      fi
      while [ "$#" -gt 0 ]; do
        case "$1" in
          --force-recreate)
            break
            ;;
          --dry-run)
            break
            ;;
          *)
            targets+=("$(normalize_stack "$1")")
            shift
            ;;
        esac
      done
      ;;
    *)
      usage >&2
      exit 1
      ;;
  esac

  while [ "$#" -gt 0 ]; do
    case "$1" in
      --force-recreate)
        force_flags+=(--force-recreate)
        shift
        ;;
      --dry-run)
        dry_run=true
        shift
        ;;
      *)
        echo "Unknown option: $1" >&2
        usage >&2
        exit 1
        ;;
    esac
  done

  if [ "${#targets[@]}" -eq 0 ]; then
    echo "No changed service stacks to deploy."
    exit 0
  fi

  local ordered_targets=()
  while IFS= read -r stack; do
    [ -n "$stack" ] && ordered_targets+=("$stack")
  done < <(ordered_stacks "${targets[@]}")
  targets=("${ordered_targets[@]}")
  if [ "${#targets[@]}" -eq 0 ]; then
    echo "No deployable service stacks selected."
    exit 0
  fi

  echo "Deploying stacks:"
  printf ' - %s\n' "${targets[@]}"

  if [ "$dry_run" = true ]; then
    echo "Dry run only; no Docker Compose commands were run."
    exit 0
  fi

  for stack in "${targets[@]}"; do
    deploy_stack "$stack" "${force_flags[@]}"
  done
}

main "$@"
