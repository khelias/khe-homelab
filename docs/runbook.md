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
host resources, the NFS mounts, pending OS updates and due reboots on the VM
and the Proxmox host, LAN IP and gateway, DNS, outbound
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

## Symptom: every deploy fails on `git pull --ff-only`

The VM checkout `/home/khe/homelab` has local changes, almost always files
copied in by hand for a quick test. Deploy refuses to pull over them, and
every later push fails in the same way until the tree is clean. On the VM:

```bash
cd /home/khe/homelab && git status --short
```

Stash tracked changes (`git stash push -m drift`), remove the stray untracked
files one by one, then `git pull --ff-only` and rerun the deploy:

```bash
gh workflow run deploy.yml --repo khelias/khe-homelab -f mode=changed
```

To test something before committing, copy it to `/tmp` on the VM, not into
the checkout. The runner's own work directory under `actions-runner-homelab/`
is not the deploy checkout.

## After `main` was rewritten

A history rewrite is an operator decision (khe-meta ADR-006). Do not re-clone
the VM checkout, because the gitignored `.env` files would go with it. Check
first that the rewrite kept the file tree: compare `git rev-parse
HEAD^{tree}` on the VM with the new `origin/main^{tree}`. If they match,
`git fetch origin && git reset --hard origin/main` on the VM leaves every
tracked file and every `.env` as it was.

## Estate app deploy

A push to `main` of `khe-ai-adventure` deploys itself: its CI builds and
publishes both images, the `Pin homelab` job opens (or updates) the PR from
`deploy/khe-ai-adventure` here with the new digests and turns on auto-merge,
`validate.yml` passes, the PR merges and `deploy.yml` recreates both
containers. Push to live took under 7 minutes the first time (khe-meta
ADR-008 "Observed"). Step 1's "Estate images" section shows the commit each
container runs.

When it stalls, look in this order:

1. The adventure CI run for the push, job `Pin homelab`. A notice there
   explains a skip: no App secrets, `:main` has moved to a newer commit, a pin
   is a `sha-` rollback, or the pins are already current. A failed job is
   rerun with `gh run rerun <run-id> --repo khelias/khe-ai-adventure --failed`;
   it is safe, because it only ever pins what `:main` points at.
2. The open PR from `deploy/khe-ai-adventure`, its `Compose and Dockerfile
   validation` log.
3. The `deploy.yml` run for the merge.

**Rollback:** pin both images to the same `sha-<full commit>@sha256:<digest>`
([AGENTS.md](../AGENTS.md)) and push. The pin job leaves a `sha-` pin alone,
so pushes to adventure do not deploy until the pins go back to
`:main@sha256:<current>`.

**A red "Pin App PRs change pins only" step** means the pin App's PR, or a
branch the App pushed to, changes something other than its own `:main@`
digests. The pin script never does that, so treat it as a compromised
adventure repo or App key: close the PR, do not merge it by hand, and rotate
the App's private key (below). **A red "Estate images are attested and paired"** on
any PR means a pinned `ghcr.io/khelias/*` digest was not built by its repo's
`ci.yml` on `main`, or the images of one repo come from different commits.

**Rotating the pin App's key.** GitHub App keys do not expire, so this is
done on suspicion, not on a schedule: a red guard step, a lost or compromised
machine, or a `.pem` left somewhere it should not be.

1. On <https://github.com/settings/apps/khe-adventure-pins>, "Generate a
   private key". The old key keeps working until it is deleted, so deploys do
   not stop in between.
2. Store the new key in the adventure environment:

   ```bash
   gh secret set HOMELAB_PIN_PRIVATE_KEY -R khelias/khe-ai-adventure --env homelab-pin < <new .pem>
   ```

3. Prove it: rerun the `Pin homelab` job of the latest adventure CI run
   (`gh run rerun <run-id> --repo khelias/khe-ai-adventure --job <job-id>`).
   GHCR's `main` is still that commit, so the job mints a token with the new
   key and ends with the "already current" notice, changing nothing.
4. Delete the old key on the App page. Move the new `.pem` to wherever keys
   are kept and remove it from the download folder.

On a suspected compromise, delete the old key first and accept that pins
stop until step 2 is done.

## OS updates and reboots

What updates itself, on both machines through `unattended-upgrades` and never
with an automatic reboot:

- **Docker VM:** Debian security updates (Debian's default origins). Docker CE
  and Tailscale come from their own repositories and wait for the monthly
  catch-up.
- **Proxmox host:** Debian security updates only
  (`/etc/apt/apt.conf.d/52khe-security-only`, written by
  `scripts/setup-proxmox-updates.sh`). Proxmox packages and kernels are
  upgraded by hand.

**How you know.** `scripts/os-status.sh` runs daily at 07:00 and five minutes
after each boot (`khe-os-status.timer`) on both machines and writes
`os-status-pve-host.json` and `os-status-vm.json` into
`/srv/data/reports/khe/internal/`. Step 1's "OS updates" section and the
Monday Telegram report ("Proxmox: ...", "Docker VM: ...") read them: pending
updates, a due reboot, or "not reported" when a file is missing or older than
48 h. On the host a due reboot means the newest installed kernel is not the
running one, so a kernel pinned to an older version reads as "reboot due"
until it is unpinned.

**The monthly catch-up**, when the Telegram lines show updates or a reboot due.
A night after 23:00: AdGuard is the LAN's only DNS, so the reboots take the
whole household offline for about ten minutes. SSH from the LAN, not over
Tailscale, and work inside `tmux` on each machine, one block at a time:

1. host: `qm snapshot 100 pre-update-$(date +%F)`
2. VM: `sudo apt update`, then `sudo apt full-upgrade` (Docker and Tailscale
   restart during it; the LAN session and `tmux` survive)
3. host: `apt update`, then `apt full-upgrade` (never `apt upgrade` on
   Proxmox, it can leave the system half-upgraded)
4. host: `qm shutdown 100 --timeout 300`, then `qm status 100` reads `stopped`
5. host: `qm config 100 | grep onboot` reads `onboot: 1`, then `reboot`
6. Step 1 once the VM is up: no reboot due, nothing pending, both NFS mounts
   OK. A day later, if nothing misbehaved: `qm delsnapshot 100
   pre-update-<date>`.

Never `zpool upgrade` in this window: a pool upgraded for the new kernel's ZFS
cannot be imported by the older kernel a rollback would boot.

**All containers down after a boot.** Docker waits for the NFS mounts
(`RequiresMountsFor=/srv/data /srv/backups`, from `scripts/setup-vm-updates.sh`)
rather than starting on the VM disk's empty `/srv/data`. If the host's NFS
server was not up in time, Docker does not start at all. Step 1 shows `/srv/data
is not mounted` and the Docker daemon unreachable. Once the host is up, on the
VM: `sudo mount -a && sudo systemctl start docker`. Unmounting `/srv/data` by
hand stops Docker too, for the same reason.

**The host does not come back on a new kernel.** The host's screen shows only
the GRUB menu: `i915` is blacklisted and the iGPU is bound to `vfio-pci`, so
the console goes dark after boot. With a monitor and keyboard on the host,
pick the previous kernel under "Advanced options" in GRUB. Once it is up,
`proxmox-boot-tool kernel pin <version>` keeps it, and
`proxmox-boot-tool kernel unpin` releases it when a fixed kernel lands. If VM
100 is not running five minutes after the host is back, read its task log in
the web UI.

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
