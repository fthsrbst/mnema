#!/usr/bin/env bash
# Pi üzerinde güncelleme: git pull + build + restart
set -euo pipefail
cd "$(dirname "$0")/.."
git pull
npm ci
npm run build
sudo systemctl restart "hub@$USER"
sleep 1
curl -fsS "http://$(grep ^HUB_HOST .env | cut -d= -f2):$(grep ^HUB_PORT .env | cut -d= -f2)/health" && echo " ok"
