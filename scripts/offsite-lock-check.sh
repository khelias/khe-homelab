#!/usr/bin/env bash
# Proves the R2 bucket lock with the VM's own token: a PUT with If-None-Match: *
# to an existing key must answer 409 ObjectLockedByBucketPolicy. R2 checks the
# lock before the condition, so with the rule off the answer is 412 and the
# object is left as it was.
#   (no argument)  one existing key under each restic prefix; attended, after
#                  the rules are switched back on
#   --sentinel     only config-lock-probe, which the config rule covers and
#                  restic never reads; nightly, so a mishandled condition can
#                  never touch restic's own files unattended
# Exit 0 when locked, 1 otherwise. See infrastructure/offsite-backup.md#bucket-lock.
set -uo pipefail

ENV_FILE="${HOME}/homelab/.env.offsite"
set -a
# shellcheck source=/dev/null
source "$ENV_FILE"
set +a
BUCKET_URL="${RESTIC_REPOSITORY#s3:}"
SENTINEL="config-lock-probe"

# Credentials go to curl on stdin, not argv, so ps does not show them.
s3() {
  printf 'user = "%s:%s"\naws-sigv4 = "aws:amz:auto:s3"\n' \
    "$AWS_ACCESS_KEY_ID" "$AWS_SECRET_ACCESS_KEY" |
    curl -sS --max-time 60 -K - -H "x-amz-content-sha256: UNSIGNED-PAYLOAD" "$@"
}

probe() {
  local label=$1 key=$2 body code
  body=$(s3 -X PUT -H "If-None-Match: *" --data-binary '' \
    -w ' %{http_code}' "${BUCKET_URL}/${key}")
  code=${body##* }
  if [ "$code" = 409 ] && [[ "$body" == *ObjectLockedByBucketPolicy* ]]; then
    echo "locked: ${label}"
  else
    echo "FAIL: ${label} not locked (HTTP ${code})" >&2
    return 1
  fi
}

if [ "${1:-}" = "--sentinel" ]; then
  # The first run creates it; a new key is allowed under the lock.
  code=$(s3 -o /dev/null -w '%{http_code}' -I "${BUCKET_URL}/${SENTINEL}")
  if [ "$code" = 404 ]; then
    s3 -o /dev/null -X PUT --data-binary 'lock probe' "${BUCKET_URL}/${SENTINEL}"
  fi
  probe "$SENTINEL" "$SENTINEL"
  exit
fi

rc=0
for prefix in config keys/ snapshots/ index/ data/; do
  key=$(s3 "${BUCKET_URL}?list-type=2&max-keys=1&prefix=${prefix}" |
    grep -o '<Key>[^<]*</Key>' | head -1 | sed 's/<[^>]*>//g')
  if [ -z "$key" ]; then
    echo "FAIL: no object under ${prefix}" >&2
    rc=1
    continue
  fi
  probe "$prefix" "$key" || rc=1
done
exit "$rc"
