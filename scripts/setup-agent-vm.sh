#!/usr/bin/env bash
# Sets up agent-vm, the VM that runs the operator's Claude Code agent
# (infrastructure/agent-vm.md). Run INSIDE the VM as the user khe (not root),
# with sudo available, on Debian 13. Safe to rerun: every step checks first.
#
# The script and infrastructure/agent-vm/ are copied to the VM together,
# keeping their relative layout, because the VM has no khe-homelab clone
# before the workspace is cloned.
#
# Two parts. The system part needs no sign-in. The workspace part needs
# `gh auth login`, so a run before it stops with a note and a rerun after it
# finishes the job.
#
#   GIT_USER_NAME / GIT_USER_EMAIL   the commit identity (the GitHub noreply
#                                    address); needed on the first run only
#   CLAUDE_VERSION                   Claude Code to pin (default below)
#   LAN_CIDR                         where ssh may come from besides the tailnet
set -euo pipefail

CLAUDE_VERSION="${CLAUDE_VERSION:-2.1.325}"
NODE_VERSION=24.22.3
NODE_SHA256=4f2b175a6d53a5c617a80dba2676238a0688cef28c6da4eba35c7d844e66fcfb
GITLEAKS_VERSION=8.30.1
GITLEAKS_SHA256=551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb
MCP_GRAFANA_VERSION=2.0.0
MCP_GRAFANA_SHA256=0a0dde2c882c24fedcce79a07d97b232f71730c744b84a09b6b0735c2ca3d024
# Matches the repos' @playwright/test range; only its install-deps is used here.
PLAYWRIGHT_DEPS_VERSION=1.59.1
# For khe-home-assistant's ha-ws.py and ha-dashboard.py; ruff comes from its ci.yml.
WEBSOCKETS_VERSION=17.4
# The K2's slicer and the parts' OpenSCAD (estate ADR-050); GitHub's and
# files.openscad.org's published sha256 of each AppImage.
ORCA_VERSION=2.5.1
ORCA_SHA256=073b8105c928356141db0ddbce88b81d52c7a9e2442f9baae0a9089c89ff04eb
OPENSCAD_VERSION=2026.10.11
OPENSCAD_SHA256=35b7248e033563cbb6dc0dbe562ef37deeca13bc98de27f64ec9126f13ecad0c
LAN_CIDR="${LAN_CIDR:-192.168.0.0/24}"

HERE="$(cd "$(dirname "$0")" && pwd)"
INFRA="$HERE/../infrastructure/agent-vm"
WORKSPACE="$HOME/khe"
UNIT_DIR="$HOME/.config/systemd/user"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }
step() { echo; echo "== $*"; }

[ "$(id -u)" -ne 0 ] || fail "run as khe, not root; the script uses sudo where it must"
[ "$(whoami)" = khe ] || fail "run as the user khe"
[ -d "$INFRA" ] || fail "$INFRA is missing; copy scripts/ and infrastructure/agent-vm/ together"
# Not `sudo -v`: with the sudo group's password rule also matching, -v asks
# for a password even though cloud-init gave khe NOPASSWD.
sudo -n true || fail "khe needs passwordless sudo (cloud-init sets it)"

# Downloads $1 to $3 and fails unless its sha256 is $2.
fetch_verified() {
  curl -fsSL --retry 3 -o "$3" "$1"
  echo "$2  $3" | sha256sum -c - >/dev/null || fail "checksum mismatch for $1"
}

# Fetches the AppImage at $2 (sha256 $3), unpacks it into /usr/local/lib/$1
# and puts /usr/local/bin/$4 in front of its AppRun, so no FUSE is needed. A
# rerun with the same $1 skips the fetch and the unpack.
install_appimage() {
  local dir="/usr/local/lib/$1"
  if [ ! -x "$dir/AppRun" ]; then
    fetch_verified "$2" "$3" "$TMP/$1.AppImage"
    chmod +x "$TMP/$1.AppImage"
    # --appimage-extract writes squashfs-root into the current folder.
    (cd "$TMP" && "./$1.AppImage" --appimage-extract >/dev/null)
    sudo rm -rf "$dir"
    sudo mv "$TMP/squashfs-root" "$dir"
    sudo chown -R root:root "$dir"
    # The image's own modes can leave folders 700, and khe runs the tools.
    sudo chmod -R a+rX "$dir"
  fi
  printf '#!/bin/sh\nexec %s/AppRun "$@"\n' "$dir" | sudo tee "/usr/local/bin/$4" >/dev/null
  sudo chmod 755 "/usr/local/bin/$4"
}

# --- System -----------------------------------------------------------------

step "Packages"
sudo apt-get update
sudo apt-get install -y git jq gawk curl ca-certificates gnupg xz-utils unzip \
  python3 python3-venv python3-pip python3-dev build-essential libffi-dev libssl-dev \
  gh tmux ufw unattended-upgrades bubblewrap socat \
  libopengl0 libgl1 libegl1 libwebkit2gtk-4.1-0 chromium

step "Node $NODE_VERSION"
if [ "$(node --version 2>/dev/null || true)" != "v$NODE_VERSION" ]; then
  fetch_verified "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-x64.tar.xz" \
    "$NODE_SHA256" "$TMP/node.tar.xz"
  sudo tar -xJf "$TMP/node.tar.xz" -C /usr/local --strip-components=1 --no-same-owner \
    --exclude='*/CHANGELOG.md' --exclude='*/LICENSE' --exclude='*/README.md'
fi
node --version

step "gitleaks $GITLEAKS_VERSION"
if [ "$(gitleaks version 2>/dev/null || true)" != "$GITLEAKS_VERSION" ]; then
  fetch_verified "https://github.com/gitleaks/gitleaks/releases/download/v$GITLEAKS_VERSION/gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz" \
    "$GITLEAKS_SHA256" "$TMP/gitleaks.tar.gz"
  tar -xzf "$TMP/gitleaks.tar.gz" -C "$TMP" gitleaks
  sudo install -m 755 "$TMP/gitleaks" /usr/local/bin/gitleaks
fi
gitleaks version

step "mcp-grafana v$MCP_GRAFANA_VERSION"
if ! mcp-grafana --version 2>/dev/null | grep -q "$MCP_GRAFANA_VERSION"; then
  fetch_verified "https://github.com/grafana/mcp-grafana/releases/download/v$MCP_GRAFANA_VERSION/mcp-grafana_Linux_x86_64.tar.gz" \
    "$MCP_GRAFANA_SHA256" "$TMP/mcp-grafana.tar.gz"
  tar -xzf "$TMP/mcp-grafana.tar.gz" -C "$TMP" mcp-grafana
  sudo install -m 755 "$TMP/mcp-grafana" /usr/local/bin/mcp-grafana
fi

step "OrcaSlicer $ORCA_VERSION"
install_appimage "orca-slicer-$ORCA_VERSION" \
  "https://github.com/OrcaSlicer/OrcaSlicer/releases/download/v$ORCA_VERSION/OrcaSlicer_Linux_AppImage_Ubuntu2404_V$ORCA_VERSION.AppImage" \
  "$ORCA_SHA256" orca-slicer
orca-slicer --help >/dev/null || echo "WARN: orca-slicer does not start here"

step "OpenSCAD $OPENSCAD_VERSION"
# Snapshots are pruned in time: a failed fetch warns and the setup goes on.
if (install_appimage "openscad-$OPENSCAD_VERSION" \
  "https://files.openscad.org/snapshots/OpenSCAD-$OPENSCAD_VERSION-x86_64.AppImage" \
  "$OPENSCAD_SHA256" openscad); then
  openscad --version || echo "WARN: openscad does not start here"
else
  echo "WARN: OpenSCAD $OPENSCAD_VERSION was not installed; pin a current snapshot"
fi

step "Playwright system libraries"
sudo env "PATH=/usr/local/bin:/usr/bin:/bin" npx --yes "playwright@$PLAYWRIGHT_DEPS_VERSION" install-deps chromium

step "sshd: keys only"
sudo tee /etc/ssh/sshd_config.d/10-agent-vm.conf >/dev/null <<'EOF'
# Managed by scripts/setup-agent-vm.sh
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
EOF
sudo sshd -t
sudo systemctl reload ssh

step "Firewall: ssh from the LAN and the tailnet only"
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow from "$LAN_CIDR" to any port 22 proto tcp
sudo ufw allow in on tailscale0 to any port 22 proto tcp
sudo ufw --force enable

step "Security updates install themselves, no automatic reboot"
sudo tee /etc/apt/apt.conf.d/20auto-upgrades >/dev/null <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
echo 'Unattended-Upgrade::Automatic-Reboot "false";' | sudo tee /etc/apt/apt.conf.d/51auto-reboot >/dev/null
# Not `| grep -q`: under pipefail, grep closing the pipe early can fail the
# pipeline with SIGPIPE although the line is there.
apt-config dump | grep '^Unattended-Upgrade::Origins-Pattern:: ".*-security' >/dev/null ||
  fail "unattended-upgrades allows no security origin"

step "Tailscale (plain node, no routes; MagicDNS resolves docker-vm)"
if ! command -v tailscale >/dev/null; then
  curl -fsSL https://pkgs.tailscale.com/stable/debian/trixie.noarmor.gpg \
    | sudo tee /usr/share/keyrings/tailscale-archive-keyring.gpg >/dev/null
  curl -fsSL https://pkgs.tailscale.com/stable/debian/trixie.tailscale-keyring.list \
    | sudo tee /etc/apt/sources.list.d/tailscale.list >/dev/null
  sudo apt-get update
  sudo apt-get install -y tailscale
fi
if ! tailscale status >/dev/null 2>&1; then
  echo "Open the login link below. The operator then disables this node's key expiry in the admin console."
  sudo tailscale up --netfilter-mode=nodivert --timeout=10m || fail "tailscale is not logged in; rerun this script"
fi
# nodivert: tailscaled's own chain would accept every tailnet packet before
# ufw, so a port a session opens would be open to the whole tailnet. Its
# WireGuard port then needs its own ufw rule for direct, unrelayed paths.
sudo tailscale set --netfilter-mode=nodivert
sudo ufw allow 41641/udp comment 'tailscale direct' >/dev/null
tailscale status | sed -n '1,3p'

step "Linger, so the user units run without a login"
sudo loginctl enable-linger khe

# --- Claude Code --------------------------------------------------------------

step "Claude Code $CLAUDE_VERSION"
export PATH="$HOME/.local/bin:$PATH"
if [ "$(claude --version 2>/dev/null | awk '{print $1}')" != "$CLAUDE_VERSION" ]; then
  curl -fsSL -o "$TMP/claude-install.sh" https://claude.ai/install.sh
  bash "$TMP/claude-install.sh" "$CLAUDE_VERSION"
fi
claude --version

# The template owns the permission rules and the sandbox: a rule dropped from
# it is dropped here too, and an "always allow" given in a session does not
# survive a rerun.
step "Claude settings from the template"
mkdir -p "$HOME/.claude"
[ -f "$HOME/.claude/settings.json" ] && cp "$HOME/.claude/settings.json" "$TMP/current.json" || echo '{}' > "$TMP/current.json"
jq -s '.[1] as $t | (.[0] * $t) | .permissions = $t.permissions | .sandbox = $t.sandbox' \
  "$TMP/current.json" "$INFRA/claude-settings.json" > "$TMP/settings.json"
install -m 600 "$TMP/settings.json" "$HOME/.claude/settings.json"

step "Git identity"
install -d "$HOME/.config/git"
git_name="${GIT_USER_NAME:-$(git config --global user.name || true)}"
git_email="${GIT_USER_EMAIL:-$(git config --file "$HOME/.config/git/khe.gitconfig" user.email || true)}"
[ -n "$git_name" ] && [ -n "$git_email" ] ||
  fail "set GIT_USER_NAME and GIT_USER_EMAIL (the GitHub noreply address) on the first run"
git config --global user.name "$git_name"
# shellcheck disable=SC2088 # git expands the tilde in include paths itself
git config --global "includeIf.gitdir:~/khe/.path" "~/.config/git/khe.gitconfig"
git config --file "$HOME/.config/git/khe.gitconfig" user.email "$git_email"

step "ssh key for khe@docker-vm"
install -d -m 700 "$HOME/.ssh"
DOCKER_KEY="$HOME/.ssh/id_ed25519_docker_vm"
# No passphrase: the key is used under systemd, which has no ssh-agent.
[ -f "$DOCKER_KEY" ] || ssh-keygen -q -t ed25519 -N '' -C "agent-vm to docker-vm" -f "$DOCKER_KEY"
if ! grep -q '^Host docker-vm$' "$HOME/.ssh/config" 2>/dev/null; then
  cat >> "$HOME/.ssh/config" <<EOF
Host docker-vm
  User khe
  IdentityFile $DOCKER_KEY
  IdentitiesOnly yes
  StrictHostKeyChecking accept-new
EOF
  chmod 600 "$HOME/.ssh/config"
fi
echo "The operator or agent authorises this key on docker-vm (append to khe's authorized_keys):"
cat "$DOCKER_KEY.pub"
ssh-keygen -l -f "$DOCKER_KEY.pub"

step "Units, the auth check and its heartbeat file"
# A rerun refreshes these copies of lib.sh and the check.
sudo install -d -m 755 /usr/local/lib/khe
sudo install -m 644 "$HERE/lib.sh" /usr/local/lib/khe/lib.sh
sudo install -m 755 "$HERE/agent-vm-auth-check.sh" /usr/local/sbin/khe-agent-auth-check
sudo install -d -m 755 /etc/khe
# The URL is the monitor's push token: readable by khe only, filled in by hand.
[ -f /etc/khe/agent-vm.heartbeat ] ||
  echo '# HEARTBEAT_URL_AGENT_VM=<Uptime Kuma push URL>' | sudo tee /etc/khe/agent-vm.heartbeat >/dev/null
sudo chown root:khe /etc/khe/agent-vm.heartbeat
sudo chmod 640 /etc/khe/agent-vm.heartbeat
install -d "$UNIT_DIR"
# remote-control.service is installed but not enabled: the first run needs the
# operator's go-ahead at its prompts (infrastructure/agent-vm.md). An existing
# one is kept, because the tmux form may have been installed in its place.
[ -f "$UNIT_DIR/remote-control.service" ] || install -m 644 "$INFRA/remote-control.service" "$UNIT_DIR/"
install -m 644 "$INFRA/auth-check.service" "$INFRA/auth-check.timer" "$UNIT_DIR/"
XDG_RUNTIME_DIR="/run/user/$(id -u)"
export XDG_RUNTIME_DIR
systemctl --user daemon-reload
systemctl --user enable --now auth-check.timer

# --- Workspace ---------------------------------------------------------------

step "Workspace"
if ! gh auth status >/dev/null 2>&1; then
  echo "gh is not logged in. Run 'gh auth login' (the operator opens the link),"
  echo "then rerun this script to clone the workspace and install each repo."
  exit 0
fi
gh auth setup-git
[ -d "$WORKSPACE/.git" ] || git clone https://github.com/khelias/khe-workspace.git "$WORKSPACE"
(cd "$WORKSPACE" && bash scripts/workspace.sh clone)

# npm ci wipes node_modules, so a rerun skips a repo whose install is current.
for lock in "$WORKSPACE"/repos/*/package-lock.json; do
  [ -f "$lock" ] || continue
  repo="$(dirname "$lock")"
  [ "$repo/node_modules/.package-lock.json" -nt "$lock" ] && continue
  echo "-- $(basename "$repo"): npm ci"
  (
    cd "$repo"
    npm ci
    ! grep -q '"@playwright/test"' package.json || npx playwright install chromium
  )
done

if [ -f "$WORKSPACE/repos/ha-estfeed/pyproject.toml" ]; then
  echo "-- ha-estfeed: .venv"
  # ha-estfeed follows Home Assistant's Python, which can be newer than
  # Debian's. When pip refuses, the repo is skipped and its commits stay with
  # the laptop; the venv is removed so a later run starts clean.
  venv="$WORKSPACE/repos/ha-estfeed/.venv"
  [ -d "$venv" ] || python3 -m venv "$venv"
  if ! "$venv/bin/pip" install --quiet -e "$WORKSPACE/repos/ha-estfeed[dev]"; then
    rm -rf "$venv"
    echo "   skipped: ha-estfeed needs a newer Python than this VM's $(python3 -V 2>&1 | cut -d' ' -f2)"
  fi
fi

tales="$WORKSPACE/repos/khe-bunny-tales"
if [ -f "$tales/requirements.txt" ]; then
  echo "-- khe-bunny-tales: .venv"
  [ -d "$tales/.venv" ] || python3 -m venv "$tales/.venv"
  "$tales/.venv/bin/pip" install --quiet -r "$tales/requirements.txt"
  # The stories app at app.ref with its node_modules in .app/, so the
  # commit gate's check runs the leak check's build test instead of skipping it.
  echo "-- khe-bunny-tales: the stories app"
  (cd "$tales" && scripts/build_app.sh output)
fi

ha="$WORKSPACE/repos/khe-home-assistant"
if [ -f "$ha/.github/workflows/ci.yml" ]; then
  echo "-- khe-home-assistant: .venv"
  # One venv for the check's ruff and the HA scripts' websockets. The sandbox
  # template runs the HA scripts outside the sandbox only through this path.
  ruff_pin="$(grep -m 1 -o 'ruff==[0-9.]*' "$ha/.github/workflows/ci.yml" || true)"
  [ -n "$ruff_pin" ] || fail "no ruff pin in khe-home-assistant's ci.yml"
  [ -d "$ha/.venv" ] || python3 -m venv "$ha/.venv"
  "$ha/.venv/bin/pip" install --quiet "$ruff_pin" "websockets==$WEBSOCKETS_VERSION"
fi

# The two printer scripts run outside the sandbox (estate ADR-050), so the
# sandbox runs root-owned copies a session cannot change. They come from
# khe-meta's origin/main, never the working tree a session can edit, and a
# change is shown and installed only on the operator's yes.
meta="$WORKSPACE/repos/khe-meta"
K2_LIB=/usr/local/lib/khe/k2
if [ -d "$meta/.git" ]; then
  echo "-- K2 printer scripts"
  # The checkout's own hooks and fsmonitor stay off, as in workspace.sh.
  kgit=(git -C "$meta" -c core.hooksPath=/dev/null -c core.fsmonitor=false --no-replace-objects)
  "${kgit[@]}" fetch -q origin main
  sudo install -d -m 755 "$K2_LIB"
  mkdir "$TMP/k2"
  # Replace refs are ignored (--no-replace-objects): a session can write them.
  for f in k2.py k2_camera.py k2_gcode.py k2_snapshot.py; do
    "${kgit[@]}" show "origin/main:house/k2-printer/$f" > "$TMP/k2/$f"
  done
  # A control character could hide a line from the diff on the terminal.
  if LC_ALL=C grep -q $'[\x01-\x08\x0b-\x1f\x7f]' "$TMP"/k2/*.py; then
    echo "   not installed: a script holds a control character"
  elif diff -ruN "$K2_LIB" "$TMP/k2"; then
    echo "   unchanged"
  else
    "${kgit[@]}" log --format='   %h %an %ad %s' --date=short -10 origin/main -- house/k2-printer/
    answer=n
    [ ! -t 0 ] || read -r -p "Install these K2 printer scripts from khe-meta $("${kgit[@]}" rev-parse --short origin/main)? [y/N] " answer
    if [ "$answer" = y ]; then
      sudo install -m 644 "$TMP"/k2/*.py "$K2_LIB/"
    else
      echo "   not installed; the copies in $K2_LIB stay as they were"
    fi
  fi
fi

# User scope, so sessions in a repo worktree see it too.
if ! claude mcp get grafana >/dev/null 2>&1; then
  claude mcp add grafana --scope user -- "$WORKSPACE/repos/khe-homelab/scripts/mcp-grafana.sh"
fi

echo
echo "=== agent-vm is set up ==="
echo "Still the operator's: claude auth login, a Grafana Viewer token in ~/.config/khe/grafana-token,"
echo "the printer's address in ~/.config/khe/k2-printer.json,"
echo "authorising the docker-vm key above, and the first remote-control run"
echo "(infrastructure/agent-vm.md)."
