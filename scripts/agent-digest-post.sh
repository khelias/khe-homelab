#!/usr/bin/env bash
# Posts the weekly digest that .github/workflows/weekly-digest.yml has Claude
# write, as one issue labelled agent-digest, and closes the older ones
# (estate ADR-027). It runs in the model-free job that holds issues: write,
# so everything the model wrote is checked here before it is posted:
#
#   1. the file exists, is UTF-8, not empty and at most 64 KB;
#   2. gitleaks finds nothing with its default rules (secrets) or with the
#      workspace's personal-data rules ($PII_RULES);
#   3. mentions and cross-repo references are neutralised, so nobody outside
#      this repo's owner is pinged or gets a backlink.
#
#   scripts/agent-digest-post.sh [--dry-run] <digest.md>
#
# --dry-run prints the title and the body that would be posted, posts nothing
# and needs no token. Env: PII_RULES (the rules file, required), GH_TOKEN and
# GITHUB_REPOSITORY (owner/name) unless dry run. Exit 0 posted or printed, 1
# refused, 2 when it cannot run.
set -euo pipefail

MAX_BYTES=65536
LABEL=agent-digest
TITLE="Weekly digest $(date -u +%Y-%m-%d)"

die() { echo "agent-digest-post: $*" >&2; exit 2; }
refuse() { echo "agent-digest-post: refused: $*" >&2; exit 1; }

dry_run=false
if [ "${1:-}" = --dry-run ]; then dry_run=true; shift; fi
[ $# -eq 1 ] || die "usage: $0 [--dry-run] <digest.md>"
digest="$1"
[ -n "${PII_RULES:-}" ] && [ -f "$PII_RULES" ] || die "PII_RULES must name the personal-data rules file"
# gitleaks runs from a temporary directory, so the path must not be relative.
PII_RULES="$(cd "$(dirname "$PII_RULES")" && pwd)/$(basename "$PII_RULES")"
for c in gitleaks jq perl iconv; do command -v "$c" >/dev/null || die "needs $c"; done
repo="${GITHUB_REPOSITORY:-khelias/khe-homelab}"
owner="${repo%%/*}"
$dry_run || [ -n "${GH_TOKEN:-}" ] || die "GH_TOKEN is not set"

[ -f "$digest" ] || refuse "$digest does not exist"
size="$(wc -c < "$digest" | tr -d ' ')"
[ "$size" -le "$MAX_BYTES" ] || refuse "$digest is $size bytes, over $MAX_BYTES"
grep -q '[^[:space:]]' "$digest" || refuse "$digest is empty"
iconv -f UTF-8 -t UTF-8 "$digest" >/dev/null 2>&1 || refuse "$digest is not UTF-8"

tmp="$(mktemp -d)"
trap 'rm -rf -- "$tmp"' EXIT

# From an empty directory, so no .gitleaks.toml or .gitleaksignore in the
# checkout can change the rules; inline gitleaks:allow comments are ignored.
# The same hardening as the workspace's scripts/pii-scan-range.sh.
scan() {
  local name="$1"; shift
  local rc=0
  (cd "$tmp" && gitleaks stdin "$@" --gitleaks-ignore-path "$tmp" --redact --no-banner \
    --no-color --log-level error --ignore-gitleaks-allow --exit-code 3 \
    --report-format json --report-path "$tmp/$name.json") < "$digest" 2> "$tmp/$name.err" || rc=$?
  case "$rc" in
    0) ;;
    3) refuse "$name scan: $(jq -r '[.[].RuleID] | unique | join(", ")' "$tmp/$name.json" 2>/dev/null || echo "a finding")" ;;
    *) cat "$tmp/$name.err" >&2; die "$name scan could not run (gitleaks exit $rc)" ;;
  esac
}
scan secrets
scan personal-data --config "$PII_RULES"

# An @ before a name gets a zero-width space after it. Links and shorthand to
# issues outside this owner's repos go through redirect.github.com, which
# GitHub does not turn into a cross-reference, as Renovate does.
OWNER="$owner" perl -CSD -pe '
  BEGIN { $o = lc $ENV{OWNER} }
  s{(?:\@|&\#0*64;|&\#x0*40;|&commat;)(?=[A-Za-z0-9])}{\@\x{200B}}gi;
  s{(?i:https?://|(?<![\w.-]))(?i:www\.)?(?i:github\.com)/([\w.-]+)/([\w.-]+)/(issues|pull|discussions)/(\d+)}{
    lc($1) eq $o ? $& : "https://redirect.github.com/$1/$2/$3/$4"}ge;
  s{(^|[^\w/.-])([\w.-]+)/([\w.-]+)#(\d+)\b}{
    lc($2) eq $o ? $& : "$1\[$2/$3#\x{200B}$4\](https://redirect.github.com/$2/$3/issues/$4)"}ge;
' "$digest" > "$tmp/body.md"

if $dry_run; then
  printf 'title: %s\nlabel: %s\n\n' "$TITLE" "$LABEL"
  cat "$tmp/body.md"
  exit 0
fi

url="$(gh issue create -R "$repo" --title "$TITLE" --label "$LABEL" --body-file "$tmp/body.md")"
new="${url##*/}"
[[ "$new" =~ ^[0-9]+$ ]] || die "gh issue create printed '$url'"
echo "posted $url"

for n in $(gh issue list -R "$repo" --label "$LABEL" --state open --limit 50 \
  --json number --jq ".[].number | select(. < $new)"); do
  gh issue close -R "$repo" "$n" --comment "Superseded by #$new."
done
