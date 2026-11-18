# KHE Homelab

The family homelab as code: self-hosted photos, passwords, family apps and
home automation on one machine, with Docker Compose on Proxmox VE.

## How it fits together

One Proxmox VE host runs one Debian VM, and every service on it is a Docker
Compose stack under [`services/`](services/): core (proxy, DNS, tunnel,
passwords, monitoring, dashboard), media (Immich), home (Home Assistant with
its MQTT broker and alarm bridge), apps (the family's web apps) and
observability (logs and alerts). The internet reaches the containers through
Cloudflare Tunnel, with Cloudflare Access in front of the private apps; at
home and over Tailscale the same names go through Nginx Proxy Manager, which
AdGuard's split-horizon DNS points them at. The router forwards no ports.

The diagram, the services with their domains, and the automation are in
[docs/architecture.md](docs/architecture.md); the access model is in
[SECURITY.md](SECURITY.md#access-model).

## Resilience

Six layers, each catching what the others miss:

1. **Kernel hang: hardware watchdog.** The Docker VM runs the `watchdog` daemon
   pinging `/dev/watchdog` (Proxmox-emulated iTCO, 30s hardware timeout). If the
   kernel wedges (OOM, I/O lock, driver bug), the hypervisor force-resets the
   VM and Proxmox boots it back up. Conservative config: only pings the device,
   no load/memory/network checks (those cause false-positive reboots on blips).
2. **Unhealthy container: autoheal sidecar.** `willfarrell/autoheal` talks to a
   narrow-scope `docker-socket-proxy` and restarts
   any container whose Docker healthcheck reports `unhealthy`. Fills the gap
   left by `restart: unless-stopped`, which only reacts to full crashes. This
   caught a stuck immich-ml worker the day it was deployed.
3. **Runaway service: Compose resource limits.** Every long-running container
   has conservative memory and CPU limits in its `docker-compose.yml`; media
   and database workloads get larger caps than static web services. This
   keeps one bad process from consuming the whole VM.
4. **Service down: Uptime Kuma + Telegram push.** Kuma watches the services
   with HTTP/DNS monitors and takes push heartbeats from the backups and the OS
   update reports; all notify the same Telegram bot (`@khe_homelab_bot`).
   Alert lands on the owner's phone within ~90s. Kuma
   DB is in `backup.sh`, so monitor + notification config survives a VM rebuild.
5. **Whole homelab down: external UptimeRobot.** Pings `khe.ee/healthz`
   every 5 min from outside the home network, pushes to the UptimeRobot iOS
   app. The only layer that can notify when the VM, Proxmox, or the home
   internet itself is unreachable (when layers 1–4 can't reach any network).
6. **Whole homelab down, static copy at the edge.** A Cloudflare Worker in
   front of `khe.ee` and `games.khe.ee` serves an hourly copy of the static
   sites when the homelab answers 5xx or not at all
   ([estate ADR-016](https://github.com/khelias/khe-architecture/blob/main/decisions/016-static-fallback-at-the-edge.md)). Visitors outside the home network still get the
   pages; the APIs and `/healthz` fail as they should, so layer 5 still
   alerts.

## Running it

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

- [docs/architecture.md](docs/architecture.md) - the diagram, services and automation
- [docs/runbook.md](docs/runbook.md) - what to do when something is broken
- [docs/operational-notes.md](docs/operational-notes.md) - per-service quirks
- [docs/service-choices.md](docs/service-choices.md) - why each service
- [infrastructure/](infrastructure/) - Proxmox, network, Cloudflare, Tailscale, offsite backup,
  [agent-vm](infrastructure/agent-vm.md) (the workspace agent's VM)
- [SECURITY.md](SECURITY.md), [ROADMAP.md](ROADMAP.md)
- [AGENTS.md](AGENTS.md) - layout and conventions for working on the repo; the Home
  Assistant configuration is in [khe-home-assistant](https://github.com/khelias/khe-home-assistant)
