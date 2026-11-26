# Cloudflare Configuration

Configuration lives in the Cloudflare dashboard (dash.cloudflare.com).
Not managed as code — document changes here manually.

## Tunnel: khe-homelab

Token stored in VM at `/home/khe/homelab/services/core/cloudflare-tunnel/.env`.
Routing is configured in Zero Trust → Networks → Tunnels → khe-homelab → Public Hostnames.
Tunnel routes directly to Docker containers. LAN traffic goes via NPM (split-horizon DNS).

| Domain              | CF Tunnel → (external)      | NPM → (LAN)                | Notes |
|---------------------|-----------------------------|-----------------------------|-------|
| khe.ee              | landing:80                  | landing:80                  | public; `/r/` = khe-trips share sites and `/trips/` = the khe-trips demo (a khe-trips decision), public by design (no Access, no dashboard change); `/stories/` = the public build of the stories app ([estate ADR-031](https://github.com/khelias/khe-architecture/blob/main/decisions/031-stories-public-app-private-stories-audio-outside-git.md)), from `/srv/data/stories/public`; edge fallback Worker on `khe.ee/*` ([Workers routes](#workers-routes)) |
| dash.khe.ee         | homepage:3000               | homepage:3000               | CF Access (external only) |
| vault.khe.ee        | vaultwarden:80              | vaultwarden:80              | |
| photos.khe.ee       | immich-server:2283          | immich-server:2283          | NPM: unlimited upload, 600s timeout |
| status.khe.ee       | uptime-kuma:3001            | uptime-kuma:3001            | CF Access (external only), like dash; Kuma keeps its own login |
| games.khe.ee        | games:80                    | — (CF only)                 | no AdGuard rewrite; edge fallback Worker on `games.khe.ee/*` ([Workers routes](#workers-routes)) |
| trips.khe.ee        | trips:80                    | trips:80                    | CF Access (external only), like dash |
| stories.khe.ee      | stories:80                  | stories:80                  | CF Access (external only), its own application; never in the edge copy |
| draft.khe.ee        | draft:8080                  | — (CF Access)               | dufs editor; CF Access OTP on all networks; **sole auth layer** (dufs runs without `--auth`, see service-choices.md); only on `draft-tunnel`; no AdGuard rewrite |
| pages.khe.ee        | pages:80                    | — (CF only)                 | public; serves published pages read-only; no AdGuard rewrite |

Not exposed via tunnel (LAN only): AdGuard (:8080), NPM admin (:81), Proxmox (:8006)

## Workers routes

Workers & Pages → the Worker → Settings → Domains & Routes. The edge
fallback ([estate ADR-016](https://github.com/khelias/khe-architecture/blob/main/decisions/016-static-fallback-at-the-edge.md)): two Workers with a static copy of the sites, deployed
by `.github/workflows/edge-fallback.yml` from
[`edge-fallback/`](edge-fallback/). Wrangler deploys the script and assets
only; the routes are set here, because routes Wrangler deploys overwrite
the failure mode.

| Route | Worker | Failure mode |
|-------|--------|--------------|
| `khe.ee/*` | `khe-fallback-khe-ee` | Fail open |
| `games.khe.ee/*` | `khe-fallback-games` | Fail open |

- Every request goes to the tunnel first and gets its answer unchanged; the
  copy answers only on a 5xx, a timeout (5 s) or no connection, with
  `X-KHE-Fallback: 1`.
- Never from the copy: `khe.ee/healthz`, `games.khe.ee/adventure/api/*` and
  any request that is not GET or HEAD. With the homelab down they fail, so
  UptimeRobot (on `https://khe.ee/healthz`) still sees the outage.
- Fail open: once the free quota (100,000 requests a day) is spent, requests
  go straight to the origin, as if no Worker existed.
- `workers.dev` and Preview URLs are off for both Workers, so the copy is
  reachable only through these routes.
- Why a route and not Pages: a Pages custom domain replaces the hostname's
  DNS record, which points at the tunnel, so Pages and the tunnel cannot
  both answer, and switching between them needs paid Load Balancing. A
  route runs the Worker in front of the origin, which answers 530 when the
  tunnel has no connector and 502 when a container is stopped.
- The adventure `config.js`, which the container writes at start from
  `API_SECRET`, is a stub without it in the copy, and staging fails on a
  tree that carries an `apiSecret` value or a symlink.
- `trips.khe.ee`, `stories.khe.ee` and the other hostnames have no route and
  no copy. `khe.ee/stories/` is copied without its audio, since Workers
  Static Assets ignore `Range`: with the homelab down the page shows the
  texts and says the reading is not available.
- LAN and Tailscale visitors to `khe.ee` never reach it: AdGuard resolves
  `khe.ee` to NPM. `games.khe.ee` has no rewrite, so they do go through its
  Worker, which passes the origin's answer through. With the VM down
  AdGuard is down too, so the fallback serves only visitors outside.
- API token: the "Edit Cloudflare Workers" template limited to this account
  and the `khe.ee` zone, without its Workers R2 Storage and Workers KV
  Storage permissions, in the `edge-fallback` environment of this repo
  (`main` only) with the account id. R2 Storage could lift the
  [offsite bucket lock](offsite-backup.md#bucket-lock) from the VM this runs
  on; the Workers bind neither R2 nor KV.

The Worker `makett-preview` is khe-makett's sales site preview, deployed by
that repo's `ci.yml` on `main` from a GitHub-hosted runner. It owns the
custom domain `makett.khe.ee`, its only address (`workers.dev` and Preview
URLs off), which Wrangler creates with the DNS record; the homelab serves
nothing there. Its API token is a custom one, Account Workers Scripts Edit
and Zone Workers Routes Edit on `khe.ee`, in khe-makett's repo secrets
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`; its accepted risk is in
[SECURITY.md](../SECURITY.md#automated-writers).

## Cloudflare Access

Zero Trust → Access → Applications.
Identity: One-time PIN via email (no OAuth setup needed).

| Application  | Domain  | Policy          |
|--------------|---------|-----------------|
| KHE Homepage  | dash.khe.ee | Owner only |
| KHE Trips    | trips.khe.ee | Owner only |
| KHE Draft    | draft.khe.ee | Owner only |
| Unejänku     | stories.khe.ee | Owner only |
| Makett preview | makett.khe.ee | Owner only |
| Uptime Kuma  | status.khe.ee | Owner only |
| Makett webhook | makett.khe.ee/api/stripe/webhook | Stripe webhook (bypass): Bypass, Everyone |

Every application but the webhook uses the one reusable policy "Owner
only" (edit once → applies to all). Despite its name it lets in both
parents' e-mails, so both reach every one of these apps, `draft` included,
which has no login of its own. Its session is 24 hours, which overrides the
applications' own.
Unejänku's Access application is created before the tunnel route to `stories:80`,
or the family build and the whole audio store are public in between; an
unauthenticated `curl -sI https://stories.khe.ee/` must then answer 302 to
the Access login.
The policy combines `Include: Emails = both parents` AND `Require: Countries = Estonia`.
The VM is not a Tailscale exit node (it advertises only the `192.168.0.0/24`
subnet route), so Tailscale does not carry the family past the country rule
when abroad. Over Tailscale, `dash.khe.ee`, `trips.khe.ee`, `status.khe.ee` and `stories.khe.ee` resolve through AdGuard to
`192.168.0.11` and go through NPM, so Access never sees them, abroad
included: the home route of
[estate ADR-022](https://github.com/khelias/khe-architecture/blob/main/decisions/022-home-route-for-access-only-apps.md) point 4. `draft.khe.ee` has no AdGuard rewrite: it reaches Cloudflare from
the device's own connection, and the country rule blocks it outside Estonia.

`draft.khe.ee` has no application-level login behind Access (dufs runs
without `--auth`), so removing or loosening its Access application exposes the
editor outright.

The makett preview's application is created before its first deploy, or the
preview is public in between; an unauthenticated `curl -sI
https://makett.khe.ee/` must then answer 302 to the Access login.

The makett webhook application lets Stripe reach the one path
`makett.khe.ee/api/stripe/webhook`; a path application takes precedence over
the hostname's, so the rest of the preview stays behind the owner policy. The
Worker's Stripe signature check is what guards that path (khe-makett
ADR-001). An unauthenticated `curl -s -o /dev/null -w '%{http_code}' -X POST
https://makett.khe.ee/api/stripe/webhook` answers 400 (no signature) while
`https://makett.khe.ee/` still answers 302.

## Custom Login Page

Zero Trust → Reusable components → Custom pages → Access login page.
Applies to all Access-protected apps (dash, trips, status, stories, draft).

| Field | Value |
|-------|-------|
| Organization's name | `KHE Homelab` |
| Logo URL | `https://khe.ee/logo.svg` (served by landing container, bind-mounted from `/srv/data/sites/khe`, which khe-sites deploys) |
| Header text | `Access limited to homelab owner.` |
| Message | `Sign in with your authorized email to receive a one-time code. All access attempts are logged.` |
| Background color | `#09090b` (matches landing page `--bg`) |

Logo is khe.ee's favicon, the family mark: "KHE" in Familjen Grotesk 600 with the Home room's red `.ee`, drawn as paths in a rounded box, light or dark with the system setting (khe-sites `src/landing/logo.svg`).

## WAF Custom Rules

Security → Security rules → Custom rules. Free plan: 5 rule slots, 4 in use.

| # | Name | Expression | Action | Purpose |
|---|------|-----------|--------|---------|
| 1 | Block known scanner paths | `(http.request.uri.path contains "/.env") or (.../.git/) or (.../wp-login) or (.../wp-admin) or (.../wp-content) or (.../xmlrpc.php) or (.../phpmyadmin) or (.../.aws/) or (.../.ssh/)` | Block | Drops WP/PHP/env scanner noise before origin |
| 2 | Challenge high-risk countries | `(ip.geoip.country in {"RU" "CN" "KP" "IR" "BY"}) and (http.host ne "khe.ee")` | Managed Challenge | CAPTCHA for bots; apex exempted so UptimeRobot still works |
| 3 | Challenge non-browser UAs on public apps | `(http.host in {"photos" "vault" "status" ".khe.ee"}) and (lower(http.user_agent) contains "curl"/"wget"/"python-requests"/"go-http-client"/"scrapy" or http.user_agent eq "")` | Managed Challenge | Stops naive scraper CLIs on the apps with their own login (status is also behind Access now); mobile apps send their own UAs so unaffected |
| 4 | Block Vaultwarden admin | `(http.host eq "vault.khe.ee") and starts_with(http.request.uri.path, "/admin")` | Block | The admin panel is never needed from the internet; LAN reaches it through NPM, which the tunnel never touches. `ADMIN_TOKEN` stays an argon2 hash as the second layer |

Also enabled:
- Bot Fight Mode: ON (+ JS Detections). It challenged the GitHub runner, but
  not Stripe's webhook calls to `makett.khe.ee/api/stripe/webhook`, which
  reached the Worker on 2026-11-26 without any IP rule. If Stripe's
  dashboard ever shows 403 deliveries there, Bot Fight Mode is the first
  suspect; a zone IP Access Allow rule matches before it, but would let
  those addresses past every custom rule on every `khe.ee` host, and the
  dashboard creates the first one only through the API.
- Block AI bots: "Block on all pages" (stops GPTBot/ClaudeBot/etc. training crawlers)
- Security Level: automated ("always protected" — the old slider was removed by CF)

## Rate limiting rules

Security → Security rules → Rate limiting rules. Free plan: 1 rule, counted
per IP over a fixed 10 s period with a 10 s block, and the expression can
only use the path (no hostname). Optional; the nginx `limit_req` in
`services/apps/games/nginx.conf` is the per-visitor limit either way.

| Name | Expression | Threshold | Action | Purpose |
|------|-----------|-----------|--------|---------|
| Adventure API flood | `starts_with(http.request.uri.path, "/adventure/api/")` | 10 requests / 10 s | Block 10 s | Stops a flood at the edge before it reaches the tunnel; a game sends one request per turn, so players never hit it. Only games.khe.ee serves that path |

## SSL/TLS

SSL/TLS → Edge Certificates.

- Always Use HTTPS: ON (zone-wide). Every `http://` request gets a 301 to
  `https://` at the edge, before the tunnel.
- HSTS is not set here. khe.ee sends it from the landing nginx without
  `includeSubDomains`, so the apex policy does not pin LAN-only names;
  games.khe.ee and pages.khe.ee send their own.

## DNS

Zone: khe.ee
All *.khe.ee records are CNAME → tunnel (proxied), except `makett.khe.ee`,
a Worker custom domain whose record Cloudflare manages for the
`makett-preview` Worker.
`www` is CNAME → `khe.ee` (proxied), handled by redirect rule below.
Split-horizon: local DNS via per-host AdGuard rewrites (no wildcard) → 192.168.0.11.
Router DHCP DNS: 192.168.0.11 (AdGuard) ONLY — never advertise a secondary.
Clients race both servers in parallel (happy-eyeballs) and Cloudflare would
win most races, silently bypassing ad/tracker filtering. Upstream DoH
(Cloudflare and DNS4EU) happens inside AdGuard, not via DHCP. See
[operational-notes.md](../docs/operational-notes.md#adguard-home).

## Redirect Rules

Rules → Redirect Rules.

| Rule name    | Match                       | Action                                                       |
|--------------|-----------------------------|--------------------------------------------------------------|
| www to apex  | Hostname equals www.khe.ee  | 301 → `concat("https://khe.ee", http.request.uri.path)`, preserve query |
