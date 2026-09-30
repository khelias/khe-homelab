#!/usr/bin/env bash
# Every ghcr.io/khelias image pinned under services/ of the tree in $PWD must
# carry a build attestation from its own repo's ci.yml on main, and all images
# of one repo must come from one commit (khe-meta ADR-008). The commit is read
# from the signing certificate, not from the predicate the workflow wrote.
# The tree is $PWD, not the script's own: validate.yml runs the base branch's
# copy of this script against the PR checkout.
set -euo pipefail

# Image name -> the repo whose CI builds it. An unmapped image fails.
source_repo() {
  case "$1" in
    khe-ai-adventure-web | khe-ai-adventure-proxy) echo khelias/khe-ai-adventure ;;
    *) return 1 ;;
  esac
}

if [ ! -d services ]; then
  echo "Run from the repository root: no services/ in $PWD." >&2
  exit 1
fi

pairs="$(mktemp)"
refs="$(mktemp)"
trap 'rm -f "$pairs" "$refs"' EXIT
rc=0

err() {
  echo "::error::$*"
  rc=1
}

# Lowercased first: Docker accepts an uppercase registry host, which would
# otherwise slip past the match.
find services -name docker-compose.yml -print0 |
  xargs -0 cat | tr '[:upper:]' '[:lower:]' | sed -nE 's/^[[:space:]]*image:[[:space:]]*["'\'']?(ghcr\.io\/khelias\/[^"'\''[:space:]]*).*/\1/p' > "$refs"

while IFS= read -r ref; do
  if [[ ! "$ref" =~ ^ghcr\.io/khelias/([a-z0-9._-]+):([A-Za-z0-9._-]+)@sha256:([0-9a-f]{64})$ ]]; then
    err "$ref is not pinned as ghcr.io/khelias/<name>:<tag>@sha256:<digest>"
    continue
  fi
  name="${BASH_REMATCH[1]}"
  tag="${BASH_REMATCH[2]}"
  digest="${BASH_REMATCH[3]}"

  if ! repo="$(source_repo "$name")"; then
    err "ghcr.io/khelias/$name has no source repo in verify-estate-pins.sh"
    continue
  fi

  if ! out="$(gh attestation verify "oci://ghcr.io/khelias/$name@sha256:$digest" \
    --repo "$repo" \
    --signer-workflow "$repo/.github/workflows/ci.yml" \
    --source-ref refs/heads/main \
    --deny-self-hosted-runners \
    --bundle-from-oci \
    --format json)"; then
    err "ghcr.io/khelias/$name@sha256:$digest has no valid attestation from $repo ci.yml on main"
    continue
  fi

  commit="$(jq -r '[.[].verificationResult.signature.certificate.sourceRepositoryDigest] | unique | if length == 1 then .[0] else "" end' <<< "$out")"
  if [[ ! "$commit" =~ ^[0-9a-f]{40}$ ]]; then
    err "ghcr.io/khelias/$name@sha256:$digest: its attestations do not agree on one commit"
    continue
  fi
  if [[ "$tag" == sha-* ]] && [ "$tag" != "sha-$commit" ]; then
    err "ghcr.io/khelias/$name is tagged $tag but was built from $commit"
    continue
  fi

  echo "$name $repo $commit"
  printf '%s %s\n' "$repo" "$commit" >> "$pairs"
done < "$refs"

while IFS= read -r repo; do
  err "$repo images come from more than one commit; pin them to the same one"
done < <(sort -u "$pairs" | awk '{ print $1 }' | uniq -d)

[ -s "$refs" ] || echo "No ghcr.io/khelias images pinned."
exit "$rc"
