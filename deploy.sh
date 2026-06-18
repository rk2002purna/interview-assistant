#!/usr/bin/env bash
##
## deploy.sh — Build all three apps and deploy to ai-assistant.referconnect.in
##
## Usage:
##   chmod +x deploy.sh
##   SERVER_USER=ubuntu SERVER_HOST=<your-server-ip> ./deploy.sh
##
## Requirements on the server:
##   - Node.js 20+, nginx, pm2 (`npm install -g pm2`)
##   - Postgres database running and migrated
##   - /var/www/ai-assistant/{web,admin} directories created
##   - .env file present at ~/interview-assistant/backend/.env
##

set -euo pipefail

SERVER_USER="${SERVER_USER:-ubuntu}"
SERVER_HOST="${SERVER_HOST:?Set SERVER_HOST=<your-server-ip>}"
REMOTE="$SERVER_USER@$SERVER_HOST"
DEPLOY_PATH="/home/$SERVER_USER/interview-assistant"

echo "==> Building backend..."
cd backend
npm ci
npm run build
cd ..

echo "==> Building web-app..."
cd web-app
npm ci
npm run build   # picks up .env.production automatically
cd ..

echo "==> Building admin-dashboard..."
cd admin-dashboard
npm ci
npm run build   # picks up .env.production automatically
cd ..

echo "==> Uploading backend to $REMOTE..."
rsync -avz --exclude node_modules --exclude .env \
  backend/dist \
  backend/package.json \
  backend/package-lock.json \
  "$REMOTE:$DEPLOY_PATH/backend/"

echo "==> Uploading web-app dist to $REMOTE..."
rsync -avz --delete web-app/dist/ "$REMOTE:/var/www/ai-assistant/web/"

echo "==> Uploading admin-dashboard dist to $REMOTE..."
rsync -avz --delete admin-dashboard/dist/ "$REMOTE:/var/www/ai-assistant/admin/"

echo "==> Restarting backend with PM2..."
ssh "$REMOTE" bash <<'ENDSSH'
  cd ~/interview-assistant/backend
  npm ci --omit=dev
  pm2 restart interview-assistant-backend || pm2 start dist/server.js \
    --name interview-assistant-backend \
    --env production
  pm2 save
ENDSSH

echo "==> Reloading nginx..."
ssh "$REMOTE" "sudo nginx -t && sudo systemctl reload nginx"

echo ""
echo "✓ Deployed to https://ai-assistant.referconnect.in"
