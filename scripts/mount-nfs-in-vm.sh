#!/usr/bin/env bash
# Mount Proxmox NFS shares inside the Docker VM
# Run INSIDE the Docker VM
set -euo pipefail

PROXMOX_IP="192.168.0.10"

echo "=== Mounting NFS shares from Proxmox ==="

# 1. Install NFS client
echo "Installing NFS client..."
sudo apt-get install -y nfs-common

# 2. Create mount points
sudo mkdir -p /srv/data /srv/backups

# 3. Add to fstab for persistent mounts
echo "Adding NFS mounts to /etc/fstab..."

# Check if already in fstab
if ! grep -q "${PROXMOX_IP}:/srv/data" /etc/fstab; then
  cat <<FSTAB | sudo tee -a /etc/fstab
# Proxmox ZFS data pool via NFS
${PROXMOX_IP}:/srv/data    /srv/data    nfs  defaults,_netdev,soft,timeo=150  0  0
${PROXMOX_IP}:/srv/backups /srv/backups nfs  defaults,_netdev,soft,timeo=150  0  0
FSTAB
fi

# 4. Mount now
sudo mount -a

# 5. Verify
echo ""
echo "=== Mount verification ==="
df -h /srv/data /srv/backups
echo ""
echo "Test write access:"
touch /srv/data/.nfs-test && rm /srv/data/.nfs-test && echo "  /srv/data: OK"
touch /srv/backups/.nfs-test && rm /srv/backups/.nfs-test && echo "  /srv/backups: OK"
echo ""
# 6. Create data subdirectories on the NFS mount
echo "Creating data directories on NFS..."
mkdir -p /srv/data/{immich/upload,nextcloud,paperless/{media,consume,export},media/{audiobooks,podcasts,kids-cartoons}}

echo "NFS mounts ready. Docker services can now use /srv/data/*"
