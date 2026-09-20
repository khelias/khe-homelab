# khe-homelab

Personal family homelab. Self-hosted cloud, media, and AI on a single Proxmox
VM running Docker Compose. Infrastructure as Code: every compose file,
AdGuard config, Homepage config, and OpenClaw workspace lives in this repo.

## Where to find detailed reference

Don't duplicate that content here. AGENTS.md only holds rules and pointers.

- [README.md](README.md) - architecture diagram, services table, security
  model, resilience layers, automation, network, setup, day-to-day ops
- [docs/runbook.md](docs/runbook.md) - what to do when something is broken,
  written to be followed without internal knowledge
- [docs/operational-notes.md](docs/operational-notes.md) - per-service
  dev-facing quirks (AdGuard config keys, NPM upload limits, OpenClaw
  device pairing, games hub mount layout, etc.)
- [docs/service-choices.md](docs/service-choices.md) - why we run the
  software we do (AdGuard vs Pi-hole, Immich vs Photoprism, etc.) and
  what would force a re-evaluation
- **House documentation is not in this repo.** The HA rollout phases, the
  dashboard layout, the HVAC protocol and register maps and the energy work
  live in the private `khe-meta` repo under `house/`. They name the house's
  devices, LAN addresses and metering data, which has no place in a public
  repo. What stays here is the container and ops layer
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
  home/            Home Assistant, Mosquitto, PAI (Paradox alarm)
  apps/            landing, games hub, pages, trips
  observability/   Loki, Grafana, Alloy, Alertmanager (one stack)
infrastructure/    Proxmox, network, Cloudflare, Tailscale docs
scripts/           setup, deploy.sh, backup.sh, hardening,
                   ha-dashboard.py (HA Overview generator)
docs/              runbook, operational notes, service choices
                   (house docs live in khe-meta/house/)
```

## Conventions (HARD)

1. **Each service directory** has `docker-compose.yml` and `.env.example`
   (if it uses env vars). Live `.env` files are `.gitignored`.
2. **Never commit secrets.** No `.env` files, no API keys, no tokens, no
   bcrypt hashes, no MAC addresses or device identifiers (public repo).
   A pre-commit gitleaks scan enforces this — install with
   `./scripts/install-hooks.sh` after cloning. Bypassing with
   `--no-verify` is forbidden; if the hook flags a false positive,
   add an exclusion to `.gitleaks.toml` and commit that. That file also
   carries two custom rules for crypt-format password hashes, which the
   upstream ruleset does not cover.
3. **Pin Docker image versions.** No `:latest` in production. Renovate
   bumps tags via PR with digest + changelog. Exception: images built on the
   VM by another repo's CI (`games-adventure-proxy:latest`, tagged by the
   khe-ai-adventure runner) cannot be pinned here; the version lives in that
   repo's workflow.
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
./scripts/backup.sh          # dump Postgres DBs + snapshot configs (+ HA recorder)
./scripts/ha-dashboard.py    # regenerate the Home Assistant Overview dashboard
```

Per-service: `cd services/<group>/<service> && docker compose up -d`.

## Working on Home Assistant

HA is operated through its own API. Not through the UI, not over SSH.

- **Token:** a long-lived token in `~/.config/khe/ha-token` on the operator's
  machine, mode 600. Read it inside scripts, never print it, never commit it.
- **REST** for states, service calls, `POST /api/template`, diagnostics and
  `POST /api/services/homeassistant/restart` (HA is back in ~10 s; give it
  another ~40 s before trusting a state read). **WebSocket**
  (`/api/websocket`) for the entity and device registries, config entries,
  dashboards and HACS. Host and port are in `scripts/ha-dashboard.py`.
- **Config lives in git, not on the VM.** Edit
  `services/home/homeassistant/config/packages/*.yaml`, commit, the operator
  pushes, CI pulls on the VM, then restart HA through the API. Never scp into
  the VM checkout: deploy runs `git pull --ff-only` and one drifted file stops
  every deploy after it.
- **YAML platforms need a restart, not a reload.** `input_*`, `rest:`,
  `shell_command:` and the group `cover:`/`light:` platforms only appear after
  a restart. Automations and templates do reload.
- **Helpers come up at their minimum**, not at a sensible value. Set the first
  value through the API; `initial:` would overwrite the household's own choice
  on every restart.
- **The dashboard is generated** by `scripts/ha-dashboard.py`, and HA adds
  sections to the stored config by itself whenever a new device appears. Diff
  the generator's output against the live config before rerunning it: exec the
  script up to `async def main`, dump `config`, compare with a WebSocket
  `lovelace/config` read.
- Measured integration behaviour and every trap worth knowing is in
  [docs/operational-notes.md](docs/operational-notes.md). Read the relevant
  section before touching an integration.

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
