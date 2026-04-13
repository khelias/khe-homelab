#!/usr/bin/env bash
# Proxmox VE post-install script
# Run on the Proxmox host after installation
set -euo pipefail

echo "=== Proxmox VE Post-Install ==="

# 1. Disable enterprise repository (no subscription)
echo "Disabling enterprise repository..."
if [ -f /etc/apt/sources.list.d/pve-enterprise.list ]; then
  sed -i 's/^deb/#deb/' /etc/apt/sources.list.d/pve-enterprise.list
fi

# 2. Add no-subscription repository
echo "Adding no-subscription repository..."
NOSUB_REPO="deb http://download.proxmox.com/debian/pve bookworm pve-no-subscription"
if ! grep -qF "$NOSUB_REPO" /etc/apt/sources.list.d/pve-no-subscription.list 2>/dev/null; then
  echo "$NOSUB_REPO" > /etc/apt/sources.list.d/pve-no-subscription.list
fi

# 3. Remove subscription nag
echo "Removing subscription nag..."
NAG_FILE="/usr/share/javascript/proxmox-widget-toolkit/proxmoxlib.js"
if [ -f "$NAG_FILE" ] && grep -q "data.status.toLowerCase() !== 'active'" "$NAG_FILE"; then
  sed -Ei.bak "s/data.status.toLowerCase\(\) !== 'active'/false/" "$NAG_FILE"
  systemctl restart pveproxy.service
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
  net-tools \
  lm-sensors

# 6. Enable IOMMU (for future GPU passthrough)
echo "Checking IOMMU..."
if ! grep -q "intel_iommu=on" /etc/default/grub; then
  sed -i 's/GRUB_CMDLINE_LINUX_DEFAULT="quiet"/GRUB_CMDLINE_LINUX_DEFAULT="quiet intel_iommu=on iommu=pt"/' /etc/default/grub
  update-grub
  echo "IOMMU enabled - reboot required"
fi

# 7. Set up ZFS email alerts (for data pool, created later)
echo "Configuring ZFS event daemon..."
cat > /etc/zfs/zed.d/zed.rc.local 2>/dev/null <<'ZEDEOF' || true
ZED_EMAIL_ADDR="root"
ZED_NOTIFY_VERBOSE=1
ZEDEOF

echo ""
echo "=== Post-install complete ==="
echo "Next steps:"
echo "  1. Reboot if IOMMU was enabled"
echo "  2. Create ZFS data pool (see scripts/create-zfs-pool.sh)"
echo "  3. Create Docker VM (see scripts/create-docker-vm.sh)"
echo "  4. Set static IP reservation on router"
