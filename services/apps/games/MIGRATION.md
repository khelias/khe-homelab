# Games Hub Migration — Faas 1

Migrate `games.khe.ee` from single study-game nginx to a hub that serves a
launcher at `/` and study-game under `/study/`. Faas 2 will add
`/adventure/` (khe-ai-adventure) on top of this same stack.

Target layout:

```
games.khe.ee/          → launcher (services/apps/games/launcher/)
games.khe.ee/study/    → study-game (/srv/data/games/study/)
```

## Strategy

The CF tunnel route for `games.khe.ee` targets `http://study-game:80` and is
managed in the Cloudflare Zero Trust dashboard (token-auth tunnel). Rather
than require a dashboard change during cutover, the new `games` container
carries a transient network alias `study-game` on the proxy network so the
existing CF route keeps working automatically once the old container is
down. CF route update is then a cleanup step that can happen any time.

## Prerequisites

- `khe-study` repo branch `feat/games-hub-base-path` merged to main
  (triggers deploy that populates `/srv/data/games/study/` with the
  rebuilt bundle).
- `khe-homelab` main updated on the VM (`git pull` under `/home/khe/homelab`).

## VM steps (run as `khe`)

```bash
# 1. Pull latest homelab repo
cd ~/homelab
git pull --ff-only

# 2. Verify study-game was redeployed under new path
ls /srv/data/games/study/ | head
# Expect: index.html, assets/, favicon.svg, ...

# 3. Atomic cutover (alias takes over DNS name the moment old is down)
cd ~/homelab/services/apps/study-game && docker compose down
cd ~/homelab/services/apps/games && docker compose up -d

# 4. Verify health
docker compose ps
docker compose logs --tail=30

# 5. Smoke test inside the proxy network
docker run --rm --network proxy curlimages/curl:latest -sI http://games/ | head -1
docker run --rm --network proxy curlimages/curl:latest -sI http://games/study/ | head -1
docker run --rm --network proxy curlimages/curl:latest -sI http://study-game/ | head -1  # alias works
```

## External smoke test

CF tunnel is still pointed at `study-game:80`, which now resolves to the new
`games` container via the alias. No dashboard change needed yet.

```bash
curl -sI https://games.khe.ee/ | head -3
curl -sI https://games.khe.ee/study/ | head -3
# SPA fallback: deep route should return 200 (index.html), not 404
curl -s -o /dev/null -w "%{http_code}\n" https://games.khe.ee/study/some-deep-route
```

Open in a browser and smoke-test study-game actually plays (asset paths
under `/study/assets/*`, React Router navigation stays under `/study/`,
a hard refresh on a deep route still loads the app).

## Cleanup (can be done any time after migration)

1. **CF tunnel route**: open the `khe-homelab` tunnel in Cloudflare Zero
   Trust → edit public hostname `games.khe.ee` → change service target
   from `http://study-game:80` → `http://games:80` → save.
2. **Remove the transient alias**: drop the `aliases: [study-game]` block
   from `services/apps/games/docker-compose.yml`, commit, pull on VM,
   `docker compose up -d`.
3. **Remove old stack files**: delete `services/apps/study-game/` from the
   homelab repo. Delete old bundle dir: `sudo rm -rf /srv/data/study-game`.

## Rollback

If anything breaks after bringing up the new stack:

```bash
cd ~/homelab/services/apps/games && docker compose down
cd ~/homelab/services/apps/study-game && docker compose up -d
```

Old container, old path, back in business. Diagnose `games` logs:
`docker logs games`.
