# KHE Homelab - Project Guidelines

## Language
Communicate in Estonian. Code comments and config files in English.

## Architecture
- Hypervisor: Proxmox VE on bare metal
- Containers: Docker Compose on a Proxmox VM (not K8s)
- GitOps: all docker-compose.yml files version-controlled here
- Domain: khe.ee via Cloudflare

## Project Structure
```
services/          # Docker Compose stacks, one dir per service
  core/            # Network infra: NPM, AdGuard, Cloudflare tunnel, Vaultwarden, Dockge, Uptime Kuma, Homepage
  media/           # Immich, Jellyfin, Audiobookshelf
  productivity/    # Nextcloud, Paperless-ngx
  ai/              # Ollama, n8n, OpenClaw
  apps/            # games hub (nginx serving launcher + study-game under /study/)
infrastructure/    # Proxmox setup notes, network config, ZFS
scripts/           # Deployment and maintenance scripts
```

## Conventions
- Each service directory has: docker-compose.yml and .env.example (if it uses env vars)
- Never commit .env files (secrets)
- Use named Docker volumes or bind mounts under /srv/data/<service>
- All services connect via a shared `proxy` Docker network for NPM
- Service-specific networks for DB isolation
- Pin Docker image versions (no :latest in production)

## Server Details
- Proxmox host IP: 192.168.0.10 (pve.khe.ee)
- Docker VM IP: 192.168.0.11
- Router: Asus RT-AX55 (192.168.0.1), DHCP range .100-.254
- Boot disk: 2TB Kingston KC3000 NVMe (Proxmox OS + VM disks)
- Data disk: ZFS mirror pool "tank" (2x 12TB WD Ultrastar) → NFS → /srv
- DBs (PostgreSQL): named Docker volumes on VM's NVMe disk (fast I/O)
- Large files (photos, media): NFS mount from ZFS pool (snapshots, compression)
- Hardware transcoding: Intel Quick Sync (i7-12700K iGPU passthrough) - SET UP
  - vfio-pci binds iGPU on host (blacklisted i915), passed through to VM 100
  - VM runs linux-image-amd64 kernel (cloud kernel lacks i915), GRUB default set
  - VM apt sources include non-free-firmware for Intel firmware packages
  - /dev/dri mounted into jellyfin and immich-server containers
- VM user: khe, SSH key auth only
- VM watchdog: `watchdog` daemon pings `/dev/watchdog` (iTCO_wdt, Proxmox-
  emulated Intel TCO, 30s timeout). If daemon wedges (kernel hang, OOM, I/O
  lock), hardware force-resets the VM within 30s — Proxmox then boots it
  back up. Conservative config: only pings the device, NO load/memory/
  network checks (those cause false-positive reboots). See `/etc/watchdog.conf`.
- Cloudflare Tunnel: khe-homelab (token in VM .env file)
- Tailscale VPN: installed on VM host (not Docker), subnet router for 192.168.0.0/24
  - Remote SSH: `ssh khe@docker-vm` (MagicDNS)
  - Gives full LAN access remotely (Proxmox UI, Dockge, AdGuard, NPM admin)
  - IP forwarding: /etc/sysctl.d/99-tailscale.conf
  - Flags: --advertise-routes=192.168.0.0/24 --accept-dns=false
  - Tailscale admin DNS: Global nameserver = VM's Tailscale IP (see
    `tailscale ip -4` on VM) + "Override DNS servers" ON. Tailscale clients
    (Mac, iPhone) resolve via AdGuard on LAN, mobile data, and foreign WiFi
    alike — no separate DoH endpoint needed. If AdGuard is down, Tailscale
    clients lose DNS until reconnect (acceptable trade-off; failure is loud).

## Current Status (2026-04-18)
All 17 services working: Immich, Jellyfin, Vaultwarden, Paperless, Audiobookshelf,
n8n, Uptime Kuma, Homepage, Ollama, Dockge, AdGuard, NPM, Cloudflare Tunnel,
Nextcloud (33-apache + PG18), OpenClaw, games hub (launcher + study-game), landing page.

AdGuard: pre-configured via AdGuardHome.yaml (bind mount), split-horizon
DNS with explicit per-service rewrites (no wildcard). openclaw.khe.ee and
games.khe.ee intentionally omitted — resolve via Cloudflare (HTTPS needed).
Router DHCP DNS: 192.168.0.11 ONLY. Never advertise 1.1.1.1 (or any upstream)
as a "secondary" — clients race both servers in parallel (happy-eyeballs) and
Cloudflare wins every time, so ad/tracker filtering silently bypasses AdGuard
for ~80%+ of traffic. If AdGuard is down, the whole LAN noticing fast is a
feature. Upstream DoH (Cloudflare/Quad9) happens inside AdGuard, not via DHCP.
  - Blocklists: AdGuard DNS filter + OISD big (~330k rules) + Hagezi Pro Plus
    (~245k rules, covers EU/EE trackers like Cxense/Piano/Gemius).
  - ratelimit: 100 req/s per /24 subnet (AdGuard's ratelimit_whitelist does NOT
    accept CIDR — bare IPs only — so a higher limit is the LAN-friendly knob).
  - Memory limit 512M (256M was too tight once OISD big + Hagezi loaded).
  - Live AdGuardHome.yaml is .gitignored (holds admin bcrypt + sessions).
    Baseline in AdGuardHome.template.yaml; apply changes as delta-patches
    (short ad-hoc Python yaml.safe_load/dump) to preserve runtime state.
    Replacing the live file wholesale wipes admin creds and sessions.

Cloudflare: tunnel routes directly to Docker containers (except photos.khe.ee).
  Access policies (OTP via email) protect: dash.khe.ee, openclaw.khe.ee,
  n8n.khe.ee. khe.ee is public (landing page). See infrastructure/cloudflare.md.

NPM (Nginx Proxy Manager): reverse proxy for LAN traffic via split-horizon DNS.
  - Wildcard Let's Encrypt cert (*.khe.ee) via Cloudflare DNS-01 challenge (auto-renewal)
  - 9 proxy hosts: khe.ee, dash, cloud, vault, docs, photos, jellyfin, books, status
  - LAN path: device → AdGuard DNS → 192.168.0.11:443 → NPM → container (fast, no CF limits)
  - External path: device → CF DNS → CF Tunnel → container directly (CF 100MB limit applies)
  - Upload-heavy services (photos, cloud, docs, jellyfin, books): unlimited body size, 600s timeouts
  - All hosts: WebSocket, HTTP/2, HSTS, SSL forced, block exploits
  - NPM admin: http://192.168.0.11:81 (creds in .env on VM)
  - CF API token for DNS challenge stored in NPM database (npm_data volume)
  - Not behind NPM: n8n, openclaw, games (CF Access / CF-only routing needed)

Landing page: static HTML at khe.ee (public), served by nginx:1.30-alpine.
  Homepage dashboard moved to dash.khe.ee (CF Access protected).
  HOMEPAGE_ALLOWED_HOSTS=dash.khe.ee in homepage .env.

Nextcloud: production-ready config (33.0.2-apache, pinned).
  - Cron sidecar (nextcloud-cron) for background jobs
  - PHP: 512M memory, 16G upload, OPcache 256M, JIT 128M (php-custom.ini mount)
  - PostgreSQL: shared_buffers=256MB, work_mem=16MB, effective_cache_size=1GB
  - Redis: 256mb maxmemory, allkeys-lru, persistence disabled (cache-only)
  - trusted_proxies: 172.16.0.0/12 (Docker network for CF Tunnel)
  - Config: default_phone_region=EE, maintenance_window_start=1 (UTC),
    simpleSignUpAllowed=false, loglevel=2, trashbin/versions "7, auto"
  - Apps: calendar 6.2.2 + contacts 8.4.4 installed (iPhone CalDAV/CardDAV ready)
  - Disabled: firstrunwizard, recommendations, survey_client, federation,
    circles, weather_status, contactsinteraction, support, user_status, dashboard
  - PG CREATEROLE bug resolved via init-db.sh (non-superuser nextcloud DB user)
  - NEXTCLOUD_TRUSTED_DOMAINS includes "nextcloud" for Homepage OCS API widget
  - App password for Homepage: docker exec nextcloud php occ user:add-app-password admin

Jellyfin QSV: configured via init container (encoding.xml bind mount +
system.xml patch). No web UI steps needed.

Homepage: live widgets for all services. Config in services/core/homepage/config/
(git-tracked bind mount). API keys stored in VM .env only (never committed).
To regenerate API keys from scratch:
  Proxmox:  pveum user token add root@pam homepage --privsep=0
  Paperless: docker exec paperless python3 manage.py drf_create_token admin
  Immich:   insert into api_key table (see scripts/ for helper)
  Jellyfin: insert into ApiKeys table in jellyfin.db
  ABS:      read token column from users table in absdatabase.sqlite
  Nextcloud: docker exec nextcloud php occ user:add-app-password admin

OpenClaw: DONE — running at https://openclaw.khe.ee via CF tunnel + CF Access (OTP)
  - Token auth (mode: token) + device pairing required on first connect
  - To approve new browser: docker exec openclaw node openclaw.mjs devices list
    then: docker exec openclaw node openclaw.mjs devices approve <request-id>
  - Gateway token in openclaw_config volume (openclaw.json)
  - Model: qwen2.5:7b via Ollama on ai-internal network
  - trustedProxies not configured — CF tunnel seen as untrusted proxy (cosmetic warning only)
  - Docker access: docker-socket-proxy (tecnativa) on socket-proxy internal network
    POST=0, ALLOW_RESTARTS=1 — read-only + container restart/stop/start only
    DOCKER_HOST=tcp://docker-socket-proxy:2375 routes docker CLI through proxy
    docker-ce-cli installed in custom image (extends base, mirrors OPENCLAW_INSTALL_DOCKER_CLI=1)
  - Agent workspace: services/ai/openclaw/workspace/ (git-tracked bind mount)
    SOUL.md (personality), USER.md (homelab context), AGENTS.md (safety rules)
  - docker-essentials skill installed (ClawHub) for container management

games hub: DONE — services/apps/games/ stack (nginx + adventure-proxy)
  - / → launcher (git-tracked in services/apps/games/launcher/, Inter-font dark design)
  - /study/ → study-game (/srv/data/games/study/, GH Actions runner deploys here)
  - /adventure/ → ai-adventure-engine (/srv/data/games/adventure/app/, GH Actions runner)
  - /adventure/api/ → adventure-proxy container (Node.js Express, Claude Sonnet 4.6 default / Gemini Flash fallback)
  - CF tunnel route games.khe.ee → games:80 (direct, no alias)
  - study-game repo base path: vite `base: '/study/'`, BrowserRouter basename `/study`
  - adventure frontend + proxy: ai-adventure-engine repo. GH Actions runner on
    VM builds the frontend (→ /srv/data/games/adventure/app/) AND the proxy
    image (`games-adventure-proxy:latest`). khe-homelab compose references the
    image by tag — no build context here.
  - Runners (each repo has its own): /home/khe/actions-runner (study-game),
    /home/khe/actions-runner-adventure (ai-adventure-engine)
  - Nested bind mount: launcher/study/ and launcher/adventure/ dirs pre-exist as
    mountpoint anchors (Docker can't mkdir inside :ro parent — see feedback memory)
  - Networks: games-internal (nginx ↔ adventure-proxy) + proxy (CF tunnel → nginx)
  - GEMINI_API_KEY + ANTHROPIC_API_KEY stored in services/apps/games/.env on VM (never committed)

adventure-proxy (source lives in ai-adventure-engine/proxy/, image built by
that repo's runner on this VM as `games-adventure-proxy:latest`):
  - Estonian editor-pass: when request body has language='et', scene + gameOverText
    are routed through Gemini Flash with an editorial system prompt (fixes
    hallucinated words, wrong verb register, calques). 25s shared budget; failures
    fall back to unedited text. Keeps total response ≤ nginx 120s ceiling.
  - Schema allowlist: POST /generate rejects any schema whose sorted top-level
    properties keys don't match one of the 4 known shapes (story/custom/sequel/turn).
    Without this, the proxy is a free generic Claude/Gemini API. Schema + proxy
    now live in the same repo — update `src/game/prompts.ts` and
    `proxy/server.js` (ALLOWED_SCHEMA_SHAPES) in the same commit.
  - Origin check: Origin OR Referer must match games.khe.ee or a localhost dev
    origin. 403 otherwise. Filters naive curl abuse.
  - Real per-visitor rate limit: nginx.conf uses $http_cf_connecting_ip as
    limit_req_zone key (fallback $remote_addr via map). Without the map,
    $binary_remote_addr sees only cloudflared's socket IP — all visitors would
    share one 30-req/min counter.
  - Choice-cost violations logged as warnings (not blocked). Watch proxy logs
    if a playtest shows no-cost choices.
  - Deploy: push to ai-adventure-engine main → runner rebuilds image locally.
    Until auto-restart is wired, bounce the container on VM:
    `cd ~/homelab/services/apps/games && docker compose up -d --force-recreate adventure-proxy`.

Adventure game engine rules:
  - Narrative gameOver: 1 param at worst = phase transition (AI narrates
    consequence, game continues), 2+ params worst = second AI call with
    forceEnd:'unrecoverable' for a written 3-5 paragraph conclusion. Hardcoded
    template string dropped to fallback-only.
  - Rule #4 (hidden "threat worsens each turn") removed — all parameter
    changes must now come from visible choice expectedChanges.
  - Docs: ai-adventure-engine/docs/ARCHITECTURE.md (C4 + flows + cost + security),
    ROADMAP.md (phases + principles), scripts/README.md (playtest harness).
  - Playtest: cd ~/Projects/ai-adventure-engine && npm run playtest -- --duration=Short

Healthchecks: games uses 127.0.0.1 (not localhost — busybox wget DNS issue in alpine).
  cloudflare-tunnel uses `cloudflared version` (distroless image, no curl/wget available).

Resilience / alerting stack (three layers, each catches what the others miss):
  1. `watchdog` daemon on VM → iTCO_wdt (30s HW timeout) catches kernel hangs
  2. `autoheal` sidecar (services/core/autoheal/) via docker-socket-proxy →
     restarts any container whose healthcheck reports `unhealthy`. Covers the
     gap left by Docker's `restart: unless-stopped` (crash-only)
  3. Uptime Kuma monitors every service + Telegram push to the owner's phone
     via the existing `@khe_homelab_bot` (same bot as OpenClaw; bot token in
     services/ai/openclaw/.env, chat_id stored in private memory, not repo).
     Kuma DB backs up nightly via backup.sh, so monitor+notification config
     survives VM rebuild from the restore tarball.

Ollama: CPU-only, qwen2.5:7b loaded. Performance tuning:
  OLLAMA_NUM_THREAD=8, OLLAMA_KEEP_ALIVE=-1, OLLAMA_FLASH_ATTENTION=1
  Resource limits: 10G RAM, 6 CPUs (leaves 2 vCPUs for other services)

Immich machine-learning: OpenVINO image (CPU inference).
  Resource limits: 4G RAM, 4 CPUs. start_period: 180s (model load on first start).

Strategic roadmap lives in ROADMAP.md.
