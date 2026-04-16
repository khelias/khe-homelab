#!/usr/bin/env bash
# Docker host setup script
# Run INSIDE the Debian VM after cloud-init completes
set -euo pipefail

echo "=== Docker Host Setup ==="

# 1. Update system
echo "Updating system..."
sudo apt-get update && sudo apt-get -y upgrade

# 2. Swap cloud kernel for the full Debian kernel so /dev/dri (i915) works
#    with the passed-through Intel iGPU. Also enable non-free-firmware for the
#    Intel media driver used by Jellyfin/Immich Quick Sync transcoding.
echo "Configuring kernel + firmware for Quick Sync passthrough..."
SOURCES_FILE="/etc/apt/sources.list.d/debian.sources"
if [ -f "$SOURCES_FILE" ] && ! grep -q "non-free-firmware" "$SOURCES_FILE"; then
  sudo sed -i 's/^Components: main$/Components: main contrib non-free-firmware/' "$SOURCES_FILE"
  sudo apt-get update
fi
sudo apt-get install -y \
  linux-image-amd64 \
  firmware-misc-nonfree \
  intel-media-va-driver-non-free
# Ensure grub boots the new kernel (cloud kernel lacks i915 drivers)
if ! grep -q '^GRUB_DEFAULT=0$' /etc/default/grub 2>/dev/null; then
  sudo sed -i 's/^GRUB_DEFAULT=.*/GRUB_DEFAULT=0/' /etc/default/grub
  sudo update-grub
fi

# 3. Install Docker
echo "Installing Docker..."
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER"

# 4. Verify Docker Compose plugin (included with Docker)
sudo docker compose version

# 5. Install QEMU guest agent
echo "Installing QEMU guest agent..."
sudo apt-get install -y qemu-guest-agent
sudo systemctl enable --now qemu-guest-agent

# 6. Install useful tools
echo "Installing tools..."
sudo apt-get install -y \
  htop \
  ncdu \
  vim \
  curl \
  git \
  jq \
  unzip

# 7. Create local directories (not on NFS)
echo "Creating local directory structure..."
sudo mkdir -p /srv/dockge/stacks
sudo chown -R "$USER:$USER" /srv/dockge

# 8. Create shared Docker networks
# NOTE: proxy network is created by NPM's docker-compose.yml (it defines it)
# Only create ai-internal here as it's referenced as external by multiple services
echo "Creating shared Docker networks..."
sudo docker network create ai-internal 2>/dev/null || true

# 9. Disable systemd-resolved (frees port 53 for AdGuard Home)
echo "Disabling systemd-resolved for AdGuard..."
sudo systemctl disable --now systemd-resolved
sudo rm -f /etc/resolv.conf
echo "nameserver 192.168.0.1" | sudo tee /etc/resolv.conf > /dev/null

# 10. Configure automatic security updates
echo "Setting up unattended upgrades..."
sudo apt-get install -y unattended-upgrades
sudo dpkg-reconfigure -plow unattended-upgrades

echo ""
echo "=== Docker host ready ==="
echo "IMPORTANT:"
echo "  - Reboot the VM now so the new kernel loads (/dev/dri appears after reboot)"
echo "  - After reboot, log out and back in so your docker group membership applies"
echo ""
echo "Next steps:"
echo "  1. sudo reboot; verify /dev/dri exists after boot"
echo "  2. mount-nfs-in-vm.sh"
echo "  3. harden-docker-vm.sh"
echo "  4. setup-tailscale.sh  (optional — remote VPN access)"
echo "  5. git clone the homelab repo, then: ./scripts/deploy.sh up"
