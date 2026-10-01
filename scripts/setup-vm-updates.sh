#!/usr/bin/env bash
# Run INSIDE the Docker VM with sudo. Safe to rerun on the live VM: it changes
# systemd and apt configuration only, restarts nothing and never touches
# ownership under /srv/data.
#
# Keeps Docker from starting before the NFS mounts, makes sure security
# updates install themselves, and installs the daily OS status file that
# ops-status and the weekly report read.
set -euo pipefail

STATUS_FILE=/srv/data/reports/khe/internal/os-status-vm.json
HERE="$(cd "$(dirname "$0")" && pwd)"

[ "$(id -u)" -eq 0 ] || { echo "Run with sudo inside the Docker VM." >&2; exit 1; }
[ -f "$HERE/os-status.sh" ] || { echo "os-status.sh must sit next to this script." >&2; exit 1; }

echo "=== Docker VM update routine ==="

echo "Installing tmux..."
apt-get install -y tmux

# Docker waiting is better than Docker writing to the VM disk's empty
# /srv/data. The failure mode is "all containers down", with the recovery in
# docs/runbook.md. Takes effect at the next Docker start; nothing restarts now.
echo "Ordering Docker after the NFS mounts..."
mkdir -p /etc/systemd/system/docker.service.d
cat > /etc/systemd/system/docker.service.d/10-after-nfs.conf <<'EOF'
[Unit]
After=remote-fs.target
RequiresMountsFor=/srv/data /srv/backups
EOF
systemctl daemon-reload

echo "Checking unattended upgrades..."
dump="$(apt-config dump)"
if ! printf '%s\n' "$dump" | grep -qx 'APT::Periodic::Update-Package-Lists "1";' \
  || ! printf '%s\n' "$dump" | grep -qx 'APT::Periodic::Unattended-Upgrade "1";'; then
  cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
  echo "  wrote 20auto-upgrades"
fi
if ! printf '%s\n' "$dump" | grep -q '^Unattended-Upgrade::Origins-Pattern:: ".*-security'; then
  echo "FAIL: unattended-upgrades allows no security origin; check /etc/apt/apt.conf.d/50unattended-upgrades" >&2
  exit 1
fi
echo "  security updates install themselves"

echo "Installing the daily OS status timer..."
bash "$HERE/os-status.sh" --install "$STATUS_FILE"

echo ""
echo "=== Done ==="
systemctl show docker -p After -p RequiresMountsFor
