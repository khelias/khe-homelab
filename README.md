# khe-homelab

[![CI](https://github.com/khelias/khe-homelab/actions/workflows/validate.yml/badge.svg)](https://github.com/khelias/khe-homelab/actions/workflows/validate.yml)
[![Deploy](https://github.com/khelias/khe-homelab/actions/workflows/deploy.yml/badge.svg)](https://github.com/khelias/khe-homelab/actions/workflows/deploy.yml)

The family homelab as code: self-hosted photos, passwords, family apps and
home automation on one machine, with Docker Compose on Proxmox VE, for one
household. It serves [khe.ee](https://khe.ee), and its shape is drawn on
[khe.ee/architecture](https://khe.ee/architecture/).

## How it works

One Proxmox VE host runs one Debian VM, and every service on it is a Docker
Compose stack under [`services/`](services/): core (proxy, DNS, tunnel,
passwords, monitoring, dashboard), media (Immich), home (Home Assistant with
its MQTT broker and alarm bridge), apps (the family's web apps) and
observability (logs and alerts). The internet reaches the containers through
Cloudflare Tunnel, with Cloudflare Access in front of the private apps; at
home and over Tailscale the same names go through Nginx Proxy Manager, which
AdGuard's split-horizon DNS points them at. The router forwards no ports.

The diagram, the services with their domains, and the automation are in
[ARCHITECTURE.md](ARCHITECTURE.md); the access model is in
[SECURITY.md](SECURITY.md#access-model).

### Resilience

Six layers, each catching what the others miss; how each works is in
[ARCHITECTURE.md](ARCHITECTURE.md#resilience).

1. A hardware watchdog resets the VM when its kernel hangs.
2. An autoheal sidecar restarts a container whose healthcheck turns unhealthy.
3. Compose resource limits keep one runaway service from taking the VM.
4. Uptime Kuma pushes a Telegram alert when a service goes down.
5. External UptimeRobot alerts when the whole homelab is unreachable.
6. A Cloudflare Worker serves a static copy of khe.ee and games.khe.ee while
   the homelab is down.

## Run it

A push to `main` is the deploy: the homelab's own runner pulls the repo on
the VM and deploys the stacks that changed. By hand, on the VM:

```bash
./scripts/deploy.sh status   # What's running?
./scripts/deploy.sh up       # (Re)start everything
./scripts/backup.sh          # Backup databases + configs
```

When something is broken, start at [docs/runbook.md](docs/runbook.md).
Building the host and the VM from scratch is in
[infrastructure/proxmox/](infrastructure/proxmox/README.md#building-it-from-scratch).

## More

- [ARCHITECTURE.md](ARCHITECTURE.md) - the diagram, services and automation
- [docs/runbook.md](docs/runbook.md) - what to do when something is broken
- [docs/operational-notes.md](docs/operational-notes.md) - per-service quirks
- [docs/service-choices.md](docs/service-choices.md) - why each service
- [infrastructure/](infrastructure/) - Proxmox, network, Cloudflare, Tailscale, offsite backup,
  [agent-vm](infrastructure/agent-vm.md) (the workspace agent's VM)
- [SECURITY.md](SECURITY.md), [ROADMAP.md](ROADMAP.md)
- [AGENTS.md](AGENTS.md) - layout and conventions for working on the repo; the Home
  Assistant configuration is in [khe-home-assistant](https://github.com/khelias/khe-home-assistant)

## Licence

MIT, see [LICENSE](LICENSE).
