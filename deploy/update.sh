#!/usr/bin/env bash
# Pi üzerinde güncelleme: git pull + build + restart
set -euo pipefail
cd "$(dirname "$0")/.."
git pull
npm ci
npm run build
(cd web && npm ci && npm run build)
sudo systemctl restart "hub@$USER"
sleep 1
health_host="$(grep ^HUB_HOST .env | cut -d= -f2)"
if [[ "$health_host" == "0.0.0.0" || "$health_host" == "::" ]]; then
  health_host="127.0.0.1"
fi
curl -fsS "http://$health_host:$(grep ^HUB_PORT .env | cut -d= -f2)/health" && echo " ok"
