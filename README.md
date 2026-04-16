# KHE Homelab

Personal family homelab — self-hosted cloud, media, and AI on a single machine. Infrastructure as Code with Docker Compose on Proxmox VE.

## Architecture

```mermaid
graph TB
    Internet((Internet))
    VPN((Tailscale<br/>VPN))
    LAN((LAN<br/>devices))

    Internet --> CF[Cloudflare Tunnel]
    VPN -->|subnet route<br/>192.168.0.0/24| LAN
    AG[AdGuard Home<br/>split-horizon DNS] -.->|9 hosts<br/>*.khe.ee → 192.168.0.11| LAN
    LAN --> NPM[Nginx Proxy Manager<br/>wildcard *.khe.ee · LAN-only]

    CF -->|12 domains direct<br/>CF Access OTP on<br/>dash, n8n, openclaw| DVM
    NPM --> DVM

    subgraph DVM[Docker VM · 192.168.0.11 — 17 services · 27 containers]
        direction LR
        Core["<b>Core</b><br/>Homepage · Vaultwarden<br/>Dockge · Uptime Kuma"]
        Media["<b>Media</b><br/>Immich · Jellyfin<br/>Audiobookshelf"]
        Prod["<b>Productivity</b><br/>Nextcloud · Paperless-ngx"]
        AI["<b>AI</b><br/>Ollama · n8n · OpenClaw"]
        Apps["<b>Apps</b><br/>Landing Page · study-game"]
    end

    DVM --> HDD[(ZFS Mirror · 2× 12TB<br/>NFS /srv)]
    DVM -.-> NVMe[(NVMe 2TB<br/>OS + DB volumes)]
```

> NPM, AdGuard, and Cloudflare Tunnel also run on the same Docker VM (shown above in the ingress tier, not listed again inside Core).

Two independent paths to the same containers:
- **External** — Cloudflare Tunnel goes directly to each container (12 public hostnames). CF Access OTP gates `dash`, `n8n`, `openclaw`. Subject to Cloudflare's 100MB upload limit.
- **LAN / Tailscale** — AdGuard rewrites 9 hostnames (`khe.ee`, `dash`, `cloud`, `vault`, `docs`, `photos`, `jellyfin`, `books`, `status`) to `192.168.0.11`, so devices hit NPM with the wildcard cert and no upload limit. `n8n`, `openclaw`, `games` have no LAN shortcut — always via CF.

Proxmox VE (192.168.0.10) is the hypervisor; the Docker VM (192.168.0.11) is the only guest. Fast storage (NVMe) holds the VM root + DB volumes; bulk storage (ZFS mirror, NFS-mounted at `/srv`) holds photos, media, documents.

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

| | Service | Domain | What it does |
|---|---------|--------|-------------|
| 🌐 | **Landing Page** | `khe.ee` | Public family landing page |
| 🏠 | **Homepage** | `dash.khe.ee` | Service dashboard with live widgets (CF Access protected) |
| <img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/nextcloud.svg" width="22" /> | **Nextcloud** | `cloud.khe.ee` | Files, calendar, contacts (CalDAV/CardDAV), tuned PHP/PG/Redis |
| <img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/immich.svg" width="22" /> | **Immich** | `photos.khe.ee` | Photo library with ML tagging (Google Photos replacement) |
| <img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/vaultwarden.svg" width="22" /> | **Vaultwarden** | `vault.khe.ee` | Password manager with Passkey support |
| <img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/jellyfin.svg" width="22" /> | **Jellyfin** | `jellyfin.khe.ee` | Media server with Quick Sync HW transcoding |
| <img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/paperless-ngx.svg" width="22" /> | **Paperless-ngx** | `docs.khe.ee` | Document archive with OCR (Estonian + English) |
| <img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/audiobookshelf.svg" width="22" /> | **Audiobookshelf** | `books.khe.ee` | Audiobooks and podcasts |
| <img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/n8n.svg" width="22" /> | **n8n** | `n8n.khe.ee` | Workflow automation (CF Access protected) |
| <img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/uptime-kuma.svg" width="22" /> | **Uptime Kuma** | `status.khe.ee` | Service monitoring and alerts |
| <img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/claude-ai.svg" width="22" /> | **OpenClaw** | `openclaw.khe.ee` | AI devops agent with sandboxed Docker access (CF Access protected) |
| 🎮 | **study-game** | `games.khe.ee` | Study game app, auto-deployed from GitHub |
| <img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/ollama.svg" width="22" /> | Ollama | LAN only | Local AI models (qwen2.5:7b, CPU-only) |
| <img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/adguard-home.svg" width="22" /> | AdGuard Home | LAN only | DNS ad-blocking + split-horizon DNS |
| <img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/dockge.svg" width="22" /> | Dockge | LAN only | Docker Compose management UI |
| <img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/nginx-proxy-manager.svg" width="22" /> | Nginx Proxy Manager | LAN only | Reverse proxy + wildcard SSL for LAN traffic |
| <img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/cloudflare.svg" width="22" /> | Cloudflare Tunnel | — | Secure external access (no open ports) |

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
./scripts/setup-igpu-passthrough.sh   # 2. Bind Intel iGPU to vfio-pci for QSV (reboot after)
./scripts/create-zfs-pool.sh          # 3. Create ZFS mirror from 2x 12TB HDDs
./scripts/create-docker-vm.sh         # 4. Create Debian 13 VM (cloud-init, fully automated)
./scripts/setup-nfs-share.sh          # 5. Export ZFS pool via NFS

# Inside Docker VM (ssh khe@192.168.0.11)
./scripts/setup-docker-host.sh        # 6. Install Docker + real kernel + firmware (reboot after)
./scripts/mount-nfs-in-vm.sh          # 7. Mount NFS shares at /srv
./scripts/harden-docker-vm.sh         # 8. UFW firewall, fail2ban, SSH hardening
./scripts/setup-tailscale.sh          # 9. Install Tailscale as subnet router
./scripts/deploy.sh up                # 10. Start all 17 services
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
