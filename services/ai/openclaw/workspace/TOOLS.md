# TOOLS.md - Local Notes

Skills define _how_ tools work. This file is for _your_ specifics — the stuff that's unique to your setup.

## Docker

- All containers are on Docker VM: 192.168.0.11
- Docker socket is proxied via `openclaw-socket-proxy` (read-only + restarts)
- `DOCKER_HOST=tcp://docker-socket-proxy:2375` — already configured in environment

## SSH

- Docker VM: `khe@192.168.0.11`
- Proxmox host: `root@192.168.0.10`

## Networks

- `proxy` — all services accessible via NPM reverse proxy
- `ai-internal` — Ollama + OpenClaw (model inference)
- `socket-proxy` — OpenClaw + docker-socket-proxy only (internal)

## Service Ports (internal)

See USER.md for the full list of services and their URLs.
