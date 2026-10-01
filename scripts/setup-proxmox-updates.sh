#!/usr/bin/env bash
# Run on the PROXMOX HOST as root. Safe to rerun.
#
# Debian security updates install themselves; Proxmox packages and kernels
# stay manual (the monthly procedure in docs/runbook.md). Nothing reboots on
# its own. Also orders guest start after the NFS export and installs the
# daily OS status file that ops-status and the weekly report read.
set -euo pipefail

STATUS_FILE=/srv/data/reports/khe/internal/os-status-pve-host.json
HERE="$(cd "$(dirname "$0")" && pwd)"

[ "$(id -u)" -eq 0 ] || { echo "Run as root on the Proxmox host." >&2; exit 1; }
command -v pveversion >/dev/null 2>&1 || { echo "Not a Proxmox host." >&2; exit 1; }
[ -f "$HERE/os-status.sh" ] || { echo "os-status.sh must sit next to this script." >&2; exit 1; }

echo "=== Proxmox update routine ==="

echo "Installing unattended-upgrades and tmux..."
apt-get install -y unattended-upgrades tmux

# 52 sorts after Debian's 50unattended-upgrades, so #clear drops its stable
# origins and leaves the security one alone.
echo "Limiting unattended upgrades to Debian security..."
cat > /etc/apt/apt.conf.d/52khe-security-only <<'EOF'
// Proxmox packages and kernels are upgraded by hand (docs/runbook.md).
#clear Unattended-Upgrade::Origins-Pattern;
Unattended-Upgrade::Origins-Pattern {
  "origin=Debian,codename=${distro_codename}-security,label=Debian-Security";
};
Unattended-Upgrade::Automatic-Reboot "false";
EOF
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF

echo "Checking the allowed origins (dry run, takes a minute)..."
allowed="$(unattended-upgrade --dry-run -d 2>&1 | grep -m 1 'Allowed origins are:' || true)"
allowed="${allowed#*Allowed origins are: }"
n_origins="$(printf '%s\n' "$allowed" | awk -F', ' '{ print NF }')"
case "$allowed" in
  *-security*) ;;
  *) echo "FAIL: no security origin allowed: '${allowed}'" >&2; exit 1 ;;
esac
if [ "$n_origins" -ne 1 ]; then
  echo "FAIL: expected only the security origin, got: ${allowed}" >&2
  exit 1
fi
echo "  allowed: ${allowed}"

# VM 100 mounts /srv/data from this host. Started before the export exists,
# its Docker would come up on the VM disk's empty /srv/data.
echo "Ordering guest start after the NFS server..."
mkdir -p /etc/systemd/system/pve-guests.service.d
cat > /etc/systemd/system/pve-guests.service.d/10-after-nfs.conf <<'EOF'
[Unit]
Wants=nfs-server.service
After=nfs-server.service
EOF
systemctl daemon-reload

echo "Installing the daily OS status timer..."
bash "$HERE/os-status.sh" --install "$STATUS_FILE"

echo ""
echo "=== Done ==="
systemctl show pve-guests -p After | sed 's/^After=//' | tr ' ' '\n' | grep -x 'nfs-server.service' >/dev/null \
  && echo "  pve-guests starts after nfs-server.service" \
  || { echo "FAIL: pve-guests is not ordered after nfs-server.service" >&2; exit 1; }
systemctl list-timers khe-os-status.timer --no-pager | head -n 2
