# khe-homelab

Family homelab as code: one Proxmox host, one Debian 13 VM running Docker
Compose stacks for cloud, media, AI and home services. Every compose file,
AdGuard, Homepage and OpenClaw config lives here. This file holds rules and
pointers; the reference lives in:

- [README.md](README.md) - architecture, services table, security model,
  resilience, network, setup, day-to-day ops
- [docs/runbook.md](docs/runbook.md) - what to do when something is broken
- [docs/operational-notes.md](docs/operational-notes.md) - per-service quirks
  and measured integration behaviour
- [docs/service-choices.md](docs/service-choices.md) - why each service, and
  what would force a re-evaluation
- [SECURITY.md](SECURITY.md), [ROADMAP.md](ROADMAP.md),
  [infrastructure/](infrastructure/) (Proxmox, network, Cloudflare, Tailscale)

House documentation (HA rollout, dashboard layout, HVAC protocols, energy)
is in the private `khe-meta` repo under `house/`: it names devices, LAN
addresses and metering data. This repo keeps the container and ops layer.

## Layout

```
services/
  core/            NPM, AdGuard, Cloudflare Tunnel, Vaultwarden, Dockge,
                   Uptime Kuma, Homepage, autoheal
  media/           Immich, Jellyfin, Audiobookshelf
  productivity/    Nextcloud, Paperless-ngx
  ai/              Ollama, n8n, OpenClaw (+ workspace/ for agent config)
  home/            Home Assistant, Mosquitto, PAI (Paradox alarm)
  apps/            landing, games, pages, trips
  observability/   Loki, Grafana, Alloy, Alertmanager (one stack)
infrastructure/    Proxmox, network, Cloudflare, Tailscale docs
scripts/           setup, deploy, backup, hardening, validate-compose,
                   ha-dashboard.py (HA Overview generator)
```

Image tags live in each `docker-compose.yml`; Renovate opens the bump PRs.
CI (`validate.yml`) runs `bash -n scripts/*.sh` and
`scripts/validate-compose.sh`.

## Rules

1. **Each service directory** has a `docker-compose.yml` and, if it uses env
   vars, a `.env.example`. Live `.env` files are gitignored.
2. **Public repo: nothing secret or identifying.** No `.env` files, keys,
   tokens, bcrypt or crypt hashes, MAC addresses or device identifiers. The
   gitleaks pre-commit hook enforces it (`./scripts/install-hooks.sh` after
   cloning). A false positive gets an exclusion in `.gitleaks.toml`, never
   `--no-verify`.
3. **Pin image versions**, no `:latest`. The one exception is
   `games-adventure-proxy:latest`, built and tagged on the VM by the
   khe-ai-adventure runner; its version lives in that repo's workflow.
4. **State in named volumes or bind mounts under `/srv/data/<service>/`**,
   never `/home` or arbitrary paths.
5. **Ingress through the shared `proxy` network** for NPM; separate networks
   isolate databases.
6. **AdGuard's live `AdGuardHome.yaml` is gitignored.** Apply changes as
   delta patches against `AdGuardHome.template.yaml`; replacing it wholesale
   wipes admin credentials and sessions
   ([notes](docs/operational-notes.md#adguard-home)).
7. **Deployment surface changes update their doc in the same commit:** a
   service or domain goes into the README services table and diagram, a
   service quirk into `docs/operational-notes.md`, a network, DNS,
   Cloudflare or Tailscale change into `infrastructure/*.md`, a security
   model change into `SECURITY.md`.

## Access and operations

- Proxmox `192.168.0.10` (`pve.khe.ee`, UI on `:8006`); Docker VM
  `192.168.0.11`, SSH `khe@docker-vm` over Tailscale MagicDNS, key auth
  only. Admin credentials live in the VM's `.env` files.
- On the VM: `./scripts/deploy.sh status|pull|up|down`, `./scripts/backup.sh`
  (Postgres dumps, config snapshots, HA recorder). Per service:
  `cd services/<group>/<service> && docker compose up -d`.

## Working on Home Assistant

HA is operated through its API: not the UI, not SSH.

- **Token:** a long-lived token in `~/.config/khe/ha-token` on the operator's
  machine, mode 600. Read it inside scripts; never print or commit it.
- **REST** for states, service calls, `POST /api/template`, diagnostics and
  `POST /api/services/homeassistant/restart` (back in ~10 s; wait another
  ~40 s before trusting a state read). **WebSocket** (`/api/websocket`) for
  the entity and device registries, config entries, dashboards and HACS.
  Host and port are in `scripts/ha-dashboard.py`.
- **Config lives in git, not on the VM.** Edit
  `services/home/homeassistant/config/packages/*.yaml`, commit, the operator
  pushes, CI pulls on the VM, then restart HA through the API. Never scp into
  the VM checkout: deploy runs `git pull --ff-only`, and one drifted file
  stops every deploy after it.
- **YAML platforms need a restart, not a reload:** `input_*`, `rest:`,
  `shell_command:` and the group `cover:`/`light:` platforms. Automations and
  templates reload.
- **Helpers come up at their minimum.** Set the first value through the API;
  `initial:` would overwrite the household's choice on every restart.
- **The dashboard is generated** by `scripts/ha-dashboard.py`, and HA adds
  sections to the stored config by itself when a new device appears. Before
  rerunning, diff the generator's output against the live config: exec the
  script up to `async def main`, dump `config`, compare with a WebSocket
  `lovelace/config` read.
- Read the integration's section in `docs/operational-notes.md` before
  touching it.
