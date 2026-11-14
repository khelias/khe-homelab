#!/usr/bin/env bash
# Create a VM on Proxmox using the Debian 13 cloud image + cloud-init.
# Run on the Proxmox host. Fully automated - no interactive installer needed.
#
# With no environment variables it builds docker-vm (VM 100) as always. Any
# other VM_ID builds a further VM and must say who it is and who may log in:
#
#   VM_ID=102 VM_NAME=agent-vm VM_IP=<address>/24 VM_SSH_PUBKEY='<public key>' \
#     VM_CORES=2 VM_MEMORY=6144 VM_DISK_SIZE=40G ./scripts/create-vm.sh
#
# VM_SSH_PUBKEY is the key itself or a file holding it. The address is given
# at run time and never committed. VM_CORES, VM_MEMORY and VM_DISK_SIZE
# override docker-vm's sizes (8 cores, 16 GB, 256G); size by memory carefully,
# because docker-vm's RAM is pinned on the host by VFIO.
set -euo pipefail

VM_ID="${VM_ID:-100}"
VM_USER="khe"
VM_GATEWAY="192.168.0.1"
VM_DNS="192.168.0.1"
VM_STORAGE="local-lvm"
VM_CORES="${VM_CORES:-8}"
VM_MEMORY="${VM_MEMORY:-16384}"
VM_DISK_SIZE="${VM_DISK_SIZE:-256G}"

case "$VM_ID" in
  ''|*[!0-9]*) echo "FAIL: VM_ID must be a number, got '$VM_ID'" >&2; exit 1 ;;
esac

if [ "$VM_ID" = 100 ]; then
  VM_NAME="${VM_NAME:-docker-vm}"
  VM_IP="${VM_IP:-192.168.0.11/24}"
else
  : "${VM_NAME:?VM_ID=$VM_ID is not docker-vm; set VM_NAME}" \
    "${VM_IP:?VM_ID=$VM_ID is not docker-vm; set VM_IP}" \
    "${VM_SSH_PUBKEY:?VM_ID=$VM_ID is not docker-vm; set VM_SSH_PUBKEY}"
fi

case "$VM_IP" in
  *.*.*.*/[0-9]*) ;;
  *) echo "FAIL: VM_IP must be <address>/<prefix>, got '$VM_IP'" >&2; exit 1 ;;
esac

CLOUD_IMAGE_URL="https://cloud.debian.org/images/cloud/trixie/latest/debian-13-genericcloud-amd64.qcow2"
CLOUD_IMAGE_PATH="/var/lib/vz/template/cloud/debian-13-genericcloud-amd64.qcow2"

# Resolve the ssh key before any qm call: a VM with no key is unreachable, so
# the run fails instead of skipping it. The key goes into a file for qm.
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
KEY_FILE="$TMP_DIR/sshkeys"
if [ -n "${VM_SSH_PUBKEY:-}" ]; then
  if [ -f "$VM_SSH_PUBKEY" ]; then
    cat "$VM_SSH_PUBKEY" > "$KEY_FILE"
  else
    printf '%s\n' "$VM_SSH_PUBKEY" > "$KEY_FILE"
  fi
elif [ -f /root/.ssh/authorized_keys ]; then
  cat /root/.ssh/authorized_keys > "$KEY_FILE"
elif [ -f /root/.ssh/id_ed25519.pub ]; then
  cat /root/.ssh/id_ed25519.pub > "$KEY_FILE"
fi
if grep -q 'PRIVATE KEY' "$KEY_FILE" 2>/dev/null; then
  echo "FAIL: VM_SSH_PUBKEY holds a private key; give the public half" >&2
  exit 1
fi
if ! KEY_FINGERPRINTS="$(ssh-keygen -l -f "$KEY_FILE" 2>/dev/null)"; then
  echo "FAIL: no usable ssh public key for cloud-init (set VM_SSH_PUBKEY)" >&2
  exit 1
fi

echo "=== Creating VM $VM_NAME (ID: $VM_ID) ==="
echo "SSH key fingerprints for cloud-init (compare with the key's owner):"
echo "$KEY_FINGERPRINTS"

# 1. Download Debian 13 cloud image if missing or empty
mkdir -p /var/lib/vz/template/cloud
if [ ! -s "$CLOUD_IMAGE_PATH" ]; then
  rm -f "$CLOUD_IMAGE_PATH"
  echo "Downloading Debian 13 cloud image..."
  wget -O "$CLOUD_IMAGE_PATH" "$CLOUD_IMAGE_URL"
fi

# shellcheck disable=SC2012 # one known file; ls -lh gives its human-readable size
echo "Image ready: $(ls -lh "$CLOUD_IMAGE_PATH" | awk '{print $5}')"

# 2. Create VM with cloud-init support
echo "Creating VM..."
qm create "$VM_ID" \
  --name "$VM_NAME" \
  --ostype l26 \
  --cores "$VM_CORES" \
  --memory "$VM_MEMORY" \
  --cpu host \
  --machine q35 \
  --net0 virtio,bridge=vmbr0 \
  --scsihw virtio-scsi-single \
  --agent enabled=1 \
  --onboot 1 \
  --startup order=1

# 3. Import cloud image as main disk
echo "Importing cloud image as VM disk..."
qm set "$VM_ID" --scsi0 "$VM_STORAGE:0,import-from=$CLOUD_IMAGE_PATH,discard=on,iothread=1,ssd=1"

# 4. Resize disk to desired size
echo "Resizing disk to $VM_DISK_SIZE..."
qm disk resize "$VM_ID" scsi0 "$VM_DISK_SIZE"

# 5. Add cloud-init drive on SCSI (NOT IDE - genericcloud image lacks IDE drivers)
qm set "$VM_ID" --scsi1 "$VM_STORAGE:cloudinit"

# 6. Set boot order (disk first, no ISO needed)
qm set "$VM_ID" --boot order=scsi0

# 7. Add serial console for cloud-init output
qm set "$VM_ID" --serial0 socket --vga serial0

# 8. Configure cloud-init
echo "Configuring cloud-init..."
qm set "$VM_ID" --ciuser "$VM_USER"
qm set "$VM_ID" --ipconfig0 "ip=$VM_IP,gw=$VM_GATEWAY"
qm set "$VM_ID" --nameserver "$VM_DNS"
qm set "$VM_ID" --searchdomain khe.ee
qm set "$VM_ID" --sshkeys "$KEY_FILE"

# 9. Start VM
echo "Starting VM..."
qm start "$VM_ID"

echo ""
echo "=== VM $VM_ID ($VM_NAME) created and started ==="
echo "Cloud-init is configuring the VM on first boot (30-60 seconds)."
echo ""
echo "Once ready, SSH in:"
echo "  ssh $VM_USER@${VM_IP%/*}"
echo ""
echo "Next steps:"
echo "  1. Wait for cloud-init to finish: ssh $VM_USER@${VM_IP%/*} 'cloud-init status --wait'"
if [ "$VM_ID" = 100 ]; then
  echo "  2. Run setup-nfs-share.sh on Proxmox host"
  echo "  3. Run setup-docker-host.sh inside the VM"
  echo "  4. Run mount-nfs-in-vm.sh inside the VM"
  echo "  5. Run harden-docker-vm.sh inside the VM"
else
  echo "  2. Run the VM's own setup script inside it (agent-vm: setup-agent-vm.sh)"
fi
