FROM ghcr.io/openclaw/openclaw:2026.4.12

# Install docker-ce-cli (official Docker apt repo) so exec-based skills can run
# docker commands. Mirrors the OPENCLAW_INSTALL_DOCKER_CLI=1 build arg from the
# official source Dockerfile — same GPG key, same packages.
# Only the CLI is installed. DOCKER_HOST in docker-compose.yml routes all docker
# calls through docker-socket-proxy (no daemon runs here).
USER root
ARG DOCKER_GPG_FINGERPRINT="9DC858229FC7DD38854AE2D88D81803C0EBFCD88"
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
    && install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/debian/gpg -o /tmp/docker.gpg.asc \
    && expected="$(printf '%s' "$DOCKER_GPG_FINGERPRINT" | tr '[:lower:]' '[:upper:]' | tr -d '[:space:]')" \
    && actual="$(gpg --batch --show-keys --with-colons /tmp/docker.gpg.asc | awk -F: '$1=="fpr"{print toupper($10);exit}')" \
    && [ -n "$actual" ] && [ "$actual" = "$expected" ] || { echo "Docker GPG key fingerprint mismatch" >&2; exit 1; } \
    && gpg --dearmor -o /etc/apt/keyrings/docker.gpg /tmp/docker.gpg.asc \
    && rm -f /tmp/docker.gpg.asc \
    && chmod a+r /etc/apt/keyrings/docker.gpg \
    && printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian bookworm stable\n' \
        "$(dpkg --print-architecture)" > /etc/apt/sources.list.d/docker.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends docker-ce-cli docker-compose-plugin \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*
USER node
