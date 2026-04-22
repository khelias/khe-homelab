#!/usr/bin/env bash
# Security hardening for Docker VM
# Run INSIDE the Docker VM after setup-docker-host.sh
set -euo pipefail

echo "=== Docker VM Security Hardening ==="

# 1. Configure UFW firewall
echo "Setting up UFW firewall..."
sudo apt-get install -y ufw

# Default: deny incoming, allow outgoing
sudo ufw default deny incoming
sudo ufw default allow outgoing

# Allow SSH from local network only
sudo ufw allow from 192.168.0.0/24 to any port 22

# Allow Proxmox host
sudo ufw allow from 192.168.0.10

# Allow service ports from local network
ALLOWED_PORTS=(
  80    # NPM HTTP
  443   # NPM HTTPS
  81    # NPM Admin
  53    # AdGuard DNS
  3003  # AdGuard Setup (temporary)
  8080  # AdGuard Admin
  3000  # Homepage
  3001  # Uptime Kuma
  5001  # Dockge
  2283  # Immich
  8096  # Jellyfin
  8888  # Nextcloud
  8010  # Paperless
  5678  # n8n
  11434 # Ollama
  13378 # Audiobookshelf
  18789 # OpenClaw
)

for port in "${ALLOWED_PORTS[@]}"; do
  sudo ufw allow from 192.168.0.0/24 to any port "$port"
done

sudo ufw --force enable
echo "UFW enabled."

# 2. Install and configure fail2ban
echo "Setting up fail2ban..."
sudo apt-get install -y fail2ban

sudo tee /etc/fail2ban/jail.local > /dev/null <<'JAIL'
[DEFAULT]
bantime = 1h
findtime = 10m
maxretry = 5
ignoreip = 127.0.0.1/8 192.168.0.0/24

[sshd]
enabled = true
port = ssh
JAIL

sudo systemctl enable --now fail2ban
echo "fail2ban enabled."

# 3. SSH hardening
echo "Hardening SSH..."
sudo sed -i 's/#PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
sudo sed -i 's/#PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sudo systemctl restart sshd
echo "SSH hardened (root login disabled, key-only auth)."
echo "IMPORTANT: Make sure you have SSH key access before locking out!"

# 4. Automatic security updates
echo "Configuring automatic security updates..."
sudo apt-get install -y unattended-upgrades
echo 'Unattended-Upgrade::Automatic-Reboot "false";' | sudo tee /etc/apt/apt.conf.d/51auto-reboot

# 5. Install cron and schedule nightly backups.
# Offsite (restic → R2) runs at 03:00 after local (02:00). Requires
# ~/homelab/.env.offsite — see infrastructure/offsite-backup.md.
echo "Installing cron and scheduling backups..."
sudo apt-get install -y cron restic
sudo systemctl enable --now cron
BACKUP_CRON="0 2 * * * cd $HOME/homelab && ./scripts/backup.sh >> /srv/backups/backup.log 2>&1"
OFFSITE_CRON="0 3 * * * cd $HOME/homelab && ./scripts/offsite-backup.sh >> /srv/backups/offsite-backup.log 2>&1"
( crontab -l 2>/dev/null | grep -vE "(backup|offsite-backup)\.sh" ; \
  echo "$BACKUP_CRON" ; echo "$OFFSITE_CRON" ) | crontab -
sudo mkdir -p /srv/backups
sudo chown "$USER:$USER" /srv/backups

# 6. Hardware watchdog — force-reset the VM if the kernel hangs.
# Proxmox emulates iTCO_wdt (Intel TCO) with 30s timeout; the daemon pings
# it every 10s. Deliberately minimal config — NO load/memory/network tests,
# those cause false-positive reboots on transient spikes or network blips.
echo "Installing hardware watchdog daemon..."
sudo apt-get install -y watchdog
sudo tee /etc/watchdog.conf > /dev/null <<'WATCHDOG'
# Managed by scripts/harden-docker-vm.sh
watchdog-device = /dev/watchdog
interval = 10
realtime = yes
priority = 1
log-dir = /var/log/watchdog
WATCHDOG
sudo systemctl enable --now watchdog

# 7. Lock down .env files (600 — owner read/write only).
# Compose reads them as the running user; group/world read is never needed.
echo "Locking .env file permissions..."
find "$HOME/homelab/services" -name .env -not -name .env.example \
  -exec sudo chmod 600 {} \; 2>/dev/null || true

echo ""
echo "=== Hardening complete ==="
echo ""
echo "Manual steps still needed:"
echo "  1. Set up 2FA on Proxmox: Datacenter > Permissions > Two Factor"
echo "  2. Set up SSH key auth before PasswordAuthentication takes effect"
echo "  3. Review Dockge/Homepage Docker socket access"
