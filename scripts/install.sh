#!/usr/bin/env bash
# AI Hub — sıfırdan kurulum (macOS/Linux).
#   curl -fsSL <repo-raw>/scripts/install.sh | bash
#   veya repo klonlanmışsa: ./scripts/install.sh
#
# Idempotent: ikinci çalıştırma güvenlidir (mevcut .env/servis dosyalarını korur).
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/fthsrbst/mnema.git}"

log() { echo -e "\n== $1 =="; }
have() { command -v "$1" >/dev/null 2>&1; }

# Evet/hayır sorusu. `curl | bash` ile çalışırken stdin script'in kendisidir —
# oradan read yapmak script satırlarını yutar; terminal varsa /dev/tty'den oku,
# yoksa (CI/tam otomatik) varsayılan Evet ile devam et.
ask_yn() {
  local ans=""
  if [[ -t 0 ]]; then
    read -r -p "$1 [Y/n] " ans
  elif [[ -r /dev/tty ]]; then
    read -r -p "$1 [Y/n] " ans < /dev/tty
  fi
  [[ "${ans:-Y}" =~ ^[Yy]$ ]]
}

# ---------------------------------------------------------------------------
# 0) Repo kökünü bul: script zaten klonlanmış bir repo içindeyse onu kullan,
#    değilse ~/ai-hub'a klonla.
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" >/dev/null 2>&1 && pwd)"
if [[ -f "$SCRIPT_DIR/../package.json" ]] && grep -q '"name": "ai-hub"' "$SCRIPT_DIR/../package.json" 2>/dev/null; then
  APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
  log "Mevcut repo kullanılıyor: $APP_DIR"
else
  APP_DIR="${APP_DIR:-$HOME/ai-hub}"
  log "Repo"
  if [[ -d "$APP_DIR/.git" ]]; then
    echo "zaten klonlanmış: $APP_DIR (güncelleniyor)"
    git -C "$APP_DIR" pull --ff-only || echo "uyarı: git pull başarısız, mevcut kopya kullanılacak"
  else
    if ! have git; then
      echo "HATA: git bulunamadı. Kurup tekrar deneyin (macOS: xcode-select --install, Debian/Ubuntu: sudo apt-get install -y git)." >&2
      exit 1
    fi
    git clone "$REPO_URL" "$APP_DIR"
  fi
fi
cd "$APP_DIR"

# ---------------------------------------------------------------------------
# 1) Node >= 22 kontrol
# ---------------------------------------------------------------------------
log "Node.js kontrol"
NODE_OK=0
if have node; then
  NODE_MAJOR="$(node -v | sed 's/^v//' | cut -d. -f1)"
  if [[ "$NODE_MAJOR" -ge 22 ]]; then NODE_OK=1; fi
fi
if [[ "$NODE_OK" -ne 1 ]]; then
  echo "Node.js >= 22 bulunamadı (mevcut: $(node -v 2>/dev/null || echo 'yok'))."
  UNAME="$(uname -s)"
  if [[ "$UNAME" == "Linux" ]] && have apt-get; then
    if ask_yn "Node 22'yi NodeSource ile şimdi kurmak ister misin?"; then
      curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
      sudo apt-get install -y nodejs
    else
      echo "Node 22 olmadan devam edilemez. https://nodejs.org üzerinden kurup tekrar çalıştırın." >&2
      exit 1
    fi
  elif [[ "$UNAME" == "Darwin" ]]; then
    if have brew; then
      if ask_yn "Node 22'yi Homebrew ile şimdi kurmak ister misin?"; then
        brew install node@22
        brew link --overwrite --force node@22
      else
        echo "Node 22 olmadan devam edilemez. https://nodejs.org üzerinden kurup tekrar çalıştırın." >&2
        exit 1
      fi
    else
      echo "Homebrew bulunamadı. https://nodejs.org adresinden Node 22+ kurup tekrar çalıştırın." >&2
      exit 1
    fi
  else
    echo "Lütfen https://nodejs.org adresinden Node 22+ kurup tekrar çalıştırın." >&2
    exit 1
  fi
fi
node -v

# ---------------------------------------------------------------------------
# 2) Bağımlılıklar + build
# ---------------------------------------------------------------------------
log "Bağımlılıklar + build"
npm ci
npm run build
if [[ -d web ]]; then
  (cd web && npm ci && npm run build)
fi

# ---------------------------------------------------------------------------
# 3) .env
# ---------------------------------------------------------------------------
log ".env"
if [[ ! -f .env ]]; then
  if have openssl; then
    TOKEN="$(openssl rand -hex 24)"
  else
    TOKEN="$(node -e 'console.log(require("crypto").randomBytes(24).toString("hex"))')"
  fi
  cat > .env <<EOF
HUB_DB_PATH=$APP_DIR/data/hub.db
HUB_HOST=127.0.0.1
HUB_PORT=8033
HUB_TOKEN=$TOKEN
GEMINI_API_KEY=
EMBEDDING_DIM=768
EOF
  chmod 600 .env # HUB_TOKEN içerir — sadece sahibi okusun
  echo ".env oluşturuldu."
  echo "HUB_TOKEN: $TOKEN  (istemcilerde bunu kullanacaksın)"
  echo "Not: GEMINI_API_KEY boş bırakıldı — sistem FTS-only (anahtar kelime arama) modda çalışır,"
  echo "     bu tamamen normaldir. Anlamsal (embedding) arama istersen: https://aistudio.google.com/apikey"
  echo "     üzerinden ücretsiz bir anahtar alıp .env içine GEMINI_API_KEY=... olarak ekle, sonra hub'ı yeniden başlat."
else
  echo ".env zaten var, dokunulmadı."
fi

mkdir -p "$(dirname "$(grep ^HUB_DB_PATH .env | cut -d= -f2)")" 2>/dev/null || true

# ---------------------------------------------------------------------------
# 4) Başlangıçta otomatik başlatma
# ---------------------------------------------------------------------------
UNAME="$(uname -s)"
log "Başlangıçta otomatik başlatma"
if ask_yn "Hub sunucusunu sistem açılışında otomatik başlatalım mı?"; then
  if [[ "$UNAME" == "Linux" ]] && have systemctl; then
    if systemctl --user status >/dev/null 2>&1; then
      echo "Linux systemd (user service) kuruluyor..."
      mkdir -p "$HOME/.config/systemd/user"
      sed -e "s#/home/%i/ai-hub#$APP_DIR#g" -e "s#%i#$USER#g" deploy/hub.service > "$HOME/.config/systemd/user/hub.service"
      systemctl --user daemon-reload
      systemctl --user enable --now hub.service
      loginctl enable-linger "$USER" 2>/dev/null || true
      sleep 1
      systemctl --user status hub.service --no-pager || true
    else
      echo "systemd user session yok; sudo ile sistem servisi kuruluyor (deploy/hub.service)..."
      sudo cp deploy/hub.service "/etc/systemd/system/hub@$USER.service"
      sudo systemctl daemon-reload
      sudo systemctl enable --now "hub@$USER"
      sleep 1
      systemctl status "hub@$USER" --no-pager || true
    fi
  elif [[ "$UNAME" == "Darwin" ]]; then
    echo "macOS launchd plist kuruluyor..."
    PLIST="$HOME/Library/LaunchAgents/com.aihub.plist"
    mkdir -p "$HOME/Library/LaunchAgents"
    NODE_BIN="$(command -v node)"
    cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.aihub</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$APP_DIR/dist/server/index.js</string>
  </array>
  <key>WorkingDirectory</key><string>$APP_DIR</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$APP_DIR/data/hub.out.log</string>
  <key>StandardErrorPath</key><string>$APP_DIR/data/hub.err.log</string>
</dict>
</plist>
EOF
    launchctl unload "$PLIST" >/dev/null 2>&1 || true
    launchctl load -w "$PLIST"
    echo "launchd servisi yüklendi: $PLIST"
  else
    echo "Bu platform için otomatik başlatma desteklenmiyor, atlanıyor."
  fi
else
  echo "Otomatik başlatma atlandı. Manuel başlatma: node $APP_DIR/dist/server/index.js"
fi

# ---------------------------------------------------------------------------
# 5) hub CLI: config + agents connect + health check
# ---------------------------------------------------------------------------
log "hub CLI kurulumu"
HUB_HOST_VAL="$(grep ^HUB_HOST .env | cut -d= -f2)"
HUB_PORT_VAL="$(grep ^HUB_PORT .env | cut -d= -f2)"
HUB_TOKEN_VAL="$(grep ^HUB_TOKEN .env | cut -d= -f2)"
HUB_URL_VAL="http://${HUB_HOST_VAL:-127.0.0.1}:${HUB_PORT_VAL:-8033}"

npm run hub -- config set url "$HUB_URL_VAL" >/dev/null
npm run hub -- config set token "$HUB_TOKEN_VAL" >/dev/null
npm run hub -- config set repoPath "$APP_DIR" >/dev/null

echo "Sunucu sağlığı kontrol ediliyor..."
sleep 1
if curl -fsS "$HUB_URL_VAL/health" >/dev/null 2>&1; then
  echo "hub sunucusu ayakta: $HUB_URL_VAL"
else
  echo "uyarı: hub sunucusuna henüz ulaşılamıyor ($HUB_URL_VAL). Servis başlıyor olabilir, birazdan tekrar dene: curl $HUB_URL_VAL/health"
fi

log "Kurulu AI agent uygulamaları tespit ediliyor ve bağlanıyor"
npm run hub -- agents connect || echo "uyarı: hub agents connect başarısız oldu, elle çalıştırabilirsin: npm run hub -- agents connect"

echo
echo "================================================================"
echo " AI Hub kurulumu tamamlandı."
echo " Dizin:   $APP_DIR"
echo " URL:     $HUB_URL_VAL"
echo " Token:   $HUB_TOKEN_VAL"
echo " Durum:   curl $HUB_URL_VAL/health"
echo " Agentlar: npm run hub -- agents"
echo "================================================================"
