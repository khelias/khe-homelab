# Architecture

How the homelab fits together: the two paths in, the services and their
domains, and the automation that keeps it running. The resilience layers are
in the [README](../README.md#resilience), the access model in
[SECURITY.md](../SECURITY.md#access-model), the LAN and DNS in
[infrastructure/network/](../infrastructure/network/) and the hardware in
[infrastructure/proxmox/](../infrastructure/proxmox/).

## Overview

```mermaid
graph TB
    Internet((Internet))
    VPN((Tailscale<br/>VPN))
    LAN((LAN<br/>devices))

    Internet --> CF[Cloudflare Tunnel]
    VPN -->|subnet route<br/>192.168.0.0/24| LAN
    AG[AdGuard Home<br/>split-horizon DNS] -.->|per-host rewrites<br/>→ 192.168.0.11| LAN
    LAN --> NPM[Nginx Proxy Manager<br/>wildcard *.khe.ee · LAN-only]

    CF -->|public hostnames<br/>CF Access OTP on<br/>the private apps| DVM
    NPM --> DVM

    subgraph DVM[Docker VM · 192.168.0.11]
        direction LR
        Core["<b>Core</b><br/>Homepage · Vaultwarden<br/>Uptime Kuma"]
        Media["<b>Media</b><br/>Immich"]
        Apps["<b>Apps</b><br/>Landing Page · games hub<br/>pages · trips · stories"]
        Obs["<b>Observability</b><br/>Loki · Grafana<br/>Alloy · Alertmanager"]
        Home["<b>Home</b><br/>Home Assistant<br/>Mosquitto · PAI"]
    end

    DVM --> HDD[(ZFS Mirror · 2× 12TB<br/>NFS /srv)]
    DVM -.-> NVMe[(NVMe 2TB<br/>OS + DB volumes)]
```

> NPM, AdGuard, and Cloudflare Tunnel also run on the same Docker VM (shown above in the ingress tier, not listed again inside Core).

Two independent paths to the same containers:
- **External** — Cloudflare Tunnel goes directly to each container. CF Access OTP gates the private apps. Subject to Cloudflare's 100MB upload limit.
- **LAN / Tailscale** — AdGuard rewrites the LAN-served hostnames to `192.168.0.11`, so devices hit NPM with the wildcard cert and no upload limit. `draft`, games and pages have no LAN shortcut and always go through Cloudflare; `dash`, `trips` and `stories` are Access-gated only from outside.

Which hostname goes where, and which ones Access gates, is in [infrastructure/cloudflare.md](../infrastructure/cloudflare.md).

Proxmox VE (192.168.0.10) is the hypervisor; the Docker VM (192.168.0.11) runs every service. Fast storage (NVMe) holds the VM root + DB volumes; bulk storage (ZFS mirror, NFS-mounted at `/srv`) holds photos and backups.

## Services

| | Service | Domain | What it does |
|---|---------|--------|-------------|
| 🌐 | **Landing Page** | `khe.ee` | Public family landing page; shared trips under `/r/`, the trip atlas demo under `/trips/`, the published bedtime stories under `/stories/` |
| 🏠 | **Homepage** | `dash.khe.ee` | Service dashboard with live widgets (CF Access protected) |
| <img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/immich.svg" width="22" /> | **Immich** | `photos.khe.ee` | Photo library with ML tagging (Google Photos replacement) |
| <img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/vaultwarden.svg" width="22" /> | **Vaultwarden** | `vault.khe.ee` | Password manager with Passkey support |
| <img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/uptime-kuma.svg" width="22" /> | **Uptime Kuma** | `status.khe.ee` | Service monitoring and alerts |
| 🎮 | **games hub** | `games.khe.ee` | Launcher, khe-study (`/study/`) and khe-ai-adventure (`/adventure/`), auto-deployed from GitHub |
| 🗺️ | **trips** | `trips.khe.ee` | Private family trip atlas, CF Access protected, own GitHub runner |
| 🌙 | **stories** | `stories.khe.ee` | Unejänku, the family's bedtime stories app, CF Access protected; khe-bunny-tales' runner deploys it, audio in `/srv/data/stories/audio`; `stories-api` under `/api/` takes the children's story requests |
| 📝 | **pages** | `pages.khe.ee` | Quick-publish HTML pages; edited at `draft.khe.ee` (CF Access protected) |
| <img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/home-assistant.svg" width="22" /> | Home Assistant | `home.khe.ee` (LAN + Tailscale) | House automation: HVAC, grid metering and cameras over local protocols. Deliberately not on the tunnel; the house detail is in the private khe-meta repo |
| | Mosquitto | internal only | MQTT broker for Home Assistant and PAI; publishes no host port |
| | PAI | internal only | Bridges the Paradox alarm panel to MQTT |
| <img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/adguard-home.svg" width="22" /> | AdGuard Home | LAN + Tailscale | DNS ad-blocking on the LAN + split-horizon DNS; over Tailscale it answers only the `khe.ee` zone |
| <img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/nginx-proxy-manager.svg" width="22" /> | Nginx Proxy Manager | LAN only | Reverse proxy + wildcard SSL for LAN traffic |
| <img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/cloudflare.svg" width="22" /> | Cloudflare Tunnel | — | Secure external access (no open ports) |
| <img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/grafana.svg" width="22" /> | Grafana + Loki + Alloy + Alertmanager | LAN only | Log aggregation for every container, Telegram alerting via Loki ruler |
| | autoheal | — | Restarts any container whose healthcheck turns unhealthy |

## Automation

Operational work is kept to a minimum by pushing everything into code and cron.

- **GitOps** — every `docker-compose.yml`, Homepage config and AdGuard config
  is version-controlled here. Rebuilding any service is `git pull && docker compose up -d`.
- **Renovate** — watches every pinned image tag except the estate's own and opens PRs for updates (digests + changelogs).
- **GitHub Actions self-hosted runners** — repo-specific runners on the Docker VM deploy
  `khe-sites` (`khe.ee` and the games launcher), `khe-study`, `khe-trips` and
  `khe-bunny-tales` (the stories app) into `/srv/data/...` directories served by nginx, and `khe-home-assistant` into Home
  Assistant's config volume.
- **Estate images**: `khe-ai-adventure` is built in GitHub-hosted CI and published to
  GHCR; this repo pins the digests and the app's CI moves them in an automerged pin PR,
  so its deploy is a merge here, minutes after the push.
- **OS update reminders** — `scripts/os-status.sh` pushes the Proxmox host's and
  the VM's update state to Uptime Kuma daily, which pages Telegram when a reboot is
  due or an update has waited 30 days, and on the host also when a ZFS pool, a
  disk's SMART verdict or the last scrub's age is bad.
- **Certificate renewal** — NPM auto-renews the wildcard cert via Cloudflare DNS API. No manual steps.
- **Backups** — `scripts/backup.sh` dumps every Postgres DB, the Home Assistant
  recorder and the service configs on a schedule; `scripts/offsite-backup.sh` then
  pushes the set to Cloudflare R2 with `restic` (client-side AES-256), which is what
  makes this 3-2-1. See [infrastructure/offsite-backup.md](../infrastructure/offsite-backup.md).
