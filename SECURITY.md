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
  updates outside the critical-infrastructure group. It is disabled for the
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
