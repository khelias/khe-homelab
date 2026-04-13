# KHE Homelab

Personal family homelab infrastructure managed as code. Everything runs on Docker Compose behind Proxmox VE.

## Hardware

| Component | Model |
|-----------|-------|
| CPU | Intel i7-12700K (12C/20T, iGPU UHD 770) |
| RAM | 32GB DDR5 |
| Motherboard | Z690 ATX |
| Boot disk | 2TB Kingston KC3000 NVMe |
| Data disks | 2x 12TB WD Ultrastar (ZFS Mirror) |
| PSU | Seasonic 850W Gold |
| Network | Intel 2.5G LAN → Asus RT-AX55 |

## Architecture

```
┌─────────────────────────────────────────────────┐
│                  Proxmox VE                      │
│              (192.168.0.10)                       │
│                                                   │
│  ┌──────────────────────────────────────────┐    │
│  │        Docker VM (192.168.0.11)           │    │
│  │                                            │    │
│  │  ┌─── Core ────────────────────────────┐  │    │
│  │  │ Nginx Proxy Manager  (:80/:443)     │  │    │
│  │  │ AdGuard Home         (:53/:8080)    │  │    │
│  │  │ Cloudflare Tunnel                   │  │    │
│  │  │ Vaultwarden                          │  │    │
│  │  │ Dockge               (:5001)        │  │    │
│  │  │ Uptime Kuma          (:3001)        │  │    │
│  │  │ Homepage             (:3000)        │  │    │
│  │  └────────────────────────────────────-┘  │    │
│  │  ┌─── Media ──────────────────────────┐   │    │
│  │  │ Immich               (:2283)       │   │    │
│  │  │ Jellyfin             (:8096)       │   │    │
│  │  │ Audiobookshelf       (:13378)      │   │    │
│  │  └───────────────────────────────────-┘   │    │
│  │  ┌─── Productivity ──────────────────┐    │    │
│  │  │ Nextcloud            (:8888)       │    │    │
│  │  │ Paperless-ngx        (:8010)       │    │    │
│  │  └───────────────────────────────────-┘   │    │
│  │  ┌─── AI ────────────────────────────┐    │    │
│  │  │ Ollama               (:11434)      │    │    │
│  │  │ n8n                  (:5678)       │    │    │
│  │  │ OpenClaw             (:18789)     │    │    │
│  │  └───────────────────────────────────-┘   │    │
│  └──────────────────────────────────────────┘    │
│                                                   │
│  NVMe: Proxmox OS + VM disks                     │
│  HDD:  ZFS Mirror (tank) → NFS → /srv/data       │
└─────────────────────────────────────────────────┘
```

## Network

| IP | Device |
|----|--------|
| 192.168.0.1 | Asus RT-AX55 (gateway) |
| 192.168.0.10 | Proxmox host (pve.khe.ee) |
| 192.168.0.11 | Docker VM |
| 192.168.0.100–254 | DHCP (phones, laptops, etc.) |

External access via Cloudflare Tunnel (no open ports on router).

## Domain Mapping (khe.ee)

| Subdomain | Service |
|-----------|---------|
| cloud.khe.ee | Nextcloud |
| photos.khe.ee | Immich |
| vault.khe.ee | Vaultwarden |
| jellyfin.khe.ee | Jellyfin |
| docs.khe.ee | Paperless-ngx |
| books.khe.ee | Audiobookshelf |
| n8n.khe.ee | n8n |
| status.khe.ee | Uptime Kuma |
| dockge.khe.ee | Dockge |
| adguard.khe.ee | AdGuard Home |
| khe.ee | Homepage (dashboard) |

## Setup Order

```bash
# 1. Install Proxmox VE on NVMe
# 2. Post-install hardening (on Proxmox host)
./scripts/proxmox-post-install.sh

# 3. Create ZFS data pool from HDDs (on Proxmox host)
./scripts/create-zfs-pool.sh

# 4. Create Docker VM (on Proxmox host)
./scripts/create-docker-vm.sh

# 5. Install Ubuntu Server in VM via Proxmox console

# 6. Set up NFS share (on Proxmox host)
./scripts/setup-nfs-share.sh

# 7. Inside VM: install Docker and prepare host
./scripts/setup-docker-host.sh

# 8. Inside VM: mount NFS shares
./scripts/mount-nfs-in-vm.sh

# 9. Harden the VM (firewall, fail2ban, SSH)
./scripts/harden-docker-vm.sh

# 10. Deploy services
./scripts/deploy.sh up
```

## Project Structure

```
services/
  core/           nginx-proxy-manager, adguard, cloudflare-tunnel, vaultwarden, dockge, uptime-kuma, homepage
  media/          immich, jellyfin, audiobookshelf
  productivity/   nextcloud, paperless-ngx
  ai/             ollama, n8n, openclaw
infrastructure/   proxmox and network documentation
scripts/          setup, deploy, and backup scripts
```

## Operations

```bash
./scripts/deploy.sh up       # Start all services
./scripts/deploy.sh down     # Stop all services
./scripts/deploy.sh status   # Show running containers
./scripts/deploy.sh pull     # Pull latest images
./scripts/backup.sh          # Backup databases and configs
```
