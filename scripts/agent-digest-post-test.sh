#!/usr/bin/env bash
# Runs agent-digest-post.sh --dry-run on its fixtures (.github/agent/fixtures/)
# and on the dirty ones built here, so no secret, LAN address or oversized
# file sits in the repo. Needs PII_RULES and gitleaks, from
# agent-digest-tools.sh in CI. validate.yml runs it.
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
post="$here/agent-digest-post.sh"
fixtures="$here/../.github/agent/fixtures"
tmp="$(mktemp -d)"
trap 'rm -rf -- "$tmp"' EXIT
rc=0
pass() { echo "ok   $1"; }
fail() { echo "FAIL $1" >&2; rc=1; }

# expect <name> <exit code> <file>: the dry run exits with that code.
expect() {
  local got=0
  GITHUB_REPOSITORY=khelias/khe-homelab bash "$post" --dry-run "$3" > "$tmp/out" 2> "$tmp/err" || got=$?
  if [ "$got" -eq "$2" ]; then pass "$1"; else fail "$1: exit $got, wanted $2"; cat "$tmp/err" >&2; fi
}

expect "clean digest is printed" 0 "$fixtures/clean.md"
grep -q 'wrangler to v4.162.0' "$tmp/out" || fail "clean digest: body missing"

expect "mentions digest is printed" 0 "$fixtures/mentions.md"
zw="$(printf '\342\200\213')"
if grep -iE '(@|&#0*64;|&#x0*40;|&commat;)[A-Za-z0-9]' "$tmp/out" >/dev/null; then fail "a live @mention is left"; else pass "no live @mention"; fi
if grep -iE '(^|[^.])github\.com/upstream-org' "$tmp/out" >/dev/null ||
  ! grep -qF 'redirect.github.com/upstream-org/upstream-repo/issues/4527.' "$tmp/out"; then
  fail "an upstream link is left on github.com"
else
  pass "upstream links go through redirect.github.com"
fi
for n in 4521 4523; do
  grep -qF "[upstream-org/upstream-repo#${zw}$n](https://redirect.github.com/upstream-org/upstream-repo/issues/$n)" "$tmp/out" ||
    fail "upstream shorthand #$n is not rewritten"
done
if grep -qF 'khelias/khe-homelab#319 and https://github.com/khelias/khe-homelab/pull/319' "$tmp/out"; then
  pass "own references stay"
else
  fail "own references were rewritten"
fi

expect "missing file is refused" 1 "$tmp/none.md"
printf '  \n\n' > "$tmp/empty.md"
expect "empty digest is refused" 1 "$tmp/empty.md"
head -c 65537 /dev/zero | tr '\0' a > "$tmp/big.md"
expect "oversized digest is refused" 1 "$tmp/big.md"
printf 'The printer answers on 192.168.%d.%d.\n' 0 42 > "$tmp/lan.md"
expect "LAN address is refused" 1 "$tmp/lan.md"
printf 'token: ghp_%s\n' "$(printf 'A1b2C3d4E5%.0s' 1 2 3 4 | cut -c 1-36)" > "$tmp/secret.md"
expect "GitHub token is refused" 1 "$tmp/secret.md"
printf '\xff\xfe not text\n' > "$tmp/binary.md"
expect "non-UTF-8 digest is refused" 1 "$tmp/binary.md"

exit "$rc"
