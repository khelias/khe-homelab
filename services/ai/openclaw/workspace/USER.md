# User: Kaido

Kaido manages a personal homelab running on Proxmox VE. All services run as
Docker Compose stacks on a single VM. The git repo for all configs is at
/home/khe/homelab on the Docker VM and /root/homelab on the Proxmox host.

## Infrastructure

| Component       | Details                                              |
|-----------------|------------------------------------------------------|
| Proxmox host    | 192.168.0.10 / pve.khe.ee, i7-12700K, 64GB RAM      |
| Docker VM       | 192.168.0.11, user: khe, SSH key auth only           |
| Domain          | khe.ee via Cloudflare                                |
| Boot disk       | 2TB Kingston KC3000 NVMe (OS + VM disks)             |
| Data disk       | ZFS mirror "tank" (2x 12TB WD Ultrastar) → /srv      |

## Running Services

### Core
- **NPM** — reverse proxy (internal routing)
- **AdGuard Home** — DNS, split-horizon for *.khe.ee → 192.168.0.11
- **Cloudflare Tunnel** — public access, tunnel routes directly to containers
- **Vaultwarden** — password manager
- **Dockge** — Docker Compose manager UI
- **Uptime Kuma** — uptime monitoring
- **Homepage** — dashboard (live widgets for all services)

### Media
- **Immich** — photo library (Google Takeout import pending: 821GB)
- **Jellyfin** — video streaming (Intel QSV hardware transcoding via iGPU passthrough)
- **Audiobookshelf** — audiobooks

### Productivity
- **Nextcloud** — files, will add CalDAV/CardDAV for iPhone
- **Paperless-ngx** — document management

### AI
- **Ollama** — local LLM server, model: qwen2.5:7b, CPU-only (no GPU yet)
- **n8n** — workflow automation
- **OpenClaw** — this agent

## Docker Networks
- `proxy` — all services that go through NPM
- `ai-internal` — Ollama, n8n, OpenClaw (isolated)
- `socket-proxy` — OpenClaw to docker-socket-proxy only

## Access policies (Cloudflare)
OTP via email protects: khe.ee (homepage), openclaw.khe.ee, n8n.khe.ee

## Pending work
- Immich Google Takeout import (821GB)
- Nextcloud iPhone CalDAV/CardDAV
- Proxmox 2FA
- Bootstrap script for full rebuild from scratch
