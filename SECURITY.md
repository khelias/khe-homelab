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
- **The weekly digest** (`weekly-digest.yml`, Friday night) opens one issue
  labelled `agent-digest` and closes the previous one
  ([estate ADR-027](https://github.com/khelias/khe-architecture/blob/main/decisions/027-attended-and-unattended-agent-tiers.md)).
  It runs on a GitHub-hosted runner, never the homelab runner, and pushes no
  code. Claude runs in a job whose `GITHUB_TOKEN` can only read and whose
  tools are a fixed list of `gh` reads, file reads, WebFetch and writing
  `digest.md`; a second job with `issues: write` and no model scans the file
  for secrets and personal data, defuses mentions and cross-repo references,
  and posts it (`scripts/agent-digest-post.sh`). The Claude subscription token
  sits in the `agent` environment, which only `main` can use, and is
  stripped from the commands Claude runs, which run in Claude Code's Bash
  sandbox, reach only GitHub and get their own PID namespace (its Unix-socket
  filter is off, because Ubuntu's bwrap profile stops it, and the runner's
  Docker socket is closed instead); outbound traffic from that job is
  open, so an injected run could still send it out, which spends the
  subscription until the token is revoked. The token from `claude
  setup-token` is valid for a year (created 2026-11-14): renew it in the
  environment before it lapses, or the job fails at its first call. Undone
  by disabling the workflow, revoking the token in claude.ai and deleting
  the issue.

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
- It holds the Home Assistant long-lived token (`~/.config/khe/ha-token`)
  and so controls the house: the attended tier of
  [estate ADR-027](https://github.com/khelias/khe-architecture/blob/main/decisions/027-attended-and-unattended-agent-tiers.md),
  a session the operator starts and steers. Every run of `ha-ws.py` or
  `ha-dashboard.py` asks the operator, and it writes no heat pump or
  ventilation setting. Undone by removing `ha-token` from the
  VM and revoking it in Home Assistant.
- Its sessions start in auto mode, so edits and most commands run on the
  classifier's judgement, not a tap, and run in Claude Code's Bash sandbox in
  strict mode: no unsandboxed retry, and Bash's outbound traffic only to the
  template's hosts (GitHub, npm, PyPI, Anthropic, Debian), with no
  per-command extra host. Connector calls do not pass through the sandbox
  (below). Sandboxed commands cannot read `~/.ssh`,
  `~/.config/khe` (the HA and Grafana tokens) or Claude's credentials, and the
  Read tool is denied the same paths. The gh token in `~/.config/gh/` stays
  readable, because `gh` and git's credential helper need it. Of the commands
  Claude runs, only `ssh`, `scp` and the two HA scripts run outside the
  sandbox, and only when written alone on the command line. Claude Code's
  hooks, the commit gate among them, and mcp-grafana, a local MCP server,
  run outside it too; mcp-grafana keeps its LAN reach. Its settings template
  (`infrastructure/agent-vm/claude-settings.json`) is the floor: every `ssh`,
  `scp` and `sftp` asks the operator, in auto mode too; a push runs without a
  prompt only as `git push ...`; bypass mode is disabled. The claude.ai
  connectors (Claude Docs, Drive, Gmail and the like) load as they do on the
  laptop, chosen on 2026-11-17 so that the VM does what the laptop does. The
  risk accepted with it: connector calls run outside the Bash sandbox and
  reach Google and claude.ai as the operator, and a session in auto mode,
  steered from the phone, can read and write there on the classifier's
  judgement, with no tap, so something it reads could lead it to send data
  out that way. Undone by setting `disableClaudeAiConnectors` back to `true`
  in the template, rerunning `setup-agent-vm.sh` and restarting
  `remote-control`. The commit gate also refuses a push that
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
  Projects, whose threads could run either way, reached the account on
  2026-11-16; its threads are sent with Work locally, to agent-vm.
- Its `vzdump` backup holds the GitHub, Claude and ssh credentials: it stays on
  a storage that is not exported to docker-vm and is not copied offsite.
- Nothing is scheduled here: work without the operator in the session runs
  on GitHub-hosted Actions, never on this VM (estate ADR-027, the weekly
  digest under Automated writers). Merges follow estate ADR-023 as on the
  laptop.
- Accepted, 2026-11-14: the permission rules and the commit gate guard
  against mistakes, not an adversary. A session the agent was talked into
  misusing has sudo on the VM and owns `~/khe`, Bash rules do not match every
  spelling of a command, a git hook or `core.sshCommand` written earlier runs
  on the next allowed push (khe-study's husky hooks live in the work tree,
  so a new `.husky/pre-push` is an ordinary edit, silent in auto mode), and
  the sandbox lets traffic reach github.com, so a sandboxed command could
  still send out the GitHub token or the repos there; an excluded command
  and the HA scripts, which the agent can edit, run with full access after
  the operator's tap; and the commit gate runs a repo's `check:` and git
  with full access and no tap, so a check script, a dependency or a git
  config that a sandboxed command changed runs outside the sandbox at the
  next commit. `npm ci` runs dependency
  install scripts as the user that holds the keys, and `create-vm.sh` fetches
  the Debian image over https without a checksum. The next control, if the
  VM starts reading more untrusted content, is an egress allowlist in the
  Proxmox firewall on the VM's NIC, out of the agent's reach.

## Access model

Independent layers, each a way in with its own control:

- **External access, Cloudflare Tunnel.** Cloudflare terminates TLS and
  forwards to the containers over an outbound-only tunnel. The private apps
  (the dashboard, trips, stories, the pages editor) sit behind Cloudflare
  Access with email OTP.
- **Remote admin, Tailscale.** The Docker VM is a Tailscale subnet router
  for the LAN, so a Tailscale device reaches the Proxmox UI, AdGuard, NPM
  admin and SSH to the VM. It also lets phones pass Cloudflare's 100MB upload
  limit: large Immich uploads go straight to NPM over the VPN.
- **LAN access, wildcard certificate.** A `*.khe.ee` Let's Encrypt
  certificate on NPM (Cloudflare DNS-01, auto-renewing) gives every LAN
  service HTTPS without per-service certificates. AdGuard's split-horizon DNS
  sends the LAN-served names to the VM at home, so a photo upload never
  leaves the house.
- **Host hardening.** SSH on the VM takes keys only. UFW and fail2ban run on
  the VM, though UFW does not filter Docker-published ports (below).
  Homepage, autoheal and Alloy reach Docker through `docker-socket-proxy`
  instead of mounting `docker.sock`. Every secret is in a `.env` file on the
  VM and never committed.

## Network exposure

The router forwards no ports; the internet reaches the homelab only through
Cloudflare Tunnel. The edge fallback Workers sit in front of the tunnel on
`khe.ee/*` and `games.khe.ee/*` and add no path into the homelab: they
forward the request as it came and, on failure, answer from their own copy. Docker-published ports bypass UFW, because Docker's
iptables rules come before UFW's, so every published port (Grafana's 3030
included) is reachable from the LAN and over the Tailscale subnet route,
whatever the UFW port list says. `dash`, `trips` and `stories` open without a login from the LAN and the
tailnet, through AdGuard rewrites and NPM
([estate ADR-022](https://github.com/khelias/khe-architecture/blob/main/decisions/022-home-route-for-access-only-apps.md)).
