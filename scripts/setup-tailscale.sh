#!/usr/bin/env bash
# Install Tailscale on the Docker VM and configure it as a subnet router
# for the whole LAN (192.168.0.0/24). Run INSIDE the Docker VM.
#
# After the script finishes you must approve the advertised subnet route in
# the Tailscale admin console: https://login.tailscale.com/admin/machines
set -euo pipefail

ADVERTISE_ROUTES="${ADVERTISE_ROUTES:-192.168.0.0/24}"

echo "=== Tailscale setup ==="

# 1. Install Tailscale from the official apt repository (stable channel)
if ! command -v tailscale >/dev/null 2>&1; then
  echo "Installing Tailscale..."
  curl -fsSL https://pkgs.tailscale.com/stable/debian/trixie.noarmor.gpg \
    | sudo tee /usr/share/keyrings/tailscale-archive-keyring.gpg >/dev/null
  curl -fsSL https://pkgs.tailscale.com/stable/debian/trixie.tailscale-keyring.list \
    | sudo tee /etc/apt/sources.list.d/tailscale.list >/dev/null
  sudo apt-get update
  sudo apt-get install -y tailscale
else
  echo "  Tailscale already installed ($(tailscale version | head -1))"
fi

# 2. Enable IP forwarding so the subnet router can relay LAN traffic
SYSCTL_FILE="/etc/sysctl.d/99-tailscale.conf"
if [ ! -f "$SYSCTL_FILE" ]; then
  echo "Enabling IP forwarding..."
  sudo tee "$SYSCTL_FILE" >/dev/null <<'EOF'
net.ipv4.ip_forward = 1
net.ipv6.conf.all.forwarding = 1
EOF
  sudo sysctl --system >/dev/null
else
  echo "  IP forwarding already configured."
fi

# 3. Bring Tailscale up as a subnet router. --accept-dns=false means this node
#    keeps using AdGuard as its own resolver; clients still get MagicDNS.
echo ""
echo "Running 'tailscale up' — follow the login URL to authenticate this node."
sudo tailscale up \
  --advertise-routes="$ADVERTISE_ROUTES" \
  --accept-dns=false

echo ""
echo "=== Tailscale up ==="
tailscale status
echo ""
echo "FINAL STEP: Approve the advertised route $ADVERTISE_ROUTES in the admin console:"
echo "  https://login.tailscale.com/admin/machines"
echo "  → docker-vm → ... → Edit route settings → enable $ADVERTISE_ROUTES"
