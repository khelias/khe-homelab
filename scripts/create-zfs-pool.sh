#!/usr/bin/env bash
# Create ZFS mirror pool from the two 12TB WD Ultrastar drives
# Run on the Proxmox host AFTER installation
set -euo pipefail

echo "=== Creating ZFS Data Pool ==="

# List available disks
echo "Available disks:"
lsblk -d -o NAME,SIZE,MODEL,SERIAL | grep -v nvme | grep -v loop

echo ""
echo "Looking for WD Ultrastar drives..."

# Find the two HDD devices (excluding NVMe)
# Using disk-by-id for stable device names (best practice)
echo ""
echo "Disk IDs:"
ls -la /dev/disk/by-id/ | grep -E "^.*(ata|scsi)-WDC" | grep -v part

echo ""
echo "=== IMPORTANT ==="
echo "Identify your two WD Ultrastar drives from the list above."
echo "Use the /dev/disk/by-id/ paths for stable naming."
echo ""
echo "Example command (replace with your actual disk IDs):"
echo ""
echo "  zpool create -o ashift=12 \\"
echo "    -O compression=lz4 \\"
echo "    -O atime=off \\"
echo "    -O xattr=sa \\"
echo "    -O acltype=posixacl \\"
echo "    -O recordsize=128k \\"
echo "    tank mirror \\"
echo "    /dev/disk/by-id/ata-WDC_XXXXX_SERIAL1 \\"
echo "    /dev/disk/by-id/ata-WDC_XXXXX_SERIAL2"
echo ""
echo "After pool creation, create datasets:"
echo "  zfs create tank/data"
echo "  zfs create tank/backups"
echo "  zfs set copies=2 tank/backups"
echo ""
echo "Set mountpoint so Docker services find data at /srv:"
echo "  zfs set mountpoint=/srv tank"
echo ""
echo "Then add to Proxmox storage:"
echo "  pvesm add zfspool tank-data -pool tank/data -content images,rootdir"
