# Service choices

Why this homelab runs the software it does. Each entry compares the active
choice to the realistic alternatives at decision time, names the constraint
that drove the pick, and lists the conditions that would force a re-evaluation.

This is not a feature exhaustive vendor matrix. It is *our* reasoning for
*our* constraints. Generic comparisons exist on the open web; this doc only
captures what is non-obvious from the code or the standard reviews.

## Constraints that drive every choice

These are the recurring tiebreakers — when two services are otherwise
comparable, the one that scores better on these wins.

1. **Single-VM Docker host.** No Kubernetes, no multi-node clusters. Anything
   requiring a control plane or 4+ companion containers per service has a
   high bar to clear.
2. **Family + small-scale.** 2-5 active users. Throughput-optimised
   solutions (vLLM, Seafile's deduped sync) gain little; UX and mobile apps
   matter more.
3. **Low-touch operations.** Renovate-driven image bumps, no manual
   patch days. Services that need hand-tuning per release lose points.
4. **ZFS-mirror NFS bulk storage at `/srv`.** Anything that wants to manage
   its own storage backend (object stores, custom block formats) fights
   the existing layout.
5. **EU data sovereignty preference.** Not absolute, but breaks ties.
6. **Public-repo blast radius.** Every config and `compose.yml` is in a
   public repo. Anything storing identifiers, MACs, or creds in plain
   YAML loses points unless a clean `.env` split exists.
7. **Mature open source over commercial freemium.** Paywalls behind hardware
   transcoding, sync limits, or "team features" are brittle long-term
   commitments that age poorly.

## Index

| Category              | Active choice         | Confidence | Last reviewed |
|-----------------------|-----------------------|-----------:|---------------|
| DNS blocker           | AdGuard Home          | High       | 2026-05-05    |
| Reverse proxy (LAN)   | Nginx Proxy Manager   | Medium     | 2026-05-05    |
| External tunnel       | Cloudflare Tunnel     | High       | 2026-05-05    |
| Mesh VPN              | Tailscale             | High       | 2026-05-05    |
| Password manager      | Vaultwarden           | High       | 2026-05-05    |
| Photo management      | Immich                | High       | 2026-05-05    |
| Media server          | Jellyfin              | High       | 2026-05-05    |
| Audiobook server      | Audiobookshelf        | High       | 2026-05-05    |
| Cloud / file sync     | Nextcloud             | Medium     | 2026-05-05    |
| Document OCR          | Paperless-ngx         | High       | 2026-05-05    |
| LLM serving           | Ollama                | High       | 2026-05-05    |
| Workflow automation   | n8n                   | Medium     | 2026-05-05    |
| Uptime monitoring     | Uptime Kuma           | High       | 2026-05-05    |
| Compose UI            | Dockge                | High       | 2026-05-05    |
| Dashboard             | Homepage              | High       | 2026-05-05    |
| Hypervisor            | Proxmox VE            | High       | 2026-05-05    |
| Container auto-heal   | autoheal              | High       | 2026-05-05    |
| Dependency updates    | Renovate              | High       | 2026-05-05    |

`Confidence` reflects how stable the choice is given current constraints —
**High** = no realistic reason to migrate, **Medium** = working but a known
contender exists, **Low** = actively considering replacement.

---

## DNS blocker — AdGuard Home

### Alternatives considered

| Tool          | Notable strengths                                                       | Why not for us                                                       |
|---------------|-------------------------------------------------------------------------|----------------------------------------------------------------------|
| **AdGuard Home** | Built-in DoH/DoT/DoQ upstream + server, per-client filters, modern UI, single binary | (selected)                                                           |
| Pi-hole       | Largest community, longest history, v6 modernised the stack             | DoH upstream still requires `cloudflared` sidecar; per-client UX worse |
| Technitium    | Recursive DNS resolver included, multi-node clustering, advanced zones  | Heavier RAM, overkill for single-LAN home; less polished UI          |
| Blocky        | Lightest footprint (~30 MB), fastest, YAML config                       | No GUI; stats/query log thinner; per-client filters need restarts    |

### Why AdGuard

- **Built-in DoH upstream** matters because the LAN router points at AdGuard
  as primary DNS, no fallback ([infrastructure/network/README.md](../infrastructure/network/README.md)).
  Encrypted upstream without a `cloudflared` sidecar reduces moving parts.
- **Per-client filtering** is the path for parental controls (kids' devices
  filter adult content + safesearch, while adults are unfiltered). Pi-hole
  and Blocky require workarounds; AdGuard treats it as first-class.
- **DNSSEC + DoH/DoT/DoQ server** built in — useful if we ever expose DNS
  externally for travel devices.
- **Filter list pipeline handles overlap automatically** — running OISD big
  alongside Hagezi Pro Plus and Hagezi TIF is not redundant; AdGuard
  deduplicates rules at load time, and the lists are philosophically
  different (OISD = compatibility-first, Hagezi = aggressive precision).

### When we'd revisit

- AdGuard Home goes commercial-only or stagnates (project is healthy as of
  2026-05; multiple releases per quarter, active maintainer team).
- We need to multi-master DNS across sites (would push us to Technitium).
- Memory pressure on the Docker VM forces shedding 200+ MB (Blocky becomes
  attractive, but at the cost of per-client UX).

### Tuning notes

Live config-specific tuning lives in [operational-notes.md](operational-notes.md#adguard-home).
The non-obvious calls:

- Upstream: Cloudflare DoH + DNS4EU Protective DoH, `parallel` mode.
  Quad9 was dropped 2026-05-05 (see commit `6c4c5ec`) due to
  [AdGuardHome#8014](https://github.com/AdguardTeam/AdGuardHome/issues/8014).
- `cache_optimistic: true` smooths over upstream blips invisibly.
- `ratelimit: 100` per-/24 — bumped from default 20 because browser
  preconnect bursts on multi-tab Safari/Chrome trip the lower limit.
- `safebrowsing_enabled: true` (one word — `safe_browsing_enabled` is a
  silent no-op). `parental_enabled: false` global; per-client lookups will
  be wired separately when kids' device IDs are stable.

---

## Reverse proxy (LAN) — Nginx Proxy Manager

### Alternatives considered

| Tool          | Notable strengths                                                | Why not for us                                                          |
|---------------|------------------------------------------------------------------|-------------------------------------------------------------------------|
| **NPM**       | GUI for issuing wildcard LE certs, simple per-host configuration | (selected)                                                              |
| Caddy         | Auto-HTTPS in 3 lines, smallest footprint, plain Caddyfile in git | No GUI; less ergonomic for adding hosts under time pressure              |
| Traefik       | Native Docker label discovery, no per-host config drift          | Steepest learning curve; YAML/labels harder to debug than NPM's GUI     |
| SWAG          | Linuxserver.io ecosystem; bundled fail2ban                       | Bundles cert + proxy + fail2ban — coupling we don't want                 |

### Why NPM

- **9 LAN hosts behind one wildcard `*.khe.ee` cert** issued via Cloudflare
  DNS-01. NPM's GUI handles this in 3 clicks; doing the same in Caddy
  requires the Cloudflare DNS plugin and cert bookkeeping by hand.
- **Per-host upload limits** (photos, cloud, docs at unlimited body size +
  600s timeouts) are a checkbox in NPM, a stanza in Caddy.
- **Audit trail through the GUI** matters when troubleshooting at 23:00 —
  reading nginx error logs through NPM's "View Log" is faster than `docker
  logs` + grep.
- We pay one one-time cost (`npm_data` SQLite volume isn't in version
  control) for daily ops convenience.

### Confidence: Medium, not High

If we ever migrate to label-driven discovery (e.g., adding 10+ services
quickly during a rebuild), Traefik's Docker provider becomes very
attractive. NPM's GUI workflow is great for a stable fleet; it adds
friction during high-churn periods.

### When we'd revisit

- Service count crosses ~20 LAN-exposed hosts (currently 9).
- We add a second Docker host and want centralised proxy state.
- Cloudflare DNS-01 stops being an option (forces manual cert renewals).

---

## External tunnel — Cloudflare Tunnel

### Alternatives considered

| Tool                | Notable strengths                                              | Why not for us                                                    |
|---------------------|----------------------------------------------------------------|-------------------------------------------------------------------|
| **Cloudflare Tunnel** | Free, no open ports, Access OTP, anycast DDoS, integrates with existing CF DNS | (selected)                                                        |
| Tailscale Funnel    | No CF dependency, Tailscale-native                             | Per-account bandwidth caps; no Access-equivalent OTP gate         |
| frp / rathole       | Self-hosted, no third party                                    | Need a public VPS endpoint = recurring cost + DDoS exposure        |
| Plain port-forward  | Simplest                                                       | Open ports on home router; ISP CGNAT may block; no DDoS shielding |

### Why CF Tunnel

- **`khe.ee` DNS already on Cloudflare** — choosing CF Tunnel means one
  vendor, one auth surface, one set of certs (CF edge cert).
- **CF Access** gates `dash.khe.ee`, `n8n.khe.ee`, `openclaw.khe.ee`,
  `trips.khe.ee` with email OTP. Replacing this with self-hosted
  equivalents (Authelia, Authentik) is real work for a 4-route gate.
- **Zero open ports** on the home router — single biggest win for
  attack-surface reduction.

### When we'd revisit

- Cloudflare changes the free-tier terms in a way that bites home use.
- We need Cloudflare-independent operation for resilience reasons.
- Tunnel becomes the bottleneck (currently nowhere near it).

---

## Mesh VPN — Tailscale

Single dominant choice for personal mesh VPN with NAT traversal. Headscale
exists as the self-hosted control plane, but the operational cost is real
and the closed-source coordinator is the part of Tailscale that "just
works." Subnet routing from the Docker VM exposes the entire LAN to
authorised devices, including SSH and admin UIs that aren't tunneled
publicly. See [infrastructure/tailscale.md](../infrastructure/tailscale.md).

**Realistic alternatives:** Headscale (self-hosted Tailscale control plane,
worth it if Tailscale changes terms), Netbird (open-source equivalent,
younger), Nebula (Slack's, more manual). None earn the migration cost
today.

---

## Password manager — Vaultwarden

### Alternatives considered

| Tool                    | Notable strengths                                  | Why not for us                                                  |
|-------------------------|----------------------------------------------------|-----------------------------------------------------------------|
| **Vaultwarden**         | Single container, ~50 MB RAM, Bitwarden-compatible | (selected)                                                      |
| Bitwarden self-hosted   | Official, formally audited, SOC 2                  | 4+ containers, 2 GB+ RAM, MSSQL — overkill for a family vault    |
| Passbolt                | Team-collaboration-first, OpenPGP key model        | Stronger for orgs sharing creds; weaker mobile/browser UX for personal use |
| KeePassXC + Syncthing   | Local files only, zero server                      | No browser autofill story across devices; sync conflicts non-trivial |

### Why Vaultwarden

- **Same Bitwarden clients work unchanged** — browser extensions, mobile
  apps, CLI all see Vaultwarden as Bitwarden. Family members onboard with
  the standard Bitwarden iOS/Android app.
- **All Bitwarden Premium features unlocked** for free (TOTP, file
  attachments, vault health reports). Doing the same on Bitwarden official
  needs an enterprise license.
- **50 MB RAM, SQLite, single container** — no service deserves to cost
  more than the product it secures, and a family vault doesn't need MSSQL.

### When we'd revisit

- We start running this for an organisation rather than a family — the
  formal audits and SSO of official Bitwarden would matter.
- Rust upstream churn breaks the unofficial-API compatibility (hasn't yet
  in years).

---

## Photo management — Immich

### Alternatives considered

| Tool          | Notable strengths                                                       | Why not for us                                                    |
|---------------|-------------------------------------------------------------------------|-------------------------------------------------------------------|
| **Immich**    | Native iOS/Android apps with auto-backup, modern face/object ML, multi-user | (selected)                                                        |
| PhotoPrism    | Excellent at indexing existing libraries, Go (lighter)                  | No native mobile app — manual sync via Syncthing/rsync; bad UX for non-technical family |
| Ente self-host | Strong E2EE design                                                     | Self-hosting story still maturing; client UX trails Immich        |
| Nextcloud Memories | Already running Nextcloud; one fewer service                       | Mobile auto-backup via Nextcloud app is fragile; ML pipeline thinner |

### Why Immich

- **The mobile auto-backup app is the deal-breaker for the rest of the
  family.** Anything requiring "open the file manager and copy these to
  the share" loses 100% of non-technical users by week 2. Immich's app is
  the only one that meaningfully replaces Google Photos UX.
- **Per-user libraries** — each adult and (eventually) each kid gets their
  own space without admin intervention.
- **Active development pace** — Immich ships meaningful features monthly,
  PhotoPrism quarterly. We pay the higher RAM cost (4 containers,
  ~4-8 GB) for the ML quality and the app polish.

### Known costs

- 4 containers (server, ML, Postgres, Redis) — heaviest service in the
  fleet by container count.
- ML container is the memory hog and the source of most healthcheck
  surprises (see commit `f4ca9aa` "fix stuck ML healthcheck").
- Storage growth is unbounded — backed by the ZFS mirror at `/srv` so
  this is fine, but library size needs occasional review.

### When we'd revisit

- We stop using a phone for primary photo capture (unlikely).
- Immich pivots to closed-source / commercial-only (no signal of this).

---

## Media server — Jellyfin

### Alternatives considered

| Tool         | Notable strengths                                       | Why not for us                                                   |
|--------------|---------------------------------------------------------|------------------------------------------------------------------|
| **Jellyfin** | Free hardware transcoding, no account, no telemetry     | (selected)                                                       |
| Plex         | Best app ecosystem, remote-share-friendly               | Hardware transcoding behind paywall; Plex account required; ad-supported content surfaced in UI |
| Emby         | Polished UI, faster release cadence than Jellyfin       | Hardware transcoding behind paywall                              |
| Kodi         | Local-first playback; no server                         | Solves a different problem (player, not server)                  |

### Why Jellyfin

- **Hardware transcoding is included.** With Intel iGPU passthrough on the
  Proxmox host, QSV transcoding is the difference between "watchable" and
  "fan spins up". Paying $120 for the same on Plex/Emby is offensive when
  the open-source alternative just works.
- **No account, no telemetry, no cloud dependency** — the server going
  offline doesn't mean the LAN clients can't reach it (Plex has historically
  required cloud auth).
- **QSV configured via init container** ([operational-notes.md](operational-notes.md#jellyfin)) —
  the setup pain is paid once at deploy time, not weekly.

### When we'd revisit

- We start sharing libraries with non-LAN remote users at scale (Plex's
  remote-friendly story would matter; today we just use Tailscale).

---

## Cloud / file sync — Nextcloud

### Alternatives considered

| Tool                     | Notable strengths                                        | Why not for us                                                       |
|--------------------------|----------------------------------------------------------|----------------------------------------------------------------------|
| **Nextcloud**            | Largest app ecosystem, mature mobile clients, Office, Calendar, Contacts | (selected)                                                           |
| Seafile                  | 30-40% faster sync, lighter on resources, deduped blocks | No Office/Calendar/Contacts; fewer apps; sync UX great, ecosystem thin |
| ownCloud Infinite Scale  | Go rewrite, single binary, faster than legacy ownCloud   | Smaller community post-Nextcloud-fork; uncertain product roadmap     |
| Syncthing-only           | No server, peer-to-peer                                  | No web UI for non-technical users; no calendar/contacts story         |

### Why Nextcloud

- **More than file sync** — CalDAV/CardDAV for Calendar + Contacts is what
  pulls phones away from iCloud/Google. Seafile and oCIS don't replace
  that without bolting on Radicale separately.
- **Mobile auto-upload backup** for documents is a working UX, even if it
  isn't as polished as Immich for photos.
- **App ecosystem** — Notes, Bookmarks, Forms, Talk, Memories. Each one
  individually is a small win; together they justify the heavier stack.
- **Document edit via Collabora / OnlyOffice** when needed.

### Confidence: Medium

Nextcloud is the **right** choice given the breadth of needs, but:

- Heaviest service by config surface — 16 GB upload, OPcache 256M, JIT
  128M, Postgres tuning, Redis cache, init script for `CREATEROLE` quirk
  ([operational-notes.md](operational-notes.md#nextcloud)).
- PHP perf still trails Seafile / oCIS noticeably for pure-sync workloads.
- Major-version upgrades have historically been a coin-flip (the NC30→NC33
  bump in commit `f4ca9aa` was driven by the `CREATEROLE` bug).

### When we'd revisit

- We drop the Calendar/Contacts/Talk features (would unblock Seafile).
- Two consecutive major upgrades break the deployment in non-trivial ways.

---

## LLM serving — Ollama

### Alternatives considered

| Tool          | Notable strengths                                                  | Why not for us                                                        |
|---------------|--------------------------------------------------------------------|-----------------------------------------------------------------------|
| **Ollama**    | One-command model pulls, polished CLI, OpenAI-compatible API       | (selected)                                                            |
| llama.cpp (server) | Lowest-level control, smallest footprint, no abstractions     | Manual GGUF download + tuning per model; brittle for model swaps      |
| LocalAI       | OpenAI-compatible hub for text/image/audio/video                   | Heavier idle footprint; multi-modal we don't need                     |
| vLLM          | Throughput king for high-concurrency APIs                          | Optimised for hundreds of concurrent users; we have 1-3                |

### Why Ollama

- **`ollama pull` and a model is running** — Ollama abstracts the
  GGUF-download-and-config dance that llama.cpp leaves to the user.
  Iterating on which model fits the iGPU is a 2-minute exercise.
- **Stable OpenAI-compatible endpoint** — n8n + OpenClaw both speak that
  protocol. Swapping models doesn't churn the integration layer.
- **Single container, model files on the ZFS mirror** — fits the layout.

### When we'd revisit

- We push past 5+ concurrent inference requests (vLLM territory).
- We need image/audio generation alongside text (LocalAI hub).
- Ollama's licensing or model-pull layer becomes restrictive (no signal).

---

## Audiobook server — Audiobookshelf

Realistic alternatives are LazyLibrarian (more about acquisition than
serving) and Booksonic (mostly dormant). Audiobookshelf is the de-facto
choice for self-hosted audiobook serving in 2026 — active development,
native iOS/Android apps, Plex-like UX without the Plex baggage.

**When we'd revisit:** the project becomes unmaintained.

---

## Document OCR — Paperless-ngx

The community-led continuation of `paperless-ng` (which itself succeeded
the original `paperless`). Estonian Tesseract language pack runs at
container startup via `PAPERLESS_OCR_LANGUAGES=est`
([operational-notes.md](operational-notes.md#paperless)).

**Realistic alternatives:** DocSpell (heavier Java stack, fewer mobile
options), Mayan EDMS (overkill for personal use), plain Nextcloud + OCR
plugins (worse search). Paperless-ngx wins on density of features per
RAM.

**When we'd revisit:** Paperless-ngx fragments again or the OCR pipeline
breaks for est language support.

---

## Workflow automation — n8n

### Alternatives considered

| Tool          | Notable strengths                              | Why not for us                                              |
|---------------|------------------------------------------------|-------------------------------------------------------------|
| **n8n**       | 400+ integrations, fair-code license, polished UI | (selected)                                                  |
| Node-RED      | Lower-level, flow-programming, mature          | Fewer SaaS integrations; UX trails n8n for API-glue work    |
| Huginn        | Long history, Ruby                             | Smaller ecosystem; UX feels dated                           |
| Activepieces  | Open-core, modern UI                           | Younger; fewer integrations than n8n                         |

### Why n8n, with caveats

- **Integration breadth** — when the use case is "fetch from API X, write
  to API Y", n8n's prebuilt nodes save real time.
- **Self-hostable for free** under the fair-code license; we're well
  inside the personal-use bounds.

### Confidence: Medium

n8n's licensing has tightened in past years and could tighten again
(commercial use vs personal use boundaries shift). Activepieces is the
emerging fully-open contender to watch.

**When we'd revisit:** licensing change that constrains personal use, or
Activepieces reaches integration parity (currently behind by a wide margin).

---

## Uptime monitoring — Uptime Kuma

The de-facto self-hosted Pingdom replacement. Realistic alternatives are
Gatus (YAML config, lighter, no GUI), Healthchecks.io self-hosted
(better at cron monitoring than uptime monitoring), and Statping-ng
(less active). Uptime Kuma's GUI + notification breadth + 60-service
homepage is hard to beat at this scale.

**When we'd revisit:** Uptime Kuma stagnates (it has slowed somewhat in
2025-26 — Gatus is gaining); we move to a config-as-code monitoring stance.

---

## Compose UI — Dockge

Successor to Portainer for the "I just want a UI for my Compose stacks"
use case. Realistic alternatives are Portainer CE (more enterprise-shaped,
heavier, agent model), Komodo (younger, ambitious), and Yacht (Compose-
focused but smaller community). Dockge's value is its **explicit alignment
with on-disk Compose files** — it edits real files in real directories,
which means the GitOps model still works (everything in
`services/<group>/<service>/docker-compose.yml`).

**When we'd revisit:** Dockge stagnates; we adopt a stronger GitOps
deploy pipeline that makes a UI redundant.

---

## Dashboard — Homepage

Realistic alternatives are Heimdall (older, heavier), Dashy (YAML-driven,
flashier, slower iteration), Glance (newer, RSS-strong), Flame (similar).
Homepage's win is **service integrations** — it talks to Sonarr, Jellyfin,
Nextcloud, Uptime Kuma, etc., and surfaces real status, not just
bookmarks. YAML config sits next to the rest of the IaC.

**When we'd revisit:** integration breadth with our specific stack falls
behind Glance or successors.

---

## Hypervisor — Proxmox VE

For bare-metal-on-consumer-hardware homelabs the realistic alternatives
are XCP-ng (Citrix Hypervisor open-source successor — solid but smaller
community), TrueNAS SCALE (NAS-first, hypervisor secondary), and ESXi
(no longer free for home use as of 2024). Proxmox is the clear choice
on community size, hardware support, and ZFS+LXC+QEMU combo.

**When we'd revisit:** Proxmox commercialises in a way that bites home
use; XCP-ng's community surpasses Proxmox's (no signal).

---

## Container auto-heal — autoheal

Single-purpose tool: restart unhealthy containers. Alternatives are
Watchtower (does both updates and restarts, but we use Renovate for the
update path) and writing custom health checks. autoheal does one thing
well; nothing is worth changing here.

---

## Dependency updates — Renovate

GitHub-native dependency-update bot. Dependabot is the realistic alternative
but Renovate's grouping + scheduling + Docker-tag strategies are richer
for a homelab where we want "Tuesday morning, all minor bumps in one PR."
Configured in `renovate.json` at repo root.

---

## Re-evaluation cadence

A service appears in this doc the moment its choice is made. The reasoning
captured here is point-in-time — every entry has a `Last reviewed` date
in the index. The bar for updating an entry is:

- **Review trigger.** Confidence drop (e.g., upstream pivots, our
  constraints shift, a contender ships a feature that closes the gap),
  service swap, or 12+ months since last review.
- **Update bar.** Make the same reasoning structure (alternatives →
  why this → when to revisit) hold. Don't tabulate features the open web
  already tabulates — capture *our* reasoning, the part that doesn't
  generalise.
