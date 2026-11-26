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
- **Per-repo pin Apps** (`khe-adventure-pins` for `khe-ai-adventure`,
  `khe-stories-pins` for `khe-stories`) open the
  estate image pin PRs with auto-merge. An App has Contents and Pull requests
  write here and nothing else, so it cannot change workflow files. The guard
  in `validate.yml` fails any PR the App wrote or pushed to that changes more
  than its own `:main@sha256:` digests, and `scripts/verify-estate-pins.sh`
  fails any PR whose `ghcr.io/khelias/*` digests are not attested by their
  repo's `ci.yml` on `main`, or whose images of one repo come from different
  commits. The accepted residual risk (the App can merge or fast-forward an
  already-green change it did not write) is in [estate ADR-008](https://github.com/khelias/khe-architecture/blob/main/decisions/008-container-images.md).
- **autoheal** restarts any container whose healthcheck reads unhealthy,
  through a socket proxy that allows container reads (list and inspect,
  every container's environment included) and restart, stop and kill,
  nothing else; it writes no code
  ([notes](docs/operational-notes.md#autoheal)).
- **The edge fallback sync** (`edge-fallback.yml`, hourly) deploys two
  Cloudflare Workers with a copy of the public static sites
  ([estate ADR-016](https://github.com/khelias/khe-architecture/blob/main/decisions/016-static-fallback-at-the-edge.md)).
  Its API token can edit Workers in the one account and zone only and sits in
  the `edge-fallback` environment, which only `main` can use; the workflow
  never runs on pull requests. The staging script copies an allowlist of
  public trees, fails on a symlink or an `apiSecret` value, and replaces the
  adventure `config.js` with a stub, so the private trips atlas and the API
  secret never reach Cloudflare.
- **The makett preview deploy** (khe-makett `ci.yml`, on a push to `main`
  or a manual run from it) deploys the Worker `makett-preview` on
  `makett.khe.ee`, behind Cloudflare Access, after the repo's full check
  passed at the same commit ([infrastructure/cloudflare.md](infrastructure/cloudflare.md#workers-routes)).
  Its token is custom, Account Workers Scripts Edit and Zone Workers Routes
  Edit on `khe.ee`, and sits in that private repo's secrets, since GitHub
  Free has no environments there; only its one collaborator can push.
  Accepted risk, 2026-11-26: Workers Scripts Edit is account-wide, so a
  leaked token could overwrite the edge fallback Workers too, and then what
  the edge serves when the homelab is down; undone by revoking the token and
  redeploying the copy with `gh workflow run edge-fallback.yml`. The Worker refuses a Stripe key
  whose mode differs from its `STRIPE_MODE` (`test` here), so the preview
  cannot take real money.
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
- **Home Assistant DHW price control** (`khe-home-assistant`
  `config/packages/heating_price.yaml`) is opt-in behind
  `input_boolean.boileri_hinnajuhtimine` (off by default). While on, it writes
  only the Daikin Altherma hot-water tank target over the LAN WebSocket,
  clamped to 45-55 °C from the day-ahead electricity price forecast, skipping
  when the tank is off, in `performance` boost or in its weekly 60 °C
  anti-legionella cycle (`temperature >= 60`). Turning the toggle off, or
  losing the price sensor for 15 minutes while on, restores 55 °C. Space
  heating and ventilation stay read-only. Undone by turning off
  `input_boolean.boileri_hinnajuhtimine` in Home Assistant (which restores
  55 °C immediately) or reverting `heating_price.yaml`.

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
- It can start prints on the house's 3D printer
  ([agent-vm "MCP servers"](infrastructure/agent-vm.md#day-to-day)):
  the `k2` MCP server reads the printer's state, files and camera, switches
  its chamber light and uploads a sliced file without a tap, since none of
  that starts anything, and starts a print only after a prompt that the
  server's own code forces on every call, which no permission rule lifts.
  Print and light refuse unless the printer is idle, print and upload refuse
  a file whose side fan goes above S38 and read only an absolute path to a
  plain file under `~/khe` or the session's temp folder, opened without
  following a link, so an untapped upload sends nothing but the file named.
  The server writes no printer configuration and restarts no Klipper.
- Its MCP servers (`grafana` and `k2`) run outside the sandbox with the VM's
  LAN reach, so the VM has only those listed in the root-owned
  `/etc/claude-code/managed-mcp.json`, whose exclusive control keeps a
  session from adding a server of its own, and each runs a root-owned copy
  in `/usr/local/lib/khe/` that a session cannot change, `k2` through
  `/usr/bin/python3 -I` rather than the `python3` that `PATH` finds first.
  The setup script takes the K2 files from khe-meta's `origin/main`, which a
  session can push to, so it shows the diff against the installed copies and
  installs only on the operator's yes: reading that diff is the review.
  mcp-grafana's wrapper comes from the setup's own checkout, which already
  runs as root. The copies hold against sessions, not against a setup
  rerun: the setup runs repo build code (`npm ci`, the stories app build,
  `pip install -e`, `workspace.sh`) as `khe` with passwordless sudo, and
  that code is session-editable, so a rerun after a session was misused
  could replace them. Accepted with the rest of the VM's sudo (estate
  ADR-027). The camera runs Debian's root-owned `chromium`. The printer's
  address is in `~/.config/khe/k2-printer.json`. Slicing and OpenSCAD run
  inside the sandbox with no network, from pins that live with the repos
  that use them. Undone by deleting `/etc/claude-code/managed-mcp.json`,
  reverting the setup and template commits, rerunning `setup-agent-vm.sh`
  and deleting the address file.
- Its sessions start in auto mode, so edits and most commands run on the
  classifier's judgement, not a tap, and run in Claude Code's Bash sandbox in
  strict mode: no unsandboxed retry, and Bash's outbound traffic only to the
  template's hosts (GitHub, npm, PyPI, Anthropic, Debian, and the
  Hinnavaatlus forum and site for khe-deals), with no
  per-command extra host. Connector calls do not pass through the sandbox
  (below). Sandboxed commands cannot read `~/.ssh`,
  `~/.config/khe` (the HA and Grafana tokens) or Claude's credentials, and the
  Read tool is denied the same paths. The gh token in `~/.config/gh/` stays
  readable, because `gh` and git's credential helper need it. Of the commands
  Claude runs, only `ssh`, `scp` and the two HA scripts run outside the
  sandbox, and only when written alone on the command line. Claude Code's
  hooks, the commit gate among them, and the MCP servers of the managed list
  (above) run outside it too. Its settings template
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
  next commit; the session-start hook does the same with the workspace
  scripts and git at every session start, with no commit. `npm ci` runs dependency
  install scripts as the user that holds the keys, and `create-vm.sh` fetches
  the Debian image over https without a checksum. The next control, if the
  VM starts reading more untrusted content, is an egress allowlist in the
  Proxmox firewall on the VM's NIC, out of the agent's reach.
- Accepted, 2026-11-19: what an agent-vm session pushes or saves reaches the
  laptop at its next session start. The laptop's hook fast-forwards the
  repos under `repos/`, so a pushed commit is there without a pull and its
  `check:` runs at the laptop's next commit in that repo, and the memory sync
  copies the notes agent-vm sessions saved into the memory the laptop's
  sessions load, naming each one in the session's opening lines. The
  workspace root, which holds the hooks and the commit gate, is only
  reported, never fast-forwarded, on either machine.

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
  Homepage, autoheal and Alloy reach Docker through a socket proxy each
  (Tecnativa's for Homepage and Alloy, linuxserver's for autoheal) instead
  of mounting `docker.sock`. Every secret is in a `.env` file on the
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
`home.khe.ee` and `swipe.khe.ee` are LAN and Tailscale only (not on Cloudflare
Tunnel); `immich-swipe` sits on `proxy` only (isolated from `immich-internal`),
publishes no host port, holds no server-side secrets, and the browser authenticates
to Immich with a scoped API key that omits `asset.delete`.
Behind both routes, `stories.khe.ee/api/` asks for a paired phone of its own:
a parent pairs it once with the family phrase, four random words, which is
tried at most five times an hour per client address and twenty in all (a LAN
client can make NPM forward an address of its choosing)
([estate ADR-038](https://github.com/khelias/khe-architecture/blob/main/decisions/038-a-childs-device-is-paired-once-by-a-parent.md)).
