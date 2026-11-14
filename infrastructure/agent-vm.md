# agent-vm: the workspace agent's home

A Debian 13 VM that runs the operator's own Claude Code agent, always on, so
the work does not depend on a laptop. `claude remote-control --spawn same-dir`
runs in `~/khe` (a clone of the khe-workspace root) under a systemd user unit
as `khe`. Sessions are reached from the Claude phone app, claude.ai and the
laptop's desktop app (as an SSH host), and a claude.ai Project's tasks run
there as local threads. The agent has the same rights as on the laptop
([estate ADR-023](https://github.com/khelias/khe-architecture/blob/main/decisions/023-agent-pushes-where-its-session-allows.md)):
push, PR, auto-merge, and ssh to `khe@docker-vm` for read-only diagnosis and
runbook steps. Why a VM and why Projects: [service-choices.md](../docs/service-choices.md#workspace-agent---agent-vm);
what it can reach: [SECURITY.md](../SECURITY.md#the-workspace-agent-agent-vm).
Its VM ID and address are in the private khe-meta `house/` network document.

2 vCPU, 6 GB, 40 GB, no passthrough. docker-vm's 16 GB is pinned on the host
by VFIO, so the host needs 6 GB free before the VM is created.

## Build order

1. **Proxmox UI shell, operator** (root on the host stays with the operator).
   Check the host has 6 GB free and what VM 101 "playground" is for. Then,
   with the values in place:

   ```bash
   VM_ID=<id> VM_NAME=agent-vm VM_IP=<address>/24 VM_SSH_PUBKEY='<public key>' \
     VM_CORES=2 VM_MEMORY=6144 VM_DISK_SIZE=40G ./scripts/create-vm.sh
   ```

   The script prints the key's fingerprint: compare it with the key's owner.
   Add a weekly `vzdump` job for the VM to a storage that is not exported to
   docker-vm, and not copied offsite.
2. **Inside the VM, as `khe`.** Copy `scripts/` and `infrastructure/agent-vm/`
   there together, then `GIT_USER_NAME=... GIT_USER_EMAIL=... ./scripts/setup-agent-vm.sh`
   (the identity is the GitHub noreply one, passed at run time, never
   committed). It stops at `tailscale up` for its login link; afterwards the
   operator disables the node's key expiry ([tailscale.md](tailscale.md)).
3. **Sign in.** `gh auth login` and `claude auth login` (the operator opens
   the links; 2FA on the claude.ai account). Rerun `setup-agent-vm.sh`: it now
   clones the workspace and every repo, runs `npm ci`, installs Playwright
   browsers, builds ha-estfeed's `.venv` and registers the grafana MCP server
   at user scope.
4. **Authorise** the VM's docker-vm key (printed by the script) in
   `khe@docker-vm`'s `authorized_keys`; put a Grafana Viewer service-account
   token in `~/.config/khe/grafana-token` (mode 600). The first ssh to
   docker-vm trusts the host key it sees (`accept-new`): compare its
   fingerprint with the one docker-vm shows for itself before relying on it.
5. **Memory.** The agent's memory folder is keyed by the workspace path, so
   the laptop's `~/.claude-isiklik/projects/<path>/memory/` is copied into
   `~/.claude/projects/-home-khe-khe/memory/`. The VM's copy is primary from
   then on; the two diverge.
6. **First run of remote control**, once in a terminal: `cd ~/khe && claude
   remote-control --spawn same-dir`, answering the trust and "Enable Remote
   Control?" prompts. If it runs without a terminal, `systemctl --user enable
   --now remote-control`. If it will not, install `remote-control-tmux.service`
   under the name `remote-control.service` instead and enable that. Turn
   push notifications on in `/config`.
7. **Heartbeat.** An Uptime Kuma push monitor with a 2-day interval; its URL
   goes into `/etc/khe/agent-vm.heartbeat` as `HEARTBEAT_URL_AGENT_VM=...`.

## Day to day

- **Login renewal.** `auth-check.timer` runs daily and pushes the heartbeat
  only when Claude is logged in, Tailscale is up and `docker-vm` resolves, and
  `remote-control.service` is active. A missed beat is the alert. Renew with
  `claude auth login` in an ssh session; check `tailscale status` and the
  key expiry if Tailscale is the failure.
- **Upgrading Claude Code.** It is pinned (`CLAUDE_VERSION` in
  `setup-agent-vm.sh`) with the autoupdater off. Stay at v2.1.280 or newer:
  local Projects threads need it. Rerun the script with the new version, then
  `systemctl --user restart remote-control`: a running server loses its
  program file when the binary is replaced. Node, gitleaks and mcp-grafana
  are pinned the same way, with checksums.
- **When the VM is down,** work from the laptop's personal Claude instance;
  the workspace and its gate are the same.
- **Cloud threads.** A Projects thread must be sent with Work locally. A cloud
  thread skips the commit gate; the Claude GitHub App is therefore kept off
  the estate repos.
