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
- Hardware transcoding: Intel Quick Sync (i7-12700K iGPU passthrough) - SET UP
  - vfio-pci binds iGPU on host (blacklisted i915), passed through to VM 100
  - VM runs linux-image-amd64 kernel (cloud kernel lacks i915), GRUB default set
  - VM apt sources include non-free-firmware for Intel firmware packages
  - /dev/dri mounted into jellyfin and immich-server containers
- VM user: khe, SSH key auth only
- Cloudflare Tunnel: khe-homelab (token in VM .env file)

## Current Status (2026-04-15)
Working: Immich, Jellyfin, Vaultwarden, Paperless, Audiobookshelf, n8n,
Uptime Kuma, Homepage, Ollama, Dockge, AdGuard, NPM, Cloudflare Tunnel,
Nextcloud (33-apache + PG16).

AdGuard: pre-configured via AdGuardHome.yaml (bind mount), split-horizon
DNS rewrites for *.khe.ee → 192.168.0.11. Router DNS: 192.168.0.11 (primary)
+ 1.1.1.1 (fallback) — ACTIVE.

Cloudflare: tunnel routes directly to Docker containers (NPM not used for
routing). Access policy protects khe.ee (homepage) with one-time PIN auth.
See infrastructure/cloudflare.md for full routing table.

Nextcloud: NEXTCLOUD_TRUSTED_DOMAINS includes internal hostname "nextcloud"
so Homepage widget can reach OCS API. Nextcloud app password (not admin
password) used for Homepage widget — generated via:
  docker exec nextcloud php occ user:add-app-password admin

Nextcloud fix: PG CREATEROLE bug resolved via init-db.sh that creates a
non-superuser nextcloud DB user. See services/productivity/nextcloud/init-db.sh.

Jellyfin QSV: configured via init container (encoding.xml bind mount +
system.xml patch). No web UI steps needed.

Homepage: live widgets for all services. Config in services/core/homepage/config/
(git-tracked bind mount). API keys stored in VM .env only (never committed).
To regenerate API keys from scratch:
  Proxmox:  pveum user token add root@pam homepage --privsep=0
  Paperless: docker exec paperless python3 manage.py drf_create_token admin
  Immich:   insert into api_key table (see scripts/ for helper)
  Jellyfin: insert into ApiKeys table in jellyfin.db
  ABS:      read token column from users table in absdatabase.sqlite
  Nextcloud: docker exec nextcloud php occ user:add-app-password admin

TODO: fan curve (BIOS Smart Fan is OK for now), Immich Google Takeout import
(821GB), Nextcloud iPhone setup, OpenClaw onboarding, Proxmox 2FA,
n8n Homepage widget (public API auth unresolved), bootstrap script for
full rebuild from scratch.
