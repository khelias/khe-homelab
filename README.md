# KHE Homelab

Personal family homelab — self-hosted cloud, media, and AI on a single machine. Infrastructure as Code with Docker Compose on Proxmox VE.

## Architecture

```mermaid
graph LR
    Internet((Internet)) --> CF[Cloudflare\nTunnel]
    VPN((Tailscale\nVPN)) --> DVM

    CF --> Landing[khe.ee\nLanding Page]
    CF -->|CF Access OTP| Protected[dash · n8n · openclaw]
    CF --> Public[Vaultwarden · Uptime Kuma\nImmich · Jellyfin · Nextcloud\nPaperless · Audiobookshelf\nstudy-game]

    Landing & Public & Protected --- DVM[Docker VM\n192.168.0.11]

    DVM --- NPM[Nginx Proxy Manager\nwildcard *.khe.ee cert]
    NPM --- LAN((LAN devices\nsplit-horizon DNS))
    LAN --- AG[AdGuard Home\nDNS + ad-block]

    HDD[(ZFS Mirror\n2× 12TB)] -->|NFS| DVM
    NVMe[(NVMe 2TB)] -.->|OS + DBs| DVM
```

> **Proxmox VE** (192.168.0.10) runs a single **Docker VM** (192.168.0.11) with 17 services.
> External traffic via **Cloudflare Tunnel**, LAN traffic via **Nginx Proxy Manager** (split-horizon DNS).
> Remote access via **Tailscale VPN** (subnet router for the whole LAN).
> Fast storage (NVMe) for OS and databases, bulk storage (ZFS mirror) via NFS for photos, media, and files.

## Hardware

| Component | Spec |
|-----------|------|
| CPU | Intel i7-12700K (12C/20T, Quick Sync iGPU) |
| RAM | 32GB DDR5 |
| Boot | 2TB Kingston KC3000 NVMe |
| Storage | 2x 12TB WD Ultrastar (ZFS Mirror) |
| PSU | Seasonic 850W Gold |
| Network | Intel 2.5G LAN → Asus RT-AX55 |

Intel iGPU is passed through to the Docker VM via `vfio-pci` for hardware transcoding —
Jellyfin and Immich machine-learning both use `/dev/dri` for Quick Sync acceleration.

## Services

| Service | Domain | What it does |
|---------|--------|-------------|
| **Landing Page** | `khe.ee` | Public family landing page |
| **Homepage** | `dash.khe.ee` | Service dashboard with live widgets (CF Access protected) |
| **Nextcloud** | `cloud.khe.ee` | Files, calendar, contacts (CalDAV/CardDAV), tuned PHP/PG/Redis |
| **Immich** | `photos.khe.ee` | Photo library with ML tagging (Google Photos replacement) |
| **Vaultwarden** | `vault.khe.ee` | Password manager with Passkey support |
| **Jellyfin** | `jellyfin.khe.ee` | Media server with Quick Sync HW transcoding |
| **Paperless-ngx** | `docs.khe.ee` | Document archive with OCR (Estonian + English) |
| **Audiobookshelf** | `books.khe.ee` | Audiobooks and podcasts |
| **n8n** | `n8n.khe.ee` | Workflow automation (CF Access protected) |
| **Uptime Kuma** | `status.khe.ee` | Service monitoring and alerts |
| **OpenClaw** | `openclaw.khe.ee` | AI devops agent with sandboxed Docker access (CF Access protected) |
| **study-game** | `games.khe.ee` | Study game app, auto-deployed from GitHub |
| Ollama | LAN only | Local AI models (qwen2.5:7b, CPU-only) |
| AdGuard Home | LAN only | DNS ad-blocking + split-horizon DNS |
| Dockge | LAN only | Docker Compose management UI |
| Nginx Proxy Manager | LAN only | Reverse proxy + wildcard SSL for LAN traffic |
| Cloudflare Tunnel | — | Secure external access (no open ports) |

## Security & Access

Multiple independent layers — nothing on the router is exposed to the internet.

**External access — Cloudflare Tunnel**
Zero inbound ports. Cloudflare terminates TLS and forwards to containers over an outbound-only tunnel.
Sensitive services (Homepage, n8n, OpenClaw) sit behind **Cloudflare Access** with email OTP.

**Remote admin — Tailscale VPN**
Docker VM runs Tailscale as a **subnet router** (`192.168.0.0/24`), so any Tailscale-connected
device gets full LAN access: Proxmox UI, Dockge, AdGuard, NPM admin, and SSH to the VM.
Lets mobile devices bypass the Cloudflare 100MB upload limit — large Immich / Nextcloud
uploads go directly to NPM over VPN.

**LAN access — Wildcard SSL**
A `*.khe.ee` Let's Encrypt certificate (Cloudflare DNS-01 challenge, auto-renewing) on NPM means
every LAN service gets HTTPS without per-service certs. AdGuard does split-horizon DNS, so
`photos.khe.ee` at home resolves to `192.168.0.11` — fast, unlimited uploads, never touches the internet.

**Host hardening**
- SSH key-only auth on Docker VM (password login disabled)
- UFW firewall + fail2ban on the VM
- OpenClaw's Docker access goes through `docker-socket-proxy` (read-only + restart, no exec/create)
- All secrets in `.env` files on the VM, never committed

## Automation

Operational work is kept to a minimum by pushing everything into code and cron.

- **GitOps** — every `docker-compose.yml`, Homepage config, AdGuard config, and OpenClaw agent workspace
  is version-controlled here. Rebuilding any service is `git pull && docker compose up -d`.
- **Renovate** — watches every pinned image tag and opens PRs for updates (digests + changelogs).
- **GitHub Actions self-hosted runner** — a runner registered on the Docker VM picks up
  jobs from the `study-game` source repo: push to `main` → Vite build → `dist/` copied to
  `/srv/data/study-game/dist` → live in seconds. Nginx container here just serves the folder.
- **Certificate renewal** — NPM auto-renews the wildcard cert via Cloudflare DNS API. No manual steps.
- **Backup script** — `scripts/backup.sh` dumps all Postgres DBs and snapshots configs on a schedule.

## Network

```
192.168.0.1       Asus RT-AX55 (gateway, DHCP .100-.254)
192.168.0.10      Proxmox host (pve.khe.ee)
192.168.0.11      Docker VM (+ Tailscale subnet router)
192.168.0.2-99    Reserved for static devices
```

Router DNS → `192.168.0.11` (AdGuard, primary) + `1.1.1.1` (fallback).
All external traffic goes through Cloudflare Tunnel — zero ports open on the router.

## Setup

```bash
# On Proxmox host
./scripts/proxmox-post-install.sh     # 1. Disable enterprise repo, install tools, enable IOMMU
./scripts/create-zfs-pool.sh          # 2. Create ZFS mirror from 2x 12TB HDDs
./scripts/create-docker-vm.sh         # 3. Create Debian 13 VM (cloud-init, fully automated)
./scripts/setup-nfs-share.sh          # 4. Export ZFS pool via NFS

# Inside Docker VM (ssh khe@192.168.0.11)
./scripts/setup-docker-host.sh        # 5. Install Docker, tools, create networks
./scripts/mount-nfs-in-vm.sh          # 6. Mount NFS shares at /srv
./scripts/harden-docker-vm.sh         # 7. UFW firewall, fail2ban, SSH hardening
./scripts/deploy.sh up                # 8. Start core + media + productivity + ai stacks
```

## Day-to-day

```bash
./scripts/deploy.sh status   # What's running?
./scripts/deploy.sh pull     # Pull latest images
./scripts/deploy.sh up       # (Re)start everything
./scripts/deploy.sh down     # Stop everything
./scripts/backup.sh          # Backup databases + configs
```

## Project Structure

```
services/
├── core/            NPM, AdGuard, Cloudflare, Vaultwarden, Dockge, Uptime Kuma, Homepage
├── media/           Immich, Jellyfin, Audiobookshelf
├── productivity/    Nextcloud, Paperless-ngx
├── ai/              Ollama, n8n, OpenClaw (+ workspace/ for agent config)
└── apps/            Landing Page, study-game

infrastructure/      Proxmox, network, Cloudflare, and Tailscale documentation
scripts/             Setup, deploy, backup, and hardening scripts
```

---

*Built with [Claude Code](https://claude.ai/claude-code). Version tracking by [Renovate](https://github.com/renovatebot/renovate).*
