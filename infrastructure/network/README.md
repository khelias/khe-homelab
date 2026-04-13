# Network Architecture

## Local Network
- Router: Asus RT-AX55 (192.168.0.1, SSID: KaidoMaj)
- Subnet: 192.168.0.0/24
- DHCP range: 192.168.0.100–254 (static devices below .100)
- Proxmox host: 192.168.0.10
- Docker VM: 192.168.0.11
- Connection: CAT5e/CAT6 gigabit LAN

## DNS Strategy (Split-Horizon)
- **External**: Cloudflare DNS for khe.ee → Cloudflare Tunnel
- **Internal**: AdGuard Home as local DNS, rewrites *.khe.ee → server local IP
  - This means local traffic stays local (no hairpin NAT needed)

## Subdomains
| Subdomain          | Service              | Port  |
|--------------------|----------------------|-------|
| khe.ee             | Homepage (dashboard) | 3000  |
| cloud.khe.ee       | Nextcloud            | 8888  |
| photos.khe.ee      | Immich               | 2283  |
| vault.khe.ee       | Vaultwarden          | 80    |
| jellyfin.khe.ee    | Jellyfin             | 8096  |
| docs.khe.ee        | Paperless-ngx        | 8010  |
| books.khe.ee       | Audiobookshelf       | 13378 |
| n8n.khe.ee         | n8n                  | 5678  |
| dockge.khe.ee      | Dockge               | 5001  |
| adguard.khe.ee     | AdGuard Home         | 8080  |
| status.khe.ee      | Uptime Kuma          | 3001  |

## Cloudflare Tunnel
- Zero Trust tunnel handles all external traffic
- No ports opened on router
- SSL/TLS: Full (strict) on Cloudflare
