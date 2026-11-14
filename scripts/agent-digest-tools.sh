#!/usr/bin/env bash
# Puts what agent-digest-post.sh needs into <dir>, checked against pinned
# hashes: the gitleaks binary and the workspace's personal-data rules at a
# pinned khe-workspace commit. weekly-digest.yml and validate.yml both run
# it, so the pins live only here; move the rules pin when the rules change.
#
#   scripts/agent-digest-tools.sh <dir>     then PATH=<dir>:$PATH, PII_RULES=<dir>/pii-rules.toml
set -euo pipefail

GITLEAKS_VERSION=8.30.1
GITLEAKS_SHA256=551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb
RULES_COMMIT=bcd24b4999fb25ff81b2c529692b62b620830231
RULES_SHA256=502659e6ec759d7103b2b6d2581c6844424f08594ed16d27445e36e87dcac8e7

[ $# -eq 1 ] || { echo "usage: $0 <dir>" >&2; exit 2; }
dir="$1"
mkdir -p "$dir"

# Downloads $1 to $3 and fails unless its sha256 is $2.
fetch() {
  curl -fsSL --retry 3 -o "$3" "$1"
  echo "$2  $3" | sha256sum -c - >/dev/null || { echo "checksum mismatch for $1" >&2; exit 1; }
}

fetch "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz" \
  "$GITLEAKS_SHA256" "$dir/gitleaks.tar.gz"
tar -xzf "$dir/gitleaks.tar.gz" -C "$dir" gitleaks
rm -f "$dir/gitleaks.tar.gz"
fetch "https://raw.githubusercontent.com/khelias/khe-workspace/${RULES_COMMIT}/.claude/hooks/pii-rules.toml" \
  "$RULES_SHA256" "$dir/pii-rules.toml"
