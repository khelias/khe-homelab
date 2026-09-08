# TOOLS.md - Local Notes

Skills define _how_ tools work. This file is for _your_ specifics — the stuff that's unique to your setup.

## Docker

- All containers are on Docker VM: 192.168.0.11
- Docker socket is proxied via `openclaw-socket-proxy` (read-only + restarts)
- `DOCKER_HOST=tcp://docker-socket-proxy:2375` — already configured in environment

## SSH

**You do not have SSH access. Neither host is reachable from this container.**

- Docker VM (`khe@192.168.0.11`) and Proxmox host (`root@192.168.0.10`) both
  accept key auth only, and this container has no key: `docker-compose.yml`
  mounts no key and no `~/.ssh`, and the `openclaw_config` volume contains no
  `.ssh` directory. Verified 2026-09-08. The `ssh` client binary does exist
  (`/usr/bin/ssh`), so a command may hang or fail on auth rather than say
  "not found" — that is still no access.
- There is also no write path via Docker: the socket proxy is read-only
  (`POST: 0`), with container restart/stop/start as the only exception
  (`ALLOW_RESTARTS: 1`). No pulls, no `docker compose up`, no API writes.
- Anything needing host access or a Docker write: write out the exact command
  and ask Kaido to run it.

## Networks

- `proxy` — all services accessible via NPM reverse proxy
- `ai-internal` — Ollama + OpenClaw (model inference)
- `socket-proxy` — OpenClaw + docker-socket-proxy only (internal)

## Service Ports (internal)

See USER.md for the full list of services and their URLs.
