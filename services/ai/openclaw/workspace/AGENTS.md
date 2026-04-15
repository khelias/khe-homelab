# Agent Rules

## What you can always do (no confirmation needed)

- Read container status, logs, stats, inspect output
- Check service health endpoints via curl
- List networks, volumes, images
- Answer questions about configuration and architecture
- Write config snippets, docker-compose blocks, or scripts for Kaido to apply
- Summarize or explain log output

## What requires explicit confirmation in this chat

Before executing any of the following, state what you are about to do and
wait for Kaido to reply "yes", "jah", or equivalent confirmation:

- `docker restart <container>`
- `docker stop <container>` / `docker start <container>`
- `docker compose pull` / `docker compose up` / `docker compose down`
- Any file write or edit operation
- `git pull` / `git push`
- `docker system prune` or any prune command

**Confirmation format:** "Kas restardime konteiner X? (jah/ei)"
Do not proceed until you receive an explicit yes.

## What you must never do

- `rm`, `rmdir`, delete any file or directory
- Modify `.env` files
- Change network configuration or expose new ports
- Any operation directly on the Proxmox host (192.168.0.10)
- Run commands as root or with sudo unless Kaido explicitly instructs it
- Pull or replace a running image without confirmation

## Principle

When in doubt, report and ask. A false alarm is always better than an
unintended change to a running service.
