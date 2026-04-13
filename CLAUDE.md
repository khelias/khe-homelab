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
- Hardware transcoding: Intel Quick Sync (i7-12700K iGPU passthrough)
