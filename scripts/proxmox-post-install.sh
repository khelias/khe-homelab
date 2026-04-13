#!/usr/bin/env bash
# Proxmox VE 9.x post-install script
# Run on the Proxmox host after installation
# Tested on: Proxmox VE 9.1.1 (Debian Trixie)
set -euo pipefail

echo "=== Proxmox VE Post-Install ==="

# 1. Disable enterprise repositories (no subscription)
# Proxmox 9.x uses .sources format (deb822), not .list
echo "Disabling enterprise repositories..."
for f in /etc/apt/sources.list.d/pve-enterprise.sources /etc/apt/sources.list.d/ceph.sources; do
  if [ -f "$f" ]; then
    if grep -q "^Enabled: yes" "$f"; then
      sed -i 's/^Enabled: yes/Enabled: no/' "$f"
    elif ! grep -q "^Enabled:" "$f"; then
      echo "Enabled: no" >> "$f"
    fi
    echo "  Disabled: $f"
  fi
done

# 2. Add no-subscription repository
echo "Adding no-subscription repository..."
if [ ! -f /etc/apt/sources.list.d/pve-no-subscription.list ]; then
  echo "deb http://download.proxmox.com/debian/pve trixie pve-no-subscription" > /etc/apt/sources.list.d/pve-no-subscription.list
  echo "  Added pve-no-subscription repo"
fi

# 3. Remove subscription nag popup
echo "Removing subscription nag..."
NAG_FILE="/usr/share/javascript/proxmox-widget-toolkit/proxmoxlib.js"
if [ -f "$NAG_FILE" ] && grep -q "data.status.toLowerCase() !== 'active'" "$NAG_FILE"; then
  sed -Ei.bak "s/data.status.toLowerCase\(\) !== 'active'/false/" "$NAG_FILE"
  systemctl restart pveproxy.service
  echo "  Subscription nag removed"
fi

# 4. Update system
echo "Updating system..."
apt-get update && apt-get -y dist-upgrade

# 5. Install useful tools
echo "Installing tools..."
apt-get install -y \
  htop \
  iotop \
  ncdu \
  vim \
  curl \
  wget \
  git \
  net-tools \
  lm-sensors

# 6. Enable IOMMU (for future GPU passthrough)
echo "Checking IOMMU..."
if ! grep -q "intel_iommu=on" /etc/default/grub; then
  sed -i 's/GRUB_CMDLINE_LINUX_DEFAULT="quiet"/GRUB_CMDLINE_LINUX_DEFAULT="quiet intel_iommu=on iommu=pt"/' /etc/default/grub
  update-grub
  echo "  IOMMU enabled - reboot required"
fi

# 7. Enable ZFS autotrim and email alerts
echo "Configuring ZFS..."
zpool set autotrim=on rpool 2>/dev/null || true

echo ""
echo "=== Post-install complete ==="
echo "Next steps:"
echo "  1. Reboot if IOMMU was enabled"
echo "  2. Create ZFS data pool (see scripts/create-zfs-pool.sh)"
echo "  3. Create Docker VM (see scripts/create-docker-vm.sh)"
echo "  4. Set static IP reservation on router"
