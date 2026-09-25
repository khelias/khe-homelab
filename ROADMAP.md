# Roadmap

Direction and priorities for the homelab — what it should become, beyond current state.

## Near-term (next few sessions)

- **House automation** — the active work since 2026-09-08 and the only area
  with its own plan: phases, dashboard and the energy work are in the private
  `khe-meta` repo under `house/`. Heating and ventilation are
  read-only today; only the pergola package acts (rain closes the roof,
  evening light). The next step that changes the house is phase 6
  (spot-price-aware heating), which also forces a `SECURITY.md` update because
  it gives this host write access to the heat pump and ventilation.
- **Resource-limit tuning from metrics** — initial `deploy.resources.limits`
  now cover every long-running container. Watch Docker stats / service behavior
  and tune caps where Nextcloud, Immich, Paperless, Jellyfin, or Ollama show
  real workload pressure.
- **Healthcheck cleanup** — standardise `start_period`, replace trivial checks
  (Nextcloud cron `stat`, Ollama `list`) with real probes.
- **Immich: unused feature surface** — audited 2026-08-03, Tier 1 (multilingual
  CLIP, fullsize renders, 1080p transcode) landed. Still open, roughly in order:
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

## Medium-term (when app phase starts)

- **Offsite backup verification** — offsite is live (`restic` → Cloudflare R2, daily,
  client-side AES-256, `--keep-daily 7 --keep-weekly 4 --keep-monthly 12`; see
  [infrastructure/offsite-backup.md](infrastructure/offsite-backup.md)), so 3-2-1 is
  satisfied. Daily `restic check` covers metadata only; schedule a monthly
  `restic check --read-data-subset` once the repo is large enough to make full-data
  verification meaningful.
- **Bootstrap script for full rebuild** — one entry point that takes a fresh
  Proxmox host to a fully working homelab. The 10-step setup is scripted already
  but has no orchestrator handling the reboot points.
- **Disaster recovery runbook from a rebuild rehearsal** — the tested restore is
  done (`restore-verify.yml` restores a Postgres dump from R2 every week). What
  is left is rebuilding the host once for real and writing the runbook from it;
  tracked in the estate roadmap in `khe-meta` (1.3).

## Long-term (when app-heavy projects arrive)

- **Komodo as GitOps controller** — once adventure-engine, spliit, or similar
  projects land, a UI + API + rollback + push-based deploys become worth the
  install. Until then, manual `deploy.sh` via Tailscale is the right scope.
- **Upgrade strategy documented** — major jumps (PVE 9 → 10, Debian 13 → 14,
  Nextcloud major) need a rehearsed path. Capture the steps before the first
  painful upgrade, not after.
- **Authentik / Authelia SSO** — once RAM upgrade lands, consolidate auth across
  services instead of each one managing its own.

## Ambitions

Directions that take several seasons, not sessions. None is committed; each
has a first step that is worth doing on its own and says what it waits for.
The sections above come first.

- **A house that runs itself.** A thermal model of the house fitted to the
  measurements Home Assistant already records, and predictive control that
  schedules the heat pump and ventilation against the weather forecast and
  the next day's electricity price, with a saving that can be stated per
  heating season. It is the long form of phase 6 above.
  - *Why here:* the inputs are already in the stack: a weather forecast
    entity, the day-ahead price sensors in `energy_price.yaml` and the house
    energy readings. Devices, measurements and the model's inputs are
    documented in the private house documentation in `khe-meta`, not here.
  - *First step:* check that every series the model needs survives long
    enough. The recorder keeps raw history for 30 days, so anything older
    exists only as HA long-term statistics, and only for entities that
    carry a `state_class`. Then fit a simple model offline and compare its
    prediction with a week it has not seen.
  - *Waits for:* phase 6 working in its rule-based form, and one full
    heating season under the current schedule as the baseline. Without a
    weather-normalised baseline there is no saving to claim.
  - *Risk and cost:* the first write access this host gets to heating.
    Control has to fail back to the devices' own schedules when HA or the VM
    is down, a manual override has to win over the optimiser, and the
    security model in `SECURITY.md` and the README changes in the same
    commit. Comfort and compressor cycling are real costs; the saving is
    unverified until the baseline exists, and may not repay the weekends.
- **Automated rebuild day.** Once a quarter, a workflow builds the whole
  homelab from git and the R2 backups on an empty VM, checks the services
  come up, and records time-to-restore. The number and its trend go on the
  public architecture page (`khe.ee/architecture`, planned in `khe-meta`).
  - *Why here:* the pieces exist. The VM is created by cloud-init, a push
    is the deploy, and `restore-verify.yml` already restores one Postgres
    dump from R2 every week. This extends that from one database to the
    whole stack.
  - *First step:* the manual rebuild rehearsal and DR runbook tracked in
    the estate roadmap in `khe-meta`, then the bootstrap script from the
    medium-term list above. Time the manual run; that is the first number.
  - *Waits for:* the rehearsal fixes, and room to run a second VM. The host
    has 32GB and the Docker VM takes 24GB, so a full parallel rebuild needs
    the RAM upgrade, a reduced stack, or a short-lived cloud VM.
  - *Risk and cost:* a rebuild VM must never talk to the live Cloudflare
    tunnel, Telegram bot or house devices, so it runs with isolated
    credentials. What it restores is config, databases and small user data;
    Immich originals and media are not in the backup (see below), so the
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
    support calls when their router changes. For the static sites the
    Cloudflare Pages fallback in the estate roadmap is cheaper; the case for
    a second site is data, not availability.
- **Agent-operated homelab.** Scheduled agents read Loki alerts, Renovate
  PRs held for review and Uptime Kuma state, diagnose, and prepare a fix as
  a branch or a written proposal. The operator reads, approves and pushes;
  the boundary that the operator runs anything touching the host stays.
  - *Why here:* `ops-status.yml` gives a diagnostic snapshot without SSH,
    Loki holds the logs and Renovate auto-merges the routine bumps, so what
    is left for a human is the judgement calls. OpenClaw was removed on
    2026-09-25 because its socket proxy let an LLM agent read every
    container's env; an agent here reads through those same read-only
    windows and never gets the Docker socket.
  - *First step:* a weekly triage note (the n8n weekly report is the
    natural carrier) listing each alert and held PR with a proposed action.
    Measure how many proposals the operator accepts unchanged.
  - *Waits for:* Prometheus metrics (estate roadmap), so diagnoses rest on
    more than logs.
  - *Risk and cost:* logs, changelogs and PR bodies are untrusted text an
    agent reads, so prompt injection is the main threat. Agents get no
    write path beyond a branch or a note, and a workflow still never takes
    a shell command as input. Model cost if a hosted model does the work;
    the local 7B model is unverified for this kind of diagnosis.
- **Local AI serving for the apps.** Serve khe-ai-adventure's narration
  from Ollama here instead of a hosted API, so a game costs nothing per
  play.
  - *Why here:* Ollama is already deployed with an OpenAI-compatible API.
  - *Honest state:* it is CPU-only, capped at 10G RAM and 6 CPUs inside an
    8-vCPU, 24GB VM, and runs `qwen2.5:7b`. khe-ai-adventure's own roadmap
    keeps local models out of the live path until latency, Estonian quality
    and structured-output reliability are competitive, and nothing measured
    says a 7B CPU model is. On this hardware the answer is most likely no.
  - *First step:* replay a recorded game's prompts against the local model
    and score it with the adventure repo's model matrix: turn latency,
    schema retries, Estonian editor corrections.
  - *Waits for:* the RTX-class GPU under Hardware, and a measured per-game
    API cost from the proxy logs to compare against.
  - *Risk and cost:* a GPU costs money and draws power around the clock,
    which may exceed the API bill of a low-volume party game. Worth doing
    only if the GPU is bought for Immich and Ollama anyway.
- **Family data the homelab can stand behind alone.** Today `backup.sh`
  skips Immich originals because they are mirrored to iCloud and Google
  Photos. The ambition is the reverse: the homelab holds the primary copy
  with its own offsite backup, and the third-party mirrors become optional.
  - *Why here:* Immich, Nextcloud and Paperless already replace the cloud
    services; only the backup does not yet trust them to.
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
- **Weekend projects** — Forgejo (self-hosted Git), CrowdSec (IPS),
  KitchenOwl (groceries + recipes)
- **When time allows** — Actual Budget, Stirling PDF, Karakeep (bookmarks + AI),
  FreshRSS, Changedetection.io, Docmost (wiki)
- **After RAM upgrade** — Authentik (SSO) or Authelia (lighter alternative)
- **Own projects** — adventure-engine revival, Spliit (Splitwise alternative),
  khe-study iterations
- **khe-memory (idea, not started)** — cross-agent memory bank as own project.
  SQLite + sqlite-vec + Ollama embeddings (`nomic-embed-text`), MCP server over
  HTTP. Shared store for Claude Code and Codex CLI on both laptops, reached via
  Tailscale. Differentiators worth pursuing: auto-ingest from existing
  `~/.claude/projects/` and `~/.codex/sessions/` history (bootstrap problem
  solved with real data), cross-agent provenance (track which agent wrote each
  fact, surface conflicts), memory decay / re-validation lifecycle. Lives under
  `services/ai/memory/`, ~500MB RAM, no extra DB infrastructure.
