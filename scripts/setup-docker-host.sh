#!/usr/bin/env bash
# Docker host setup script
# Run INSIDE the Debian VM after cloud-init completes
set -euo pipefail

echo "=== Docker Host Setup ==="

# 1. Update system
echo "Updating system..."
sudo apt-get update && sudo apt-get -y upgrade

# 2. Install Docker
echo "Installing Docker..."
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER"

# 3. Verify Docker Compose plugin (included with Docker)
sudo docker compose version

# 4. Install QEMU guest agent
echo "Installing QEMU guest agent..."
sudo apt-get install -y qemu-guest-agent
sudo systemctl enable --now qemu-guest-agent

# 5. Install useful tools
echo "Installing tools..."
sudo apt-get install -y \
  htop \
  ncdu \
  vim \
  curl \
  git \
  jq \
  unzip

# 6. Create local directories (not on NFS)
echo "Creating local directory structure..."
sudo mkdir -p /srv/dockge/stacks
sudo chown -R "$USER:$USER" /srv/dockge

# 7. Create shared Docker networks
echo "Creating shared Docker networks..."
sudo docker network create proxy 2>/dev/null || true
sudo docker network create ai-internal 2>/dev/null || true

# 8. Configure automatic security updates
echo "Setting up unattended upgrades..."
sudo apt-get install -y unattended-upgrades
sudo dpkg-reconfigure -plow unattended-upgrades

echo ""
echo "=== Docker host ready ==="
echo "IMPORTANT: Log out and back in for docker group to take effect"
echo ""
echo "Next steps:"
echo "  1. Clone your homelab repo: git clone <repo-url> ~/homelab"
echo "  2. Start core services first:"
echo "     cd ~/homelab/services/core/nginx-proxy-manager && docker compose up -d"
echo "     cd ~/homelab/services/core/adguard && docker compose up -d"
echo "  3. Then media and productivity services"
