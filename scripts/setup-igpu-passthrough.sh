#!/usr/bin/env bash
# Bind Intel iGPU to vfio-pci on the Proxmox host so it can be passed through
# to the Docker VM for Jellyfin/Immich Quick Sync hardware transcoding.
#
# Run on the Proxmox HOST (not inside the VM).
# Requires IOMMU enabled (intel_iommu=on) — proxmox-post-install.sh sets this.
# A reboot is required after this script.
set -euo pipefail

VM_ID="${VM_ID:-100}"

echo "=== iGPU passthrough setup ==="

# 1. Verify IOMMU is enabled in the running kernel
if [ ! -d /sys/class/iommu ] || [ -z "$(ls -A /sys/class/iommu 2>/dev/null)" ]; then
  echo "ERROR: IOMMU is not active. Run proxmox-post-install.sh and reboot first." >&2
  exit 1
fi
echo "  IOMMU active."

# 2. Detect Intel iGPU PCI address + vendor:device id
IGPU_ADDR="$(lspci -nn | awk '/VGA|Display/ && /Intel/ {print $1; exit}')"
IGPU_ID="$(lspci -nn | awk '/VGA|Display/ && /Intel/' | grep -oE '8086:[0-9a-f]{4}' | head -1)"
if [ -z "$IGPU_ADDR" ] || [ -z "$IGPU_ID" ]; then
  echo "ERROR: No Intel iGPU detected via lspci." >&2
  exit 1
fi
echo "  Detected iGPU: $IGPU_ADDR ($IGPU_ID)"

# 3. Ensure vfio modules load at boot
MODULES_FILE="/etc/modules"
for mod in vfio vfio_iommu_type1 vfio_pci; do
  if ! grep -qxF "$mod" "$MODULES_FILE"; then
    echo "$mod" >> "$MODULES_FILE"
    echo "  Added $mod to $MODULES_FILE"
  fi
done

# 4. Bind the iGPU to vfio-pci by vendor:device id
VFIO_CONF="/etc/modprobe.d/vfio.conf"
VFIO_LINE="options vfio-pci ids=$IGPU_ID disable_vga=1"
if [ ! -f "$VFIO_CONF" ] || ! grep -qxF "$VFIO_LINE" "$VFIO_CONF"; then
  echo "$VFIO_LINE" > "$VFIO_CONF"
  echo "  Wrote $VFIO_CONF"
fi

# 5. Blacklist i915 on the host so it doesn't grab the device before vfio-pci
BLACKLIST_CONF="/etc/modprobe.d/blacklist-i915.conf"
if [ ! -f "$BLACKLIST_CONF" ]; then
  cat > "$BLACKLIST_CONF" <<'EOF'
blacklist i915
blacklist snd_hda_intel
EOF
  echo "  Wrote $BLACKLIST_CONF"
fi

# 6. Rebuild initramfs so the blacklist/binding takes effect early
echo "Updating initramfs..."
update-initramfs -u -k all

# 7. If VM $VM_ID already exists, attach the iGPU as a PCI device
if qm status "$VM_ID" >/dev/null 2>&1; then
  CURRENT_HOSTPCI="$(qm config "$VM_ID" | awk -F': ' '/^hostpci0:/ {print $2}')"
  if [ -z "$CURRENT_HOSTPCI" ]; then
    echo "Attaching iGPU to VM $VM_ID..."
    qm set "$VM_ID" --hostpci0 "$IGPU_ADDR,pcie=1"
  else
    echo "  VM $VM_ID already has hostpci0: $CURRENT_HOSTPCI"
  fi
else
  echo "  VM $VM_ID does not exist yet — run create-docker-vm.sh, then re-run this script."
fi

echo ""
echo "=== Host passthrough configured ==="
echo "REBOOT the Proxmox host, then inside the VM run setup-docker-host.sh"
echo "to install the i915-capable kernel + firmware for /dev/dri to appear."
