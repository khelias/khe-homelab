# khe-homelab

Personal family homelab. Self-hosted cloud, media, and AI on a single Proxmox
VM running Docker Compose. Infrastructure as Code: every compose file,
AdGuard config, Homepage config, and OpenClaw workspace lives in this repo.

## Where to find detailed reference

Don't duplicate that content here. AGENTS.md only holds rules and pointers.

- [README.md](README.md) - architecture diagram, services table, security
  model, resilience layers, automation, network, setup, day-to-day ops
- [docs/operational-notes.md](docs/operational-notes.md) - per-service
  dev-facing quirks (AdGuard config keys, NPM upload limits, OpenClaw
  device pairing, games hub mount layout, etc.)
- [SECURITY.md](SECURITY.md) - security model
- [ROADMAP.md](ROADMAP.md) - planned changes
- [infrastructure/cloudflare.md](infrastructure/cloudflare.md) - CF Tunnel + Access
- [infrastructure/tailscale.md](infrastructure/tailscale.md) - VPN + subnet router
- [infrastructure/network/](infrastructure/network/) - LAN, DNS, AdGuard
- [infrastructure/proxmox/](infrastructure/proxmox/) - hypervisor, iGPU passthrough

## Tech stack

- Proxmox VE on bare metal (hypervisor)
- Single Debian 13 VM as Docker host (192.168.0.11)
- Docker Compose for orchestration (no Kubernetes)
- nginx Proxy Manager (LAN), Cloudflare Tunnel (external)
- AdGuard Home (DNS, split-horizon)
- Tailscale (subnet router for remote LAN access)
- ZFS mirror, NFS-mounted at `/srv` for bulk storage

Versions and image tags live in each service's `docker-compose.yml`.
Renovate opens PRs for image updates.

## Layout

```
services/
  core/            NPM, AdGuard, Cloudflare Tunnel, Vaultwarden, Dockge,
                   Uptime Kuma, Homepage, autoheal
  media/           Immich, Jellyfin, Audiobookshelf
  productivity/    Nextcloud, Paperless-ngx
  ai/              Ollama, n8n, OpenClaw (+ workspace/ for agent config)
  apps/            landing, games hub, trips
infrastructure/    Proxmox, network, Cloudflare, Tailscale docs
scripts/           setup, deploy.sh, backup.sh, hardening
docs/              operational-notes.md (service quirks not in README)
```

## Conventions (HARD)

1. **Each service directory** has `docker-compose.yml` and `.env.example`
   (if it uses env vars). Live `.env` files are `.gitignored`.
2. **Never commit secrets.** No `.env` files, no API keys, no tokens, no
   bcrypt hashes, no MAC addresses or device identifiers (public repo).
3. **Pin Docker image versions.** No `:latest` in production. Renovate
   bumps tags via PR with digest + changelog.
4. **Named Docker volumes** for service state, OR bind mounts under
   `/srv/data/<service>/`. Never bind to `/home` or arbitrary paths.
5. **Services on shared `proxy` network** for NPM ingress. Service-specific
   networks for DB isolation.
6. **AdGuard live `AdGuardHome.yaml` is `.gitignored`.** Apply changes as
   delta-patches against the committed `AdGuardHome.template.yaml`.
   Wholesale replacement wipes admin creds + active sessions. See
   [docs/operational-notes.md#adguard-home](docs/operational-notes.md).

## Server access

- Proxmox: `192.168.0.10` (`pve.khe.ee`), web UI on `:8006`
- Docker VM: `192.168.0.11`, SSH `khe@docker-vm` via Tailscale MagicDNS
- SSH key auth only. Password login disabled.
- All admin creds in VM `.env` files. Tailscale gives full LAN access remotely.

## Common operations

```bash
./scripts/deploy.sh status   # what's running
./scripts/deploy.sh pull     # pull latest images
./scripts/deploy.sh up       # (re)start everything
./scripts/deploy.sh down     # stop everything
./scripts/backup.sh          # dump Postgres DBs + snapshot configs
```

Per-service: `cd services/<group>/<service> && docker compose up -d`.

## Update discipline

When you change deployment surface (new service, removed service, network
topology, security model, resilience layer), update the relevant doc in
the SAME commit:

- New / removed service or domain -> [README.md](README.md) services table
  + architecture diagram
- New service-level quirk worth documenting (config gotcha, healthcheck
  edge case, dependency between services) -> [docs/operational-notes.md](docs/operational-notes.md)
- Network / DNS / CF / Tailscale change -> the relevant `infrastructure/*.md`
- Security model change -> [SECURITY.md](SECURITY.md)

AGENTS.md itself only changes when conventions change.
