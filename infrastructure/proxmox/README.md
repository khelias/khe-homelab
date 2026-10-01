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
- Datasets: tank/data, which holds all service data (Immich's photos included), and tank/backups. tank/data/immich exists but is empty: the `/srv/data` export has no `crossmnt`, so the VM writes Immich's files into tank/data. The nextcloud, paperless and media datasets were empty for the same reason, and were destroyed on 2026-10-01 together with their directories in tank/data

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
| 100   | docker-vm  | Main Docker host     | 8    | 24GB  | Debian 13 (cloud-init) | NVMe (local-lvm) 256GB |
| 101   | playground | Testing/experiments  | 4    | 8GB   | Debian 13 (cloud-init) | NVMe (local-lvm) |

## Security

### Two-Factor Authentication (2FA)
Configured for `root@pam` (2026-04-15):
- **TOTP**: Microsoft Authenticator
- **Recovery keys**: generated (store in Vaultwarden or offline)
- **SSH**: key-only auth (unaffected by web UI 2FA — always available as fallback)

Setup: Datacenter → Permissions → Two Factor Authentication → Add TOTP / Recovery Keys

## Updates
Debian security updates install themselves (`unattended-upgrades`, limited to
the Debian security origin); Proxmox packages and kernels are upgraded by hand
in a monthly catch-up, and nothing reboots on its own. Guests start after the
NFS server (`pve-guests.service` drop-in), so the Docker VM never mounts an
export that is not there yet. A daily timer writes the host's update state for
ops-status and pushes it to its Uptime Kuma monitor. Set up by `../../scripts/setup-proxmox-updates.sh`
(called from the post-install script); the procedure and the kernel rollback
are in [docs/runbook.md](../../docs/runbook.md#os-updates-and-reboots).

## API tokens
Read-only consumers use the `monitor@pve` user with the `PVEAuditor` role on
`/`, and one privilege-separated token per consumer, also `PVEAuditor`:

```bash
pveum user add monitor@pve --comment "read-only"
pveum acl modify / --users monitor@pve --roles PVEAuditor
pveum user token add monitor@pve <consumer> --privsep 1
pveum acl modify / --tokens 'monitor@pve!<consumer>' --roles PVEAuditor
```

The token secret goes straight into that consumer's `.env` on the VM. Current
consumers: `homepage` (the Proxmox widget). `root@pam` gets no tokens; the
Homepage token it held until October 2026 is replaced and removed in
`khe-meta/plans/flickering-crunching-sparkle.md` step 4.

## VM Provisioning
VMs are created using Debian 13 (Trixie) cloud images with cloud-init (no interactive installer).
Cloud-init configures: hostname, static IP, SSH keys, user account.
See `../../scripts/create-docker-vm.sh`
