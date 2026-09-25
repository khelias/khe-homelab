# Operational notes

Per-service quirks and gotchas not covered in [`README.md`](../README.md).
Read on demand when working on the relevant service. Loading this whole
file in every session is wasteful; the entries are independent.

## AdGuard Home

- **Live config is `.gitignored`.** Baseline lives in
  `services/core/adguard/AdGuardHome.template.yaml`. Apply changes as delta-
  patches against the live YAML. Wholesale replacement wipes admin bcrypt +
  active sessions.
- **Per-service rewrites only**, no wildcard. 9 hostnames resolve to
  `192.168.0.11`. `games.khe.ee` is intentionally omitted - it resolves via
  Cloudflare for HTTPS.
- **Router DHCP DNS: `192.168.0.11` ONLY**, no secondary. A "fallback" DNS
  triggers happy-eyeballs racing - clients query both in parallel and CF
  always wins, so ad/tracker filtering silently bypasses AdGuard for ~80%+
  of traffic. Better to fail loudly if AdGuard is down.
- **Blocklists**: AdGuard DNS filter + OISD big (~330k rules) + Hagezi Pro
  Plus (~245k, covers EU/EE trackers like Cxense/Piano/Gemius) + Hagezi
  Threat Intelligence (paired with built-in Safe Browsing for layered
  defense).
- **Safe Browsing config key is `safebrowsing_enabled`** (one word).
  `safe_browsing_enabled` is a silent no-op.
- **`ratelimit_whitelist` does NOT accept CIDR**, only bare IPs. The
  LAN-friendly knob is a higher `ratelimit` value (currently 100 req/s
  per /24).
- **Memory limit 1G.** 256M was too tight once OISD big + Hagezi loaded; 512M
  also turned out to be too tight (2-4 OOM-kills/day observed early May 2026,
  ~10s DNS outage each = "wifi dropped" symptom on clients).
- **Per-client filtering** (parental + safesearch for kids) is the right
  architecture but requires >=1 MAC/IP per persistent client. AdGuard
  crash-loops on empty `ids: []`. Not provisioned yet; wire when kids'
  device IDs are collected. Apply to LIVE YAML via delta-patch only -
  never commit MAC/IP addresses to the template (public repo).
- **Custom user_rules**: `||connect.facebook.net^` (FB Pixel) and
  `||cxswyjy.com^` (Creality printer Chinese telemetry).
  `crealitycloud.com` left alone so the Creality Cloud app still works.

## Nginx Proxy Manager

- **Wildcard `*.khe.ee` Let's Encrypt cert** via Cloudflare DNS-01 (auto-renew).
- **9 proxy hosts**: `khe.ee`, `dash`, `cloud`, `vault`, `docs`, `photos`,
  `jellyfin`, `books`, `status`.
- **Upload-heavy hosts** (photos, cloud, docs, jellyfin, books) have
  unlimited body size + 600s timeouts. Applies to LAN clients only; the CF
  tunnel does not route through NPM (see Cloudflare Tunnel section).
- **All hosts**: WebSocket, HTTP/2, HSTS, SSL forced, block exploits.
- **Admin UI**: `http://192.168.0.11:81`, creds in VM `.env`.
- **CF API token for DNS-01** is stored inside NPM's database
  (`npm_data` volume), not in repo.
- **Not behind NPM**: `n8n`, `games` (CF Access / CF-only routing).

## Cloudflare Tunnel + Access

- Tunnel routes directly to Docker containers, `photos.khe.ee` included.
  Verified 2026-08-03: a request through the CF edge carries neither NPM's
  `x-served-by` nor its HSTS header, only Immich's own `x-powered-by:
  Express`. **NPM's per-host tuning (unlimited body, 600s timeout) therefore
  applies to LAN traffic only** - split-horizon DNS sends LAN clients to NPM,
  external clients bypass it entirely.
- Access policies (email OTP) protect: `dash.khe.ee`, `n8n.khe.ee`,
  `trips.khe.ee`, `draft.khe.ee`.
- `khe.ee` is fully public (landing page).
- **Healthcheck must be `cloudflared tunnel ready`, not `cloudflared version`.**
  The old check only proved the binary could execute, so it stayed green through
  the 2026-08-22 outage where every hostname served CF error 1033: the process had
  not crashed, so `restart: unless-stopped` saw nothing, and it never went
  unhealthy, so autoheal saw nothing either. `tunnel ready` queries the `/ready`
  endpoint, which reflects real edge registration, and requires `--metrics` on the
  run command to have something to query. The image is distroless (no shell, curl
  or wget), so the check has to invoke the `cloudflared` binary itself.
  Since the check now reflects edge state, autoheal acts on it: a tunnel that
  loses its edge registration is restarted automatically within roughly two
  minutes. So an unexplained tunnel restart in the logs is autoheal doing its
  job, not a crash.
- **A tunnel outage is invisible to Uptime Kuma.** Kuma runs on this VM and reaches
  services over the LAN through NPM, which tunnel traffic never touches, so internal
  monitors stay green while the public side is entirely down. Detecting it needs an
  external monitor, or the edge probe in `ops-status.yml`, which forces the
  Cloudflare address via `curl --resolve` and sends a browser User-Agent to avoid
  WAF custom rule 3.
- **CF error 1033 on every hostname** means the tunnel is not registered with the
  edge at all, not that one service is broken. Check outbound connectivity from the
  VM first: on 2026-08-22 the cause was a router DHCP misconfiguration, so the VM
  had no path out while every container kept running normally.
- See [`infrastructure/cloudflare.md`](../infrastructure/cloudflare.md).

## Nextcloud

- **PHP**: 512M memory, 16G upload, OPcache 256M, JIT 128M
  (`php-custom.ini` mount).
- **PostgreSQL**: `shared_buffers=256MB`, `work_mem=16MB`,
  `effective_cache_size=1GB`.
- **Redis**: `maxmemory 256MB`, `allkeys-lru`, persistence disabled (cache-only).
- **`trusted_proxies`**: `172.16.0.0/12` (Docker network for CF Tunnel).
- **Config**: `default_phone_region=EE`, `maintenance_window_start=1` (UTC),
  `simpleSignUpAllowed=false`, `loglevel=2`, `trashbin/versions "7, auto"`.
- **`PG CREATEROLE` bug** resolved via `init-db.sh` (non-superuser nextcloud
  DB user).
- **`NEXTCLOUD_TRUSTED_DOMAINS`** includes `nextcloud` for Homepage OCS API.
- **App password for Homepage**:
  `docker exec nextcloud php occ user:add-app-password admin`.
- **Cron sidecar** (`nextcloud-cron`) runs background jobs.

## Jellyfin

- **QSV** configured via init container (`encoding.xml` bind mount +
  `system.xml` patch). No web UI steps needed.
- `/dev/dri` mounted for Intel Quick Sync (iGPU passthrough).

## Homepage

- Live widgets for all services. Config in `services/core/homepage/config/`
  (git-tracked bind mount).
- API keys in VM `.env` only, never committed.
- **Regenerate API keys** from scratch:
  - Proxmox: `pveum user token add root@pam homepage --privsep=0`
  - Paperless: `docker exec paperless python3 manage.py drf_create_token admin`
  - Immich: insert into `api_key` table (helper in `scripts/`)
  - Jellyfin: insert into `ApiKeys` table in `jellyfin.db`
  - Audiobookshelf: read `token` column from `users` table in `absdatabase.sqlite`
  - Nextcloud: `docker exec nextcloud php occ user:add-app-password admin`

## Games hub (launcher + study + adventure)

Stack: `services/apps/games/` (nginx + adventure-proxy).

- `/` -> launcher (`khe-sites` repo deploys to `/srv/data/games/launcher/`)
- `/study/` -> `khe-study` (`/srv/data/games/study/`, GH Actions runner deploys here)
- `/adventure/` -> `khe-ai-adventure` (`/srv/data/games/adventure/app/`, GH Actions runner)
- `/adventure/api/` -> `adventure-proxy` container
- CF tunnel route `games.khe.ee` -> `games:80` (direct, no alias).

**Vite base path** for sub-app deployments:

- `khe-study`: `vite { base: '/study/' }`, BrowserRouter `basename="/study"`
- `khe-ai-adventure`: same pattern with `/adventure/`

**Adventure proxy build chain** (lives in `khe-ai-adventure`, not here):

- That repo's runner builds the proxy image as `games-adventure-proxy:latest`.
- `khe-homelab` compose references the image by tag, no build context.
- Source: `khe-ai-adventure/proxy/server.js`.

**Per-repo runners on the VM**:

- `/home/khe/actions-runner` - khe-study
- `/home/khe/actions-runner-adventure` - khe-ai-adventure
- `/home/khe/actions-runner-sites` - khe-sites
- `/home/khe/actions-runner-trips` - khe-trips

**nginx mount nesting**: study/adventure are bind-mounted **outside** the
launcher root and served via per-location `root`. Do NOT nest these mounts
under `/usr/share/nginx/html` - nginx then sees launcher placeholders and
returns 403 for `/study/` and `/adventure/`.

**Networks**: `games-internal` (nginx <-> adventure-proxy) + `proxy`
(CF tunnel -> nginx).

**API keys**: `GEMINI_API_KEY` + `ANTHROPIC_API_KEY` in
`services/apps/games/.env` on VM (never committed).

## Trips

- `services/apps/trips/` stack (nginx alpine, pinned by Renovate, mirrors landing).
- `trips.khe.ee` -> `trips:80` via CF Tunnel (no AdGuard rewrite, CF only
  for HTTPS).
- CF Access protected with the shared `Email + Country=EE` policy
  (same as dash, n8n, draft).
- Static SPA: bind mount `/srv/data/trips/app:/usr/share/nginx/html:ro`,
  SPA fallback to `/index.html`.
- Source: `khelias/khe-trips` (private).
- Share sites (one trip each, public by link) are served by landing at
  `khe.ee/r/<slug>/`, not here; see "Landing page".
- GH Actions runner: `/home/khe/actions-runner-trips`,
  systemd unit `actions.runner.khelias-khe-trips.trips-runner.service`.

## Ollama

- CPU-only, `qwen2.5:7b` loaded.
- Tuning: `OLLAMA_NUM_THREAD=8`, `OLLAMA_KEEP_ALIVE=-1`,
  `OLLAMA_FLASH_ATTENTION=1`.
- Resource limits: 10G RAM, 6 CPUs (leaves 2 vCPUs for other services).

## Immich

- **`immich-server` needs 6G RAM.** Since v3 the job workers (thumbnails,
  ffmpeg transcode) run inside `immich-server`, not in the ML container.
  With a 2G limit the cgroup OOM-killed ffmpeg + the node process during
  video ingest (observed 2026-08-03); `restart: unless-stopped` brought it
  back ~90s later and every in-flight upload returned 502 via NPM.
  Note `docker inspect .State.OOMKilled` reads `false` in this case -
  `dmesg -T | grep "killed process"` is the authoritative signal.
- **`immich.config.json` edits need `docker compose up -d --force-recreate`.**
  It is a single-file bind mount, Docker binds such a mount by inode, and
  `git pull` / `git checkout` replace the file via rename. A running
  container keeps serving the old inode, so a plain `up -d` reports
  "Running" while the container still holds the previous config. Hit
  2026-08-05: the compose memory limits had applied but preset,
  targetResolution and the CLIP model had not. Verify inside the container
  (`docker exec immich-server grep preset /immich.config.json`), never
  against the file on the host.
- **Video playback serves the transcode, never the original.**
  `/api/assets/:id/video/playback` returns the `encoded-video/` file
  whenever one exists, so every client (phone, TV, browser) watches the
  re-encode. Photos differ: the app fetches the original when you zoom in.
  This is why the transcode profile is a quality decision, not just a
  storage one.
- Transcode policy is `required` + `targetResolution: original` since
  2026-08-05: only files in an unaccepted codec get re-encoded, and those
  keep their resolution. `optimal` / `720` and later `optimal` / `1080`
  both meant every 4K clip was watched as a downscale. `preset: medium`,
  `crf: 23` and `tonemap: hable` only apply to the files that still do get
  transcoded.
- **`acceptedContainers` must list `mp4` explicitly.** Immich's default list
  (`mov`, `ogg`, `webm`) does not cover it, and an unaccepted container
  forces a re-encode regardless of codec - so under `required` every phone
  `.mp4` was still being transcoded (observed 2026-08-05: 9 h264 mp4
  transcodes in 3 minutes immediately after the policy switch). mp4 is the
  container Immich itself writes output into, so accepting it costs nothing.
- **`required` leaves existing transcodes in place.** They keep being
  served until Video Conversion is re-run from the Job Status page, which
  re-evaluates each asset and drops the files the policy no longer wants.
  Originals under `upload/library/` are untouched throughout.
- Browser HEVC support is the risk `required` carries: `hevc` is in
  `acceptedVideoCodecs`, so iPhone 4K clips are now served as-is. The
  mobile apps and Safari handle that, Chrome and Firefox may not. If web
  playback breaks, drop `hevc` from the accepted list - it will then be
  re-encoded to h264 at original resolution.
- `image.fullsize` and `image.extractEmbedded` are on. Without them the
  largest viewable render of a HEIC or RAW original is the 1440px preview,
  because browsers cannot decode the original. Cost is one extra JPEG per
  non-web-native asset.
- **Everything absent from `immich.config.json` runs on its default and
  cannot be changed in the UI.** With `IMMICH_CONFIG_FILE` set, the whole
  admin settings page is read-only. Secrets (SMTP password, OAuth client
  secret) therefore have nowhere to live yet - the file is committed to a
  public repo.
- **Uploads over 100MB fail from outside the LAN** with 413, not 502:
  Cloudflare's free plan caps request body at 100MB and the Immich app
  does not chunk. Measured 2026-08-03: a 120MB POST got 413 from the CF
  edge after ~1.7MB, the same POST via NPM on the LAN reached Immich.
  Routing the tunnel through NPM would not help - the cap is at the CF
  edge, before the origin. Large videos have to go via LAN or Tailscale.

## Immich machine-learning

- OpenVINO image (CPU inference, no GPU model needed at this size).
- Resource limits: 6G RAM, 4 CPUs.
- `start_period: 180s` (model load on first start).
- **Smart Search runs `nllb-clip-base-siglip__v1`, not the default
  `ViT-B-32__openai`.** Reason: Estonian queries. Immich has no Estonian
  benchmark, but Finnish is the closest proxy in its own table and there
  the `nllb` family scores ~79% recall against ~40% for the SigLIP2 models
  and far less for the old default. `nllb` models translate the query using
  the **user's UI language**, so each account must have Estonian selected
  in Immich for this to work (`et` maps to `est_Latn` in Immich's
  FLORES-200 table).
- Switching the CLIP model invalidates every existing embedding. After a
  model change, run Smart Search -> "All" from the Job Status page (jobs
  stay usable even though settings are read-only). Expect hours on CPU for
  a large library; the model is worth nothing until that finishes.
- Model TTL is the default 300s, so the first search after an idle period
  reloads a ~4.7G model and takes 10-20s. Levers if that becomes annoying:
  `MACHINE_LEARNING_MODEL_TTL=0` (keeps it resident, permanently spends the
  RAM) or `MACHINE_LEARNING_OPENVINO_PRECISION=FP16` (halves memory, small
  accuracy risk).
- `nllb-clip-large-siglip__mrl` is the upgrade path (~+5pp recall) but is
  5x slower per query on CPU. Not worth it without a discrete GPU.

## Landing page

- Static HTML at `khe.ee` (public), served by nginx alpine (pinned by Renovate).
- `/r/<slug>/` serves khe-trips share sites from `/srv/data/trips/share`,
  written by the khe-trips runner and mounted outside the html root
  (`/srv/share/r`). An unknown slug, `/r` and `/r/` answer 404, not the
  landing fallback. Everything under `/r/` is `Cache-Control: private` (assets
  a week in the browser only), so Cloudflare never holds a copy and an
  un-shared trip is gone at once. `/srv/data/trips/share` must exist, owned by
  the runner user, before landing starts, or Docker creates it root-owned and
  the khe-trips deploy can no longer write it.
- Homepage dashboard moved to `dash.khe.ee` (CF Access protected).
- `HOMEPAGE_DOMAIN=dash.khe.ee` in homepage `.env`; compose builds
  `HOMEPAGE_ALLOWED_HOSTS` from it plus `homepage:3000`, the Uptime Kuma
  monitor URL. Homepage v2 answers 400 to any other Host, the IP included.

## Pages (FileBrowser editor + nginx)

Quick-publish surface: paste an AI-generated HTML page from a phone, get a
public shareable link. Two containers in `services/apps/pages/` sharing
`/srv/data/pages/app` (writer/reader split, same shape as n8n -> landing
`/reports`).

- `draft` (FileBrowser `v2.63.12`, runs as UID 1000, internal port 8080) is
  the **private** editor. `draft.khe.ee` -> `draft:8080` via CF Tunnel, CF
  Access protected (shared `Email + Country=EE` policy). It only mounts the
  published tree at `/srv` (`FB_ROOT`); the DB lives in a separate
  `/srv/data/pages/db:/database` mount (`FB_DATABASE=/database/filebrowser.db`)
  so it never shows up in the file UI.
- `pages` (nginx `1.31-alpine`) is the **public** reader. `pages.khe.ee` ->
  `pages:80` via CF Tunnel (public, no Access, no AdGuard rewrite). Mounts the
  same dir `:ro`. Unlike landing/trips it mounts a full **main** `nginx.conf`
  (at `/etc/nginx/nginx.conf`, not `conf.d/`) so the worker `user` can be set.
- **Why nginx workers run as `root`:** FileBrowser hardcodes newly created
  files to mode `0640` (owner+group read, no other-read) regardless of umask,
  so the stock `nginx` worker (uid 101) gets **403 Forbidden** on every page.
  Workers run as root to read them. Safe here: read-only static server, mounts
  only the public page tree + its own config, no proxy/exec/secrets. (Do NOT
  copy this to landing/trips - they serve git-deployed, world-readable files.)
- **Extension-less files render:** `default_type text/html` means a page saved
  in FileBrowser as just `unify` (no `.html`) still serves as HTML instead of
  downloading. `.html` names work too (mapped via mime.types).
- **First deploy is permission-sensitive.** Create and chown the tree BEFORE
  the first `docker compose up`, or Docker auto-creates it root-owned and the
  non-root FileBrowser cannot write its DB (same trap as Loki):
  `sudo mkdir -p /srv/data/pages/app /srv/data/pages/db && sudo chown -R 1000:1000 /srv/data/pages`
- **Login: no FileBrowser password.** Since 2026-08-29 the editor runs with
  `auth.method=proxy` and `auth.header=Cf-Access-Authenticated-User-Email`. It
  trusts the header cloudflared injects for Access-protected hostnames and logs
  in the user whose username equals that email (user ID 1). CF Access is now the
  only auth layer, so the `draft.khe.ee` Access application must never be
  removed. This replaced the one-time random admin password FileBrowser printed
  to `docker logs draft` on first run.
- **Changing that setting requires stopping the container.** The bbolt DB takes
  an exclusive lock, so `docker exec draft filebrowser config ...` hangs against
  a running server. Stop `draft`, copy `/srv/data/pages/db/filebrowser.db`
  aside, then run the config command in a throwaway container mounting the same
  `/database`. The setting lives in the DB, not in git or compose, so it is not
  reproducible from the repo; it rides along in the `/srv/data/pages` backup.
  Rollback to password login is `config set --auth.method=json`.
- **Clean URLs:** nginx `try_files $uri $uri.html $uri/ =404` — a flat
  `leht1.html` is shared as `pages.khe.ee/leht1`. The public root `/` 404s
  until an `index.html` exists; intentional (no directory listing).
- **noindex:** `X-Robots-Tag: noindex` header (authoritative) plus an
  always-200 `/robots.txt` Disallow. The `pages` healthcheck targets
  `/robots.txt`, so it stays healthy even with zero published pages.
- **No auto-expiry:** pages stay public until deleted in the FileBrowser UI.
  `/srv/data/pages` is the one app tree not reproducible from git, so it is in
  `backup.sh` BIND_MOUNTS.
- Headers match the `games`/`adventure` house set minus the strict app CSP
  (it would break user-authored inline JS); only `frame-ancestors 'none'`
  plus the origin-wide HSTS/nosniff/referrer/permissions headers are kept.

## Observability (Loki + Grafana + Alloy + Alertmanager)

- **Stack layout.** Four sub-stacks under `services/observability/`,
  each with its own `docker-compose.yml`: `loki/`, `grafana/`,
  `alloy/` (with a sibling `alloy-socket-proxy`), `alertmanager/`.
  Deploy order is enforced by `scripts/deploy.sh` /
  `scripts/deploy-stacks.sh` DEPLOY_ORDER: loki first (owns the
  `observability` network), then alertmanager, grafana, alloy.
- **Why Alloy, not OTel Collector contrib.** Grafana Alloy is an
  OpenTelemetry Collector distribution — 100% OTLP compatible — with
  native Docker discovery (`discovery.docker`) and a native Docker
  log source (`loki.source.docker`) that the upstream OTel
  Collector lacks. Promtail reached end-of-life on 2026-03-02, so
  it was never a candidate. The initial implementation tried
  upstream OTel Collector + filelog and ended up needing a hand-
  maintained container_id → container_name map; switching to Alloy
  removes that whole layer.
- **First deploy.** Copy
  `services/observability/grafana/.env.example` → `.env` and pick a
  Grafana admin password. Copy
  `services/observability/alertmanager/config/alertmanager.yml.example`
  → `alertmanager.yml`, paste the Telegram bot token + chat ID
  (grab both from Uptime Kuma's web UI → Settings → Notifications;
  the same bot is reused). The live `alertmanager.yml` is
  `.gitignored`.
- **Loki storage.** Chunks + index live on the ZFS mirror at
  `/srv/data/loki`, not NVMe — log retention is 30 days and this
  is bulk data, not hot. First run will need the directory created:
  `sudo mkdir -p /srv/data/loki && sudo chown 10001:10001 /srv/data/loki`
  (Loki runs as UID 10001). Without ownership, Loki errors out on
  boltdb-shipper init.
- **Log shipping.** Alloy talks to Docker through the hardened
  `alloy-socket-proxy` (tecnativa/docker-socket-proxy with only
  `CONTAINERS: 1`, no write surface — same pattern as
  `services/core/autoheal/`). `loki.source.docker` reads each
  container's log stream via `GET /containers/{id}/logs` and ships
  to Loki via the native push API. `container_name`, `stream`, and
  `cluster` are first-class stream labels — query with
  `{container_name="adventure-proxy"}`.
- **Loki ruler.** Alert rules live in
  `services/observability/loki/config/rules/fake/` — the `fake`
  subdir is Loki's default tenant ID when `auth_enabled: false`.
  Bind-mounted read-only; Loki polls every minute, fires via
  Alertmanager v2 protocol.
- **Log-content rules must exclude `container_name="loki"`.** Loki
  logs every executed query at info level *including the LogQL
  query string itself*. A rule like `... |~ "panic|fatal" ...`
  matches its own echo as soon as Alloy ships Loki's logs back in,
  fires forever, and every ad-hoc Explore query against the rule's
  metric perpetuates the loop. Always add
  `container_name!="loki"` to the stream selector. Loki's own
  health is covered by the Uptime Kuma `/ready` probe instead.
- **`reject_old_samples_max_age` matches `retention_period`** (both
  720h). Alloy's `loki.source.docker` tails each container from the
  start of its log file; containers running >7d would otherwise hit
  HTTP 400 "timestamp too old" on every batch and silently drop
  all backlog. Anything inside the retention window is acceptable
  to ingest.
- **Grafana datasources.** Loki + Alertmanager, both provisioned
  from `config/provisioning/datasources/` over the shared
  observability network. Alertmanager wires Grafana's
  `Alerting > Alert groups` page to the same Alertmanager the Loki
  ruler fires into, so alert review happens in Grafana rather than
  Alertmanager's bare UI.
- **Grafana dashboards.** Two, both read-only via
  `config/provisioning/dashboards/files/`:
  - `Homelab — Overview` — single-screen state: active alerts,
    log volume per container, top-5 ERROR/WARN/FAIL rate, top-10
    Loki ingestion rate stacked.
  - `Homelab — Container logs` — Explore-style log stream with a
    `container_name` dropdown sourced from
    `label_values({cluster="homelab"}, container_name)`. Auto-
    populates from whatever Alloy is currently shipping, no manual
    ID-to-name map.
- **Grafana ingress.** LAN-only for v1 via host port `3030` (NPM
  is taken by homepage on port 3000) + direct via NPM at
  `grafana.khe.ee`. Add to AdGuard split-horizon DNS + NPM proxy
  host before the domain resolves. **Do not** expose via Cloudflare
  Tunnel without CF Access OTP — log search is the door to every
  container's history. CF integration is a deliberate follow-up
  step.
- **Telegram channel.** Reuses the existing Uptime Kuma bot for
  simplicity. If alert volume gets noisy, split into a second bot
  + chat to keep uptime pings and log alerts on different channels.

## Home Assistant

Runs as HA **Container**, not HAOS, so there is no Supervisor and no add-ons.
Add-on equivalents (Mosquitto, Zigbee2MQTT, ESPHome) run as ordinary
containers in the same group. See
khe-meta's `house/home-assistant-plan.md` for the phased rollout.

**Trusted proxies live in the UI, not in YAML.** Since HA 2026.8 the `http:`
block is imported once and then ignored, and on this install the import did
not take: NPM requests answered `400: Bad Request` with "your HTTP integration
is not set-up for reverse proxies" in the log while the YAML block was
present. Set Settings -> System -> Network -> HTTP server: Trust
X-Forwarded-For on, Trusted proxies `172.18.0.0/16` (the `proxy` network; check
with `docker network inspect proxy`). Stored in `.storage`, so it survives in
backups but not in the repo.

**NPM needs WebSocket support enabled** on the `home.khe.ee` proxy host. Without
it the frontend loads and then hangs on a blank page, which looks like a HA
fault and is not one.

**Port 8123 needs a UFW rule.** Added to `ALLOWED_PORTS` in
`harden-docker-vm.sh`, but that script is not re-run on deploy, so on an
existing VM the rule has to be added by hand:
`sudo ufw allow from 192.168.0.0/24 to any port 8123`.

**Config directory is mostly gitignored.** HA rewrites the directory at runtime
and `.storage` holds the user database, long-lived tokens and integration
credentials. Only `configuration.yaml` and `config/packages/*.yaml` are
tracked; the ignore rule is a
blanket `config/*` plus a whitelist, so every new hand-written YAML file must
be added to `.gitignore` explicitly or it silently stays untracked. HACS and
its integrations (`custom_components/`) are deliberately untracked and
reinstalled by hand; they are covered by the config-dir backup.

**Every `template/reload` must be followed at once by
`POST /api/events/khe_price_refresh`.** Trigger-based template sensors do not
re-run on reload, so the whole price stack (`elektri_hinna_prognoos`, `_tase`,
`odavaim_aken_*`) goes blank and the Kodu Elekter card renders `None. None`
until the hourly tick. A restart is safe, the package has a `start` trigger;
only reload breaks it. An `event_template_reloaded` trigger does not fix it,
the reload races the entities listening for it (core issues #65832, #101835).

**A Nord Pool delivery date is a CET day**, 01:00-01:00 Estonian time, so
`nordpool.get_prices_for_date` for today starts at 01:00. The forecast sensor
also fetches yesterday and keeps slots from local midnight; without that the
00:00 hour is missing and the price level goes blank every night until 01:04.
The integration's own "tomorrow available" flag flips on the same CET clock.

**Config changes need a restart.** The config dir is a bind mount, so editing
YAML and running `deploy-stacks.sh` changes nothing in the running container.
Validate, then restart:
`docker exec homeassistant hass --script check_config -c /config && docker restart homeassistant`.

**Not on the Cloudflare Tunnel, deliberately.** CF Access breaks the HA
companion app login and webhooks, and this host will eventually control the
ventilation and heat pump. Remote access is Tailscale.

**Backup.** `backup.sh` copies the recorder DB via Python's `sqlite3` backup
API inside the container (`homeassistant-recorder.db.gz`) and tars the config
dir with the live DB, its journals and the log excluded
(`homeassistant-config.tar.gz`). Restore: untar the config dir, drop the
gunzipped DB in as `home-assistant_v2.db`, start the container.

**Grid consumption from Estfeed (since 2026-09-13).** HACS custom repository
`khelias/ha-estfeed` (fork of `tehisain/ha-estfeed` with the day/night grid
tariff, cost sensors, the resume-point fix and the hourly price statistic
`estfeed:estfeed_price`; a permanent fork that merges upstream in). The API key is entered in the integration's UI
flow and lives in `.storage`, nowhere else. Tariff options are on the config
entry (Settings -> Devices -> Estfeed -> Configure); the values and the
reasoning are in
khe-meta's `house/home-assistant-plan.md`, section "House meter without
hardware".
If the cost history looks like spot-only after an options change, or the
cumulative sums jump (check monthly totals against the self-service), run
the `estfeed.backfill_history` service (months: 2): it rewrites both series
from zero over the window. The integration's default
entity ids embed the metering point EIC; they were renamed in the entity
registry to `sensor.maja_*`, `binary_sensor.maja_andmed_varsked` and
`button.maja_*` so the dashboard generator can reference them in this public
repo. A fresh install of the integration would recreate the EIC-based ids.
Options can also be set over REST through
`/api/config/config_entries/options/flow`, but a change made while the
initial backfill is still running gets overwritten; run `backfill_history`
afterwards. The fork has no releases, so HACS sees a new commit only after
`hacs/repository/refresh` (WebSocket); download the update in the HACS UI
after that.

**Pergola via Tuya Local (since 2026-09-20).** The two motorised pergolas are
Tuya WiFi devices (protocol 3.5). Tuya's cloud only declares three datapoints
for them, so the built-in Tuya integration can offer nothing but a door
binary sensor: the roof control and both LED circuits are custom datapoints
that are reachable over the LAN only. They run on HACS custom repository
`make-all/tuya-local`, which is a *custom* repository, not in the HACS default
store.

That integration ships its device definitions inside its own folder and has no
user config directory (the PR that would have added one,
make-all/tuya-local#5141, was rejected), **and a tuya-local update deletes
anything extra in there.** The folder is also owned by root, because the
container runs as root, so the deploy runner cannot write into it and a
tracked file at that path breaks `git pull --ff-only` with "Permission
denied" (hit on 2026-09-20).

So the device definition is tracked at
`config/tuya_local_devices/nordin_eco_pergola.yaml` and copied into place from
inside the container by `shell_command.sync_tuya_local_devices`
(`config/packages/pergola.yaml`), which an automation runs on every Home
Assistant start. The copy lands too late for the config entries of that boot,
and a reload does not rescue them: 2026.9.2 bumped the entry version, the
migration failed on the missing file and left both entries in
`migration_error`, which only a restart clears (2026-09-25). So the automation
restarts HA once whenever the copy changed a file; the second boot finds the
file identical and does not restart again. Updating tuya-local therefore costs
one restart more than the one HACS asks for, and it happens by itself.

Device ids, local keys and LAN addresses are not in this repo; the local keys
live in `.storage` and the addresses in khe-meta's
`house/home-assistant-plan.md`.

**These units report no roof position, and that is settled.** Measured three
ways on 2026-09-20:

- Over the LAN, dp1 does not exist. A tinytuya `updatedps([1,14,24,101,102,110])`
  returns nothing and the following `status()` is unchanged, so tuya-local's
  `force` flag has nobody to ask.
- dp2 holds the last command only until the motor stops, then the device
  resets it to `stop` by itself, seen passively with no movement at all.
- In the cloud dp1 exists but is frozen at its pairing value. Driving the roof
  fully open and fully closed while polling the built-in Tuya integration's
  diagnostics showed `control` tracking live (stop -> open -> close, within
  15 s) while `status` never moved off `opened` - with the louvres physically
  shut the whole time. The cloud link is alive; the datapoint is not.

So the cover entities are command-only and sit at `unknown`, which is honest
rather than broken, and the built-in Tuya integration adds nothing that
tuya-local does not already have locally. Any state shown in Home Assistant
would have to be remembered on the HA side, and would be wrong whenever the
RF remote is used. If the manufacturer's rain sensor is ever fitted, re-check
dp24 (`switch_sensor`): it reads false and never moves today.

**Helpers start at their minimum, not at a sensible value.** An `input_number`
or `input_datetime` created in a package comes up at the bottom of its range
(the pergola evening brightness landed at 5 %, the off time at 00:00). `initial:`
is not the fix, because it overwrites whatever the household chose on every
restart. Set the value once through the API after first deploy instead.

**Editing a tuya-local device config renames its entities.** The unique id is
derived from the entity's type plus its name or class, so dropping
`class: awning` from the cover made tuya-local register brand new entities
(`cover.aed_pergola_parem`, area-prefixed because the old id was taken) and
left the originals behind as unavailable orphans, which also broke the group
that referenced them. After such an edit, delete the orphans from the entity
registry and rename the new entities back, or the dashboard quietly points at
nothing.

**The roof rain rule runs on Open-Meteo, not on met.no.** met.no reported
`partlycloudy` and 0.0 mm for six hours while it was raining on the terrace
(2026-09-20), because it is a grid forecast and a local shower fits between
the grid points. `config/packages/pergola.yaml` has a `rest:` sensor pair
(`sensor.sademed_praegu`, `sensor.sademed_kahe_tunniga`) reading Open-Meteo's
15 minute nowcast; the URL is a `resource_template` so the house coordinates
come from `zone.home` and stay out of this repo. Whether the nowcast catches
a shower this one missed is not proven yet.

**New devices drift the generated dashboard.** Home Assistant adds a section
for a newly discovered device to the stored Overview config by itself, so
`scripts/ha-dashboard.py` and the live dashboard diverge after every new
integration. That is what the generator is for; diff before assuming the
drift is someone's deliberate edit.

**A tile's colour is not a state indicator by itself.** A tile paints its
icon whenever the entity counts as active, and a select, a sensor or a water
heater in its normal mode (`on`) always does. So a coloured tile on such an
entity is coloured all day. Where colour has to mean "this is running",
the generator shows two tiles picked by a visibility condition, coloured and
`disabled` (`by_state`, `heater_month`). Red is kept for faults and for
things that should be zero and are not.

**Integrations without translations show raw option keys** (`working_week`,
`heating`, `twice`). The Estonian labels are template sensors in the device's
package, and the dashboard tile shows the label with a `more-info` tap action
on the select (`"entity": <select>`), so the picker is one tap away as before.

### HVAC integrations

The Komfovent and Daikin integration quirks (Modbus client rules, register
gotchas, the broken space-heating energy channel) name the units and their LAN
addresses, so they live in the private `khe-meta` repo under
`house/house-hvac.md`.

## Healthchecks

- **games**: uses `127.0.0.1` (NOT `localhost`). Busybox wget DNS issue in
  alpine - localhost doesn't resolve.
- **cloudflare-tunnel**: uses `cloudflared version` (distroless image, no
  curl/wget available).
- **alloy**, **loki** (>= 3.7): no container-internal healthcheck.
  `grafana/alloy` ships without wget/curl; `grafana/loki` 3.7+ is
  fully distroless (no shell either). Adding a thin Dockerfile
  layer just for a probe breaks the "pinned upstream image"
  convention. Liveness is covered externally by Uptime Kuma
  monitors against `http://alloy:12345/-/ready` and
  `http://loki:3100/ready` on the observability network — that's
  also why `services/core/uptime-kuma` joins `observability` in
  addition to `proxy`.

## Hardware passthrough

- Intel iGPU bound to `vfio-pci` on Proxmox host (`i915` blacklisted),
  passed through to Docker VM 100.
- VM runs `linux-image-amd64` kernel (cloud kernel lacks i915), GRUB
  default set.
- VM apt sources include `non-free-firmware` for Intel firmware packages.
- `/dev/dri` mounted into `jellyfin` and `immich-server` containers.

## VM watchdog

- `watchdog` daemon pings `/dev/watchdog` (iTCO_wdt, Proxmox-emulated
  Intel TCO, 30s timeout).
- If daemon wedges (kernel hang, OOM, I/O lock), hardware force-resets
  the VM within 30s. Proxmox boots it back up.
- **Conservative config**: only pings the device, NO load/memory/network
  checks (those cause false-positive reboots on blips). See
  `/etc/watchdog.conf` on the VM.

## Restore verify (GH Action)

- `.github/workflows/restore-verify.yml` runs Sundays 04:00 UTC on the
  self-hosted homelab runner. Pulls the latest restic snapshot from R2,
  restores the `nextcloud-db.dump` (largest schema, only DB-init quirk)
  into a throwaway Postgres container, and asserts ≥50 public tables
  before tearing down. Heartbeat pings Kuma at the end.
- **Why nextcloud-db, not all four DBs:** if its restore works, the
  others almost certainly do — they don't carry the non-superuser
  CREATEROLE constraint that bit us once. Limit egress, limit run time.
- **Sync risk:** the workflow re-creates the `nextcloud` role + DB
  inline using the same approach `services/productivity/nextcloud/init-db.sh`
  uses. If you change `init-db.sh`, update the workflow's role-create
  block in the same commit, otherwise the test stops mirroring prod.
- **Manual trigger:** Actions tab → Restore Verify → Run workflow.
  Useful right after touching backup.sh, the Postgres image, or the
  Nextcloud schema (major version upgrade).

## Backup heartbeats

- `scripts/backup.sh` and `scripts/offsite-backup.sh` ping a configurable
  URL on exit — `status=up` on success, `status=down` with exit code +
  failure count on any non-zero exit. Without the URL set, both scripts
  remain fully silent on this dimension.
- Configuration lives in `~/homelab/.env.heartbeat` (mode 0600,
  gitignored via `*.env`). See [`../.env.heartbeat.example`](../.env.heartbeat.example)
  for the variable names and the matching Uptime Kuma push-monitor setup.
- Heartbeat target = Uptime Kuma "Push" monitor. Telegram alert
  fires automatically when the heartbeat is missed past the configured
  interval. Heartbeat interval should exceed the longest expected run
  (suggested 28h for daily-cron scripts).
- The trap fires on **any** exit, including the FATAL early ones
  (missing env file, wrong perms, repo unreachable). Don't move the
  trap below those checks.

## Tailscale

- Installed on VM host (not Docker), subnet router for `192.168.0.0/24`.
- IP forwarding: `/etc/sysctl.d/99-tailscale.conf`.
- Flags: `--advertise-routes=192.168.0.0/24 --accept-dns=false`.
- Admin DNS (since 2026-09-12): **split DNS** `khe.ee` -> VM's Tailscale IP
  (`tailscale ip -4` on VM), "Override DNS servers" OFF, no global nameserver.
  Before that it was a global AdGuard nameserver with override on, which made
  Tailscale fight FortiClient/UniFi for the laptop's resolver. Split DNS
  touches only `khe.ee` queries, so work VPNs keep their own DNS untouched.
- Clients need "Use Tailscale DNS" enabled for the split route to apply
  (macOS: `Tailscale set --accept-dns=true`; mobile defaults to on). The VM
  itself stays `--accept-dns=false`.
- Trade-off accepted: AdGuard filters the LAN, not mobile data. If AdGuard is
  down, remote clients lose `khe.ee` names only; the rest of DNS keeps working.
- See [`infrastructure/tailscale.md`](../infrastructure/tailscale.md).
