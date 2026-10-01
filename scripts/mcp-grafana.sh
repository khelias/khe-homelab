#!/usr/bin/env bash
# Starts the official mcp-grafana server read-only for an agent on the
# operator's machine, so it can query Loki (container logs and the
# homelab-status snapshot) without ssh.
#
#   claude mcp add grafana --scope local -- <path>/scripts/mcp-grafana.sh
#
# Needs mcp-grafana v2.0.0 on PATH and a Viewer service account token in
# ~/.config/khe/grafana-token, mode 600. The server reads the token from the
# file itself; this script never prints it.
set -euo pipefail

TOKEN_FILE="${GRAFANA_TOKEN_FILE:-$HOME/.config/khe/grafana-token}"
export GRAFANA_URL="${GRAFANA_URL:-http://192.168.0.11:3030}"

command -v mcp-grafana >/dev/null || { echo "mcp-grafana not on PATH" >&2; exit 1; }
[ -s "$TOKEN_FILE" ] || { echo "missing Grafana token: $TOKEN_FILE" >&2; exit 1; }
mode="$(stat -f %Lp "$TOKEN_FILE" 2>/dev/null || stat -c %a "$TOKEN_FILE")"
[ "$mode" = 600 ] || { echo "$TOKEN_FILE is mode $mode; chmod 600 it" >&2; exit 1; }
# An inline token in the environment would win over the file.
unset GRAFANA_SERVICE_ACCOUNT_TOKEN GRAFANA_API_KEY
export GRAFANA_SERVICE_ACCOUNT_TOKEN_FILE="$TOKEN_FILE"

# v2.0.0 reports anonymous usage stats unless told not to. The disabled
# categories are on by default and have no backend here: the only datasources
# are Loki and Alertmanager, and Grafana has no image renderer.
exec mcp-grafana --disable-write --usage-stats=disabled \
  --disable-incident --disable-prometheus --disable-oncall --disable-asserts \
  --disable-pyroscope --disable-rendering --disable-provisioning
