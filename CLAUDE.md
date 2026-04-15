# KHE Homelab - Project Guidelines

## Language
Communicate in Estonian. Code comments and config files in English.

## Architecture
- Hypervisor: Proxmox VE on bare metal
- Containers: Docker Compose on a Proxmox VM (not K8s)
- GitOps: all docker-compose.yml files version-controlled here
- Domain: khe.ee via Cloudflare

## Project Structure
```
services/          # Docker Compose stacks, one dir per service
  core/            # Network infra: NPM, AdGuard, Cloudflare tunnel, Vaultwarden, Dockge, Uptime Kuma, Homepage
  media/           # Immich, Jellyfin, Audiobookshelf
  productivity/    # Nextcloud, Paperless-ngx
  ai/              # Ollama, n8n, OpenClaw
infrastructure/    # Proxmox setup notes, network config, ZFS
scripts/           # Deployment and maintenance scripts
```

## Conventions
- Each service directory has: docker-compose.yml and .env.example (if it uses env vars)
- Never commit .env files (secrets)
- Use named Docker volumes or bind mounts under /srv/data/<service>
- All services connect via a shared `proxy` Docker network for NPM
- Service-specific networks for DB isolation
- Pin Docker image versions (no :latest in production)

## Server Details
- Proxmox host IP: 192.168.0.10 (pve.khe.ee)
- Docker VM IP: 192.168.0.11
- Router: Asus RT-AX55 (192.168.0.1), DHCP range .100-.254
- Boot disk: 2TB Kingston KC3000 NVMe (Proxmox OS + VM disks)
- Data disk: ZFS mirror pool "tank" (2x 12TB WD Ultrastar) → NFS → /srv
- DBs (PostgreSQL): named Docker volumes on VM's NVMe disk (fast I/O)
- Large files (photos, media): NFS mount from ZFS pool (snapshots, compression)
- Hardware transcoding: Intel Quick Sync (i7-12700K iGPU passthrough) - NOT YET SET UP
- VM user: khe, SSH key auth only
- Cloudflare Tunnel: khe-homelab (token in VM .env file)

## Current Status (2026-04-15)
Working: Immich, Jellyfin, Vaultwarden, Paperless, Audiobookshelf, n8n,
Uptime Kuma, Homepage, Ollama, Dockge, AdGuard, NPM, Cloudflare Tunnel,
Nextcloud (33-apache + PG16).

AdGuard: pre-configured via AdGuardHome.yaml (bind mount), split-horizon
DNS rewrites for *.khe.ee → 192.168.0.11. Router DNS must point to
192.168.0.11 (primary) + 1.1.1.1 (fallback) to activate.

Nextcloud fix: PG CREATEROLE bug resolved via init-db.sh that creates a
non-superuser nextcloud DB user. See services/productivity/nextcloud/init-db.sh.

TODO: Router DNS config (AdGuard activation), iGPU passthrough,
fan curve, Immich Google Takeout import (821GB), Nextcloud iPhone setup,
OpenClaw onboarding, Proxmox 2FA.
