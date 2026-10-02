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
  already-green change it did not write) is in khe-meta ADR-008.

## Automated readers

- **The agent's log reader** is mcp-grafana on the operator's machine, run
  read-only by `scripts/mcp-grafana.sh` with a Grafana service account token
  of role Viewer in `~/.config/khe/grafana-token` (mode 600, never in git).
  Grafana answers on the LAN only. Loki itself has `auth_enabled: false` and
  is reachable only on the `observability` Docker network, through Grafana.
- **Public Actions logs** get only aggregate output: `ops-status.yml` prints
  the snapshot's summary, and the snapshot itself goes to Loki.
- **Homepage** (dash.khe.ee, internet-facing behind Access) reads Docker
  through `homepage-socket-proxy`, not the socket: no writes or exec, but
  `CONTAINERS: 1` still lets it inspect every container, environment included.

## Network exposure

The router forwards no ports; the internet reaches the homelab only through
Cloudflare Tunnel. Docker-published ports bypass UFW, because Docker's
iptables rules come before UFW's, so every published port (Grafana's 3030
included) is reachable from the LAN and over the Tailscale subnet route,
whatever the UFW port list says.
