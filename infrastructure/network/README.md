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
- **Internal**: AdGuard Home as local DNS, rewrites *.khe.ee → 192.168.0.11
  - Local traffic stays local (no hairpin NAT)
  - Router DNS: 192.168.0.11 (primary) + 1.1.1.1 (fallback) — ACTIVE

## Cloudflare Tunnel Routing

The tunnel routes directly to Docker containers. LAN traffic goes via NPM.
See `../cloudflare.md` for the authoritative routing table.

| Domain              | Container           | Port  |
|---------------------|---------------------|-------|
| khe.ee              | landing             | 80    |
| dash.khe.ee         | homepage            | 3000  |
| cloud.khe.ee        | nextcloud           | 80    |
| vault.khe.ee        | vaultwarden         | 80    |
| docs.khe.ee         | paperless           | 8000  |
| photos.khe.ee       | immich-server       | 2283  |
| jellyfin.khe.ee     | jellyfin            | 8096  |
| books.khe.ee        | audiobookshelf      | 80    |
| n8n.khe.ee          | n8n                 | 5678  |
| status.khe.ee       | uptime-kuma         | 3001  |
| games.khe.ee        | study-game          | 80    |
| openclaw.khe.ee     | openclaw            | 18789 |

## LAN-Only Services (not exposed via tunnel)

| Service             | IP:Port                  |
|---------------------|--------------------------|
| AdGuard Home        | 192.168.0.11:8080        |
| Dockge              | 192.168.0.11:5001        |
| Nginx Proxy Manager | 192.168.0.11:81 (admin)  |
| Proxmox             | 192.168.0.10:8006        |

## Remote Access (Tailscale VPN)

Tailscale mesh VPN on the Docker VM provides remote access to the entire LAN.
See `../tailscale.md` for setup details.

- SSH: `ssh khe@docker-vm` (MagicDNS)
- Subnet route: 192.168.0.0/24 → all LAN services accessible remotely
- No open ports on the router
