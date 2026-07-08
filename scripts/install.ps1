# AI Hub — sıfırdan kurulum (Windows / PowerShell).
#   irm <repo-raw>/scripts/install.ps1 | iex
#   veya repo klonlanmışsa: .\scripts\install.ps1
#
# Idempotent: ikinci çalıştırma güvenlidir (mevcut .env / Startup kısayolunu korur).

$ErrorActionPreference = "Stop"

function Write-Step($msg) { Write-Host "`n== $msg ==" -ForegroundColor Cyan }
function Write-Warn2($msg) { Write-Host "uyarı: $msg" -ForegroundColor Yellow }
function Test-Cmd($name) { return [bool](Get-Command $name -ErrorAction SilentlyContinue) }

$RepoUrl = if ($env:REPO_URL) { $env:REPO_URL } else { "https://github.com/fthsrbst/mnema.git" }

# ---------------------------------------------------------------------------
# 0) Repo kökünü bul: script zaten klonlanmış bir repo içindeyse onu kullan,
#    değilse ~\mnema'a klonla.
# ---------------------------------------------------------------------------
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path -ErrorAction SilentlyContinue
if (-not $ScriptDir) { $ScriptDir = (Get-Location).Path }
$CandidateRoot = Split-Path -Parent $ScriptDir

$AppDir = $null
$pkgJsonCandidate = Join-Path $CandidateRoot "package.json"
if (Test-Path $pkgJsonCandidate) {
  try {
    $pkg = Get-Content $pkgJsonCandidate -Raw | ConvertFrom-Json
    if ($pkg.name -eq "mnema") { $AppDir = $CandidateRoot }
  } catch { }
}

if ($AppDir) {
  Write-Step "Mevcut repo kullanılıyor: $AppDir"
} else {
  Write-Step "Repo"
  $AppDir = if ($env:APP_DIR) { $env:APP_DIR } else { Join-Path $HOME "mnema" }
  if (Test-Path (Join-Path $AppDir ".git")) {
    Write-Host "zaten klonlanmış: $AppDir (güncelleniyor)"
    try { git -C $AppDir pull --ff-only } catch { Write-Warn2 "git pull başarısız, mevcut kopya kullanılacak" }
  } else {
    if (-not (Test-Cmd git)) {
      Write-Host "HATA: git bulunamadı. https://git-scm.com/download/win adresinden kurup tekrar çalıştırın." -ForegroundColor Red
      exit 1
    }
    git clone $RepoUrl $AppDir
  }
}
Set-Location $AppDir

# ---------------------------------------------------------------------------
# 1) Node >= 22 kontrol
# ---------------------------------------------------------------------------
Write-Step "Node.js kontrol"
$nodeOk = $false
if (Test-Cmd node) {
  try {
    $verStr = (node -v).TrimStart("v")
    $major = [int]($verStr.Split(".")[0])
    if ($major -ge 22) { $nodeOk = $true }
  } catch { }
}
if (-not $nodeOk) {
  Write-Host "Node.js >= 22 bulunamadı."
  if (Test-Cmd winget) {
    $ans = Read-Host "Node 22'yi winget ile şimdi kurmak ister misin? [Y/n]"
    if ($ans -eq "" -or $ans -match '^[Yy]') {
      winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
      Write-Host "Node kuruldu. Lütfen bu terminali kapatıp yeniden açtıktan sonra scripti tekrar çalıştırın." -ForegroundColor Yellow
      exit 0
    }
  }
  Write-Host "Lütfen https://nodejs.org adresinden Node 22+ kurup tekrar çalıştırın." -ForegroundColor Red
  exit 1
}
node -v

# ---------------------------------------------------------------------------
# 2) Bağımlılıklar + build
# ---------------------------------------------------------------------------
Write-Step "Bağımlılıklar + build"
npm ci
if ($LASTEXITCODE -ne 0) { throw "npm ci başarısız" }
npm run build
if ($LASTEXITCODE -ne 0) { throw "npm run build başarısız" }
if (Test-Path "web") {
  Push-Location web
  npm ci
  if ($LASTEXITCODE -ne 0) { Pop-Location; throw "web: npm ci başarısız" }
  npm run build
  if ($LASTEXITCODE -ne 0) { Pop-Location; throw "web: npm run build başarısız" }
  Pop-Location
}

# ---------------------------------------------------------------------------
# 3) .env
# ---------------------------------------------------------------------------
Write-Step ".env"
$envFile = Join-Path $AppDir ".env"
if (-not (Test-Path $envFile)) {
  $bytes = New-Object byte[] 24
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $token = -join ($bytes | ForEach-Object { $_.ToString("x2") })
  $dbPath = (Join-Path $AppDir "data\hub.db") -replace '\\', '/'
  @"
HUB_DB_PATH=$dbPath
HUB_HOST=127.0.0.1
HUB_PORT=8033
HUB_TOKEN=$token
GEMINI_API_KEY=
EMBEDDING_DIM=768
"@ | Set-Content -Path $envFile -Encoding utf8NoBOM
  Write-Host ".env oluşturuldu."
  Write-Host "HUB_TOKEN: $token  (istemcilerde bunu kullanacaksın)"
  Write-Host "Not: GEMINI_API_KEY bos birakildi - sistem FTS-only (anahtar kelime arama) modda calisir,"
  Write-Host "     bu tamamen normaldir. Anlamsal (embedding) arama istersen: https://aistudio.google.com/apikey"
  Write-Host "     uzerinden ucretsiz bir anahtar alip .env icine GEMINI_API_KEY=... olarak ekle, sonra hub'i yeniden baslat."
} else {
  Write-Host ".env zaten var, dokunulmadı."
}

New-Item -ItemType Directory -Force -Path (Join-Path $AppDir "data") | Out-Null

# .env'i oku (basit KEY=VALUE parse)
$envMap = @{}
Get-Content $envFile | ForEach-Object {
  if ($_ -match '^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$') {
    $envMap[$Matches[1]] = $Matches[2]
  }
}
$hubHost = if ($envMap.HUB_HOST) { $envMap.HUB_HOST } else { "127.0.0.1" }
$hubPort = if ($envMap.HUB_PORT) { $envMap.HUB_PORT } else { "8033" }
$hubToken = $envMap.HUB_TOKEN
$hubUrl = "http://${hubHost}:${hubPort}"

# ---------------------------------------------------------------------------
# 4) Başlangıçta otomatik başlatma (Startup klasörüne kısayol)
# ---------------------------------------------------------------------------
Write-Step "Başlangıçta otomatik başlatma"
$ans = Read-Host "Hub sunucusunu Windows açılışında otomatik başlatalım mı? [Y/n]"
if ($ans -eq "" -or $ans -match '^[Yy]') {
  $vbsSrc = Join-Path $AppDir "deploy\windows\start-hub-hidden.vbs"
  if (Test-Path $vbsSrc) {
    $startupDir = [Environment]::GetFolderPath("Startup")
    $shortcutPath = Join-Path $startupDir "AI Hub.lnk"
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = "wscript.exe"
    $shortcut.Arguments = "`"$vbsSrc`""
    $shortcut.WorkingDirectory = $AppDir
    $shortcut.Description = "AI Hub sunucusunu gizli başlatır"
    $shortcut.Save()
    Write-Host "Startup kısayolu oluşturuldu: $shortcutPath"
    Write-Host "Hemen başlatmak için: wscript.exe `"$vbsSrc`""
    Start-Process wscript.exe -ArgumentList "`"$vbsSrc`""
  } else {
    Write-Warn2 "deploy\windows\start-hub-hidden.vbs bulunamadı, Startup kısayolu atlandı."
  }
} else {
  Write-Host "Otomatik başlatma atlandı. Manuel başlatma: node `"$AppDir\dist\server\index.js`""
}

# ---------------------------------------------------------------------------
# 5) hub CLI: config + agents connect + health check
# ---------------------------------------------------------------------------
Write-Step "hub CLI kurulumu"
npm run hub -- config set url $hubUrl | Out-Null
npm run hub -- config set token $hubToken | Out-Null
npm run hub -- config set repoPath $AppDir | Out-Null

Write-Host "Sunucu sağlığı kontrol ediliyor..."
Start-Sleep -Seconds 2
try {
  $resp = Invoke-WebRequest -Uri "$hubUrl/health" -UseBasicParsing -TimeoutSec 5
  Write-Host "hub sunucusu ayakta: $hubUrl"
} catch {
  Write-Warn2 "hub sunucusuna henüz ulaşılamıyor ($hubUrl). Servis başlıyor olabilir, birazdan tekrar dene: Invoke-WebRequest $hubUrl/health"
}

Write-Step "Kurulu AI agent uygulamaları tespit ediliyor ve bağlanıyor"
try {
  npm run hub -- agents connect
} catch {
  Write-Warn2 "hub agents connect başarısız oldu, elle çalıştırabilirsin: npm run hub -- agents connect"
}

Write-Host ""
Write-Host "================================================================"
Write-Host " AI Hub kurulumu tamamlandı."
Write-Host " Dizin:    $AppDir"
Write-Host " URL:      $hubUrl"
Write-Host " Token:    $hubToken"
Write-Host " Durum:    Invoke-WebRequest $hubUrl/health"
Write-Host " Agentlar: npm run hub -- agents"
Write-Host "================================================================"
