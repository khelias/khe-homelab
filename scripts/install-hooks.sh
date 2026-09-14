#!/usr/bin/env bash
# Wire repo-tracked git hooks (.githooks/) into this clone. Idempotent.
# Run once after `git clone`; the setting persists in .git/config.
#
#   ./scripts/install-hooks.sh
#
# Why core.hooksPath rather than copying into .git/hooks/: copies drift
# silently when the source updates. core.hooksPath makes git read straight
# from the version-controlled directory, so any future hook addition
# applies the moment the repo is pulled.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

git -C "$ROOT" config core.hooksPath .githooks
chmod +x "$ROOT"/.githooks/* 2>/dev/null || true
echo "core.hooksPath=.githooks (active)"

if command -v gitleaks >/dev/null 2>&1; then
  echo "gitleaks: $(gitleaks version 2>&1 | head -1)"
  exit 0
fi

cat <<'MSG'

gitleaks not found in PATH — the pre-commit hook needs it.

Install options:
  Linux (Debian):  sudo apt install gitleaks
  macOS:           brew install gitleaks
  Windows:         winget install gitleaks.gitleaks
  Manual:          https://github.com/gitleaks/gitleaks/releases

After install, the hook fires automatically on every git commit.
MSG
