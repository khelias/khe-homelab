# Games Hub Migration — Faas 1

Migrate `games.khe.ee` from single study-game nginx to a hub that serves a
launcher at `/` and study-game under `/study/`. Faas 2 will add
`/adventure/` (ai-adventure-engine) on top of this same stack.

Target layout:

```
games.khe.ee/          → launcher (services/apps/games/launcher/)
games.khe.ee/study/    → study-game (/srv/data/games/study/)
```

## Prerequisites

- `study-game` repo branch `feat/games-hub-base-path` merged to main
  (triggers deploy that populates `/srv/data/games/study/` with the
  rebuilt bundle).
- `khe-homelab` main updated on the VM (`git pull` under `/home/khe/khe-homelab`).

## VM steps (run as `khe`)

```bash
# 1. Pull latest homelab repo
cd ~/khe-homelab
git pull --ff-only

# 2. Verify study-game was redeployed under new path
ls /srv/data/games/study/ | head
# Expect: index.html, assets/, favicon.svg, ...

# 3. Bring up new games hub stack (containers named `games` — does not
#    conflict with existing `study-game` container)
cd ~/khe-homelab/services/apps/games
docker compose up -d
docker compose ps
docker compose logs --tail=30

# 4. Smoke test inside the proxy network (before switching CF tunnel)
docker run --rm --network proxy curlimages/curl:latest -sI http://games/ | head -1
docker run --rm --network proxy curlimages/curl:latest -sI http://games/study/ | head -1
docker run --rm --network proxy curlimages/curl:latest -s http://games/ | grep -o '<title>.*</title>'
# Expect: HTTP/1.1 200 OK for both, launcher title in the last one
```

## Cloudflare Tunnel switch

1. Open the `khe-homelab` tunnel in the Cloudflare Zero Trust dashboard.
2. Edit the public hostname `games.khe.ee`.
3. Change service target from `http://study-game:80` → `http://games:80`.
4. Save. CF propagates in ~30s.

Verify from outside the LAN:

```bash
# Launcher + study-game index both return 200
curl -sI https://games.khe.ee/ | head -3
curl -sI https://games.khe.ee/study/ | head -3

# SPA fallback: any path under /study/ should return 200 (index.html),
# not 404 — React Router handles the route client-side.
curl -s -o /dev/null -w "%{http_code}\n" https://games.khe.ee/study/some-deep-route
# Expect: 200
```

Open in a browser and smoke-test study-game actually plays (asset paths
under `/study/assets/*`, React Router navigation stays under `/study/`,
a hard refresh on a deep route still loads the app).

## Tear down old stack

Only after confirming `games.khe.ee/study/` works end-to-end:

```bash
cd ~/khe-homelab/services/apps/study-game
docker compose down
cd ~
# Old build bundle can stay for now as a rollback safety net.
# Remove only after a few days of the new hub being stable:
# sudo rm -rf /srv/data/study-game
```

Then merge the homelab PR that removes `services/apps/study-game/`.

## Rollback

If anything breaks after the CF switch:

1. Flip CF tunnel `games.khe.ee` target back to `http://study-game:80`
   (old container is still running until tear-down step).
2. Diagnose `games` container logs: `docker logs games`.
