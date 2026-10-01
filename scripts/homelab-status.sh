#!/usr/bin/env bash
# Read-only health snapshot of the Docker VM, the agent's diagnostic channel
# since ssh is unavailable.
#
#   homelab-status.sh              print the snapshot
#   homelab-status.sh --log FILE   append it to FILE, rotating FILE to FILE.1
#                                  past 1 MB
#
# The khe-homelab-status timer (scripts/setup-status-timer.sh) runs it every
# 5 min with --log, Alloy tails the file into Loki, and the agent reads it
# there. ops-status.yml uses --log too and prints only the summary, because
# this repo is PUBLIC and Actions run logs are world-readable.
#
# Output discipline: Loki content enters AI conversations, so emit only
# aggregated facts already documented in the repo (container names, ports,
# the VM's RFC1918 addresses). Never emit raw container logs, full
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
# Written daily by scripts/os-status.sh on the Proxmox host and on this VM.
STATUS_DIR="${HOMELAB_STATUS_DIR:-/srv/data/reports/khe/internal}"
STATUS_MAX_AGE_HOURS="${HOMELAB_STATUS_MAX_AGE_HOURS:-48}"

# WAF custom rule 3 challenges CLI user agents, so an honest browser UA is
# required or every edge probe comes back 403 and the diagnosis goes wrong.
BROWSER_UA='Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_MAX_BYTES=1048576

if [ "$#" -gt 0 ]; then
  if [ "$1" != --log ] || [ -z "${2:-}" ] || [ "$#" -ne 2 ]; then
    echo "usage: $0 [--log FILE]" >&2
    exit 2
  fi
  log_file="$2"
  # The timer and ops-status share one file: the lock keeps runs from
  # interleaving and rotation from racing a writer. Rotation is a rename, never
  # a copy: Alloy reads a new inode from offset 0 and stamps lines at read
  # time, so copied lines would reappear in Loki as current.
  exec 9>>"${log_file}.lock" || exit 1
  flock 9 || exit 1
  if [ -f "$log_file" ] && [ "$(stat -c %s "$log_file")" -gt "$LOG_MAX_BYTES" ]; then
    mv -f "$log_file" "${log_file}.1"
  fi
  exec >>"$log_file" 2>&1 || exit 1
fi

problems=0
warnings=0

fail() { printf '  FAIL  %s\n' "$1"; problems=$((problems + 1)); }
warn() { printf '  WARN  %s\n' "$1"; warnings=$((warnings + 1)); }
ok()   { printf '  OK    %s\n' "$1"; }

# Workflow commands are noise anywhere but a live Actions log.
use_groups=false
if [ "${GITHUB_ACTIONS:-}" = true ] && [ -z "${log_file:-}" ]; then use_groups=true; fi
group()    { if [ "$use_groups" = true ]; then echo "::group::$1"; fi; }
endgroup() { if [ "$use_groups" = true ]; then echo "::endgroup::"; fi; }

summary() {
  echo "Summary"
  printf '  %d failure(s), %d warning(s)\n' "$problems" "$warnings"
  if [ "$problems" -gt 0 ]; then
    echo "  Status: PROBLEMS FOUND"
    exit 1
  fi
  echo "  Status: healthy"
}

# The status files are flat, one key per line, written by os-status.sh, so a
# sed lookup is enough and the runner needs no JSON tool.
status_field() {
  sed -n "s/^ *\"$2\": *//p" "$1" 2>/dev/null | head -n 1 | tr -d '",'
}

# live=yes for this VM: the host checks above already read its state directly,
# so its file only proves that its timer runs.
os_update_line() {
  local label="$1" file="$2" live="$3" epoch age_h pending since reboot running newest pve detail waited
  if [ ! -f "$file" ]; then
    warn "${label}: not reported (no ${file##*/})"
    return
  fi
  epoch="$(status_field "$file" generatedEpoch)"
  case "$epoch" in
    ''|*[!0-9]*) warn "${label}: not reported (${file##*/} unreadable)"; return ;;
  esac
  age_h=$(( ($(date +%s) - epoch) / 3600 ))
  if [ "$age_h" -ge "$STATUS_MAX_AGE_HOURS" ]; then
    warn "${label}: not reported for ${age_h} h (${file##*/} is stale)"
    return
  fi
  pending="$(status_field "$file" pendingUpdates)"
  reboot="$(status_field "$file" rebootRequired)"
  running="$(status_field "$file" runningKernel)"
  newest="$(status_field "$file" newestKernel)"
  pve="$(status_field "$file" pveVersion)"
  since="$(status_field "$file" pendingSinceEpoch)"
  case "$pending" in
    ''|*[!0-9]*) warn "${label}: not reported (${file##*/} unreadable)"; return ;;
  esac
  # Files written before os-status.sh kept the pending age have no such field.
  waited=""
  case "$since" in
    ''|*[!0-9]*) ;;
    *) waited=" for $(( ($(date +%s) - since) / 86400 )) d" ;;
  esac
  detail="kernel ${running}"
  [ -n "$pve" ] && [ "$pve" != null ] && detail="pve ${pve}, ${detail}"

  if [ "$live" = yes ]; then
    local due="no reboot due"
    [ "$reboot" = true ] && due="reboot due"
    printf '  INFO  %s: %s pending%s, %s (%s, reported %d h ago)\n' \
      "$label" "$pending" "$waited" "$due" "$detail" "$age_h"
    return
  fi
  if [ "$reboot" = true ]; then
    if [ -n "$newest" ] && [ "$newest" != "$running" ]; then
      warn "${label}: reboot due (${running} -> ${newest})"
    else
      warn "${label}: reboot due"
    fi
  fi
  if [ "$pending" -gt 0 ]; then
    warn "${label}: ${pending} update(s) pending${waited}"
  fi
  if [ "$reboot" != true ] && [ "$pending" -eq 0 ]; then
    ok "${label}: up to date (${detail})"
  fi
}

os_updates_section() {
  echo "OS updates"
  os_update_line "Proxmox host" "${STATUS_DIR}/os-status-pve-host.json" no
  os_update_line "Docker VM" "${STATUS_DIR}/os-status-vm.json" yes
  echo
}

echo "run $(date -u +%Y-%m-%dT%H:%M:%SZ)"

if [ "${HOMELAB_STATUS_ONLY:-}" = osupdates ]; then
  os_updates_section
  summary
  exit 0
fi

group Host
printf 'uptime:   %s\n' "$(uptime -p 2>/dev/null || echo unknown)"
printf 'kernel:   %s\n' "$(uname -r)"
printf 'load:     %s\n' "$(cut -d' ' -f1-3 /proc/loadavg 2>/dev/null || echo unknown)"
echo
free -h 2>/dev/null
echo
df -h / /srv/data /srv/backups 2>/dev/null
endgroup

echo "Host checks"
root_pct="$(df -P / 2>/dev/null | awk 'NR == 2 { gsub("%", "", $5); print $5 }')"
if [ -n "$root_pct" ] && [ "$root_pct" -ge "$DISK_WARN_PERCENT" ]; then
  fail "root filesystem ${root_pct}% full (threshold ${DISK_WARN_PERCENT}%)"
else
  ok "root filesystem ${root_pct:-?}% full"
fi

# Unmounted, these are plain directories on the VM disk and containers would
# write into them unnoticed.
for mnt in /srv/data /srv/backups; do
  if mountpoint -q "$mnt" 2>/dev/null; then
    ok "${mnt} mounted"
  else
    fail "${mnt} is not mounted (NFS from the Proxmox host)"
  fi
done

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

os_updates_section

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
  if [ -n "$unhealthy" ]; then fail "unhealthy: ${unhealthy}"; else ok "no unhealthy containers"; fi

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
  if [ -n "$restarting" ]; then fail "restarting: ${restarting}"; else ok "no restart loops"; fi

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
  if [ -n "$oom_hits" ]; then warn "cgroup OOM kills since start: ${oom_hits}"; else ok "no cgroup OOM kills"; fi
fi
echo

echo "Estate images"
# Images built by the estate's own repos carry OCI labels (ADR-008 in
# khe-meta). The revision shows which commit is live without a shell, and two
# containers of one app must show the same one.
if docker info >/dev/null 2>&1; then
  n_estate=0; estate_revs=""
  while read -r cname; do
    [ -z "$cname" ] && continue
    fields="$(docker inspect --format '{{index .Config.Labels "org.opencontainers.image.source"}}|{{index .Config.Labels "org.opencontainers.image.revision"}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$cname" 2>/dev/null)"
    IFS='|' read -r src rev hstate <<< "$fields"
    case "$src" in
      https://github.com/khelias/*) ;;
      *) continue ;;
    esac
    n_estate=$((n_estate + 1))
    line="${cname} ${hstate} ${rev:-no-revision} (${src#https://github.com/})"
    if [ "$hstate" = "healthy" ]; then ok "$line"; else warn "$line"; fi
    estate_revs="${estate_revs}${src} ${rev:-no-revision}"$'\n'
  done < <(docker ps --format '{{.Names}}' 2>/dev/null)
  [ "$n_estate" -eq 0 ] && warn "no running container carries a khelias image source label"
  while read -r src; do
    [ -z "$src" ] && continue
    fail "${src#https://github.com/} runs more than one revision; pin its images to the same commit"
  done < <(printf '%s' "${estate_revs:-}" | sort -u | awk '{ print $1 }' | uniq -d)
fi
echo

echo "Orphan compose projects"
# A stack deleted from git is skipped by deploy-stacks.sh, so its containers
# and volumes stay until retire-stack.yml removes them.
if docker info >/dev/null 2>&1; then
  n_orphans=0
  while read -r project; do
    [ -z "$project" ] && continue
    n_orphans=$((n_orphans + 1))
    warn "${project}: no services/*/${project}/docker-compose.yml; retire it with retire-stack.yml"
  done < <("${SCRIPT_DIR}/retire-stack.sh" 2>/dev/null)
  [ "$n_orphans" -eq 0 ] && ok "every compose project has a compose file in the checkout"
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

summary
