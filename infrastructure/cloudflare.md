# Cloudflare Configuration

Configuration lives in the Cloudflare dashboard (dash.cloudflare.com).
Not managed as code — document changes here manually.

## Tunnel: khe-homelab

Token stored in VM at `/home/khe/homelab/services/core/cloudflare-tunnel/.env`.
Routing is configured in Zero Trust → Networks → Tunnels → khe-homelab → Public Hostnames.
Tunnel routes directly to Docker containers. LAN traffic goes via NPM (split-horizon DNS).

| Domain              | CF Tunnel → (external)      | NPM → (LAN)                | Notes |
|---------------------|-----------------------------|-----------------------------|-------|
| khe.ee              | landing:80                  | landing:80                  | public |
| dash.khe.ee         | homepage:3000               | homepage:3000               | CF Access (external only) |
| cloud.khe.ee        | nextcloud:80                | nextcloud:80                | NPM: 16G upload, 600s timeout |
| vault.khe.ee        | vaultwarden:80              | vaultwarden:80              | |
| docs.khe.ee         | paperless:8000              | paperless:8000              | NPM: unlimited upload, 300s timeout |
| photos.khe.ee       | immich-server:2283          | immich-server:2283          | NPM: unlimited upload, 600s timeout |
| jellyfin.khe.ee     | jellyfin:8096               | jellyfin:8096               | NPM: unlimited body, 600s timeout |
| books.khe.ee        | audiobookshelf:80           | audiobookshelf:80           | NPM: unlimited upload, 600s timeout |
| n8n.khe.ee          | n8n:5678                    | — (CF Access)               | CF Access OTP on all networks |
| status.khe.ee       | uptime-kuma:3001            | uptime-kuma:3001            | |
| games.khe.ee        | study-game:80 (→ games)     | — (CF only)                 | no AdGuard rewrite; alias in games compose until route updated to games:80 |
| openclaw.khe.ee     | openclaw:18789              | — (CF Access)               | CF Access OTP on all networks |
| trips.khe.ee        | trips:80                    | — (CF Access)               | CF Access OTP on all networks; no AdGuard rewrite |

Not exposed via tunnel (LAN only): AdGuard (:8080), Dockge (:5001), NPM admin (:81), Proxmox (:8006)

## Cloudflare Access

Zero Trust → Access → Applications.
Identity: One-time PIN via email (no OAuth setup needed).

| Application  | Domain  | Policy          |
|--------------|---------|-----------------|
| KHE Dashboard | dash.khe.ee | Email allowlist + Require Country=EE |
| n8n          | n8n.khe.ee  | Email allowlist + Require Country=EE |
| OpenClaw     | openclaw.khe.ee | Email allowlist + Require Country=EE |
| KHE Trips    | trips.khe.ee | Email allowlist + Require Country=EE |

All four apps share a single reusable policy (edit once → applies to all).
Policy combines `Include: Email = owner` AND `Require: Countries = Estonia`.
Owner traveling abroad connects via Tailscale → egresses through VM's EE IP → passes both checks.
If Tailscale is down while abroad, access is blocked — intentional two-factor (identity + location).

## Custom Login Page

Zero Trust → Reusable components → Custom pages → Access login page.
Applies to all Access-protected apps (dash, n8n, openclaw, trips).

| Field | Value |
|-------|-------|
| Organization's name | `KHE Homelab` |
| Logo URL | `https://khe.ee/logo.svg` (served by landing container, bind-mounted from `services/apps/landing/site/`) |
| Header text | `Access limited to homelab owner.` |
| Message | `Sign in with your authorized email to receive a one-time code. All access attempts are logged.` |
| Background color | `#09090b` (matches landing page `--bg`) |

Logo is a standalone SVG matching the landing page monogram (indigo 15% → violet 5% tint on `#09090b`, violet 25% border, Inter 600 white "KHE" text).

## WAF Custom Rules

Security → Security rules → Custom rules. Free plan: 5 rule slots, 3 in use.

| # | Name | Expression | Action | Purpose |
|---|------|-----------|--------|---------|
| 1 | Block known scanner paths | `(http.request.uri.path contains "/.env") or (.../.git/) or (.../wp-login) or (.../wp-admin) or (.../wp-content) or (.../xmlrpc.php) or (.../phpmyadmin) or (.../.aws/) or (.../.ssh/)` | Block | Drops WP/PHP/env scanner noise before origin |
| 2 | Challenge high-risk countries | `(ip.geoip.country in {"RU" "CN" "KP" "IR" "BY"}) and (http.host ne "khe.ee")` | Managed Challenge | CAPTCHA for bots; apex exempted so UptimeRobot still works |
| 3 | Challenge non-browser UAs on public apps | `(http.host in {"photos" "cloud" "books" "jellyfin" "docs" "vault" "status" ".khe.ee"}) and (lower(http.user_agent) contains "curl"/"wget"/"python-requests"/"go-http-client"/"scrapy" or http.user_agent eq "")` | Managed Challenge | Stops naive scraper CLIs on non-Access-protected subdomains; mobile apps send their own UAs so unaffected |

Also enabled:
- Bot Fight Mode: ON (+ JS Detections)
- Block AI bots: "Block on all pages" (stops GPTBot/ClaudeBot/etc. training crawlers)
- Security Level: automated ("always protected" — the old slider was removed by CF)

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
