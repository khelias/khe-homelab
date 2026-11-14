# Security Policy

## Reporting a Vulnerability

Please do not open public issues for suspected vulnerabilities.

Report security concerns privately through the contact links on
https://khe.ee. Include the affected URL or repository, a short reproduction
path, and the impact you believe the issue has.

Do not include secrets, tokens, internal host details, private logs, or
personally sensitive data in public issues or pull requests.

## Supported Scope

Only the current `main` branch and the live homelab deployment are supported.
This is a personal infrastructure repository, so there is no formal SLA, but I
treat reports that could affect users, data, deployment credentials, or service
availability as high priority.

## Automated writers

A merge to `main` deploys to the VM, so every automated writer is bounded by
the required `validate.yml` check:

- **Renovate** opens image bump PRs and automerges patch, minor and digest
  updates outside the critical-infrastructure group, except Home Assistant
  minor releases, which wait for review. It is disabled for the
  estate's own images (`ghcr.io/khelias/*`).
- **Per-repo pin Apps** (`khe-adventure-pins` for `khe-ai-adventure`) open the
  estate image pin PRs with auto-merge. An App has Contents and Pull requests
  write here and nothing else, so it cannot change workflow files. The guard
  in `validate.yml` fails any PR the App wrote or pushed to that changes more
  than its own `:main@sha256:` digests, and `scripts/verify-estate-pins.sh`
  fails any PR whose `ghcr.io/khelias/*` digests are not attested by their
  repo's `ci.yml` on `main`, or whose images of one repo come from different
  commits. The accepted residual risk (the App can merge or fast-forward an
  already-green change it did not write) is in [estate ADR-008](https://github.com/khelias/khe-architecture/blob/main/decisions/008-container-images.md).
- **The edge fallback sync** (`edge-fallback.yml`, hourly) deploys two
  Cloudflare Workers with a copy of the public static sites
  ([estate ADR-016](https://github.com/khelias/khe-architecture/blob/main/decisions/016-static-fallback-at-the-edge.md)).
  Its API token can edit Workers in the one account and zone only and sits in
  the `edge-fallback` environment, which only `main` can use; the workflow
  never runs on pull requests. The staging script copies an allowlist of
  public trees, fails on a symlink or an `apiSecret` value, and replaces the
  adventure `config.js` with a stub, so the private trips atlas and the API
  secret never reach Cloudflare.

## Automated readers

- **The agent's log reader** is mcp-grafana on the operator's laptop and on
  agent-vm, run read-only by `scripts/mcp-grafana.sh` with a Grafana service
  account token of role Viewer in `~/.config/khe/grafana-token` (mode 600,
  never in git). It talks plain http to Grafana's published port, which the
  LAN and the Tailscale subnet route reach (see Network exposure). Loki itself has `auth_enabled: false` and
  is reachable only on the `observability` Docker network, through Grafana.
- **Public Actions logs** get only aggregate output: `ops-status.yml` prints
  the snapshot's summary, and the snapshot itself goes to Loki.
- **Homepage** (dash.khe.ee, internet-facing behind Access) reads Docker
  through `homepage-socket-proxy`, not the socket: no writes or exec, but
  `CONTAINERS: 1` still lets it inspect every container, environment included.
  Its only host mount is `./config` (read-write, Homepage writes sample files
  there); the `/srv` share, with backups, runner credentials and service
  data, is not mounted.

## The workspace agent (agent-vm)

agent-vm runs the operator's Claude Code agent, always on
([infrastructure/agent-vm.md](infrastructure/agent-vm.md)). What that means
for the blast radius:

- It holds an ssh key that is root on docker-vm (the `khe` user has sudo
  and the docker group there; docker-vm accepts the key only from agent-vm's
  LAN and tailnet addresses) and pushes to GitHub as the operator, under
  [estate ADR-023](https://github.com/khelias/khe-architecture/blob/main/decisions/023-agent-pushes-where-its-session-allows.md).
  It is reachable only over the LAN and the tailnet, with keys-only sshd and a
  default-deny firewall that Tailscale does not bypass
  ([tailscale.md](infrastructure/tailscale.md)).
- Its sessions run without the Bash sandbox the laptop has and start in auto
  mode, so edits and most commands run on the classifier's judgement, not a
  tap. Its settings template (`infrastructure/agent-vm/claude-settings.json`)
  is the floor: every `ssh`, `scp` and `sftp` asks the operator, in auto mode
  too; a push
  runs without a prompt only as `git push ...`; bypass mode is disabled; claude.ai connectors (Drive
  and the like) are not loaded. The commit gate also refuses a push that
  could run a command of its choosing (`--receive-pack`, `--exec`, any
  global option but `-C`, `GIT_SSH*`, an ASKPASS) or whose options it cannot
  read, the other road to docker-vm.
- The claude.ai account (2FA on) drives an always-on agent with that reach
  through Remote Control, so Require trusted devices is on: a phone or
  browser enrols with a passkey before it can steer a session.
- The gh token has no `workflow` scope, so GitHub itself refuses a push that
  changes `.github/workflows/`.
- A Claude Code cloud session would skip the commit gate; the Claude GitHub
  App, which gives those sessions write access, was uninstalled on 2026-11-14
  (with Google Labs Jules) and is not to come back without a decision.
  Projects, whose threads could run either way, is not on the account yet
  (2026-11-14).
- Its `vzdump` backup holds the GitHub, Claude and ssh credentials: it stays on
  a storage that is not exported to docker-vm and is not copied offsite.
- Nothing is scheduled and no unattended worker exists; merges follow
  estate ADR-023 as on the laptop. A worker that acts without the operator
  in the session is a separate decision.
- Accepted, 2026-11-14: the permission rules and the commit gate guard
  against mistakes, not an adversary. A session the agent was talked into
  misusing has sudo on the VM and owns `~/khe`, Bash rules do not match every
  spelling of a command, a git hook or `core.sshCommand` written earlier runs
  on the next allowed push (khe-study's husky hooks live in the work tree,
  so a new `.husky/pre-push` is an ordinary edit, silent in auto mode), and outbound traffic is open, so it could still send
  out the GitHub token or the repos with `curl`. `npm ci` runs dependency
  install scripts as the user that holds the keys, and `create-vm.sh` fetches
  the Debian image over https without a checksum. The next control, if the
  VM starts reading more untrusted content, is an egress allowlist in the
  Proxmox firewall on the VM's NIC, out of the agent's reach.

## Network exposure

The router forwards no ports; the internet reaches the homelab only through
Cloudflare Tunnel. The edge fallback Workers sit in front of the tunnel on
`khe.ee/*` and `games.khe.ee/*` and add no path into the homelab: they
forward the request as it came and, on failure, answer from their own copy. Docker-published ports bypass UFW, because Docker's
iptables rules come before UFW's, so every published port (Grafana's 3030
included) is reachable from the LAN and over the Tailscale subnet route,
whatever the UFW port list says.
