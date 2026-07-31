#!/usr/bin/env bash
# Build and deploy only the main-branch backend to a bootstrapped Ubuntu EC2
# instance. Vercel continues serving the web and admin applications.
#
# Usage after creating a Neon restore point:
#   NEON_BACKUP_CONFIRMED=yes SERVER_HOST=<elastic-ip> \
#     SSH_KEY=~/.ssh/upnod-aws.pem ./deploy.sh

set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

SERVER_USER="${SERVER_USER:-ubuntu}"
SERVER_HOST="${SERVER_HOST:?Set SERVER_HOST to the EC2 Elastic IP or hostname}"
SSH_KEY="${SSH_KEY:-}"
SSH_KNOWN_HOSTS="${SSH_KNOWN_HOSTS:-}"
SSH_PORT="${SSH_PORT:-22}"
API_HOST="${API_HOST:-api-interview.referconnect.in}"
NEON_BACKUP_CONFIRMED="${NEON_BACKUP_CONFIRMED:-no}"
ALLOW_UNCOMMITTED="${ALLOW_UNCOMMITTED:-no}"
REMOTE="$SERVER_USER@$SERVER_HOST"

[[ "$SERVER_USER" =~ ^[a-z_][a-z0-9_-]*$ ]] || {
  echo "Invalid SERVER_USER." >&2
  exit 1
}
[[ "$SERVER_HOST" =~ ^[A-Za-z0-9._-]+$ ]] || {
  echo "Invalid SERVER_HOST." >&2
  exit 1
}
[[ "$SSH_PORT" =~ ^[0-9]+$ ]] || {
  echo "Invalid SSH_PORT." >&2
  exit 1
}
[[ "$API_HOST" =~ ^[A-Za-z0-9.-]+$ ]] || {
  echo "Invalid API_HOST." >&2
  exit 1
}
[[ "$NEON_BACKUP_CONFIRMED" == "yes" ]] || {
  echo "Refusing to deploy until a current Neon restore point/branch exists." >&2
  echo "After creating it, set NEON_BACKUP_CONFIRMED=yes." >&2
  exit 1
}

SSH_ARGS=(
  -p "$SSH_PORT"
  -o BatchMode=yes
  -o ConnectTimeout=10
)
RSYNC_SSH="ssh -p $SSH_PORT -o BatchMode=yes -o ConnectTimeout=10"

# Host-key verification (finding F13).
# When SSH_KNOWN_HOSTS points at a file containing the target's host key,
# require an exact match and fail closed on mismatch. Provision that file
# out of band once per host — e.g. `ssh-keyscan -p 22 $SERVER_HOST > known_hosts`
# reviewed against the fingerprint AWS shows for the instance — then export
# SSH_KNOWN_HOSTS=/path/to/known_hosts before running this script. Only fall
# back to trust-on-first-use (`accept-new`) when SSH_KNOWN_HOSTS is empty and
# ALLOW_TOFU_HOST_KEY=yes is set explicitly, so a first bootstrap can still
# work but no later deploy silently accepts a rogue key.
if [[ -n "$SSH_KNOWN_HOSTS" ]]; then
  [[ -f "$SSH_KNOWN_HOSTS" ]] || {
    echo "SSH_KNOWN_HOSTS does not exist: $SSH_KNOWN_HOSTS" >&2
    exit 1
  }
  [[ "$SSH_KNOWN_HOSTS" != *[[:space:]]* ]] || {
    echo "SSH_KNOWN_HOSTS paths containing whitespace are not supported." >&2
    exit 1
  }
  SSH_ARGS+=(
    -o StrictHostKeyChecking=yes
    -o UserKnownHostsFile="$SSH_KNOWN_HOSTS"
    -o GlobalKnownHostsFile=/dev/null
  )
  RSYNC_SSH+=" -o StrictHostKeyChecking=yes -o UserKnownHostsFile=$SSH_KNOWN_HOSTS -o GlobalKnownHostsFile=/dev/null"
elif [[ "${ALLOW_TOFU_HOST_KEY:-no}" == "yes" ]]; then
  echo "WARNING: SSH_KNOWN_HOSTS is unset and ALLOW_TOFU_HOST_KEY=yes — accepting" >&2
  echo "         the remote host key on first sight. A MITM at this moment would" >&2
  echo "         be silently trusted. Set SSH_KNOWN_HOSTS on every subsequent deploy." >&2
  SSH_ARGS+=(-o StrictHostKeyChecking=accept-new)
  RSYNC_SSH+=" -o StrictHostKeyChecking=accept-new"
else
  echo "Refusing to deploy without a pinned host key. Set SSH_KNOWN_HOSTS to a file" >&2
  echo "containing the target's public host key (from an out-of-band verification of" >&2
  echo "the fingerprint), or set ALLOW_TOFU_HOST_KEY=yes for a first-bootstrap deploy." >&2
  exit 1
fi
if [[ -n "$SSH_KEY" ]]; then
  [[ -f "$SSH_KEY" ]] || {
    echo "SSH_KEY does not exist: $SSH_KEY" >&2
    exit 1
  }
  [[ "$SSH_KEY" != *[[:space:]]* ]] || {
    echo "SSH_KEY paths containing whitespace are not supported." >&2
    exit 1
  }
  SSH_ARGS+=(-i "$SSH_KEY" -o IdentitiesOnly=yes)
  RSYNC_SSH+=" -i $SSH_KEY -o IdentitiesOnly=yes"
fi

if [[ "$ALLOW_UNCOMMITTED" == "yes" ]]; then
  DIRTY_MARKER="-dirty"
  echo "WARNING: ALLOW_UNCOMMITTED=yes — deploying the local worktree as-is and" >&2
  echo "         bypassing the branch/clean/origin checks. Commit these changes to" >&2
  echo "         the repository afterwards so the release is reproducible." >&2
else
  DIRTY_MARKER=""
  CURRENT_BRANCH="$(git branch --show-current)"
  if [[ "$CURRENT_BRANCH" != "main" ]]; then
    echo "Refusing to deploy branch '$CURRENT_BRANCH'; checkout main first." >&2
    exit 1
  fi

  if [[ -n "$(git status --porcelain --untracked-files=all)" ]]; then
    echo "Refusing to deploy a dirty worktree. Commit or remove every local change first." >&2
    git status --short >&2
    exit 1
  fi

  echo "==> Verifying main against the current remote branch..."
  git fetch --quiet origin main
  if [[ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]]; then
    echo "Refusing to deploy: local main does not exactly match origin/main." >&2
    exit 1
  fi
fi

REMOTE_HOME="$(ssh "${SSH_ARGS[@]}" "$REMOTE" \
  "getent passwd '$SERVER_USER' | cut -d: -f6")"
[[ "$REMOTE_HOME" =~ ^/[A-Za-z0-9._/-]+$ ]] || {
  echo "Could not safely resolve the remote home directory." >&2
  exit 1
}
APP_ROOT="$REMOTE_HOME/interview-assistant/backend"

command -v openssl >/dev/null || {
  echo "Local openssl is required to generate a unique release ID." >&2
  exit 1
}
COMMIT="$(git rev-parse --short=12 HEAD)"
RELEASE_ID="${COMMIT}${DIRTY_MARKER}-$(date -u +%Y%m%d%H%M%S)-$(openssl rand -hex 4)"
RELEASE_DIR="$APP_ROOT/releases/$RELEASE_ID"

echo "==> Building backend from main at $COMMIT..."
(
  cd backend
  npm ci
  npm run typecheck
  npm run build
)

echo "==> Checking the EC2 host and protected environment file..."
ssh "${SSH_ARGS[@]}" "$REMOTE" "APP_ROOT='$APP_ROOT' RELEASE_DIR='$RELEASE_DIR' bash -s" <<'REMOTE_CHECK'
set -euo pipefail
for command_name in node npm nginx pm2 rsync curl flock; do
  command -v "$command_name" >/dev/null || {
    echo "Missing server dependency: $command_name. Run scripts/aws/bootstrap-ec2.sh first." >&2
    exit 1
  }
done
[[ -f "$APP_ROOT/shared/.env" ]] || {
  echo "Missing $APP_ROOT/shared/.env; copy the DigitalOcean backend environment securely first." >&2
  exit 1
}
[[ "$(stat -c '%a' "$APP_ROOT/shared/.env")" == "600" ]] || {
  echo "$APP_ROOT/shared/.env must have permission 600." >&2
  exit 1
}
[[ ! -e "$RELEASE_DIR" ]] || {
  echo "Release directory already exists: $RELEASE_DIR" >&2
  exit 1
}
mkdir -m 0755 "$RELEASE_DIR"
mkdir -m 0755 "$RELEASE_DIR/dist" "$RELEASE_DIR/migrations"
REMOTE_CHECK

echo "==> Uploading immutable release $RELEASE_ID..."
rsync -az --delete -e "$RSYNC_SSH" \
  backend/dist/ "$REMOTE:$RELEASE_DIR/dist/"
rsync -az --delete -e "$RSYNC_SSH" \
  backend/migrations/ "$REMOTE:$RELEASE_DIR/migrations/"
rsync -az -e "$RSYNC_SSH" \
  backend/package.json \
  backend/package-lock.json \
  backend/ecosystem.config.cjs \
  "$REMOTE:$RELEASE_DIR/"
rsync -az -e "$RSYNC_SSH" \
  nginx.conf \
  nginx-proxy.conf \
  "$REMOTE:$APP_ROOT/shared/"

echo "==> Installing production dependencies and activating the release..."
ssh "${SSH_ARGS[@]}" "$REMOTE" \
  "APP_ROOT='$APP_ROOT' RELEASE_DIR='$RELEASE_DIR' RELEASE_ID='$RELEASE_ID' API_HOST='$API_HOST' bash -s" <<'REMOTE_DEPLOY'
set -Eeuo pipefail

APP_NAME="interview-assistant-backend"
ACTIVATED=false
ROLLBACK_RUNNING=false

exec 9>"$APP_ROOT/shared/deploy.lock"
if ! flock -n 9; then
  echo "Another deployment is currently activating a release." >&2
  exit 1
fi

PREVIOUS_RELEASE="$(readlink -f "$APP_ROOT/current" 2>/dev/null || true)"

wait_for_health() {
  for _attempt in $(seq 1 45); do
    if curl -fsS http://127.0.0.1:8787/health >/dev/null; then
      return 0
    fi
    sleep 2
  done
  return 1
}

start_release() {
  local config="$1/ecosystem.config.cjs"
  # Delete any existing app before starting. `pm2 restart <ecosystem>` does NOT
  # re-point an already-running app to a new release's script/cwd, so a plain
  # restart keeps executing the previous release (the exact bug that left
  # /auth/google 404ing after a deploy). Deleting first forces PM2 to adopt the
  # new release directory, resolved via the ecosystem's __dirname.
  pm2 delete "$APP_NAME" >/dev/null 2>&1 || true
  pm2 start "$config" --env production
}

rollback_application() {
  ROLLBACK_RUNNING=true
  echo "Restoring the previous application release." >&2
  if [[ -n "$PREVIOUS_RELEASE" && -d "$PREVIOUS_RELEASE" ]]; then
    ln -sfn "$PREVIOUS_RELEASE" "$APP_ROOT/current.rollback.$RELEASE_ID"
    mv -Tf "$APP_ROOT/current.rollback.$RELEASE_ID" "$APP_ROOT/current"
    if ! start_release "$APP_ROOT/current"; then
      echo "CRITICAL: PM2 could not restart the previous release." >&2
      return 1
    fi
    if ! wait_for_health; then
      echo "CRITICAL: the previous release did not recover its health endpoint." >&2
      return 1
    fi
    pm2 save || true
  else
    pm2 delete "$APP_NAME" >/dev/null 2>&1 || true
    rm -f "$APP_ROOT/current"
  fi
}

on_deploy_error() {
  local exit_code=$?
  trap - ERR
  if [[ "$ACTIVATED" == true && "$ROLLBACK_RUNNING" != true ]]; then
    set +e
    rollback_application
    local rollback_code=$?
    set -e
    if [[ "$rollback_code" -ne 0 ]]; then
      echo "Manual recovery is required. Database migrations are not automatically reversed." >&2
    fi
  fi
  exit "$exit_code"
}
trap on_deploy_error ERR

ln -s "$APP_ROOT/shared/.env" "$RELEASE_DIR/.env"
cd "$RELEASE_DIR"
npm ci --omit=dev --no-audit --no-fund

NEXT_LINK="$APP_ROOT/current.$RELEASE_ID"
ln -sfn "$RELEASE_DIR" "$NEXT_LINK"
mv -Tf "$NEXT_LINK" "$APP_ROOT/current"
ACTIVATED=true

start_release "$APP_ROOT/current"
if ! wait_for_health; then
  pm2 logs "$APP_NAME" --lines 80 --nostream || true
  false
fi

NGINX_SITE=/etc/nginx/sites-available/upnod-api
NGINX_ENABLED=/etc/nginx/sites-enabled/upnod-api
NGINX_PROXY=/etc/nginx/snippets/upnod-api-proxy.conf
PROXY_BACKUP="$APP_ROOT/shared/nginx-proxy.$RELEASE_ID.backup"
SITE_CREATED=false
PROXY_EXISTED=false

if sudo test -f "$NGINX_PROXY"; then
  sudo cp "$NGINX_PROXY" "$PROXY_BACKUP"
  PROXY_EXISTED=true
fi
sudo install -m 0644 "$APP_ROOT/shared/nginx-proxy.conf" "$NGINX_PROXY.new"
sudo mv "$NGINX_PROXY.new" "$NGINX_PROXY"

if ! sudo test -f "$NGINX_SITE"; then
  sed "s/__API_HOST__/$API_HOST/g" "$APP_ROOT/shared/nginx.conf" \
    > "$APP_ROOT/shared/nginx-site.rendered"
  sudo install -m 0644 "$APP_ROOT/shared/nginx-site.rendered" "$NGINX_SITE"
  sudo ln -sfn "$NGINX_SITE" "$NGINX_ENABLED"
  sudo rm -f /etc/nginx/sites-enabled/default
  SITE_CREATED=true
fi

if ! sudo nginx -t; then
  if [[ "$PROXY_EXISTED" == true ]]; then
    sudo install -m 0644 "$PROXY_BACKUP" "$NGINX_PROXY"
  else
    sudo rm -f "$NGINX_PROXY"
  fi
  if [[ "$SITE_CREATED" == true ]]; then
    sudo rm -f "$NGINX_ENABLED" "$NGINX_SITE"
  fi
  sudo nginx -t || true
  false
fi
sudo systemctl reload nginx

if sudo test -f "/etc/letsencrypt/live/$API_HOST/fullchain.pem"; then
  curl -fsS --resolve "$API_HOST:443:127.0.0.1" \
    "https://$API_HOST/health" >/dev/null
else
  curl -fsS -H "Host: $API_HOST" http://127.0.0.1/health >/dev/null
fi

pm2 save
rm -f "$PROXY_BACKUP"
ACTIVATED=false
trap - ERR

printf 'Active release: %s\n' "$RELEASE_DIR"
printf 'Local health:  http://127.0.0.1:8787/health\n'
if sudo test -f "/etc/letsencrypt/live/$API_HOST/fullchain.pem"; then
  printf 'Proxy health:  https://%s/health\n' "$API_HOST"
else
  printf 'Proxy health:  HTTP health only; issue the TLS certificate before cutover.\n'
fi
REMOTE_DEPLOY

echo
echo "Deployment succeeded for release $RELEASE_ID."
echo "Before DNS cutover, test the Elastic IP with:"
echo "  curl -H 'Host: $API_HOST' http://$SERVER_HOST/health"
