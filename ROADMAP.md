# Roadmap

Direction and priorities for the homelab — what it should become, beyond current state.

## Near-term (next few sessions)

- **Resource limits on every long-running container** — so a single runaway service
  can't OOM the 32GB VM and take down all 17 services. Conservative defaults for
  web services, heavier for Nextcloud / Immich / Paperless.
- **Dockge socket-proxy live validation** — config now routes Dockge through
  `docker-socket-proxy`; deploy it and test stack create/update/down/build so
  the endpoint allowlist can be tightened further if Dockge permits it.
- **Healthcheck cleanup** — standardise `start_period`, replace trivial checks
  (Nextcloud cron `stat`, Ollama `list`) with real probes.

## Medium-term (when offsite + app phase starts)

- **Offsite backup** — rclone → Backblaze B2 or Wasabi. Today backups live only on
  the ZFS pool; if the pool fails, we lose backups too (3-2-1 rule violation).
- **Bootstrap script for full rebuild** — one entry point that takes a fresh
  Proxmox host to a fully working homelab. The 10-step setup is scripted already
  but has no orchestrator handling the reboot points.
- **Disaster recovery runbook + tested restore** — actually restore a Postgres dump
  into a spare container and verify. Today we trust the backup script to work
  without evidence it does under pressure.
## Long-term (when app-heavy projects arrive)

- **Komodo as GitOps controller** — once adventure-engine, spliit, or similar
  projects land, a UI + API + rollback + push-based deploys become worth the
  install. Until then, manual `deploy.sh` via Tailscale is the right scope.
- **Upgrade strategy documented** — major jumps (PVE 9 → 10, Debian 13 → 14,
  Nextcloud major) need a rehearsed path. Capture the steps before the first
  painful upgrade, not after.
- **Authentik / Authelia SSO** — once RAM upgrade lands, consolidate auth across
  services instead of each one managing its own.

## Hardware

Currently: i7-12700K, 32GB DDR5, 2× 12TB ZFS mirror, 2TB NVMe. No discrete GPU.

- **RTX-class GPU** — accelerate Ollama (today CPU-only `qwen2.5:7b`) and Immich
  ML (today OpenVINO CPU). IOMMU is already on, iGPU is already passed through for
  Quick Sync — a discrete card would pass through the same way.
- **+32GB DDR5 → 64GB total** — unblocks Authentik SSO, more concurrent services,
  larger local LLMs, parallel ML workloads.
- **UPS** — not yet; power cut is unclean shutdown for the whole homelab. Worth
  considering once critical family usage grows.
- **10GbE upgrade** — only relevant if Jellyfin / Immich / Nextcloud transfers
  start saturating the current 2.5GbE link. No evidence of that yet.

## Service wishlist

Rough order of impact:

- **Quick wins** — Dozzle (Docker log viewer), ntfy (push notifications),
  IT-Tools (dev utilities)
- **Weekend projects** — Home Assistant, Forgejo (self-hosted Git), CrowdSec (IPS),
  KitchenOwl (groceries + recipes)
- **When time allows** — Actual Budget, Stirling PDF, Karakeep (bookmarks + AI),
  FreshRSS, Changedetection.io, Docmost (wiki)
- **After RAM upgrade** — Authentik (SSO) or Authelia (lighter alternative)
- **Own projects** — adventure-engine revival, Spliit (Splitwise alternative),
  study-game iterations
