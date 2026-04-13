# Proxmox VE Setup

## Hardware
- CPU: Intel i7-12700K (12C/20T, iGPU UHD 770)
- RAM: 32GB DDR5
- Motherboard: Z690 ATX
- PSU: Seasonic 850W Gold
- Boot: 2TB Kingston KC3000 NVMe (ext4)
- Data: 2x 12TB WD Ultrastar (ZFS Mirror, configured post-install)
- Network: Intel igc 2.5G LAN

## Installation
- Target disk: Kingston KC3000 NVMe (/dev/nvme0n1), ext4
- Country: Estonia, Timezone: Europe/Tallinn
- Hostname: pve.khe.ee
- IP: 192.168.0.10/24
- Gateway: 192.168.0.1
- DNS: 192.168.0.1
- Network interface: igc (pinned)

## Post-Install
See `../../scripts/proxmox-post-install.sh`

## Storage Layout
| Device | Mount/Pool | Purpose |
|--------|-----------|---------|
| Kingston KC3000 NVMe 2TB | / (ext4) | Proxmox OS + VM system disks |
| 2x WD Ultrastar 12TB | tank (ZFS mirror) | Data: photos, media, files, backups |

## ZFS Data Pool (created post-install)
- Pool name: `tank`
- Layout: mirror (2x 12TB)
- Usable space: ~12TB
- Compression: lz4
- Mountpoint: `/srv`
- Datasets: tank/data/immich, tank/data/nextcloud, tank/data/paperless, tank/data/media, tank/backups

## Storage Access (ZFS → Docker VM)
ZFS pool lives on Proxmox host. Docker VM accesses it via **NFS**:
- Proxmox exports `/srv/data` and `/srv/backups` via NFS
- Docker VM mounts these at the same paths
- **Databases (PostgreSQL) stay on VM's NVMe disk** (named Docker volumes) for fast I/O
- **Large files (photos, media, documents) go via NFS** to ZFS for snapshots/compression

Why NFS over virtual disk (zvol):
- ZFS snapshots work per-file, not per-disk-image
- ZFS compression is effective on actual files
- No need to pre-allocate size, entire pool is available
- Easy to share with future VMs

## VM Layout
| VM ID | Name       | Purpose              | vCPU | RAM   | OS | OS Disk |
|-------|------------|----------------------|------|-------|----|---------|
| 100   | docker-vm  | Main Docker host     | 8    | 24GB  | Debian 13 (cloud-init) | NVMe (local-lvm) 32GB |
| 101   | playground | Testing/experiments  | 4    | 8GB   | Debian 13 (cloud-init) | NVMe (local-lvm) |

## VM Provisioning
VMs are created using Debian 13 (Trixie) cloud images with cloud-init (no interactive installer).
Cloud-init configures: hostname, static IP, SSH keys, user account.
See `../../scripts/create-docker-vm.sh`
