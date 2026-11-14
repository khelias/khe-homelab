#!/usr/bin/env bash
# Daily on agent-vm (auth-check.timer, as khe): pushes the Uptime Kuma
# heartbeat only when the agent can work: Claude is logged in, Tailscale is up
# and resolves docker-vm, and remote-control.service is active. A missed beat
# is the alert (the monitor's interval is 2 days), so a failure pushes nothing.
# Installed as /usr/local/sbin/khe-agent-auth-check by setup-agent-vm.sh.
set -uo pipefail

# The overrides are for tests with stubbed commands.
LIB="${KHE_LIB:-/usr/local/lib/khe/lib.sh}"
HEARTBEAT_ENV="${KHE_HEARTBEAT_ENV:-/etc/khe/agent-vm.heartbeat}"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"

# shellcheck source=/dev/null
. "$LIB"
heartbeat_init HEARTBEAT_URL_AGENT_VM "$HEARTBEAT_ENV"

problems=()
check() { # check <label> <command...>
  local label="$1"
  shift
  "$@" >/dev/null 2>&1 || problems+=("$label")
}

claude_logged_in() { claude auth status --json | jq -e '.loggedIn == true'; }

check "claude login" claude_logged_in
check "tailscale" tailscale status
check "docker-vm lookup" getent hosts docker-vm
check "remote-control.service" systemctl --user is-active remote-control.service

if [ "${#problems[@]}" -gt 0 ]; then
  echo "agent-vm check failed: ${problems[*]}" >&2
  exit 1
fi
heartbeat up "agent-vm ok"
