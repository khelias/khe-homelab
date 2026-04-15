# Cloudflare Configuration

Configuration lives in the Cloudflare dashboard (dash.cloudflare.com).
Not managed as code — document changes here manually.

## Tunnel: khe-homelab

Token stored in VM at `/home/khe/homelab/services/core/cloudflare-tunnel/.env`.
Routing is configured in Zero Trust → Networks → Tunnels → khe-homelab → Public Hostnames.
NPM is not used for routing — the tunnel routes directly to Docker containers.

| Domain              | Service (internal)          | Port |
|---------------------|-----------------------------|------|
| khe.ee              | homepage                    | 3000 |
| cloud.khe.ee        | nextcloud                   | 80   |
| vault.khe.ee        | vaultwarden                 | 80   |
| docs.khe.ee         | paperless                   | 8000 |
| photos.khe.ee       | immich-server               | 2283 |
| jellyfin.khe.ee     | jellyfin                    | 8096 |
| books.khe.ee        | audiobookshelf              | 80   |
| n8n.khe.ee          | n8n                         | 5678 |
| status.khe.ee       | uptime-kuma                 | 3001 |
| games.khe.ee        | study-game                  | 80   |

Not exposed via tunnel (LAN only): AdGuard (:8080), Dockge (:5001), NPM admin (:81), Proxmox (:8006)

## Cloudflare Access

Zero Trust → Access → Applications.
Identity: One-time PIN via email (no OAuth setup needed).

| Application  | Domain  | Policy          |
|--------------|---------|-----------------|
| KHE Homepage | khe.ee  | Email: kaidoelias@gmail.com |

## DNS

Zone: khe.ee
All *.khe.ee records are CNAME → tunnel (proxied).
Split-horizon: local DNS via AdGuard rewrites *.khe.ee → 192.168.0.11.
Router DNS: primary 192.168.0.11 (AdGuard), fallback 1.1.1.1.
