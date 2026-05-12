#!/usr/bin/env bash
#
# refresh-grafana-container-map.sh
#
# Rebuild the Grafana "Homelab — Container logs" dashboard so its
# `container_id` template variable lists every currently-running
# container by friendly name. Run after any deploy that recreates
# containers (Renovate image bumps, --force-recreate, etc.) — the
# previous container_ids stop matching the new ones.
#
# Run modes:
#   ./scripts/refresh-grafana-container-map.sh
#       Reads `docker ps` locally (only works on the Docker host).
#
#   ./scripts/refresh-grafana-container-map.sh --remote khe@docker-vm
#       SSHs to the host, reads its `docker ps`, writes the dashboard
#       JSON in this repo. Commit + push from your dev machine after.
#
# The output is checked into git on purpose: the dashboard is part of
# the homelab's documented state, and reviewers can see the mapping
# in PR diffs after Renovate bumps.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DASHBOARD_DIR="$ROOT_DIR/services/observability/grafana/config/provisioning/dashboards/files"
TARGET="$DASHBOARD_DIR/khe-homelab-logs.json"

mkdir -p "$DASHBOARD_DIR"

REMOTE=""
if [ "${1:-}" = "--remote" ]; then
  REMOTE="${2:?usage: --remote user@host}"
fi

docker_ps() {
  if [ -n "$REMOTE" ]; then
    ssh "$REMOTE" 'docker ps --format "{{.Names}} {{.ID}}"'
  else
    docker ps --format '{{.Names}} {{.ID}}'
  fi
}

PAIRS="$(docker_ps | awk '{print $1, substr($2,1,12)}' | sort)"

if [ -z "$PAIRS" ]; then
  echo "error: no running containers found via docker ps" >&2
  exit 1
fi

# Build the dashboard JSON. The python heredoc keeps the schema
# explicit and avoids 200 lines of jq pipelines.
python3 - "$TARGET" <<EOF
import json, sys

target = sys.argv[1]
pairs = """$PAIRS""".strip().splitlines()

options = [
    {"selected": False, "text": "All", "value": "\$__all"},
]
for line in pairs:
    name, cid = line.split()
    options.append({"selected": False, "text": name, "value": cid})

# The "query" string is what Grafana shows in the variable editor as
# the canonical list. Format: "label : value, label : value, ...".
query = ", ".join(f"{name} : {cid}" for name, cid in (l.split() for l in pairs))

dashboard = {
    "annotations": {"list": []},
    "editable": False,
    "fiscalYearStartMonth": 0,
    "graphTooltip": 0,
    "id": None,
    "links": [],
    "liveNow": True,
    "panels": [
        {
            "datasource": {"type": "loki", "uid": "loki"},
            "fieldConfig": {"defaults": {}, "overrides": []},
            "gridPos": {"h": 22, "w": 24, "x": 0, "y": 0},
            "id": 1,
            "options": {
                "dedupStrategy": "none",
                "enableLogDetails": True,
                "prettifyLogMessage": False,
                "showCommonLabels": False,
                "showLabels": True,
                "showTime": True,
                "sortOrder": "Descending",
                "wrapLogMessage": True,
            },
            "targets": [
                {
                    "datasource": {"type": "loki", "uid": "loki"},
                    "expr": '{container_id=~"\$container_id"}',
                    "queryType": "range",
                    "refId": "A",
                }
            ],
            "title": "Container logs",
            "type": "logs",
        }
    ],
    "refresh": "10s",
    "schemaVersion": 39,
    "tags": ["homelab", "observability"],
    "templating": {
        "list": [
            {
                "current": {"selected": False, "text": "All", "value": "\$__all"},
                "description": "Pick one or more containers; the dropdown maps friendly names to 12-char container_ids.",
                "includeAll": True,
                "label": "Container",
                "multi": True,
                "name": "container_id",
                "options": options,
                "query": query,
                "queryValue": "",
                "skipUrlSync": False,
                "type": "custom",
            }
        ]
    },
    "time": {"from": "now-1h", "to": "now"},
    "timepicker": {},
    "timezone": "Europe/Tallinn",
    "title": "Homelab — Container logs",
    "uid": "khe-homelab-logs",
    "version": 1,
    "weekStart": "",
}

with open(target, "w") as f:
    json.dump(dashboard, f, indent=2, ensure_ascii=False)
    f.write("\n")

print(f"wrote {target} with {len(pairs)} containers")
EOF
