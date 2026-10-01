# khe-homelab

Family homelab as code: one Proxmox host, one Debian 13 VM running Docker
Compose stacks for core, media, home and app services. Every compose file,
AdGuard and Homepage config lives here. This file holds rules and
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
Read `house/home-assistant-plan.md` before analysing house data: its method
rules are not loaded into context on their own.

## Layout

```
services/
  core/            NPM, AdGuard, Cloudflare Tunnel, Vaultwarden,
                   Uptime Kuma, Homepage, autoheal
  media/           Immich
  home/            Home Assistant, Mosquitto, PAI (Paradox alarm)
  apps/            landing, games, pages, trips
  observability/   Loki, Grafana, Alloy, Alertmanager (one stack)
infrastructure/    Proxmox, network, Cloudflare, Tailscale docs
scripts/           setup, deploy, backup, hardening, validate-compose,
                   ha-dashboard.py (HA Overview generator),
                   ha-ws.py (HA WebSocket commands from the CLI)
```

Image tags live in each `docker-compose.yml`; Renovate opens the bump PRs,
except for the estate's own images (rule 3). CI (`validate.yml`, the required
check) runs the pin App guard, `scripts/verify-estate-pins.sh`, `bash -n` on
each `scripts/*.sh` and `scripts/validate-compose.sh`, every script from the
base branch against the PR tree.

## Rules

1. **Each service directory** has a `docker-compose.yml` and, if it uses env
   vars, a `.env.example`. Live `.env` files are gitignored.
2. **Public repo: nothing secret or identifying.** No `.env` files, keys,
   tokens, bcrypt or crypt hashes, MAC addresses or device identifiers. The
   gitleaks pre-commit hook enforces it for secrets (`./scripts/install-hooks.sh`
   after cloning). A false positive gets an exclusion in `.gitleaks.toml`, never
   `--no-verify`. Personal-data patterns (MAC and LAN addresses, coordinates,
   e-mail, phone) are caught by the khe workspace commit gate, rules in its
   `.claude/hooks/pii-rules.toml`; names and street addresses by nobody.
3. **Pin image versions**, no `:latest`. Images the estate builds itself
   (`ghcr.io/khelias/*`, khe-meta ADR-008) are pinned as
   `:main@sha256:<digest>`. The app's CI publishes them and then opens a pin
   PR here through a per-repo GitHub App (`khe-adventure-pins`) with
   auto-merge; Renovate is disabled for them (`renovate.json`). An App PR is
   safe to automerge because `validate.yml` lets the App change nothing but
   its own `:main@` digests, one line for one line, and
   `verify-estate-pins.sh` requires every pinned digest to be attested by its
   repo's `ci.yml` on main, all images of a repo from one commit.
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
- **A push to `main` is the deploy.** `deploy.yml` runs when `services/**`,
  `scripts/deploy.sh`, `scripts/deploy-stacks.sh`, `scripts/homelab-status.sh`,
  `scripts/retire-stack.sh` (the status timer runs both from the VM
  checkout) or the workflow changes: the runner pulls `/home/khe/homelab`
  with `git pull --ff-only` and deploys the stacks changed since
  `.deploy/last-successful-sha`. A manual deploy after that push is a no-op.
  One is needed only for changes outside the paths filter or when CI is
  down, and then it is `gh workflow run deploy.yml` (inputs `mode`, `stack`,
  `dry_run`).
- **Rolling back an estate app** is a git change here. Pin every image of
  the app to the same `sha-<full commit>@sha256:<digest>` and push. The pin
  job skips a `sha-` pin, so the rollback stays until the operator returns
  the pins to `:main@sha256:<current>`, the digest from an anonymous
  manifest fetch of `ghcr.io/v2/khelias/<image>/manifests/main`; the next
  app push then moves them again. `homelab-status.sh` prints the revision
  each estate container runs.
- **Check the branch before writing.** The VM pulls `main`, and finished work
  sometimes sits on a feature branch for weeks. A push to the wrong branch
  shows up as "Already up to date" on the VM and "Unknown stack" from the
  deploy.
- **Operations go through `workflow_dispatch`** on the homelab runner:
  `ops-status.yml` refreshes the status snapshot ([runbook](docs/runbook.md)),
  `deploy.yml` deploys (the operator's call), `retire-stack.yml` removes what
  a stack deleted from git leaves on the VM (the agent dispatches it only
  with `apply=false`; `apply=true` is the operator's call). A workflow never
  takes a shell command as input; that would be SSH under another name.
  Narrow, pre-written actions only.
- **The agent reads the VM through Loki**, with the official mcp-grafana
  server (`scripts/mcp-grafana.sh`, read-only, Grafana Viewer token in
  `~/.config/khe/grafana-token`): container logs, and `{job="homelab-status"}`
  for the `homelab-status.sh` snapshot that the `khe-homelab-status` timer
  writes every 5 min. This repo's Actions logs are public, so `ops-status.yml`
  prints only the summary. Loki has no per-stream access control, so
  Vaultwarden, Home Assistant, Immich and trips logs are reachable too: query
  only what the task needs, and never quote personal data or tokens from them.
- **Fork PRs can reach the runner.** Fork PR approval stays at
  `all_external_contributors`, and a fork run is approved only after reading
  its `.github/workflows/` diff (khe-meta ADR-006).

## Working on Home Assistant

HA is operated through its API: not the UI, not SSH.

- **Token:** a long-lived token in `~/.config/khe/ha-token` on the operator's
  machine, mode 600. Read it inside scripts; never print or commit it.
- **REST** for states, service calls, `POST /api/template`, diagnostics and
  `POST /api/services/homeassistant/restart` (back in ~10 s; wait another
  ~40 s before trusting a state read). **WebSocket** (`/api/websocket`) for
  the entity and device registries, config entries, dashboards and HACS,
  sent with `scripts/ha-ws.py '{"type": "..."}'`, which handles auth and ids.
  Host and port are in `scripts/ha-dashboard.py` and `scripts/ha-ws.py`.
- **Config lives in git, not on the VM.** Edit
  `services/home/homeassistant/config/packages/*.yaml`, commit, the operator
  pushes, CI pulls on the VM, then restart HA through the API. Never scp into
  the VM checkout: deploy runs `git pull --ff-only`, and one drifted file
  stops every deploy after it.
- **YAML platforms need a restart, not a reload:** `input_*`, `rest:`,
  `shell_command:` and the group `cover:`/`light:` platforms. Automations and
  templates reload, but a template reload blanks the trigger-based price
  sensors until the hourly tick: follow every `template/reload` at once with
  `POST /api/events/khe_price_refresh`
  ([notes](docs/operational-notes.md#home-assistant)).
- **Helpers come up at their minimum.** Set the first value through the API;
  `initial:` would overwrite the household's choice on every restart.
- **The dashboard is generated** by `scripts/ha-dashboard.py`, and HA adds
  sections to the stored config by itself when a new device appears. Before
  rerunning, diff the generator's output against the live config: exec the
  script up to `async def main`, dump `config`, compare with a WebSocket
  `lovelace/config` read.
- **Keep the house idiom in a new view**, and read two existing views first.
  A row is a `horizontal-stack` of 2-4 vertical tiles or `third()`, never a
  lone full-width tile; full width is for charts, forecast cards and alerts.
  Each number appears once (turn off a forecast card's `show_current` when a
  tile already carries the value). Badge labels are short and still say what
  they control. The front page holds what is done daily; per-side controls,
  rare settings and diagnostics go on a `subview` behind a "Seaded" badge. A
  `note()` truncates to one line, so longer text needs a markdown card.
- Read the integration's section in `docs/operational-notes.md` before
  touching it.
