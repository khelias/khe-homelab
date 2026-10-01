#!/usr/bin/env bash
# Removes what a stack deleted from git leaves on the VM: deploy-stacks.sh
# skips a stack whose compose file is gone, so its containers, volumes,
# networks and images stay. Run by retire-stack.yml; dry run unless --apply.
#
#   retire-stack.sh                      list orphan compose projects
#   retire-stack.sh <project>            print what would be removed
#   retire-stack.sh <project> --apply    remove it
#
# An orphan is a compose project named in the labels of a container or volume
# that has no services/*/<project>/docker-compose.yml in this checkout.
# homelab-status.sh reports the same list.
#
# Bind-mount sources are only printed, as sudo lines for the operator: the
# runner has no sudo, and some sit on the shared NFS data set.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKDIR_ROOT="${RETIRE_STACK_WORKDIR_ROOT:-/home/khe/homelab/services/}"
PROJECT_LABEL=com.docker.compose.project
NAME_RE='^[a-z0-9][a-z0-9_-]*$'

usage() { echo "usage: $0 [<project> [--apply]]" >&2; exit 2; }
refuse() { echo "refused: $1" >&2; exit 1; }

in_tree() {
  compgen -G "${REPO_DIR}/services/*/$1/docker-compose.yml" >/dev/null
}

list_orphans() {
  local project
  {
    docker ps -a --format "{{.Label \"${PROJECT_LABEL}\"}}"
    docker volume ls --format "{{.Label \"${PROJECT_LABEL}\"}}"
  } | { grep -E "$NAME_RE" || true; } | sort -u | while read -r project; do
    in_tree "$project" || printf '%s\n' "$project"
  done
}

# Runs the command once per non-empty line of a newline-separated list.
each() {
  local list="$1" item
  shift
  while read -r item; do
    [ -n "$item" ] || continue
    "$@" "$item"
  done <<< "$list"
}

project=""
apply=false
for arg in "$@"; do
  case "$arg" in
    --apply) apply=true ;;
    -*) usage ;;
    *) [ -z "$project" ] || usage; project="$arg" ;;
  esac
done
if [ "$apply" = true ] && [ -z "$project" ]; then usage; fi
if [ -n "$project" ] && ! [[ "$project" =~ $NAME_RE ]]; then
  echo "invalid project name: $project" >&2
  exit 2
fi

docker info >/dev/null 2>&1 || { echo "docker daemon unreachable" >&2; exit 1; }

if [ -z "$project" ]; then
  orphans="$(list_orphans)"
  if [ -z "$orphans" ]; then
    echo "no orphan compose projects" >&2
  else
    printf '%s\n' "$orphans"
  fi
  exit 0
fi

if in_tree "$project"; then
  refuse "services/*/${project}/docker-compose.yml is still in the tree"
fi
# Another repo's runner may start compose projects on this VM too; only a
# stack this repo once had is ours to remove.
history="$(git -C "$REPO_DIR" log --format= --name-only -- "services/*/${project}/docker-compose.yml")"
[ -n "$history" ] || refuse "git history has never had services/*/${project}/docker-compose.yml"

# Newline-separated lists: ids and compose names carry no whitespace.
filter="label=${PROJECT_LABEL}=${project}"
containers="$(docker ps -aq --filter "$filter")"
volumes="$(docker volume ls -q --filter "$filter")"
networks="$(docker network ls --filter "$filter" --format '{{.Name}}')"
images=""
binds=""
while read -r id; do
  [ -n "$id" ] || continue
  workdir="$(docker inspect --format "{{index .Config.Labels \"${PROJECT_LABEL}.working_dir\"}}" "$id")"
  case "$workdir" in
    *..*) refuse "a container of ${project} has working directory ${workdir}" ;;
    "$WORKDIR_ROOT"*) ;;
    *) refuse "a container of ${project} was started from ${workdir:-an unknown directory}, outside ${WORKDIR_ROOT}" ;;
  esac
  images="${images}$(docker inspect --format '{{.Image}}' "$id")"$'\n'
  binds="${binds}$(docker inspect --format '{{range .Mounts}}{{if eq .Type "bind"}}{{.Source}}{{"\n"}}{{end}}{{end}}' "$id")"$'\n'
done <<< "$containers"
images="$(printf '%s' "$images" | sed '/^$/d' | sort -u)"
binds="$(printf '%s' "$binds" | sed '/^$/d' | sort -u)"

[ -n "${containers}${volumes}${networks}" ] || refuse "nothing labelled ${PROJECT_LABEL}=${project} on this host"

show_container() {
  printf '  container  %s %.12s\n' "$(docker inspect --format '{{.Name}}' "$1" | sed 's#^/##')" "$1"
}
show() { printf '  %-10s %s\n' "$1" "$2"; }
show_image() { printf '  image      %.12s\n' "${1#sha256:}"; }
show_bind() {
  case "$1" in
    /var/run/*|/run/*|/etc/*|/proc/*|/sys/*|/dev/*|/usr/*|/lib/*|/boot/*)
      printf '  keep: %s (system path)\n' "$1" ;;
    *) printf '  sudo rm -rf %q\n' "$1" ;;
  esac
}

echo "Plan for ${project}"
each "$containers" show_container
each "$images" show_image
each "$volumes" show volume
each "$networks" show network
if [ -n "$binds" ]; then
  echo "Bind mounts, never removed here; check each before running its line:"
  each "$binds" show_bind
fi

if [ "$apply" != true ]; then
  echo "Dry run: nothing removed. Run again with --apply (apply=true) to remove the above."
  exit 0
fi

failed=0
remove() { "$@" >/dev/null || failed=1; }
remove_image() {
  docker image rm "$1" >/dev/null 2>&1 || printf '  note: image %.12s kept (still in use)\n' "${1#sha256:}"
}
each "$containers" remove docker rm -f
each "$networks" remove docker network rm
each "$volumes" remove docker volume rm
each "$images" remove_image
if [ "$failed" -ne 0 ]; then
  echo "Some removals failed; see above." >&2
  exit 1
fi
echo "Removed ${project}."
