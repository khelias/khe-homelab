# Runbook

What to do when something is broken. Written to be followed without knowing
how any of this works internally.

Two rules before anything else:

1. **Diagnose before acting.** Restarting the wrong thing wastes time and can
   make a partial outage total. Step 1 below tells you what is actually wrong.
2. **Never edit anything directly on the VM.** Every change goes through git,
   or the next deploy silently reverts it. See
   [operational-notes](operational-notes.md) for the exceptions (AdGuard's live
   YAML, NPM's database), which are deliberate and documented.

## Step 1: always start here

```bash
gh workflow run ops-status.yml --repo khelias/khe-homelab
```

Wait about a minute, then read the result:

```bash
gh run list --repo khelias/khe-homelab --workflow ops-status.yml --limit 1
gh run view <run-id> --repo khelias/khe-homelab --log
```

This is read-only and safe to run at any time, as often as you like. It reports
host resources, pending OS updates, LAN IP and gateway, DNS, outbound
connectivity, container health, OOM kills, and whether the public side actually
works through Cloudflare.

If it will not run at all, the runner is offline, which itself is a finding:
jump to "Nothing responds" below.

## Symptom: public sites are down, but the LAN works

Typical sign: `khe.ee` fails from your phone on mobile data, but works from
home Wi-Fi. Confirm what Cloudflare says:

```bash
curl -sS -o /dev/null -w '%{http_code}\n' -A 'Mozilla/5.0' https://khe.ee
```

Send a browser User-Agent as shown, or WAF custom rule 3 answers `403` and the
diagnosis goes the wrong way.

- **`530`** means the tunnel is not registered with the Cloudflare edge. This
  is not a per-service fault; every hostname will be failing. Run step 1 and
  look at the network checks. The usual causes, in order of likelihood: the VM
  has no outbound path (router, DHCP, DNS), or the `cloudflare-tunnel`
  container is not running.
- **`403`** with a browser UA means WAF or Access is blocking, not the origin.
  Cloudflare dashboard, not the VM.
- **`502` / `504`** means the tunnel is up but the container behind that
  hostname is not answering. Treat it as a single-service fault below.

To restart just the tunnel:

```bash
gh workflow run deploy.yml --repo khelias/khe-homelab \
  -f mode=changed -f stack=services/core/cloudflare-tunnel -f force_recreate=true -f dry_run=false
```

## Symptom: one service is down

Run step 1 first and look for that container under `unhealthy`, `restarting`,
or `exited`. Then redeploy only that stack, using its path under `services/`:

```bash
gh workflow run deploy.yml --repo khelias/khe-homelab \
  -f mode=changed -f stack=services/media/immich -f force_recreate=true -f dry_run=false
```

If it comes back unhealthy again, the cause is in the service, not the deploy.
Check that service's entry in [operational-notes](operational-notes.md) before
changing anything; most recurring faults there are already documented, with the
memory limits and config keys that caused them.

## Symptom: nothing responds, not even the LAN

This is the one case where GitHub Actions cannot help: if the VM has no network,
the runner is offline too, and so is SSH. Use the hypervisor, which is reachable
independently:

**Proxmox web UI: `https://192.168.0.10:8006`** -> select the Docker VM ->
Console. That gives you a login prompt on the machine itself, in the browser,
even when its networking is broken.

From there the useful first commands are:

```bash
ip addr                 # does the VM have 192.168.0.11?
ip route                # is there a default route via 192.168.0.1?
ping -c3 1.1.1.1        # is there a path out at all?
docker ps --format '{{.Names}}\t{{.Status}}'
```

If the VM is wedged entirely (no console response), the Proxmox UI can force a
reset. The hardware watchdog also handles this automatically, see
[README](../README.md) resilience section.

## Symptom: things are slow, or a deploy fails on disk space

```bash
gh workflow run runner-maintenance.yml --repo khelias/khe-homelab -f aggressive=false
```

This prunes unused Docker images and build cache. It never touches volumes, so
application data is safe. Set `aggressive=true` only if the normal run did not
free enough.

## OS updates and reboots

Security updates install themselves through `unattended-upgrades`; nobody needs
to act. Two things do need a human:

- **Pending non-security updates.** Step 1 reports the count. Not urgent.
- **`OS reboot required`.** A kernel or libc update is installed but not active
  until reboot. Step 1 reports this too. Reboot at a quiet moment over SSH
  (`ssh khe@docker-vm`, via Tailscale) or from the Proxmox console. Containers
  come back on their own, since every stack uses `restart: unless-stopped`.

## Before you restore from backup

Restoring is the last resort, not a diagnostic step. Confirm what is actually
lost first; a container that will not start is almost never a data loss problem.
Backups and their verification are described in
[infrastructure/offsite-backup.md](../infrastructure/offsite-backup.md).

## Where the knowledge lives

- **What broke and why, per service** -> [operational-notes.md](operational-notes.md)
- **Why we run this software at all** -> [service-choices.md](service-choices.md)
- **Tunnel routes, Access policies, WAF rules** -> [infrastructure/cloudflare.md](../infrastructure/cloudflare.md)
- **LAN, DNS, AdGuard** -> [infrastructure/network/](../infrastructure/network/)
- **Architecture, resilience layers, day-to-day ops** -> [README.md](../README.md)
