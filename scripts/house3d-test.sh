#!/usr/bin/env bash
# The house 3D view's tests: the model and build tests, the engine tests in Node, and a syntax
# check of every engine and test module (vendored three.js excepted). Runs from any directory;
# exits 1 when anything fails, after running everything.
set -u
cd "$(dirname "$0")/.." || exit 1

for tool in node python3; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "house3d-test: $tool is not installed" >&2
    exit 1
  fi
done

rc=0
fail() { echo "house3d-test: FAILED: $1" >&2; rc=1; }

python3 -I -m unittest discover -s tests/house3d || fail "python tests"
node --test tests/house3d/engine.test.mjs || fail "engine tests"

engine=services/home/homeassistant/house3d
while IFS= read -r f; do
  node --input-type=module --check < "$f" || fail "syntax: $f"
done < <(find "$engine" tests/house3d -path "$engine/vendor" -prune -o -type f \( -name '*.js' -o -name '*.mjs' \) -print | sort)

[ "$rc" -eq 0 ] && echo "house3d-test: all passed"
exit "$rc"
