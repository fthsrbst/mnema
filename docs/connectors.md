# Bağlayıcılar (Connectors) — claude.ai, ChatGPT, Gemini'den hub'a erişim

> Bu belgedeki `?token=` örnekleri, header gönderemeyen hosted istemciler için
> yalnızca **personal profil uyumluluk yoludur**. `team` ve `enterprise`
> profilleri `HUB_ALLOW_QUERY_TOKEN=false` gerektirir; header/OAuth destekli
> onaylı bir gateway kullanılmalıdır. Ayrıntı: `operations/company-deployment.md`.

Bu doküman hub'ı **hosted/bulut AI uygulamalarından** (kendi bilgisayarında
çalışan CLI/editör agent'ları değil — claude.ai web/mobil, ChatGPT web/mobil,
Gemini app) MCP üzerinden nasıl bağlayacağını anlatır.

> Platform UI'ları sık değişiyor. Buradaki adımlar Ocak 2026 kesimli bilgi +
> güncel arama ile doğrulanmıştır (Temmuz 2026); "sürüme göre değişebilir"
> notu düşülen yerlerde önce platformun kendi yardım sayfasına bak.

---

## Ortak gereksinim: internete açık HTTPS MCP endpoint

claude.ai, ChatGPT ve Gemini'nin hosted sürümleri **kendi bulut
altyapılarından** bağlanır — senin tailnet'ine giremezler. Bu yüzden hub'ın
`/mcp` yolu geçici olarak internete açılmalı.

### Tailscale Funnel ile açma

```bash
sudo tailscale funnel --bg 8033
```

Bu, Pi'nin `8033` portunu `https://<cihaz-adı>.<tailnet-adı>.ts.net` adresinde
**herkese açık** hale getirir (Funnel = internete açık; `serve` = sadece
tailnet içi). URL biçimi:

```
https://<cihaz-adı>.<tailnet-adı>.ts.net/mcp?token=<HUB_TOKEN>
```

`?token=` neden gerekli: bu üç platform da özel HTTP header (`Authorization:
Bearer ...`) ekleme imkanı **vermiyor** — bağlantı URL'i dışında bir
kimlik doğrulama alanı yok. Hub sunucusu bu yüzden token'ı query string'den
de kabul edecek şekilde yazıldı (`src/server/index.ts`):

Sunucu önce scoped token politikalarını doğrular. Legacy `HUB_TOKEN` yalnızca
`HUB_ALLOW_LEGACY_ADMIN=true` iken, query transport ise yalnızca
`HUB_ALLOW_QUERY_TOKEN=true` iken kabul edilir.

Kapatmak için:
```bash
sudo tailscale funnel --https=443 off
```

### Güvenlik uyarısı — ciddiye al

- **Funnel = internete açık.** URL'i tahmin eden/ele geçiren herkes token'ı
  bilmeden istek atabilir (ama token olmadan 401 alır) — tek koruma katmanı
  bu token'dır. Tailscale ağ katmanı burada devre dışı kalır (istek dışarıdan
  geliyor), token her şeyi taşıyor.
- **Token'ı URL'de taşımanın riskleri:**
  - Tarayıcı geçmişine yazılır.
  - Sunucu/proxy access log'larına (ör. nginx, Cloudflare, hatta Tailscale'in
    kendi log'ları) düşebilir.
  - Ekran paylaşımında/URL kopyalarken yanlışlıkla ifşa olabilir.
  - Üçüncü parti platformun (Anthropic/OpenAI/Google) kendi loglarına da
    düşme ihtimali var — bu platformların log retention politikasına
    güveniyorsun.
- **Azaltma:** Funnel'ı sadece ihtiyaç olduğunda aç, işin bitince kapat
  (`--https=443 off`). Sürekli açık tutacaksan token'ı düzenli rotasyona sok.
- **Token rotasyonu:**
  1. Pi'de `.env` içindeki `HUB_TOKEN` değerini değiştir (`openssl rand -hex 24`
     ile yeni bir tane üret).
  2. Servisi yeniden başlat: `sudo systemctl restart hub@<user>` (veya
     `deploy/update.sh`).
  3. Tüm bağlı connector'larda (claude.ai, ChatGPT, Gemini, ve `hub config`
     kullanan cihazlar) URL/token'ı güncelle — eski token anında geçersiz
     olur, güncellemeyen istemci 401 almaya başlar.

---

## claude.ai (web + mobil uygulama)

1. **Settings → Connectors** (Pro/Max planlarda kullanılabilir; Team/Enterprise'da
   önce bir Owner **Organization Settings → Connectors** üzerinden eklemeli,
   sonra üyeler kendi hesaplarından bağlanır).
2. **Add custom connector** → **URL** alanına yapıştır:
   ```
   https://<cihaz-adı>.<tailnet-adı>.ts.net/mcp?token=<HUB_TOKEN>
   ```
3. "Advanced settings" sadece OAuth Client ID/Secret gerektiren sunucular
   için — hub bearer/token tabanlı olduğundan bu alanı boş bırak.
4. **Add** ile kaydet. Mobil uygulamada aynı hesapla giriş yaptığında
   connector otomatik görünür (ayrıca eklemene gerek yok).

**Araçların nasıl göründüğü:** Claude, sohbet sırasında hub'ın MCP tool
listesini (`memory_search`, `project_get`, `rag_search` vb.) otomatik keşfeder
ve gerektiğinde çağırır; kullanıcı olarak "hangi tool'u kullanacağını" sen
seçmezsin, Claude bağlama göre karar verir (istersen mesajında açıkça
"önce memory_search çağır" diyerek yönlendirebilirsin).

**Sınırlamalar:**
- Sunucu **herkese açık** olmalı — Funnel kapalıyken connector 4xx/timeout
  döner.
- Bazı planlarda connector sayısı/erişim kısıtlı olabilir; kesin limitler
  plana göre değişir, hesabının plan sayfasından doğrula.
- Yanıt süresi: hub içi hibrit arama hızlı olsa da, Anthropic sunucusu →
  internet → Pi → SQLite gidiş-dönüşü tailnet-içi çağrıdan daha yavaştır.

---

## ChatGPT (web + mobil uygulama)

1. **Settings → Apps → Advanced settings → Developer mode** (alternatif yol:
   **Workspace Settings → Permissions & Roles → Connected Data → Developer
   mode**). Bu özellik Pro/Plus/Business/Enterprise/Education hesaplarda
   web'de kullanılabilir; Apps/tam MCP desteği asıl olarak Business/
   Enterprise/Edu hesaplar için düşünülmüş — kendi hesap tipinde göremezsen
   bu sınırdan olabilir.
2. Developer mode açıldıktan sonra **Settings → Connectors → Create** (veya
   "Add custom connector") ile:
   ```
   URL: https://<cihaz-adı>.<tailnet-adı>.ts.net/mcp?token=<HUB_TOKEN>
   ```
3. Connector eklendikten sonra "app detay" sayfasından tool'ları
   aç/kapat edebilir, "refresh" ile hub'daki güncel tool listesini
   (yeni MCP tool ekledikçe) çekebilirsin.

**OpenAI'nin destek durumu ve sınırları:**
- Developer mode, "yazma" (write) aksiyonu yapan tool'ları da (bizim durumda
  `memory_save`, `project_update` gibi) çalıştırabilir — OpenAI bunu açıkça
  "güçlü ama tehlikeli, dikkatli kullan" diye işaretliyor. Prompt injection
  ve model hatasıyla istenmeyen yazma riskini bil.
- Gizli/kritik veri barındıran bir hub'ı bağlıyorsan, hangi tool'ların
  otomatik onay istediğini/istemediğini connector ayarlarından kontrol et.
- Mobil ChatGPT uygulamasında connector davranışı hesap/sürüme göre
  değişebilir — web'de kurup mobilde senkron göründüğünü doğrula.

---

## Gemini

### Gemini uygulaması (mobil/web, hosted)

Bu yazının kesim tarihi itibarıyla Gemini'nin tüketici uygulamasında
(telefon/web "Gemini app") genel kullanıcıya açık, claude.ai/ChatGPT
tarzında bir "custom MCP connector ekle" arayüzü **yaygın olarak
belgelenmiş değil** — Google tarafı MCP desteğini şu an ağırlıklı olarak
geliştirici araçları (Gemini CLI, Android Studio, Cloud Assist) üzerinden
sunuyor. Bu değişebilir; hesabında **Settings → Connected apps/Extensions**
benzeri bir bölüm arayıp gördüğün gerçek UI'ı esas al, burada yazılana değil.

### Alternatif: Gemini CLI

Gemini CLI'da MCP sunucusu eklemek `~/.gemini/settings.json` üzerinden
yapılır — bu bir CLI olduğu için tailnet içinden de erişebilir, Funnel'a
gerek yok (tailnet IP'siyle bağlanabiliyorsan public URL şart değil):

```json
{
  "mcpServers": {
    "hub": {
      "httpUrl": "https://<cihaz-adı>.<tailnet-adı>.ts.net/mcp?token=<HUB_TOKEN>",
      "timeout": 10000
    }
  }
}
```

veya tailnet içinden doğrudan:
```json
{
  "mcpServers": {
    "hub": {
      "httpUrl": "http://100.x.x.x:8033/mcp",
      "headers": { "Authorization": "Bearer <HUB_TOKEN>" }
    }
  }
}
```

Not: Streamable HTTP MCP sunucuları için alan adı **`httpUrl`** olmalı
(`url` alanı SSE transport'a denk gelir — yanlış alan kullanılırsa bağlantı
kurulamaz). Gemini CLI, Claude Code ile aynı tailnet'te çalışıyorsa Funnel'a
hiç gerek yok — sadece hosted Gemini app için gerekiyor.

---

## Genel doğrulama notu

Yukarıdaki üç platform da hızlı değişiyor (özellikle "developer mode" /
"connector" isimlendirmeleri ve plan kısıtları). Kurulum sırasında UI
söylenenle uyuşmuyorsa:
1. Platformun resmi yardım sayfasını ara (`site:support.claude.com`,
   `site:help.openai.com`, Gemini için resmi Google desteği).
2. Sürüm/plan farkına dikkat et — burada anlatılanlar genel akışı yansıtır,
   buton adı/menü yeri değişmiş olabilir.

---

## Sorun giderme

**401 Unauthorized**
- Token yanlış/eksik. `?token=` query param'ının `.env`'deki `HUB_TOKEN`
  ile birebir aynı olduğunu kontrol et (kopyala-yapıştırda boşluk/satır
  sonu sızıntısına dikkat).
- Token rotasyonu yaptıysan ama connector'da güncellemeyi unuttuysan.
- `Authorization: Bearer` header'ı destekleyen bir istemciyse (Gemini CLI,
  Claude Code gibi) header formatının tam `Bearer <token>` olduğunu kontrol
  et — sadece token yazıp `Bearer` kelimesini unutmak yaygın hata.

**404 Not Found**
- Yol yanlış. Doğru yol `/mcp` — `/api/...` REST için, MCP connector'lar
  için değil. `https://.../mcp` ile bitmeli, sonuna `?token=...` gelir.
- Funnel/serve farklı bir port'a yönlendiriyor olabilir — Pi'de
  `tailscale funnel status` ile hangi portun neye eşlendiğini doğrula.

**Funnel kapalı / bağlantı zaman aşımı**
- `sudo tailscale funnel --bg 8033` çalıştırılmamış veya daha önce
  `off` ile kapatılmış. `tailscale funnel status` ile kontrol et.
- Pi'de `hub-server` servisi ayakta değil: `systemctl status hub@<user>`
  ile kontrol et, `journalctl -u hub@<user> -f` ile log'a bak.
- Router/ISP seviyesinde bir engel yok — Funnel Tailscale'in kendi relay
  altyapısını kullandığı için genelde port yönlendirme sorunu olmaz, ama
  yine de `curl https://<cihaz-adı>.<tailnet-adı>.ts.net/health` ile
  Pi dışından erişilebilirliği test et.

**MCP tool listesi boş görünüyor**
- Connector eklendi ama `memory_search` vb. tool'lar hiç görünmüyorsa:
  önce hub'ın `/health` uç noktasının 200 döndüğünü doğrula.
  ```
  curl "https://<cihaz-adı>.<tailnet-adı>.ts.net/mcp?token=<HUB_TOKEN>"
  ```
- Platform tarafında "refresh"/"yeniden bağlan" seçeneğini dene (ChatGPT'de
  connector detay sayfasında bu var) — bazı istemciler tool listesini ilk
  bağlantıda cache'ler.
- Sunucu loğunda (`journalctl -u hub@<user>`) MCP isteğinin ulaşıp
  ulaşmadığını kontrol et; hiç log yoksa istek Pi'ye hiç varmıyor demektir
  (Funnel/DNS sorunu), log var ama hata varsa (`Zod` validation, vs.)
  hub tarafı sorunudur.
