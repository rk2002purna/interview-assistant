#!/usr/bin/env bash
# Bootstrap a fresh Ubuntu 24.04 EC2 instance for the UpNod backend.
# Run as the normal SSH user (ubuntu), not as root.

set -euo pipefail

if [[ "$EUID" -eq 0 ]]; then
  echo "Run this script as the normal EC2 user, not with sudo." >&2
  exit 1
fi

DEPLOY_USER="${DEPLOY_USER:-$USER}"
DEPLOY_HOME="$(getent passwd "$DEPLOY_USER" | cut -d: -f6)"
DEPLOY_GROUP="$(id -gn "$DEPLOY_USER")"
APP_ROOT="$DEPLOY_HOME/interview-assistant/backend"
NODE_MAJOR=22
PM2_VERSION=6.0.8

if [[ -z "$DEPLOY_HOME" ]]; then
  echo "Could not resolve the home directory for $DEPLOY_USER." >&2
  exit 1
fi

echo "==> Refreshing Ubuntu packages..."
sudo apt-get update
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y \
  ca-certificates \
  certbot \
  curl \
  gnupg \
  nginx \
  python3-certbot-nginx \
  rsync \
  util-linux

echo "==> Installing Node.js ${NODE_MAJOR}.x from the NodeSource repository..."
curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
  -o /tmp/nodesource-repo.gpg.key
sudo install -d -m 0755 /etc/apt/keyrings
sudo gpg --dearmor --yes \
  -o /etc/apt/keyrings/nodesource.gpg \
  /tmp/nodesource-repo.gpg.key
rm -f /tmp/nodesource-repo.gpg.key
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
  | sudo tee /etc/apt/sources.list.d/nodesource.list >/dev/null
sudo apt-get update
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs

echo "==> Installing PM2 ${PM2_VERSION}..."
sudo npm install --global "pm2@${PM2_VERSION}"

echo "==> Creating release, secret, and log directories..."
sudo install -d -m 0755 -o "$DEPLOY_USER" -g "$DEPLOY_GROUP" \
  "$APP_ROOT" \
  "$APP_ROOT/releases" \
  "$APP_ROOT/shared"
sudo install -d -m 0755 -o "$DEPLOY_USER" -g "$DEPLOY_GROUP" /var/log/upnod

# copytruncate avoids signaling the user-owned PM2 daemon from root's
# logrotate process. maxsize also protects the small EC2 volume during bursts.
cat <<LOGROTATE | sudo tee /etc/logrotate.d/upnod >/dev/null
/var/log/upnod/*.log {
    su $DEPLOY_USER $DEPLOY_GROUP
    daily
    maxsize 20M
    rotate 7
    compress
    delaycompress
    missingok
    notifempty
    copytruncate
}
LOGROTATE
sudo chmod 0644 /etc/logrotate.d/upnod

echo "==> Enabling Nginx and PM2 startup..."
sudo systemctl enable --now nginx
sudo env PATH="$PATH:/usr/bin" pm2 startup systemd \
  -u "$DEPLOY_USER" \
  --hp "$DEPLOY_HOME" >/dev/null
sudo nginx -t

echo
echo "Bootstrap complete."
echo "Node: $(node --version)"
echo "npm:  $(npm --version)"
echo "PM2:  $(pm2 --version)"
echo
echo "Next: securely create $APP_ROOT/shared/.env with mode 600,"
echo "then run deploy.sh from the clean main-branch worktree on your Mac."
