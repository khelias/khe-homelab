#!/usr/bin/env bash
# Create the main Docker VM on Proxmox using Debian 12 cloud image + cloud-init
# Run on the Proxmox host
# Fully automated - no interactive installer needed
set -euo pipefail

VM_ID=100
VM_NAME="docker-vm"
VM_CORES=8
VM_MEMORY=24576  # 24GB
VM_DISK_SIZE="32G"
VM_STORAGE="local-lvm"
VM_IP="192.168.0.11/24"
VM_GATEWAY="192.168.0.1"
VM_DNS="192.168.0.1"
VM_USER="khe"

CLOUD_IMAGE_URL="https://cloud.debian.org/images/cloud/bookworm/latest/debian-12-genericcloud-amd64.qcow2"
CLOUD_IMAGE_PATH="/var/lib/vz/template/cloud/debian-12-genericcloud-amd64.qcow2"

echo "=== Creating Docker VM (ID: $VM_ID) ==="

# 1. Download Debian 12 cloud image if missing or empty
mkdir -p /var/lib/vz/template/cloud
if [ ! -s "$CLOUD_IMAGE_PATH" ]; then
  rm -f "$CLOUD_IMAGE_PATH"
  echo "Downloading Debian 12 cloud image..."
  wget -O "$CLOUD_IMAGE_PATH" "$CLOUD_IMAGE_URL"
fi

echo "Image ready: $(ls -lh "$CLOUD_IMAGE_PATH" | awk '{print $5}')"

# 2. Create VM with cloud-init support
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

# 3. Add EFI disk
qm set $VM_ID --efidisk0 $VM_STORAGE:0,efitype=4m

# 4. Import cloud image as main disk
echo "Importing cloud image as VM disk..."
qm set $VM_ID --scsi0 $VM_STORAGE:0,import-from=$CLOUD_IMAGE_PATH,discard=on,iothread=1,ssd=1

# 5. Resize disk to desired size
echo "Resizing disk to $VM_DISK_SIZE..."
qm disk resize $VM_ID scsi0 $VM_DISK_SIZE

# 6. Add cloud-init drive
qm set $VM_ID --ide2 $VM_STORAGE:cloudinit

# 7. Set boot order (disk first, no ISO needed)
qm set $VM_ID --boot order=scsi0

# 8. Add serial console for cloud-init output
qm set $VM_ID --serial0 socket --vga serial0

# 9. Configure cloud-init
echo "Configuring cloud-init..."
qm set $VM_ID --ciuser $VM_USER
qm set $VM_ID --ipconfig0 ip=$VM_IP,gw=$VM_GATEWAY
qm set $VM_ID --nameserver $VM_DNS
qm set $VM_ID --searchdomain khe.ee

# Import SSH key from Proxmox host
if [ -f /root/.ssh/authorized_keys ]; then
  qm set $VM_ID --sshkeys /root/.ssh/authorized_keys
  echo "SSH keys imported from Proxmox host"
elif [ -f /root/.ssh/id_ed25519.pub ]; then
  qm set $VM_ID --sshkeys /root/.ssh/id_ed25519.pub
  echo "SSH key imported"
fi

# 10. Start VM
echo "Starting VM..."
qm start $VM_ID

echo ""
echo "=== VM $VM_ID created and started ==="
echo "Cloud-init is configuring the VM on first boot (30-60 seconds)."
echo ""
echo "Once ready, SSH in:"
echo "  ssh $VM_USER@${VM_IP%/*}"
echo ""
echo "Next steps:"
echo "  1. Wait for cloud-init to finish: ssh $VM_USER@${VM_IP%/*} 'cloud-init status --wait'"
echo "  2. Run setup-nfs-share.sh on Proxmox host"
echo "  3. Run setup-docker-host.sh inside the VM"
echo "  4. Run mount-nfs-in-vm.sh inside the VM"
echo "  5. Run harden-docker-vm.sh inside the VM"
