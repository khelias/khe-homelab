# Tailscale VPN

Mesh VPN for remote access to the homelab. Installed on the Docker VM host (not as a container)
because it needs to provide SSH access to the VM itself and advertise subnet routes.

## Setup

Installed on Docker VM (192.168.0.11) via official apt repo:

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --advertise-routes=192.168.0.0/24 --accept-dns=false
```

IP forwarding enabled for subnet routing:

```bash
# /etc/sysctl.d/99-tailscale.conf
net.ipv4.ip_forward = 1
net.ipv6.conf.all.forwarding = 1
```

Subnet routes (192.168.0.0/24) must be approved in the Tailscale admin console:
https://login.tailscale.com/admin/machines → docker-vm → Edit route settings.

## Why host install, not Docker?

- SSH access to the VM itself requires host-level networking
- Subnet routing needs host network stack and IP forwarding
- Survives Docker daemon restarts
- Tailscale recommends host install for servers

## Network Details

| Node      | OS    | Role                        |
|-----------|-------|-----------------------------|
| docker-vm | Linux | Server, subnet router       |
| mac       | macOS | Client                      |
| iphone    | iOS   | Client                      |

Subnet route: 192.168.0.0/24 → via docker-vm
MagicDNS: `docker-vm` resolves automatically.

## Remote Access

From any Tailscale-connected device:

```bash
# SSH to Docker VM
ssh khe@docker-vm

# Proxmox web UI
https://192.168.0.10:8006

# LAN-only services (via subnet routing)
http://192.168.0.11:5001    # Dockge
http://192.168.0.11:8080    # AdGuard Home
http://192.168.0.11:81      # NPM admin
```

## Flags

- `--advertise-routes=192.168.0.0/24`: expose entire LAN to Tailscale network
- `--accept-dns=false`: keep using AdGuard as DNS, don't override with Tailscale DNS.
  **This applies to the VM only.** The VM is the subnet router and the host
  AdGuard runs on; if it accepted the tailnet resolver it would point at itself
  through the tunnel.

## Client DNS

Clients are the opposite case. The tailnet (admin console -> DNS) carries a
**split-DNS route `khe.ee` -> docker-vm's Tailscale address** (AdGuard), with
"Override local DNS" off and no global nameserver. A client with "Use Tailscale
DNS" **enabled** therefore resolves `*.khe.ee` LAN names to `192.168.0.11`
from anywhere and reaches them over the subnet route, while every other query
follows the local network or an active work VPN (FortiClient, UniFi) - the
reason for split rather than override, decided 2026-09-12. With it disabled the client keeps the local network's DNS: at
home that is still AdGuard via DHCP, but on mobile data or a foreign Wi-Fi the
LAN names simply do not resolve while the IPs stay reachable - which looks like
"Tailscale is connected but nothing works" (seen 2026-09-12 on the Mac).

- iOS/Android: Tailscale DNS is on by default.
- macOS: `Tailscale set --accept-dns=true`
  (binary at `/Applications/Tailscale.app/Contents/MacOS/Tailscale`);
  `Tailscale dns status` shows what the coordination server pushes.

## Account

Admin console: https://login.tailscale.com/admin (login details in Vaultwarden).
