# Cloudflare Configuration

Configuration lives in the Cloudflare dashboard (dash.cloudflare.com).
Not managed as code — document changes here manually.

## Tunnel: khe-homelab

Token stored in VM at `/home/khe/homelab/services/core/cloudflare-tunnel/.env`.
Routing is configured in Zero Trust → Networks → Tunnels → khe-homelab → Public Hostnames.
Tunnel routes directly to Docker containers. LAN traffic goes via NPM (split-horizon DNS).

| Domain              | CF Tunnel → (external)      | NPM → (LAN)                | Notes |
|---------------------|-----------------------------|-----------------------------|-------|
| khe.ee              | landing:80                  | landing:80                  | public; `/r/` = khe-trips share sites, public by design (no Access, no dashboard change) |
| dash.khe.ee         | homepage:3000               | homepage:3000               | CF Access (external only) |
| vault.khe.ee        | vaultwarden:80              | vaultwarden:80              | |
| photos.khe.ee       | immich-server:2283          | immich-server:2283          | NPM: unlimited upload, 600s timeout |
| status.khe.ee       | uptime-kuma:3001            | uptime-kuma:3001            | |
| games.khe.ee        | study-game:80 (→ games)     | — (CF only)                 | no AdGuard rewrite; alias in games compose until route updated to games:80 |
| trips.khe.ee        | trips:80                    | — (CF Access)               | CF Access OTP on all networks; no AdGuard rewrite |
| draft.khe.ee        | draft:8080                  | — (CF Access)               | dufs editor; CF Access OTP on all networks; **sole auth layer** (dufs runs without `--auth`, see service-choices.md); only on `draft-tunnel`; no AdGuard rewrite |
| pages.khe.ee        | pages:80                    | — (CF only)                 | public; serves published pages read-only; no AdGuard rewrite |

Not exposed via tunnel (LAN only): AdGuard (:8080), NPM admin (:81), Proxmox (:8006)

## Cloudflare Access

Zero Trust → Access → Applications.
Identity: One-time PIN via email (no OAuth setup needed).

| Application  | Domain  | Policy          |
|--------------|---------|-----------------|
| KHE Dashboard | dash.khe.ee | Email allowlist + Require Country=EE |
| KHE Trips    | trips.khe.ee | Email allowlist + Require Country=EE |
| KHE Pages    | draft.khe.ee | Email allowlist + Require Country=EE |

All three apps share a single reusable policy (edit once → applies to all).
Policy combines `Include: Email = owner` AND `Require: Countries = Estonia`.
Owner traveling abroad connects via Tailscale → egresses through VM's EE IP → passes both checks.
If Tailscale is down while abroad, access is blocked — intentional two-factor (identity + location).

`draft.khe.ee` has no application-level login behind Access (dufs runs
without `--auth`), so removing or loosening its Access application exposes the
editor outright.

## Custom Login Page

Zero Trust → Reusable components → Custom pages → Access login page.
Applies to all Access-protected apps (dash, trips, draft).

| Field | Value |
|-------|-------|
| Organization's name | `KHE Homelab` |
| Logo URL | `https://khe.ee/logo.svg` (served by landing container, bind-mounted from `services/apps/landing/site/`) |
| Header text | `Access limited to homelab owner.` |
| Message | `Sign in with your authorized email to receive a one-time code. All access attempts are logged.` |
| Background color | `#09090b` (matches landing page `--bg`) |

Logo is a standalone SVG matching the landing page monogram (indigo 15% → violet 5% tint on `#09090b`, violet 25% border, Inter 600 white "KHE" text).

## WAF Custom Rules

Security → Security rules → Custom rules. Free plan: 5 rule slots, 4 in use.

| # | Name | Expression | Action | Purpose |
|---|------|-----------|--------|---------|
| 1 | Block known scanner paths | `(http.request.uri.path contains "/.env") or (.../.git/) or (.../wp-login) or (.../wp-admin) or (.../wp-content) or (.../xmlrpc.php) or (.../phpmyadmin) or (.../.aws/) or (.../.ssh/)` | Block | Drops WP/PHP/env scanner noise before origin |
| 2 | Challenge high-risk countries | `(ip.geoip.country in {"RU" "CN" "KP" "IR" "BY"}) and (http.host ne "khe.ee")` | Managed Challenge | CAPTCHA for bots; apex exempted so UptimeRobot still works |
| 3 | Challenge non-browser UAs on public apps | `(http.host in {"photos" "vault" "status" ".khe.ee"}) and (lower(http.user_agent) contains "curl"/"wget"/"python-requests"/"go-http-client"/"scrapy" or http.user_agent eq "")` | Managed Challenge | Stops naive scraper CLIs on non-Access-protected subdomains; mobile apps send their own UAs so unaffected |
| 4 | Block Vaultwarden admin | `(http.host eq "vault.khe.ee") and starts_with(http.request.uri.path, "/admin")` | Block | The admin panel is never needed from the internet; LAN reaches it through NPM, which the tunnel never touches. `ADMIN_TOKEN` stays an argon2 hash as the second layer |

Also enabled:
- Bot Fight Mode: ON (+ JS Detections)
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
All *.khe.ee records are CNAME → tunnel (proxied).
`www` is CNAME → `khe.ee` (proxied), handled by redirect rule below.
Split-horizon: local DNS via AdGuard rewrites *.khe.ee → 192.168.0.11.
Router DHCP DNS: 192.168.0.11 (AdGuard) ONLY — never advertise a secondary.
Clients race both servers in parallel (happy-eyeballs) and Cloudflare would
win most races, silently bypassing ad/tracker filtering. Upstream DoH
(Cloudflare/Quad9) happens inside AdGuard, not via DHCP. See CLAUDE.md.

## Redirect Rules

Rules → Redirect Rules.

| Rule name    | Match                       | Action                                                       |
|--------------|-----------------------------|--------------------------------------------------------------|
| www to apex  | Hostname equals www.khe.ee  | 301 → `concat("https://khe.ee", http.request.uri.path)`, preserve query |
