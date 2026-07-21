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
health_url="http://$health_host:$(grep ^HUB_PORT .env | cut -d= -f2)/health"

# Servis systemd tarafindan yeniden baslatildiktan sonra portu dinlemeye baslamasi
# birkac saniye suruyor (sema migrationlari ve vektor tablosu kontrolleri dahil).
# Tek seferlik curl bu pencerede basarisiz oluyor ve her deploy'da SAHTE bir hata
# raporluyordu; sahte hata veren bir saglik kontrolu zamanla gormezden gelinir.
for attempt in $(seq 1 15); do
  if curl -fsS --max-time 5 "$health_url"; then
    echo " ok (deneme $attempt)"
    exit 0
  fi
  sleep 2
done
echo "HATA: servis 30 saniye icinde saglikli yanit vermedi -> $health_url" >&2
echo "Tani icin: journalctl -u hub@\$USER -n 50 --no-pager" >&2
exit 1
