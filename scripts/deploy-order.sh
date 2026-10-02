# shellcheck shell=bash
# Sourced by deploy.sh and deploy-stacks.sh.
# A stack that owns a shared network comes before every stack that joins it
# as external: nginx-proxy-manager owns `proxy`, loki owns `observability`,
# cloudflare-tunnel owns `draft-tunnel`.
# shellcheck disable=SC2034
DEPLOY_ORDER=(
  "core/nginx-proxy-manager"
  "core/adguard"
  "core/cloudflare-tunnel"
  "core/vaultwarden"
  "observability/loki"
  "core/uptime-kuma"
  "core/homepage"
  "core/autoheal"
  "media/immich"
  "home/mosquitto"
  "home/homeassistant"
  "home/pai"
  "apps/landing"
  "apps/games"
  "apps/pages"
  "apps/trips"
  "observability/alertmanager"
  "observability/grafana"
  "observability/alloy"
)
