#!/usr/bin/env bash
# Raspberry Pi ilk kurulum. Pi üzerinde çalıştır:
#   curl -fsSL <repo-raw>/deploy/setup-pi.sh | bash   # veya repo klonladıktan sonra ./deploy/setup-pi.sh
set -euo pipefail

REPO_URL="${REPO_URL:-git@github.com:fthsrbst/ai-hub.git}"
APP_DIR="$HOME/ai-hub"

echo "== Node 22 kontrol =="
if ! command -v node >/dev/null || [[ "$(node -v | cut -c2-3)" -lt 22 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
node -v

echo "== Repo =="
if [[ -d "$APP_DIR/.git" ]]; then
  git -C "$APP_DIR" pull
else
  git clone "$REPO_URL" "$APP_DIR"
fi
cd "$APP_DIR"

echo "== Bağımlılıklar + build =="
npm ci
npm run build
(cd web && npm ci && npm run build)

echo "== .env =="
if [[ ! -f .env ]]; then
  TS_IP="$(tailscale ip -4 2>/dev/null | head -1 || echo 127.0.0.1)"
  TOKEN="$(openssl rand -hex 24)"
  cat > .env <<EOF
HUB_DB_PATH=$HOME/ai-hub/data/hub.db
HUB_HOST=$TS_IP
HUB_PORT=8033
HUB_TOKEN=$TOKEN
GEMINI_API_KEY=
EMBEDDING_DIM=768
EOF
  echo "!! .env oluşturuldu. GEMINI_API_KEY'i elle ekle: nano $APP_DIR/.env"
  echo "!! HUB_TOKEN: $TOKEN  (istemcilere bunu gir)"
fi

echo "== systemd =="
sudo cp deploy/hub.service "/etc/systemd/system/hub@$USER.service"
sudo systemctl daemon-reload
sudo systemctl enable --now "hub@$USER"
sleep 2
systemctl status "hub@$USER" --no-pager || true

echo "== Yedek cron =="
chmod +x deploy/backup.sh deploy/update.sh
(crontab -l 2>/dev/null | grep -v ai-hub/deploy/backup.sh; echo "0 3 * * * $APP_DIR/deploy/backup.sh >> $HOME/hub-backup.log 2>&1") | crontab -

echo "Bitti. Test: curl http://$(grep HUB_HOST .env | cut -d= -f2):8033/health"
