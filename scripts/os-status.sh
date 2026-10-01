#!/usr/bin/env bash
# Writes this machine's OS update state as a small JSON file for ops-status
# (homelab-status.sh) and pushes it to an Uptime Kuma push monitor: down when a
# reboot is due or an update has been pending for 30 days, up otherwise. Runs
# daily from the khe-os-status timer on the Proxmox host and on the Docker VM.
#
#   os-status.sh <output.json>             write the status file once
#   os-status.sh --install <output.json>   install this script and its timer
#
# Values are version strings, booleans, integers and null only: the file is
# read by a public repo's Actions log.
#
# The push URL is OS_STATUS_PUSH_URL in the config file; without it nothing is
# pushed. Setup: docs/operational-notes.md#os-update-heartbeats.
set -euo pipefail

BOOT_DIR="${OS_STATUS_BOOT_DIR:-/boot}"
REBOOT_FLAG="${OS_STATUS_REBOOT_FLAG:-/var/run/reboot-required}"
OS_RELEASE="${OS_STATUS_OS_RELEASE:-/etc/os-release}"
STATE_DIR="${OS_STATUS_STATE_DIR:-/var/lib/khe-os-status}"
CONFIG="${OS_STATUS_CONFIG:-/etc/khe/os-status.env}"
PENDING_DAYS="${OS_STATUS_PENDING_DAYS:-30}"

usage() { echo "usage: $0 [--install] <output.json>" >&2; exit 2; }

# Keeps a value inside a JSON string without a JSON tool, which the host lacks.
clean() { printf '%s' "$1" | tr -cd 'A-Za-z0-9._+~:/() -'; }

install_timer() {
  local out="$1"
  [ "$(id -u)" -eq 0 ] || { echo "--install needs root" >&2; exit 1; }
  install -m 755 "$0" /usr/local/sbin/khe-os-status
  cat > /etc/systemd/system/khe-os-status.service <<EOF
[Unit]
Description=Write the OS update status for ops-status and Uptime Kuma
# ZFS datasets have no mount unit for RequiresMountsFor to wait on; on the VM
# zfs-mount.service does not exist and the line is a no-op.
After=zfs-mount.service
RequiresMountsFor=$(dirname "$out")

[Service]
Type=oneshot
StateDirectory=khe-os-status
ExecStart=/usr/local/sbin/khe-os-status $out
EOF
  # 07:00 is after the daily package list refresh on both machines; the boot
  # run makes a reboot show as done without waiting a day.
  cat > /etc/systemd/system/khe-os-status.timer <<'EOF'
[Unit]
Description=Daily OS update status

[Timer]
OnCalendar=*-*-* 07:00
OnBootSec=5min
Persistent=true

[Install]
WantedBy=timers.target
EOF
  systemctl daemon-reload
  systemctl enable --now khe-os-status.timer
  if [ -d "$(dirname "$out")" ]; then
    echo "  first run; an unreachable Kuma makes the push retry for up to 6 min"
    systemctl start khe-os-status.service
    echo "  wrote $out"
  else
    echo "  WARN: $(dirname "$out") does not exist yet; the timer writes once it does" >&2
  fi
}

# Read, not sourced: the file is root's, but a value is all this needs from it.
push_url() {
  local url
  [ -r "$CONFIG" ] || return 0
  url="$(sed -n 's/^\(export \)\{0,1\}OS_STATUS_PUSH_URL=//p' "$CONFIG" | tail -n 1 | tr -d "\"' \r")"
  # Kuma shows the URL with ?status=up&msg=OK&ping=; a second status parameter
  # would reach it as an array and read as down.
  printf '%s' "${url%%\?*}"
}

push_status() {
  local reboot="$1" pending="$2" since="$3" running="$4" newest="$5"
  local url status=up msg="" days=0 noun=updates
  url="$(push_url)"
  [ -n "$url" ] || return 0
  if [ "$pending" -gt 0 ]; then
    days=$(( ($(date +%s) - since) / 86400 ))
    if [ "$pending" -eq 1 ]; then noun=update; fi
    msg="${pending} ${noun} pending ${days} d"
    if [ "$days" -ge "$PENDING_DAYS" ]; then status=down; fi
  fi
  if [ "$reboot" = true ]; then
    status=down
    msg="${msg:+${msg}, }reboot due"
    if [ "$newest" != "$running" ]; then msg="${msg} (${running} -> ${newest})"; fi
  fi
  msg="${msg:-up to date}"
  # The host's boot run fires while VM 100 and Kuma are still starting.
  curl -fsS --max-time 5 --retry 10 --retry-delay 30 --retry-all-errors -G \
    --data-urlencode "status=${status}" \
    --data-urlencode "msg=${msg}" \
    "$url" >/dev/null 2>&1 || true
}

write_status() {
  local out="$1" role os pve running newest reboot upgradable apt_ok pending since kernel tmp
  if command -v pveversion >/dev/null 2>&1; then
    role="pve-host"
    pve="\"$(clean "$(pveversion | awk -F/ '{ print $2 }')")\""
  else
    role="vm"
    pve=null
  fi

  os="$(sed -n 's/^PRETTY_NAME=//p' "$OS_RELEASE" 2>/dev/null | tr -d '"')"
  os="${os:-unknown}"
  running="$(uname -r)"

  newest=""
  for kernel in "$BOOT_DIR"/vmlinuz-*; do
    [ -e "$kernel" ] || continue
    kernel="${kernel##*/vmlinuz-}"
    # Proxmox keeps its own kernels apart from any Debian one left installed.
    if [ "$role" = pve-host ]; then
      case "$kernel" in *-pve) ;; *) continue ;; esac
    fi
    newest="$(printf '%s\n%s\n' "$newest" "$kernel" | sed '/^$/d' | sort -V | tail -n 1)"
  done

  # Proxmox kernels never set the Debian flag, so the host compares kernels; a
  # kernel pinned to an older version therefore reads as a reboot due.
  reboot=false
  [ -e "$REBOOT_FLAG" ] && reboot=true
  if [ "$role" = pve-host ] && [ -n "$newest" ] && [ "$newest" != "$running" ]; then
    reboot=true
  fi

  # Counts from the package lists the daily jobs refresh (pve-daily-update on
  # the host, apt-daily on the VM); this script never runs apt update itself.
  # A failed apt reads as 0 pending but must not reset the pending age below.
  apt_ok=true
  upgradable="$(LC_ALL=C apt list --upgradable 2>/dev/null)" || apt_ok=false
  pending="$(printf '%s\n' "$upgradable" | grep -c 'upgradable from' || true)"
  pending="${pending:-0}"

  # The day the pending count last left zero, kept across runs so the push can
  # tell an update waiting for a week from one waiting for a month.
  since=null
  mkdir -p "$STATE_DIR"
  if [ "$pending" -gt 0 ]; then
    since="$(cat "$STATE_DIR/pending-since" 2>/dev/null || true)"
    case "$since" in
      ''|*[!0-9]*) since="$(date +%s)"; printf '%s\n' "$since" > "$STATE_DIR/pending-since" ;;
    esac
  elif [ "$apt_ok" = true ]; then
    rm -f "$STATE_DIR/pending-since"
  fi

  tmp="$(mktemp "$(dirname "$out")/.os-status.XXXXXX")"
  cat > "$tmp" <<EOF
{
  "role": "$role",
  "generatedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "generatedEpoch": $(date +%s),
  "os": "$(clean "$os")",
  "pveVersion": $pve,
  "runningKernel": "$(clean "$running")",
  "newestKernel": "$(clean "${newest:-$running}")",
  "rebootRequired": $reboot,
  "pendingUpdates": $pending,
  "pendingSinceEpoch": $since
}
EOF
  chmod 644 "$tmp"
  mv -f "$tmp" "$out"

  push_status "$reboot" "$pending" "$since" "$(clean "$running")" "$(clean "${newest:-$running}")"
}

case "${1:-}" in
  --install) [ -n "${2:-}" ] || usage; install_timer "$2" ;;
  ''|-*) usage ;;
  *) write_status "$1" ;;
esac
