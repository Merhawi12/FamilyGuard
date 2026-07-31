#!/usr/bin/env bash
#
# One-time host setup for a Compute Engine instance running Debian 12
# (the default GCE image family). Safe to re-run.
#
#   ./bootstrap.sh
#
# Installs Docker and the compose plugin, adds swap so the frontend build does
# not get OOM-killed on a small machine type, and caps container log growth.
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  exec sudo -E "$0" "$@"
fi

REAL_USER=${SUDO_USER:-$(logname 2>/dev/null || echo debian)}

export DEBIAN_FRONTEND=noninteractive

echo "==> Installing packages"
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg git

echo "==> Installing Docker"
# Debian's own docker.io package lags and does not ship the compose v2 plugin,
# so use Docker's repository. `docker-compose` (the old Python v1) is a
# different tool and will not read this project's compose file.
install -m 0755 -d /etc/apt/keyrings
if [[ ! -f /etc/apt/keyrings/docker.asc ]]; then
  curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
fi

cat > /etc/apt/sources.list.d/docker.list <<EOF
deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable
EOF

apt-get update -qq
apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

echo "==> Capping container log size"
# Default json-file logging is unbounded; on a small boot disk a chatty
# container will fill it and take Postgres down with it.
cat > /etc/docker/daemon.json <<'JSON'
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "3" }
}
JSON

systemctl enable --now docker
systemctl restart docker
usermod -aG docker "$REAL_USER"

# Vite's production build of the two SPAs needs well over the 1 GB an e2-micro
# has. Swap is far slower than RAM, but it is the difference between a build
# that finishes and one the kernel kills halfway through.
if ! swapon --show=NAME --noheadings | grep -qx /swapfile; then
  echo "==> Creating 2G swapfile"
  fallocate -l 2G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=2048
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "==> Installing nightly backup timer"
UNIT_DIR=$(cd "$(dirname "$0")" && pwd)
sed "s#__DEPLOY_DIR__#${UNIT_DIR}#" "${UNIT_DIR}/parentix-backup.service.in" \
  > /etc/systemd/system/parentix-backup.service
install -m 644 "${UNIT_DIR}/parentix-backup.timer" /etc/systemd/system/parentix-backup.timer
systemctl daemon-reload
systemctl enable --now parentix-backup.timer

cat <<EOF

Done.

  RAM:  $(free -h | awk '/^Mem:/{print $2}')   swap: $(free -h | awk '/^Swap:/{print $2}')
  Disk: $(df -h / | awk 'NR==2{print $4" free of "$2}')

Next:
  1. Log out and back in so '${REAL_USER}' picks up the docker group.
  2. cp .env.example .env && chmod 600 .env   # then fill it in
  3. Point DNS at this instance, then ./deploy.sh
EOF
