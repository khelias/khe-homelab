#!/usr/bin/env bash
# Set up NFS share on Proxmox host for ZFS data pool
# Run on the PROXMOX HOST after ZFS pool is created
set -euo pipefail

DOCKER_VM_IP="192.168.0.11"

echo "=== Setting up NFS share for ZFS data ==="

# 1. Install NFS server
echo "Installing NFS server..."
apt-get install -y nfs-kernel-server

# 2. Create ZFS datasets with proper mountpoints
echo "Creating ZFS datasets..."
zfs create -p tank/data/immich
zfs create -p tank/data/nextcloud
zfs create -p tank/data/paperless
zfs create -p tank/data/media
zfs create -p tank/backups

# Set mountpoint so everything lives under /srv
zfs set mountpoint=/srv tank

# 3. Configure NFS exports (only allow Docker VM)
echo "Configuring NFS exports..."
cat > /etc/exports <<EXPORTS
/srv/data    ${DOCKER_VM_IP}/32(rw,sync,no_subtree_check,no_root_squash)
/srv/backups ${DOCKER_VM_IP}/32(rw,sync,no_subtree_check,no_root_squash)
EXPORTS

# 4. Apply and start
exportfs -ra
systemctl enable --now nfs-kernel-server

echo ""
echo "=== NFS share ready ==="
echo "Exports:"
exportfs -v
echo ""
echo "Next: Mount these shares inside the Docker VM"
echo "  See scripts/mount-nfs-in-vm.sh"
