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
| 2x WD Ultrastar 12TB | tank (ZFS mirror) | Data: service data (Immich photos), backups |

## ZFS Data Pool (created post-install)
- Pool name: `tank`
- Layout: mirror (2x 12TB)
- Usable space: ~12TB
- Compression: lz4
- Mountpoint: `/srv`
- Datasets: tank/data, which holds all service data (Immich's photos included), and tank/backups; no child datasets, for the reason in `scripts/setup-nfs-share.sh`

## Storage Access (ZFS → Docker VM)
ZFS pool lives on Proxmox host. Docker VM accesses it via **NFS**:
- Proxmox exports `/srv/data` and `/srv/backups` via NFS
- Docker VM mounts these at the same paths
- **Databases (PostgreSQL) stay on VM's NVMe disk** (named Docker volumes) for fast I/O
- **Large files (photos, backups) go via NFS** to ZFS for snapshots/compression

Why NFS over virtual disk (zvol):
- ZFS snapshots work per-file, not per-disk-image
- ZFS compression is effective on actual files
- No need to pre-allocate size, entire pool is available
- Easy to share with future VMs

## VM Layout
| VM ID | Name       | Purpose              | vCPU | RAM   | OS | OS Disk |
|-------|------------|----------------------|------|-------|----|---------|
| 100   | docker-vm  | Main Docker host     | 8    | 16GB  | Debian 13 (cloud-init) | NVMe (local-lvm) 256GB |
| (private) | agent-vm | The workspace agent  | 2    | 8GB   | Debian 13 (cloud-init) | NVMe (local-lvm) 40GB |

agent-vm runs the operator's Claude Code agent
([agent-vm.md](../agent-vm.md)). Its VM ID and address are in the private
khe-meta `house/` network document, not here. It has no passthrough, but its
ballooning is off ([why](../agent-vm.md)), so it needs 8 GB of free host
memory before it is created.

docker-vm has the iGPU passed through (`vfio-pci`) for Quick Sync: Immich's
server and machine-learning containers use it through `/dev/dri`. VFIO pins
all of its memory on the host from boot and ballooning cannot return any of
it: on 2026-10-01 a balloon
floor shrank the guest to 14 GiB while the host stayed at 96%. Size the VM by
`memory` alone, which needs a VM reboot. At 24GB the host had about 1 GiB
available next to ARC (capped at 3.1 GiB) while the guest used 6.8 GiB, the
rest file cache, after Ollama, Jellyfin, Nextcloud and Paperless were retired.
The guest has no swap and Immich ML jobs are its peaks, so keep headroom.

## Backups

A weekly `vzdump` job covers agent-vm, to a storage that is not exported to
docker-vm and is not copied offsite: the image holds the GitHub, Claude and
ssh credentials of the agent
([SECURITY.md](../../SECURITY.md#the-workspace-agent-agent-vm)).

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
the status snapshot and pushes it to its Uptime Kuma monitor. Set up by `../../scripts/setup-proxmox-updates.sh`
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
Homepage token it held was replaced and removed on 2026-10-01
(`khe-meta/plans/proxmox-vm-updates.md` step 4).

## VM Provisioning
VMs are created using Debian 13 (Trixie) cloud images with cloud-init (no interactive installer).
Cloud-init configures: hostname, static IP, SSH keys, user account.
See `../../scripts/create-vm.sh`: with no variables it builds docker-vm; any other VM
gives its ID, name, address and ssh public key at run time (the script lists them),
so addresses are never committed.

## Building it from scratch

The order the setup scripts run in, from a fresh Proxmox install to running stacks:

```bash
# On Proxmox host
./scripts/proxmox-post-install.sh     # 1. Disable enterprise repo, tools, security updates, IOMMU
./scripts/create-zfs-pool.sh          # 2. Create ZFS mirror from 2x 12TB HDDs
./scripts/create-vm.sh                # 3. Create the docker-vm Debian 13 VM (cloud-init, fully automated)
./scripts/setup-igpu-passthrough.sh   # 4. Bind Intel iGPU to vfio-pci, attach it to the VM (reboot after)
./scripts/setup-nfs-share.sh          # 5. Export ZFS pool via NFS

# Inside Docker VM (ssh khe@192.168.0.11)
./scripts/setup-docker-host.sh        # 6. Install Docker + real kernel + firmware (reboot after)
./scripts/mount-nfs-in-vm.sh          # 7. Mount NFS shares at /srv, Docker waits for them
./scripts/harden-docker-vm.sh         # 8. UFW firewall, fail2ban, SSH hardening
./scripts/setup-tailscale.sh          # 9. Install Tailscale as subnet router
./scripts/deploy.sh up                # 10. Start the stacks
sudo ./scripts/setup-status-timer.sh  # 11. 5-min status snapshot into Loki
```
