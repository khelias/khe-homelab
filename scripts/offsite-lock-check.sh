#!/usr/bin/env bash
# Proves the R2 bucket lock with the VM's own token: for one existing key under
# each locked restic prefix, a PUT with If-None-Match: * must answer 409
# ObjectLockedByBucketPolicy. R2 checks the lock before the condition, so with
# the rule off the answer is 412 and the object is left as it was.
# Exit 0 when every prefix is locked, 1 otherwise. See
# infrastructure/offsite-backup.md#bucket-lock.
set -uo pipefail

ENV_FILE="${HOME}/homelab/.env.offsite"
set -a
# shellcheck source=/dev/null
source "$ENV_FILE"
set +a
BUCKET_URL="${RESTIC_REPOSITORY#s3:}"

# Credentials go to curl on stdin, not argv, so ps does not show them.
s3() {
  printf 'user = "%s:%s"\naws-sigv4 = "aws:amz:auto:s3"\n' \
    "$AWS_ACCESS_KEY_ID" "$AWS_SECRET_ACCESS_KEY" |
    curl -sS -K - -H "x-amz-content-sha256: UNSIGNED-PAYLOAD" "$@"
}

rc=0
for prefix in config keys/ snapshots/ index/ data/; do
  key=$(s3 "${BUCKET_URL}?list-type=2&max-keys=1&prefix=${prefix}" |
    grep -o '<Key>[^<]*</Key>' | head -1 | sed 's/<[^>]*>//g')
  if [ -z "$key" ]; then
    echo "FAIL: no object under ${prefix}" >&2
    rc=1
    continue
  fi
  body=$(s3 -X PUT -H "If-None-Match: *" --data-binary '' \
    -w ' %{http_code}' "${BUCKET_URL}/${key}")
  code=${body##* }
  if [ "$code" = 409 ] && [[ "$body" == *ObjectLockedByBucketPolicy* ]]; then
    echo "locked: ${prefix}"
  else
    echo "FAIL: ${prefix} not locked (HTTP ${code})" >&2
    rc=1
  fi
done
exit "$rc"
