# khe-homelab

Family homelab as code: one Proxmox host, one Debian 13 VM running Docker
Compose stacks for core, media, home and app services, no Kubernetes
([estate ADR-010](https://github.com/khelias/khe-architecture/blob/main/decisions/010-one-host-docker-compose.md)).
Every compose file,
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

Home Assistant's configuration, dashboard generator and 3D house view are in
[khe-home-assistant](https://github.com/khelias/khe-home-assistant), whose
`AGENTS.md` points on to the house documentation in the private `khe-meta`
repo. This repo keeps HA's container and ops layer.

## Layout

```
services/
  core/            NPM, AdGuard, Cloudflare Tunnel, Vaultwarden,
                   Uptime Kuma, Homepage, autoheal
  media/           Immich
  home/            Home Assistant (container only), Mosquitto, PAI (Paradox alarm)
  apps/            landing, games, pages, trips
  observability/   Loki, Grafana, Alloy, Alertmanager (one stack)
infrastructure/    Proxmox, network, Cloudflare, Tailscale docs;
                   edge-fallback/ holds the edge copy's Worker
scripts/           setup, deploy, backup, hardening, validate-compose;
                   lib.sh holds the helpers they share
```

Image tags live in each `docker-compose.yml`; Renovate opens the bump PRs,
except for the estate's own images (rule 3). CI (`validate.yml`, the required
check) runs the pin App guard, `scripts/verify-estate-pins.sh`, `bash -n` on
each `scripts/*.sh` and `scripts/validate-compose.sh`, every script from the
base branch against the PR tree. The edge fallback's Worker tests
(`node --test infrastructure/edge-fallback/test/`, no install needed) run in
`edge-fallback.yml` before every deploy and in the workspace commit gate.

## Rules

1. **Each service directory** has a `docker-compose.yml` and, if it uses env
   vars, a `.env.example`. Live `.env` files are gitignored.
2. **Public repo: nothing secret or identifying.** No `.env` files, keys,
   tokens, bcrypt or crypt hashes, MAC addresses or device identifiers. The
   gitleaks pre-commit hook enforces it for secrets (`./scripts/install-hooks.sh`
   after cloning). A false positive gets an exclusion in `.gitleaks.toml`, never
   `--no-verify`. Personal-data patterns (MAC and LAN addresses, coordinates,
   e-mail, phone) are caught by the khe-workspace commit gate, rules in its
   `.claude/hooks/pii-rules.toml`; names and street addresses by nobody.
3. **Pin image versions**, no `:latest`. Images the estate builds itself
   (`ghcr.io/khelias/*`, [estate ADR-008](https://github.com/khelias/khe-architecture/blob/main/decisions/008-container-images.md)) are pinned as
   `:main@sha256:<digest>`. The app's CI publishes them and then opens a pin
   PR here through a per-repo GitHub App (`khe-adventure-pins`) with
   auto-merge; Renovate is disabled for them (`renovate.json`). An App PR is
   safe to automerge because `validate.yml` lets the App change nothing but
   its own `:main@` digests, one line for one line, and
   `verify-estate-pins.sh` requires every pinned digest to be attested by its
   repo's `ci.yml` on main, all images of a repo from one commit.
4. **State in named volumes or bind mounts under `/srv/data/<service>/`**,
   never `/home` or arbitrary paths. HA's config is the named volume
   `homeassistant_ha_config`, not `/srv/data`, because the recorder is SQLite
   and `/srv/data` is a soft NFS mount; khe-home-assistant's deploy writes
   its managed files there. State that lives in the checkout: Mosquitto's
   `./data`, and AdGuard's live `config/AdGuardHome.yaml` (gitignored, seeded
   from the committed template, rule 6). `backup.sh` tars HA's config volume (plus a recorder dump) and
   Mosquitto's `config/`, not its `data/`.
5. **Ingress through the shared `proxy` network** for NPM; separate networks
   isolate databases. The `draft.khe.ee` editor, which runs without an app
   login, sits on `draft-tunnel`, shared only with `cloudflare-tunnel`; the
   tunnel stack owns that network because it deploys first. Public traffic
   enters only through the Cloudflare Tunnel, never a forwarded port, and an
   app without a login of its own sits behind Cloudflare Access
   ([estate ADR-011](https://github.com/khelias/khe-architecture/blob/main/decisions/011-cloudflare-tunnel-and-access-edge.md)).
   The one exception for the private khe-trips atlas is its public demo at
   `khe.ee/trips/`, which shows only trips that are over, and only their
   short title, place and start date for trips that do not open
   ([estate ADR-013](https://github.com/khelias/khe-architecture/blob/main/decisions/013-trips-public-demo.md)).
   Landing serves it as khe-trips built it, like `/r/`: no edge cache and
   never indexed.
6. **AdGuard's live `AdGuardHome.yaml` is gitignored.** Apply changes as
   delta patches against `AdGuardHome.template.yaml`; replacing it wholesale
   wipes admin credentials and sessions
   ([notes](docs/operational-notes.md#adguard-home)).
7. **Deployment surface changes update their doc in the same commit:** a
   service or domain goes into the README services table and diagram, a
   service quirk into `docs/operational-notes.md`, a network, DNS,
   Cloudflare or Tailscale change into `infrastructure/*.md`, a security
   model change into `SECURITY.md`.
8. **The edge fallback mirrors the landing and games nginx**
   ([estate ADR-016](https://github.com/khelias/khe-architecture/blob/main/decisions/016-static-fallback-at-the-edge.md)).
   Two Cloudflare Workers (`infrastructure/edge-fallback/`) serve a copy of
   the static sites when the homelab answers 5xx or not at all. A header,
   redirect or SPA-fallback change in `services/apps/landing/nginx.conf` or
   `services/apps/games/nginx.conf` is mirrored in
   `infrastructure/edge-fallback/src/rules.mjs` in the same commit; the
   Worker tests catch header drift. The allowlist in
   `scripts/edge-fallback-stage.sh` is the only way a tree reaches the copy:
   `trips.khe.ee` and secrets never do, and the adventure `config.js` is a
   stub without `API_SECRET`. The Worker routes live in the dashboard, fail
   open, and are not in `wrangler.jsonc`. games.khe.ee's root is khe-sites'
   launcher build, and /study and /adventure load the consent banner from
   its `/assets/analytics-consent.js`
   ([estate ADR-019](https://github.com/khelias/khe-architecture/blob/main/decisions/019-consent-banner-from-the-origin-root.md)),
   so a route change keeps that path on the launcher, in the games nginx,
   in `rules.mjs` and in the staged copy.

## Access and operations

- Proxmox `192.168.0.10` (`pve.khe.ee`, UI on `:8006`); Docker VM
  `192.168.0.11`, SSH `khe@docker-vm` over Tailscale MagicDNS, key auth
  only. Admin credentials live in the VM's `.env` files, except NPM's login
  (in its database) and AdGuard's (in its live `AdGuardHome.yaml`).
- On the VM: `./scripts/deploy.sh status|pull|up|down`, `./scripts/backup.sh`
  (Postgres dumps, config snapshots, HA's config volume and recorder). Per service:
  `cd services/<group>/<service> && docker compose up -d`.
- **A push to `main` is the deploy.** `deploy.yml` runs when `services/**`,
  `scripts/deploy.sh`, `scripts/deploy-stacks.sh`, `scripts/lib.sh` (which
  deploy-stacks.sh and the cron backups source), `scripts/homelab-status.sh`,
  `scripts/retire-stack.sh` (the status timer runs those two from the VM
  checkout) or the workflow changes: the runner pulls `/home/khe/homelab`
  with `git pull --ff-only` and deploys the stacks changed since
  `.deploy/last-successful-sha`. A manual deploy after that push is a no-op.
  One is needed only for changes outside the paths filter or when CI is
  down, and then it is `gh workflow run deploy.yml` (inputs `mode`, `stack`,
  `force_recreate`, `dry_run`).
- **Rolling back an estate app** is a git change here. Pin every image of
  the app to the same `sha-<full commit>@sha256:<digest>` and push. The pin
  job skips a `sha-` pin, so the rollback stays until the operator returns
  the pins to `:main@sha256:<current>`, the digest from an anonymous
  manifest fetch of `ghcr.io/v2/khelias/<image>/manifests/main`; the next
  app push then moves them again. `homelab-status.sh` prints the revision
  each estate container runs.
- **Automated writers**
  ([estate ADR-007](https://github.com/khelias/khe-architecture/blob/main/decisions/007-automated-writers.md)): Renovate
  automerges Docker patch, minor and digest updates except Home Assistant
  minors and the critical-infrastructure group (`renovate.json`), the pin
  Apps automerge estate image pins (rule 3), every merge to `main` deploys,
  and scheduled jobs back up and prune, verify a restore and clean the
  runner. `edge-fallback.yml` deploys the edge copy hourly when a served tree
  changed; it is undone by disabling the workflow and deleting the two
  Worker routes. The way back from a bad update is to revert its commit on `main`
  and push; for an image that keeps state, also restore its data from the
  backup taken before the update
  ([runbook](docs/runbook.md#undoing-an-automerged-update)). A new automated
  writer joins the estate's writer register in khe-meta in the same change.
- **A new app database** joins `POSTGRES_JOBS` in `scripts/backup.sh` and the
  weekly restore check (`restore-verify.yml`, Immich only today) in the
  change that creates it, and one passing restore of it comes before any
  data that is not the family's own
  ([estate ADR-004](https://github.com/khelias/khe-architecture/blob/main/decisions/004-app-backend-and-identity.md) point 6).
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
  its `.github/workflows/` diff ([estate ADR-006](https://github.com/khelias/khe-architecture/blob/main/decisions/006-branch-protection.md)).

## Working on Home Assistant

The procedure (API, token, reloads, the dashboard generator) is in
[khe-home-assistant's AGENTS.md](https://github.com/khelias/khe-home-assistant/blob/main/AGENTS.md);
its deploy writes the config into the `homeassistant_ha_config` volume and
never restarts HA. What stays here: the container in
`services/home/homeassistant/docker-compose.yml` and its volume, the image
pin, the Renovate hold on HA bumps and the backup in `scripts/backup.sh`
([notes](docs/operational-notes.md#home-assistant)).
