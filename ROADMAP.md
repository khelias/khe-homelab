# Roadmap

Direction and priorities for the homelab — what it should become, beyond current state.

## Near-term (next few sessions)

- **House automation** — moved to
  [khe-home-assistant's roadmap](https://github.com/khelias/khe-home-assistant/blob/main/ROADMAP.md).
- **Immich: unused feature surface** — audited 2026-08-03, Tier 1 (multilingual
  CLIP, fullsize renders, video transcoding) landed. A second family account
  is coming (2026-11-27), so the account items come first. Still open, roughly
  in order:
  - **Config secrets have nowhere to live.** `immich.config.json` is committed
    to a public repo and `IMMICH_CONFIG_FILE` locks the admin UI, so SMTP and
    OAuth cannot be enabled at all until the file is rendered at deploy time
    from a committed template plus `.env`. Blocks the two items below.
  - **SMTP** — no album invites, welcome mails or password resets for family
    accounts today.
  - **External library** — `library.scan` / `library.watch` unset and nothing
    from `/srv` is mounted `:ro`, so any pre-Immich archive is invisible.
    Touches compose mounts and the backup assumption, decide together.
  - **Per-user storage quota** — unset, so one account can fill the ZFS mirror.
  - **`duplicateDetection.maxDistance: 0.01`** is near bit-identical only;
    0.02-0.03 would surface real burst duplicates.
  - **`job` concurrency** unset — defaults are conservative against the 2-CPU
    cap, worth raising temporarily for bulk re-index runs.
  - **Metrics** — `IMMICH_TELEMETRY_INCLUDE` would expose job-queue and ML
    latency on `:8081`, but Alloy only ships logs to Loki; no Prometheus in the
    stack yet, so this is gated on adding one.
  - **Upload backup assumption** — `backup.sh` skips Immich uploads because
    they are mirrored to iCloud + Google Photos. That stops being true the
    moment a family account without such a mirror starts backing up.
- **Healthcheck cleanup** — every check tests something its own restart can
  fix and has a `start_period` sized to the service, so autoheal restarts only
  what is broken. Then host and container metrics (Prometheus) and a Uptime
  Kuma monitor for every address, with the list kept in git (estate roadmap
  1.2 steps 2 and 3).
- **Resource-limit tuning from metrics** — initial `deploy.resources.limits`
  now cover every long-running container. Tune the caps where Immich shows
  real pressure, once the metrics above exist.

## Medium-term (when app phase starts)

- **Bootstrap script for full rebuild** — one entry point that takes a fresh
  Proxmox host to a fully working homelab. The setup steps are scripted already
  but have no orchestrator handling the reboot points.
- **Disaster recovery runbook from a rebuild rehearsal** — the tested restore is
  done (`restore-verify.yml` restores a Postgres dump and the Vaultwarden DB
  from R2 every week). What
  is left is rebuilding the host once for real and writing the runbook from it;
  tracked in the estate roadmap in `khe-meta` (1.3).

## Long-term (when app-heavy projects arrive)

- **Upgrade strategy documented** — major jumps (PVE 9 → 10, Debian 13 → 14,
  Immich major) need a rehearsed path. Capture the steps before the first
  painful upgrade, not after.

## Ambitions

Directions that take several seasons, not sessions. None is committed; each
has a first step that is worth doing on its own and says what it waits for.
The sections above come first.

- **A house that runs itself** — moved to
  [khe-home-assistant's roadmap](https://github.com/khelias/khe-home-assistant/blob/main/ROADMAP.md#ambitions).
- **Automated rebuild day.** Once a quarter, a workflow builds the whole
  homelab from git and the R2 backups on an empty VM, checks the services
  come up, and records time-to-restore. The number and its trend go on the
  public architecture page (`khe.ee/architecture`).
  - *Why here:* the pieces exist. The VM is created by cloud-init, a push
    is the deploy, and `restore-verify.yml` already restores one Postgres
    dump from R2 every week. This extends that from one database to the
    whole stack.
  - *First step:* the manual rebuild rehearsal and DR runbook tracked in
    the estate roadmap in `khe-meta`, then the bootstrap script from the
    medium-term list above. Time the manual run; that is the first number.
  - *Waits for:* the rehearsal fixes, and room to run a second VM. The host
    has 32GB, of which docker-vm takes 16GB and agent-vm 8GB, so a full
    parallel rebuild needs the RAM upgrade, a reduced
    stack, or a short-lived cloud VM.
  - *Risk and cost:* a rebuild VM must never talk to the live Cloudflare
    tunnel, Telegram bot or house devices, so it runs with isolated
    credentials. What it restores is config, databases and small user data;
    Immich originals are not in the backup (see below), so the
    number describes that scope, not a full restore.
- **Second site.** A small node at a relative's home, reached over
  Tailscale, holding a second restic repository of this homelab's backups
  and, in return, theirs. Later it could serve the public static sites
  warm when this one is down.
  - *Why here:* R2 is the only offsite copy today. A second copy under our
    own control makes 3-2-1 independent of one provider and one account,
    and makes large data (Immich originals) affordable to keep offsite.
  - *First step:* a second `restic` repository on any spare disk outside
    the house, fed by the same `offsite-backup.sh` run, with the same
    `restic check`.
  - *Waits for:* a willing host household and a low-power machine.
  - *Risk and cost:* hardware and electricity at someone else's home, and
    support calls when their router changes. The static sites already have
    the edge fallback ([estate ADR-016](https://github.com/khelias/khe-architecture/blob/main/decisions/016-static-fallback-at-the-edge.md));
    the case for a second site is data, not availability.
- **Agent-operated homelab.** Scheduled agents read Loki alerts, Renovate
  PRs held for review and Uptime Kuma state, diagnose, and prepare a fix as
  a branch or a written proposal. The operator reads, approves and pushes;
  the boundary that the operator runs anything touching the host stays.
  - *Why here:* the status snapshot and every container's logs are in Loki,
    which an agent reads read-only through mcp-grafana without SSH, and
    Renovate auto-merges the routine bumps, so what
    is left for a human is the judgement calls. OpenClaw was removed on
    2026-09-25 because its socket proxy let an LLM agent read every
    container's env; an agent here reads through those same read-only
    windows and never gets the Docker socket.
  - *First step, done 2026-11-14:* `weekly-digest.yml` opens one issue a
    week from a Claude run on a GitHub-hosted runner
    ([estate ADR-027](https://github.com/khelias/khe-architecture/blob/main/decisions/027-attended-and-unattended-agent-tiers.md)).
    Next: count how many of its proposals the operator takes unchanged.
  - *Waits for:* Prometheus metrics (estate roadmap), so diagnoses rest on
    more than logs.
  - *Risk and cost:* logs, changelogs and PR bodies are untrusted text an
    agent reads, so prompt injection is the main threat. Loki OSS has no
    per-stream access control, so the Vaultwarden, Home Assistant, Immich
    and trips logs are within reach; the agent queries only the containers a task
    needs and never quotes personal data or tokens from them. Agents get no
    write path beyond a branch or a note, and a workflow still never takes
    a shell command as input. Model cost if a hosted model does the work;
    no local model runs here since Ollama was removed on 2026-10-01.
- **Local AI serving for the apps** — moved to
  [khe-ai-adventure's roadmap](https://github.com/khelias/khe-ai-adventure/blob/main/ROADMAP.md),
  "Local Model On The Homelab", which holds the benchmark that comes first.
- **Family data the homelab can stand behind alone.** Today `backup.sh`
  skips Immich originals because they are mirrored to iCloud and Google
  Photos. The ambition is the reverse: the homelab holds the primary copy
  with its own offsite backup, and the third-party mirrors become optional.
  - *Why here:* Immich already replaces the cloud photo services; only the
    backup does not yet trust it to.
  - *First step:* measure the size of Immich originals and price keeping
    them offsite (R2 beyond its free 10 GB, or the second site).
  - *Waits for:* the Immich config-secrets and SMTP items above, before
    family accounts rely on it, and the upload-backup assumption in the
    Immich list being retired.
  - *Risk and cost:* until the offsite copy exists and restore-verify
    covers it, dropping a mirror would make this box the only copy of the
    family photo archive. The payoff is independence, and money only if a
    cloud subscription is actually cancelled.

## Hardware

Currently: i7-12700K, 32GB DDR5, 2× 12TB ZFS mirror, 2TB NVMe. No discrete GPU.

- **RTX-class GPU** — accelerate local LLMs (Ollama, CPU-only `qwen2.5:7b`, was
  removed on 2026-10-01 for lack of use) and Immich ML (today OpenVINO CPU).
  IOMMU is already on, iGPU is already passed through for
  Quick Sync — a discrete card would pass through the same way.
- **+32GB DDR5 → 64GB total** — more concurrent services, a parallel
  rebuild VM, larger local LLMs, parallel ML workloads. On hold: a 32GB kit cost about
  €1000 in November 2026, twice what the whole server cost, so it waits for
  DRAM prices to fall. Until then the stories reading runs on GitHub's runner,
  not here.
- **UPS** — not yet; power cut is unclean shutdown for the whole homelab. Worth
  considering once critical family usage grows.
- **10GbE upgrade** — only relevant if Immich transfers
  start saturating the current 2.5GbE link. No evidence of that yet.

## Service wishlist

Gone through on 2026-11-27 against what already runs: the rest had a
replacement in place or no user.

- **Actual Budget** — a household budget shared with the family, if bank
  sync works for Estonian banks (GoCardless or Enable Banking). To be tried
  before it gets a stack.
- **A shared shopping list** — Home Assistant already has one; tracked in
  [khe-home-assistant's roadmap](https://github.com/khelias/khe-home-assistant/blob/main/ROADMAP.md).
