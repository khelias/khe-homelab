#!/usr/bin/env bash
# Installs the khe-homelab-status timer on the Docker VM: every 5 min it runs
# scripts/homelab-status.sh from the deploy checkout as khe and appends the
# snapshot to /var/lib/khe-status/status.log, which Alloy tails into Loki.
# Run once with sudo; deploys update the script the timer runs.
set -euo pipefail

STATUS_DIR=/var/lib/khe-status
CHECKOUT=/home/khe/homelab

[ "$(id -u)" -eq 0 ] || { echo "run with sudo" >&2; exit 1; }

# Alloy's bind mount may have deployed first, and then Docker created the
# directory as root; install -d alone leaves an existing directory's owner.
install -d -o khe -g khe -m 755 "$STATUS_DIR"
chown khe:khe "$STATUS_DIR"
chmod 755 "$STATUS_DIR"

cat > /etc/systemd/system/khe-homelab-status.service <<EOF
[Unit]
Description=Homelab status snapshot for Loki
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=khe
# Exit 1 means the snapshot found problems: data, not a failed unit.
SuccessExitStatus=1
ExecStart=${CHECKOUT}/scripts/homelab-status.sh --log ${STATUS_DIR}/status.log
EOF

cat > /etc/systemd/system/khe-homelab-status.timer <<'EOF'
[Unit]
Description=Homelab status snapshot every 5 minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=5min

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now khe-homelab-status.timer
systemctl start khe-homelab-status.service
echo "  wrote ${STATUS_DIR}/status.log"
