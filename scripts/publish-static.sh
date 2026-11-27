#!/usr/bin/env bash
# Publishes a static build into a directory the homelab nginx serves: copies
# it beside the live tree, then renames it in entry by entry, so no file of
# the old build is left and the bind-mounted directory itself stays. Dotfiles
# at the build's top level (study's .htaccess) are not published.
#
#   publish-static.sh [--no-index] <src-dir> <dest-dir>
#
# --no-index: a tree of sites with no index.html at its root, possibly empty.
# PUBLISH_ROOT (default /srv/data): where <dest-dir> must be, for the test.
set -euo pipefail

die() {
  echo "publish-static: $*" >&2
  exit 1
}

need_index=true
if [ "${1:-}" = "--no-index" ]; then
  need_index=false
  shift
fi
[ $# -eq 2 ] || die "usage: publish-static.sh [--no-index] <src-dir> <dest-dir>"
src="$1"
dest="$2"
while [ "$dest" != "${dest%/}" ]; do dest="${dest%/}"; done
root="${PUBLISH_ROOT:-/srv/data}"

[ -d "$src" ] || die "$src is not a directory"
if $need_index && [ ! -f "$src/index.html" ]; then
  die "$src/index.html is missing: the build produced no site"
fi
case "$dest" in
  "$root"/?*) ;;
  *) die "$dest is not a directory under $root" ;;
esac
case "$dest/" in
  */../* | */./* | *//*) die "$dest is not a plain path" ;;
esac
parent="$(dirname "$dest")"
existing="$parent"
while [ ! -e "$existing" ]; do existing="$(dirname "$existing")"; done
[ -d "$root" ] || die "$root is missing"
real_root="$(cd "$root" && pwd -P)"
case "$(cd "$existing" && pwd -P)/" in
  "$real_root"/*) ;;
  *) die "$parent leads outside $root" ;;
esac
[ ! -L "$dest" ] || die "$dest is a symlink"
mkdir -p "$dest"

next="$(mktemp -d "$dest.next.XXXXXX")"
trap 'rm -rf "$next"' EXIT
for entry in "$src"/*; do
  if [ -e "$entry" ] || [ -L "$entry" ]; then cp -R "$entry" "$next/"; fi
done
old="$(mktemp -d "$dest.old.XXXXXX")"

# Each new entry replaces its old one by rename, so the site is never empty;
# the old build stays in $old until the end, and is kept on any failure.
keep_old() { die "the swap stopped; the previous build's moved files are in $old"; }
for entry in "$next"/* "$next"/.[!.]* "$next"/..?*; do
  [ -e "$entry" ] || [ -L "$entry" ] || continue
  name="$(basename "$entry")"
  if [ -e "$dest/$name" ] || [ -L "$dest/$name" ]; then mv "$dest/$name" "$old/" || keep_old; fi
  mv "$entry" "$dest/" || keep_old
done
for entry in "$dest"/* "$dest"/.[!.]* "$dest"/..?*; do
  [ -e "$entry" ] || [ -L "$entry" ] || continue
  name="$(basename "$entry")"
  case "$name" in .*) ;; *) [ -e "$src/$name" ] && continue ;; esac
  mv "$entry" "$old/" || keep_old
done
rm -rf "$old" || echo "publish-static: could not remove $old" >&2
echo "publish-static: $dest from $src"
