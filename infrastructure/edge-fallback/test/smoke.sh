#!/usr/bin/env bash
# Smoke test of a served site against what the edge fallback must reproduce
# (estate ADR-016): pages, one hashed asset per app, a hard 404 and the
# noindex and HSTS headers.
#
#   smoke.sh [--require-fallback] <base-url> <khe|games>
#
# --require-fallback also requires X-KHE-Fallback: 1 on every page, which
# proves the copy answered; without it the origin may answer. SHARE_SLUG
# adds /r/<slug>/ to the khe pages; share slugs are unlisted links, so none
# is written here.
set -euo pipefail

require_fallback=false
if [ "${1:-}" = "--require-fallback" ]; then
  require_fallback=true
  shift
fi
[ $# -eq 2 ] || { echo "usage: smoke.sh [--require-fallback] <base-url> <khe|games>" >&2; exit 2; }
base="${1%/}"
site="$2"

work="$(mktemp -d)"
trap 'find "$work" -delete' EXIT
failures=0

fail() {
  echo "FAIL $*"
  failures=$((failures + 1))
}

# fetch <path>: status into $status, body and headers into $work.
fetch() {
  status="$(curl -sS -o "$work/body" -D "$work/headers" -w '%{http_code}' --max-time 20 "$base$1")" || status=000
}

header() {
  grep -i "^$1:" "$work/headers" | head -1 | cut -d: -f2- | sed 's/^ *//; s/\r$//'
}

# page <path> <text the body must contain>
page() {
  fetch "$1"
  if [ "$status" != 200 ]; then
    fail "$1: status $status, want 200"
    return
  fi
  grep -q -- "$2" "$work/body" || fail "$1: body lacks '$2'"
  if $require_fallback && [ "$(header X-KHE-Fallback)" != 1 ]; then
    fail "$1: no X-KHE-Fallback: 1"
  fi
  echo "ok   $1"
}

# asset_of <path>: the first same-origin assets/ file the page links, a
# content-hashed one (name-<hash>.js|css) if there is one.
asset_of() {
  fetch "$1"
  { grep -oE '(src|href)="/[^"]*assets/[^"]*-[A-Za-z0-9_-]{8,}\.(js|css)"' "$work/body" || true
    grep -oE '(src|href)="/[^"]*assets/[^"]+"' "$work/body" || true
  } | head -1 | sed -E 's/^(src|href)="//; s/"$//'
}

# asset <page path>: that page's first asset answers 200.
asset() {
  local path
  path="$(asset_of "$1")"
  if [ -z "$path" ]; then
    fail "$1: links no assets/ file"
    return
  fi
  fetch "$path"
  [ "$status" = 200 ] || { fail "$path: status $status, want 200"; return; }
  echo "ok   $path"
}

# expect_header <path> <header> <value>
expect_header() {
  fetch "$1"
  local got
  got="$(header "$2")"
  [ "$got" = "$3" ] || { fail "$1: $2 is '$got', want '$3'"; return; }
  echo "ok   $1 $2"
}

case "$site" in
  khe)
    page / "<html"
    page /architecture/ "<html"
    page /architecture/decisions/ 'data-page="decisions"'
    page /agents/ 'data-page="agents"'
    page /ha/ "<html"
    page /trips/ "/trips/assets/"
    page /trips/some/deep/link "/trips/assets/"
    if [ -n "${SHARE_SLUG:-}" ]; then
      page "/r/$SHARE_SLUG/" "/r/$SHARE_SLUG/assets/"
      asset "/r/$SHARE_SLUG/"
      expect_header "/r/$SHARE_SLUG/" X-Robots-Tag "noindex, nofollow, noarchive"
    else
      echo "skip /r/<slug>/: SHARE_SLUG is not set"
    fi
    asset /
    asset /trips/
    fetch /r/nope/
    [ "$status" = 404 ] && echo "ok   /r/nope/ 404" || fail "/r/nope/: status $status, want 404"
    expect_header /r/nope/ X-Robots-Tag "noindex, nofollow, noarchive"
    expect_header /trips/ X-Robots-Tag "noindex, nofollow, noarchive"
    expect_header / Strict-Transport-Security "max-age=31536000"
    ;;
  games)
    page / "<html"
    page /study/ "/study/assets/"
    page /study/some/deep/link "/study/assets/"
    page /adventure/ "/adventure/assets/"
    asset /study/
    asset /adventure/
    expect_header / Strict-Transport-Security "max-age=31536000; includeSubDomains"
    ;;
  *)
    echo "unknown site $site" >&2
    exit 2
    ;;
esac

if [ "$failures" -gt 0 ]; then
  echo "$failures check(s) failed"
  exit 1
fi
echo "all checks passed"
