#!/usr/bin/env bash
# Read-only health snapshot of the Docker VM. Runs on the self-hosted runner
# and is the agent-facing diagnostic channel, since ssh is unavailable.
#
# Output discipline: this repo is PUBLIC, so Actions run logs are world-readable.
# Emit only aggregated facts already documented in the repo (container names,
# ports, the VM's RFC1918 addresses). Never emit raw container logs, full
# `docker inspect` output, environment variables, or per-visitor data. A
# single `--format`ed field such as health status is fine; a whole object is not.
#
# No `set -e`: a diagnostic must report every section even when an earlier
# check fails. Failures are counted and surfaced in the summary instead.
set -uo pipefail

EXPECTED_LAN_IP="${HOMELAB_EXPECTED_LAN_IP:-192.168.0.11}"
EXPECTED_GATEWAY="${HOMELAB_EXPECTED_GATEWAY:-192.168.0.1}"
TUNNEL_CONTAINER="${HOMELAB_TUNNEL_CONTAINER:-cloudflare-tunnel}"
EDGE_PROBE_HOST="${HOMELAB_EDGE_PROBE_HOST:-khe.ee}"
DISK_WARN_PERCENT="${HOMELAB_DISK_WARN_PERCENT:-85}"
MEM_WARN_PERCENT="${HOMELAB_MEM_WARN_PERCENT:-90}"

# WAF custom rule 3 challenges CLI user agents, so an honest browser UA is
# required or every edge probe comes back 403 and the diagnosis goes wrong.
BROWSER_UA='Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36'

problems=0
warnings=0

fail() { printf '  FAIL  %s\n' "$1"; problems=$((problems + 1)); }
warn() { printf '  WARN  %s\n' "$1"; warnings=$((warnings + 1)); }
ok()   { printf '  OK    %s\n' "$1"; }

echo "::group::Host"
printf 'uptime:   %s\n' "$(uptime -p 2>/dev/null || echo unknown)"
printf 'kernel:   %s\n' "$(uname -r)"
printf 'load:     %s\n' "$(cut -d' ' -f1-3 /proc/loadavg 2>/dev/null || echo unknown)"
echo
free -h 2>/dev/null
echo
df -h / /srv 2>/dev/null
echo "::endgroup::"

echo "Host checks"
root_pct="$(df -P / 2>/dev/null | awk 'NR == 2 { gsub("%", "", $5); print $5 }')"
if [ -n "$root_pct" ] && [ "$root_pct" -ge "$DISK_WARN_PERCENT" ]; then
  fail "root filesystem ${root_pct}% full (threshold ${DISK_WARN_PERCENT}%)"
else
  ok "root filesystem ${root_pct:-?}% full"
fi

mem_pct="$(free 2>/dev/null | awk '/^Mem:/ { printf "%d", ($2 - $7) / $2 * 100 }')"
if [ -n "$mem_pct" ] && [ "$mem_pct" -ge "$MEM_WARN_PERCENT" ]; then
  warn "memory ${mem_pct}% in use (threshold ${MEM_WARN_PERCENT}%)"
else
  ok "memory ${mem_pct:-?}% in use"
fi

# Answers "does the OS itself need attention" without anyone opening a shell.
if [ -f /var/run/reboot-required ]; then
  warn "OS reboot required (kernel or libc updated)"
else
  ok "no OS reboot pending"
fi

pending="$(apt list --upgradable 2>/dev/null | tail -n +2 | grep -c '/' || true)"
if [ "${pending:-0}" -gt 0 ]; then
  warn "${pending} OS package update(s) pending"
else
  ok "OS packages up to date"
fi
echo

echo "Network checks"
lan_ips="$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^192\.168\.' | tr '\n' ' ')"
if printf '%s' "$lan_ips" | grep -qw "$EXPECTED_LAN_IP"; then
  ok "LAN IP ${EXPECTED_LAN_IP} present"
else
  fail "LAN IP ${EXPECTED_LAN_IP} missing; interfaces hold: ${lan_ips:-none}"
fi

gateway="$(ip route 2>/dev/null | awk '/^default/ { print $3; exit }')"
if [ "$gateway" = "$EXPECTED_GATEWAY" ]; then
  ok "default gateway ${gateway}"
else
  fail "default gateway is ${gateway:-none}, expected ${EXPECTED_GATEWAY}"
fi

# AdGuard runs as a container on this same host and is the LAN resolver, so a
# resolver outage takes the tunnel's own DNS with it. Worth naming explicitly.
resolver="$(awk '/^nameserver/ { print $2; exit }' /etc/resolv.conf 2>/dev/null)"
printf '  INFO  resolver %s\n' "${resolver:-unknown}"

if getent hosts cloudflare.com >/dev/null 2>&1; then
  ok "DNS resolution works"
else
  fail "DNS resolution broken"
fi

if curl -sS -o /dev/null --max-time 8 https://1.1.1.1 2>/dev/null; then
  ok "outbound internet reachable"
else
  fail "no outbound internet (tunnel cannot reach the Cloudflare edge)"
fi
echo

echo "Docker checks"
if ! docker info >/dev/null 2>&1; then
  fail "docker daemon unreachable; skipping container checks"
else
  total="$(docker ps -aq 2>/dev/null | wc -l | tr -d ' ')"
  running="$(docker ps -q 2>/dev/null | wc -l | tr -d ' ')"
  ok "${running}/${total} containers running"

  unhealthy="$(docker ps --filter health=unhealthy --format '{{.Names}}' 2>/dev/null | tr '\n' ' ')"
  [ -n "$unhealthy" ] && fail "unhealthy: ${unhealthy}" || ok "no unhealthy containers"

  # "not unhealthy" covers both healthy and still-starting, which is too coarse
  # to verify a healthcheck change: a container in start_period looks identical
  # to a passing one. Report the distribution so a rollout can be confirmed
  # rather than inferred from elapsed time.
  n_healthy=0; n_starting=0; n_nocheck=0; starting_names=""
  while read -r cname; do
    [ -z "$cname" ] && continue
    hstate="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$cname" 2>/dev/null)"
    case "$hstate" in
      healthy)  n_healthy=$((n_healthy + 1)) ;;
      starting) n_starting=$((n_starting + 1)); starting_names="${starting_names}${cname} " ;;
      none)     n_nocheck=$((n_nocheck + 1)) ;;
    esac
  done < <(docker ps --format '{{.Names}}' 2>/dev/null)
  printf '  INFO  health: %d healthy, %d starting, %d without a healthcheck\n' \
    "$n_healthy" "$n_starting" "$n_nocheck"
  [ -n "$starting_names" ] && printf '  INFO  starting: %s\n' "$starting_names"

  restarting="$(docker ps --filter status=restarting --format '{{.Names}}' 2>/dev/null | tr '\n' ' ')"
  [ -n "$restarting" ] && fail "restarting: ${restarting}" || ok "no restart loops"

  stopped="$(docker ps -a --filter status=exited --format '{{.Names}}' 2>/dev/null | tr '\n' ' ')"
  [ -n "$stopped" ] && warn "exited: ${stopped}"

  # A cgroup-level OOM of a child process leaves .State.OOMKilled false, so the
  # container flag is useless here. The cgroup counter is the reliable signal.
  oom_hits=""
  while read -r cid cname; do
    [ -z "$cid" ] && continue
    for base in /sys/fs/cgroup/system.slice/docker-*.scope /sys/fs/cgroup/docker/*; do
      case "$base" in *"$cid"*) ;; *) continue ;; esac
      count="$(awk '/^oom_kill / { print $2 }' "${base}/memory.events" 2>/dev/null)"
      [ -n "${count:-}" ] && [ "$count" -gt 0 ] && oom_hits="${oom_hits}${cname}=${count} "
    done
  done < <(docker ps --format '{{.ID}} {{.Names}}' 2>/dev/null)
  [ -n "$oom_hits" ] && warn "cgroup OOM kills since start: ${oom_hits}" || ok "no cgroup OOM kills"
fi
echo

echo "Cloudflare tunnel checks"
tunnel_state="$(docker ps --filter "name=^${TUNNEL_CONTAINER}$" --format '{{.State}}' 2>/dev/null)"
if [ "$tunnel_state" = "running" ]; then
  ok "${TUNNEL_CONTAINER} container running"
else
  fail "${TUNNEL_CONTAINER} container not running (state: ${tunnel_state:-absent})"
fi

# Split-horizon DNS points *.khe.ee at the LAN, so probing the hostname from
# inside the VM tests NPM, not the tunnel. Force the Cloudflare edge address to
# actually exercise the public path.
edge_ip="$(getent ahostsv4 "$EDGE_PROBE_HOST" 2>/dev/null | awk '{ print $1; exit }')"
case "$edge_ip" in
  ''|192.168.*|10.*|172.1[6-9].*|172.2*.*|172.3[01].*)
    edge_ip="$(curl -sS --max-time 8 "https://cloudflare-dns.com/dns-query?name=${EDGE_PROBE_HOST}&type=A" \
      -H 'accept: application/dns-json' 2>/dev/null \
      | grep -oE '"data":"[0-9.]+"' | head -1 | grep -oE '[0-9.]+')"
    ;;
esac

if [ -z "${edge_ip:-}" ]; then
  warn "could not resolve a public address for ${EDGE_PROBE_HOST}; edge probe skipped"
else
  code="$(curl -sS -o /tmp/edge-probe.$$ -w '%{http_code}' --max-time 15 \
    -A "$BROWSER_UA" --resolve "${EDGE_PROBE_HOST}:443:${edge_ip}" \
    "https://${EDGE_PROBE_HOST}" 2>/dev/null)"
  cf_err="$(grep -oE 'error code: [0-9]{4}' /tmp/edge-probe.$$ 2>/dev/null | head -1)"
  rm -f /tmp/edge-probe.$$
  case "$code" in
    200|301|302|304)
      ok "public edge probe ${EDGE_PROBE_HOST} -> ${code}"
      ;;
    530)
      fail "public edge probe -> 530 (${cf_err:-error code: 1033}); tunnel is not registered with the edge"
      ;;
    *)
      warn "public edge probe -> ${code:-no response} ${cf_err}"
      ;;
  esac
fi
echo

echo "Summary"
printf '  %d failure(s), %d warning(s)\n' "$problems" "$warnings"
if [ "$problems" -gt 0 ]; then
  echo "  Status: PROBLEMS FOUND"
  exit 1
fi
echo "  Status: healthy"
