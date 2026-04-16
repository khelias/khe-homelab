# Roadmap

Direction and priorities for the homelab. Sensitive gaps (current security shortcomings,
credentials) live in a separate private note, not here. This file describes what the
platform should become, not what's currently broken.

## Near-term (next few sessions)

- **Resource limits on every long-running container** — so a single runaway service
  can't OOM the 32GB VM and take down all 17 services. Conservative defaults for
  web services, heavier for Nextcloud / Immich / Paperless.
- **Uptime Kuma SQLite backup** — already have Postgres + Vaultwarden + NPM in
  `backup.sh`; add Uptime Kuma's `/app/data` so monitor config and incident history
  survive a volume loss.
- **Dockge socket access via `docker-socket-proxy`** — mirror the OpenClaw pattern
  (read-only + restricted actions) instead of mounting `/var/run/docker.sock` directly.
- **Healthcheck cleanup** — standardise `start_period`, replace trivial checks
  (Nextcloud cron `stat`, Ollama `list`) with real probes.

## Medium-term (when offsite + app phase starts)

- **Offsite backup** — rclone → Backblaze B2 or Wasabi. Today backups live only on
  the ZFS pool; if the pool fails, we lose backups too (3-2-1 rule violation).
- **Bootstrap script for full rebuild** — one script that takes a fresh Proxmox host
  to a fully working homelab. Currently the 10-step setup is a scripted sequence,
  but there's no single entrypoint that chains them and handles the reboot points.
- **Disaster recovery runbook + tested restore** — actually restore a Postgres dump
  into a spare container and verify. Today we trust the backup script to work
  without evidence it does under pressure.
- **Observability revamp** — cover every production service in Uptime Kuma; add
  ntfy (or Telegram) push channel for alerts. Today we'd silently notice outages.

## Long-term (when app-heavy projects arrive)

- **Komodo as GitOps controller** — once adventure-engine, spliit, or similar
  projects land, a UI + API + rollback + push-based deploys become worth the
  install. Until then, manual `deploy.sh` via Tailscale is the right scope.
- **Upgrade strategy documented** — major jumps (PVE 9 → 10, Debian 13 → 14,
  Nextcloud major) need a rehearsed path. Capture the steps before the first
  painful upgrade, not after.
- **Authentik / Authelia SSO** — once RAM upgrade lands, consolidate auth across
  services instead of each one managing its own.

## Service wishlist

Categorised in `CLAUDE.md` under `New services (wishlist)`. In rough order of
impact: Dozzle, ntfy, IT-Tools (quick wins), then Home Assistant, Forgejo,
CrowdSec, KitchenOwl, then the long-tail utilities.

## What this roadmap deliberately excludes

- **Current security gaps** — specific misconfigurations that an attacker could
  exploit today. Those live in a private note and disappear once fixed.
- **Credentials or secrets** — always in Vaultwarden, never in the repo.
