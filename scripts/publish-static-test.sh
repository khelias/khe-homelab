#!/usr/bin/env bash
# Tests scripts/publish-static.sh against a temporary PUBLISH_ROOT.
#
#   scripts/publish-static-test.sh
set -euo pipefail

script="$(cd "$(dirname "$0")" && pwd)/publish-static.sh"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
export PUBLISH_ROOT="$tmp/srv"
failures=0

fail() {
  echo "FAIL: $*" >&2
  failures=$((failures + 1))
}

refused() {
  if "$script" "$@" >/dev/null 2>&1; then fail "accepted: $*"; fi
}

mkdir -p "$PUBLISH_ROOT" "$tmp/build/assets" "$tmp/empty" "$tmp/shares/abc"
echo new > "$tmp/build/index.html"
echo deny > "$tmp/build/.htaccess"
echo js > "$tmp/build/assets/app.js"
echo share > "$tmp/shares/abc/index.html"

# A missing dest is created and filled.
"$script" "$tmp/build" "$PUBLISH_ROOT/site" >/dev/null
[ "$(cat "$PUBLISH_ROOT/site/index.html")" = new ] || fail "first publish"
[ -f "$PUBLISH_ROOT/site/assets/app.js" ] || fail "nested file"
[ ! -e "$PUBLISH_ROOT/site/.htaccess" ] || fail "top-level dotfile published"

# An old build's files, a dotfile among them, are gone; the directory stays.
echo old > "$PUBLISH_ROOT/site/stale.html"
echo x > "$PUBLISH_ROOT/site/.DS_Store"
inode_before="$(ls -di "$PUBLISH_ROOT/site" | awk '{print $1}')"
"$script" "$tmp/build/" "$PUBLISH_ROOT/site/" >/dev/null
[ ! -e "$PUBLISH_ROOT/site/stale.html" ] || fail "old file left"
[ ! -e "$PUBLISH_ROOT/site/.DS_Store" ] || fail "dotfile left"
[ -z "$(ls -d "$PUBLISH_ROOT"/site.* 2>/dev/null)" ] || fail "staging dir left"
[ "$(ls -di "$PUBLISH_ROOT/site" | awk '{print $1}')" = "$inode_before" ] || fail "directory replaced"

# Refused: no index.html, a source that is not a directory, a dest outside
# the root, climbing out of it, the root itself, a symlink out, a wrong
# argument count.
refused "$tmp/empty" "$PUBLISH_ROOT/x"
refused "$tmp/none" "$PUBLISH_ROOT/x"
refused "$tmp/build" "$tmp/elsewhere"
refused "$tmp/build" "$PUBLISH_ROOT/../escape"
refused "$tmp/build" "$PUBLISH_ROOT"
refused "$tmp/build" "$PUBLISH_ROOT//"
refused "$tmp/build" "$PUBLISH_ROOT//x"
mkdir -p "$tmp/outside" && ln -s "$tmp/outside" "$PUBLISH_ROOT/link"
refused "$tmp/build" "$PUBLISH_ROOT/link"
refused "$tmp/build" "$PUBLISH_ROOT/link/x/y"
[ ! -e "$tmp/outside/x" ] || fail "a refusal made a directory outside"
refused "$tmp/build"
[ "$(cat "$PUBLISH_ROOT/site/index.html")" = new ] || fail "a refusal touched the live site"

# A failed rename stops the swap and keeps the old build's moved files.
mkdir -p "$tmp/bin"
printf '#!/bin/sh\ncase "$1" in */site.next.*/assets) exit 1 ;; esac\nexec /bin/mv "$@"\n' > "$tmp/bin/mv"
chmod +x "$tmp/bin/mv"
if PATH="$tmp/bin:$PATH" "$script" "$tmp/build" "$PUBLISH_ROOT/site" >/dev/null 2>&1; then fail "a failed rename passed"; fi
ls -d "$PUBLISH_ROOT"/site.old.*/assets >/dev/null 2>&1 || fail "old build not kept"
rm -rf "$PUBLISH_ROOT"/site.old.*

# --no-index takes a tree of sites, and an empty one empties the dest.
"$script" --no-index "$tmp/shares" "$PUBLISH_ROOT/share" >/dev/null
[ -f "$PUBLISH_ROOT/share/abc/index.html" ] || fail "--no-index publish"
"$script" --no-index "$tmp/empty" "$PUBLISH_ROOT/share" >/dev/null
[ -z "$(ls -A "$PUBLISH_ROOT/share")" ] || fail "empty --no-index left files"

if [ "$failures" -ne 0 ]; then
  echo "publish-static-test: $failures failed" >&2
  exit 1
fi
echo "publish-static-test: ok"
