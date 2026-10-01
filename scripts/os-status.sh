#!/usr/bin/env bash
# Writes this machine's OS update state as a small JSON file, for ops-status
# (homelab-status.sh) and the weekly n8n report. Runs daily from the
# khe-os-status timer on the Proxmox host and on the Docker VM.
#
#   os-status.sh <output.json>             write the status file once
#   os-status.sh --install <output.json>   install this script and its timer
#
# Values are version strings, booleans and integers only: the file is read by
# a public repo's Actions log.
set -euo pipefail

BOOT_DIR="${OS_STATUS_BOOT_DIR:-/boot}"
REBOOT_FLAG="${OS_STATUS_REBOOT_FLAG:-/var/run/reboot-required}"
OS_RELEASE="${OS_STATUS_OS_RELEASE:-/etc/os-release}"

usage() { echo "usage: $0 [--install] <output.json>" >&2; exit 2; }

# Keeps a value inside a JSON string without a JSON tool, which the host lacks.
clean() { printf '%s' "$1" | tr -cd 'A-Za-z0-9._+~:/() -'; }

install_timer() {
  local out="$1"
  [ "$(id -u)" -eq 0 ] || { echo "--install needs root" >&2; exit 1; }
  install -m 755 "$0" /usr/local/sbin/khe-os-status
  cat > /etc/systemd/system/khe-os-status.service <<EOF
[Unit]
Description=Write the OS update status for ops-status and the weekly report
# ZFS datasets have no mount unit for RequiresMountsFor to wait on; on the VM
# zfs-mount.service does not exist and the line is a no-op.
After=zfs-mount.service
RequiresMountsFor=$(dirname "$out")

[Service]
Type=oneshot
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
    systemctl start khe-os-status.service
    echo "  wrote $out"
  else
    echo "  WARN: $(dirname "$out") does not exist yet; the timer writes once it does" >&2
  fi
}

write_status() {
  local out="$1" role os pve running newest reboot pending kernel tmp
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
  pending="$(LC_ALL=C apt list --upgradable 2>/dev/null | grep -c 'upgradable from' || true)"

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
  "pendingUpdates": ${pending:-0}
}
EOF
  chmod 644 "$tmp"
  mv -f "$tmp" "$out"
}

case "${1:-}" in
  --install) [ -n "${2:-}" ] || usage; install_timer "$2" ;;
  ''|-*) usage ;;
  *) write_status "$1" ;;
esac
