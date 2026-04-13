#!/usr/bin/env bash
# Create the main Docker VM on Proxmox
# Run on the Proxmox host
set -euo pipefail

VM_ID=100
VM_NAME="docker-vm"
VM_CORES=8
VM_MEMORY=24576  # 24GB
VM_DISK="32"     # OS disk size in GB (no suffix for Proxmox LVM)
VM_STORAGE="local-lvm"   # NVMe storage for fast VM disks
ISO_STORAGE="local"

echo "=== Creating Docker VM (ID: $VM_ID) ==="

# Download Ubuntu Server 24.04 LTS if not present
ISO_FILE="ubuntu-24.04.2-live-server-amd64.iso"
ISO_PATH="/var/lib/vz/template/iso/$ISO_FILE"
# Download ISO if missing or empty (previous failed download)
if [ ! -s "$ISO_PATH" ]; then
  rm -f "$ISO_PATH"
  echo "Downloading Ubuntu Server 24.04 LTS (~3GB)..."
  wget -O "$ISO_PATH" \
    "https://releases.ubuntu.com/24.04.2/$ISO_FILE"
fi

# Create VM
echo "Creating VM..."
qm create $VM_ID \
  --name $VM_NAME \
  --ostype l26 \
  --cores $VM_CORES \
  --memory $VM_MEMORY \
  --cpu host \
  --bios ovmf \
  --machine q35 \
  --net0 virtio,bridge=vmbr0 \
  --scsihw virtio-scsi-single \
  --agent enabled=1 \
  --onboot 1 \
  --startup order=1

# Add EFI disk
qm set $VM_ID --efidisk0 $VM_STORAGE:0,efitype=4m

# Add OS disk
qm set $VM_ID --scsi0 $VM_STORAGE:$VM_DISK,discard=on,iothread=1,ssd=1

# Attach ISO
qm set $VM_ID --ide2 $ISO_STORAGE:iso/$ISO_FILE,media=cdrom

# Set boot order
qm set $VM_ID --boot order="ide2;scsi0"

# Passthrough iGPU for Quick Sync (Intel UHD 770)
# Uncomment after confirming IOMMU is working:
# qm set $VM_ID --hostpci0 0000:00:02.0,mdev=i915-GVTg_V5_4

# NOTE: Data storage is provided via NFS from Proxmox ZFS pool,
# not as a virtual disk. See scripts/setup-nfs-share.sh

echo ""
echo "=== VM $VM_ID created ==="
echo "Next steps:"
echo "  1. Start VM: qm start $VM_ID"
echo "  2. Open console in Proxmox web UI"
echo "  3. Install Ubuntu Server 24.04"
echo "  4. Run setup-nfs-share.sh on Proxmox host"
echo "  5. Run setup-docker-host.sh inside the VM"
echo "  6. Run mount-nfs-in-vm.sh inside the VM"
