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

| Node      | Tailscale IP    | OS    | Role                        |
|-----------|-----------------|-------|-----------------------------|
| docker-vm | 100.71.186.32   | Linux | Server, subnet router       |
| mac       | 100.126.136.127 | macOS | Client                      |

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
- `--accept-dns=false`: keep using AdGuard as DNS, don't override with Tailscale DNS

## Account

Login: kaidoelias@ (same as Tailscale admin console)
Admin: https://login.tailscale.com/admin
