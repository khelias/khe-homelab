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
| games.khe.ee        | study-game:80               | — (CF only)                 | no AdGuard rewrite |
| openclaw.khe.ee     | openclaw:18789              | — (CF Access)               | CF Access OTP on all networks |

Not exposed via tunnel (LAN only): AdGuard (:8080), Dockge (:5001), NPM admin (:81), Proxmox (:8006)

## Cloudflare Access

Zero Trust → Access → Applications.
Identity: One-time PIN via email (no OAuth setup needed).

| Application  | Domain  | Policy          |
|--------------|---------|-----------------|
| KHE Dashboard | dash.khe.ee | Email allowlist (owner only) |
| n8n          | n8n.khe.ee  | Email allowlist (owner only) |
| OpenClaw     | openclaw.khe.ee | Email allowlist (owner only) |

## DNS

Zone: khe.ee
All *.khe.ee records are CNAME → tunnel (proxied).
`www` is CNAME → `khe.ee` (proxied), handled by redirect rule below.
Split-horizon: local DNS via AdGuard rewrites *.khe.ee → 192.168.0.11.
Router DNS: primary 192.168.0.11 (AdGuard), fallback 1.1.1.1.

## Redirect Rules

Rules → Redirect Rules.

| Rule name    | Match                       | Action                                                       |
|--------------|-----------------------------|--------------------------------------------------------------|
| www to apex  | Hostname equals www.khe.ee  | 301 → `concat("https://khe.ee", http.request.uri.path)`, preserve query |
