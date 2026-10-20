#!/usr/bin/env bash
# Stages the trees the Cloudflare edge fallback serves (estate ADR-016):
# <out-dir>/khe/ for khe.ee and <out-dir>/games/ for games.khe.ee, copied
# from what the homelab serves. The sources below are the whole allowlist:
# a tree that is not named here never reaches the copy, and the private
# khe-trips atlas (/srv/data/trips/app) is not one of them.
#
#   edge-fallback-stage.sh [--fixtures] <out-dir>
#
# EF_SITES_ROOT, EF_SHARE_ROOT, EF_DEMO_ROOT, EF_LAUNCHER_ROOT, EF_STUDY_ROOT
# and EF_ADVENTURE_ROOT replace one source each; EF_ADVENTURE_ROOT also skips
# copying the adventure build out of its image. --fixtures stages the test
# tree in infrastructure/edge-fallback/test/fixtures/ instead.
# Prints "<site> <tree hash>" per site. Runs on the homelab runner and, for
# local checks, under macOS /bin/bash 3.2.
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
marker=".edge-fallback-stage"
max_files=20000
max_file_mib=25

die() {
  echo "edge-fallback-stage: $*" >&2
  exit 1
}

fixtures=false
if [ "${1:-}" = "--fixtures" ]; then
  fixtures=true
  shift
fi
[ $# -eq 1 ] || die "usage: edge-fallback-stage.sh [--fixtures] <out-dir>"
out="$1"

if $fixtures; then
  fx="$repo/infrastructure/edge-fallback/test/fixtures"
  EF_SITES_ROOT="$fx/sites" EF_SHARE_ROOT="$fx/share" EF_DEMO_ROOT="$fx/demo"
  EF_LAUNCHER_ROOT="$fx/launcher" EF_STUDY_ROOT="$fx/study" EF_ADVENTURE_ROOT="$fx/adventure"
fi
sites_root="${EF_SITES_ROOT:-/srv/data/sites/khe}"
share_root="${EF_SHARE_ROOT:-/srv/data/trips/share}"
demo_root="${EF_DEMO_ROOT:-/srv/data/trips/demo}"
launcher_root="${EF_LAUNCHER_ROOT:-/srv/data/games/launcher}"
study_root="${EF_STUDY_ROOT:-/srv/data/games/study}"
adventure_root="${EF_ADVENTURE_ROOT:-}"

# Only a directory this script made is emptied, so a wrong <out-dir> fails
# instead of losing its contents.
if [ -e "$out" ]; then
  [ -d "$out" ] || die "$out is not a directory"
  if [ -n "$(ls -A "$out")" ] && [ ! -f "$out/$marker" ]; then
    die "$out is not empty and was not staged by this script"
  fi
  find "$out" -mindepth 1 -delete
fi
mkdir -p "$out"
touch "$out/$marker"

# A symlink could point the copy at a tree outside the allowlist.
copy_tree() {
  local src="$1" dest="$2"
  [ -d "$src" ] || die "source $src is missing"
  [ -n "$(ls -A "$src")" ] || die "source $src is empty"
  [ -z "$(find "$src" -type l | head -1)" ] || die "source $src contains a symlink"
  mkdir -p "$dest"
  cp -R "$src/." "$dest/"
}

# A top-level directory of the same name in the root tree would be shadowed
# by the mount, on the homelab and here alike.
no_overlap() {
  local root="$1"
  shift
  local name
  for name in "$@"; do
    [ ! -e "$root/$name" ] || die "$root/$name would collide with the /$name/ mount"
  done
}

no_overlap "$sites_root" r trips
copy_tree "$sites_root" "$out/khe"
copy_tree "$share_root" "$out/khe/r"
copy_tree "$demo_root" "$out/khe/trips"

no_overlap "$launcher_root" study adventure
copy_tree "$launcher_root" "$out/games"
copy_tree "$study_root" "$out/games/study"

if [ -n "$adventure_root" ]; then
  copy_tree "$adventure_root" "$out/games/adventure"
else
  compose="$repo/services/apps/games/docker-compose.yml"
  image="$(docker compose -f "$compose" config --format json | jq -r '.services["adventure-web"].image')" ||
    die "could not read the adventure-web image from $compose"
  [[ "$image" =~ ^ghcr\.io/khelias/khe-ai-adventure-web:[A-Za-z0-9._-]+@sha256:[0-9a-f]{64}$ ]] ||
    die "no digest-pinned adventure-web image in $compose"
  cid="$(docker create "$image")"
  trap 'docker rm "$cid" >/dev/null' EXIT
  extracted="$out/.adventure"
  mkdir -p "$extracted"
  docker cp "$cid:/usr/share/nginx/html/adventure/." "$extracted/"
  [ -n "$(ls -A "$extracted")" ] || die "$image has no /usr/share/nginx/html/adventure"
  [ -z "$(find "$extracted" -type l | head -1)" ] || die "$image's adventure build contains a symlink"
  mv "$extracted" "$out/games/adventure"
fi

# The container writes config.js from API_SECRET at start; the copy gets a
# stub without it (estate ADR-016 point 4).
printf '%s\n' 'window.__ADVENTURE_CONFIG__ = { "apiSecret": "" };' > "$out/games/adventure/config.js"
# grep exits 1 only when nothing matched; a read error must fail too.
found=0
grep -rlE "apiSecret[\"']? *: *[\"'][^\"']" "$out" >&2 || found=$?
case "$found" in
  0) die "a staged file carries an apiSecret value" ;;
  1) ;;
  *) die "the apiSecret scan could not read the staged tree" ;;
esac

if command -v sha256sum >/dev/null; then
  sha=(sha256sum)
else
  sha=(shasum -a 256)
fi

for site in khe games; do
  files="$(find "$out/$site" -type f | wc -l | tr -d ' ')"
  [ "$files" -le "$max_files" ] || die "$site has $files files, over the $max_files a Worker version holds"
  big="$(find "$out/$site" -type f -size +"${max_file_mib}M" | head -1)"
  [ -z "$big" ] || die "$big is over ${max_file_mib} MiB"
  hash="$(cd "$out/$site" && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 "${sha[@]}" | "${sha[@]}" | cut -d' ' -f1)"
  echo "$site $hash"
done
