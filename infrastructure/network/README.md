# Network Architecture

## Local Network
- Router: Asus RT-AX55 (192.168.0.1)
- Subnet: 192.168.0.0/24
- DHCP range: 192.168.0.100–254; the static block below .100 holds the
  infrastructure and the cameras
- Several house devices answer from inside the DHCP range rather than the
  static block, and Home Assistant addresses them by IP. They need router DHCP
  reservations; whether those exist is unverified
- Proxmox host: 192.168.0.10
- Docker VM: 192.168.0.11
- Connection: CAT5e/CAT6 gigabit LAN

## DNS Strategy (Split-Horizon)
- **External**: Cloudflare DNS for khe.ee → Cloudflare Tunnel
- **Internal**: AdGuard Home as local DNS, 10 `*.khe.ee` rewrites → 192.168.0.11
  - Local traffic stays local (no hairpin NAT)
  - Router DHCP DNS: 192.168.0.11 only, never a secondary. Clients race two
    servers in parallel and Cloudflare usually wins, which silently bypasses
    filtering. Upstream DoH happens inside AdGuard.

## Cloudflare Tunnel Routing

The tunnel routes directly to Docker containers; LAN traffic goes via NPM.
The routing table lives in [`../cloudflare.md`](../cloudflare.md) and is not
duplicated here.

## LAN-Only Services (not exposed via tunnel)

| Service             | IP:Port                  |
|---------------------|--------------------------|
| AdGuard Home        | 192.168.0.11:8080        |
| Dockge              | 192.168.0.11:5001        |
| Nginx Proxy Manager | 192.168.0.11:81 (admin)  |
| Proxmox             | 192.168.0.10:8006        |
| Grafana             | 192.168.0.11:3030        |
| Home Assistant      | 192.168.0.11:8123 (`home.khe.ee`) |

## Remote Access (Tailscale VPN)

Tailscale mesh VPN on the Docker VM provides remote access to the entire LAN.
See `../tailscale.md` for setup details.

- SSH: `ssh khe@docker-vm` (MagicDNS)
- Subnet route: 192.168.0.0/24 → all LAN services accessible remotely
- No open ports on the router
