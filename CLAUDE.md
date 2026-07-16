# ai-hub

Tüm AI agentların ortak hafızası: MCP + REST üzerinden hafıza, RAG ve proje mapleri.
Raspberry Pi 5'te systemd servisi olarak çalışır; istemciler Tailscale üzerinden bağlanır.
Detaylı mimari ve fazlar: PLAN.md.

## Komutlar
- `npm run dev` — sunucuyu lokal başlat (http://127.0.0.1:8033)
- `npm run build` — tsc → dist/
- `npm run smoke` — uçtan uca smoke test (geçici DB ile)
- `npm run hub -- <komut>` — CLI'ı kaynak koddan çalıştır (örn. `npm run hub -- status`)

## Yapı
- `src/core/` — DB (SQLite + sqlite-vec + FTS5), Gemini embedding, chunker, hibrit arama (RRF), memory/document/project/session işlemleri. Sunucudan bağımsız, saf kütüphane.
- `src/server/` — Express: `/mcp` (Streamable HTTP, stateless), `/api` (REST), `/health`. Auth: bearer token (HUB_TOKEN boşsa kapalı).
- `src/cli/` — `hub` komutu. REST üzerinden konuşur; sunucuya bağımlı. `hub recall --hook` (UserPromptSubmit) ve `hub bridge --hook` (SessionStart) Claude Code hook'larıdır: stdin'den JSON okur, sessizce başarısız olur (prompt'u/oturumu asla bloklamaz). Recall hassasiyet-öncelikli çalışır (anlamsal kanıt kapısı + proje yakınlığı + ortak tepe eşiği); bridge proje map'i + son oturumu enjekte eder.
- `skills/`, `prompts/` — DB authority (`assets` tablosu, kind='skill'/'prompt' — bkz. `src/core/assets.ts`). Bu klasörler yalnızca ilk kurulum SEED'idir: sunucu açılışta DB'de olmayan (kind,name) çiftlerini içe aktarır (`seedAssetsFromDisk`, idempotent). Sonraki yazımlar (`skill_save`/prompt düzenleme) DB'ye düşer ve sync ile diğer cihazlara OTOMATİK yayılır — git commit/push gerekmez. `hub sync` CLI'ı `~/.claude/skills/`e REST (`/api/skills`) üzerinden materyalize eder (daha önce senkronladığı klasörleri bir manifest ile takip eder, hub'dan silinenleri temizler). `prompts/master.md` mühendis zihniyeti çekirdeğidir (her role otomatik eklenir); MCP `prompt_get`/`prompt_list` ile servis edilir, `local_llm` system prompt verilmezse master'ı enjekte eder. Gövdeler İngilizce (küçük modeller İngilizce talimatı daha iyi izler), açıklamalar Türkçe.
- Agent presence (`agent_presence` tablosu, `src/core/presence.ts`) — advisory koordinasyon, mutual-exclusion KİLİDİ DEĞİL: `agent_checkin`/`agent_checkout`/`agent_active` MCP/REST uçları + `bridge()` çıktısına enjekte edilen "aktif agent var" uyarısı. Bayatlık `HUB_PRESENCE_TTL_MIN` (varsayılan 30dk) ile `stale` işaretlenir, engellenmez. done/abandoned + 7 günden eski kayıtlar sync öncesi `pruneStalePresence()` ile tombstone'lanır.
- `deploy/` — Pi kurulum/güncelleme/yedek scriptleri + systemd unit.

## Kurallar
- Embedding yoksa (GEMINI_API_KEY boş) veya sqlite-vec yüklenemezse sistem **FTS-only moda düşer, asla çökmez** — bu davranışı bozan değişiklik yapma.
- Vektör tabloları (memories_vec, chunks_vec) rowid üzerinden ana tablolara eşlenir; ana tablodan silerken vec tablosunu da temizle.
- EMBEDDING_DIM değişirse mevcut vektörler geçersiz olur → re-index gerekir.
- Kullanıcıya görünen metinler Türkçe, kod/identifier'lar İngilizce.
- Proje map'leri kod haritası taşır (`architecture`, `modules`, `entry_points`, `commands`, `conventions`, `data_model` — bkz. `src/core/types.ts` ProjectMap). `bridge()` bu alanları oturum başında enjekte eder; şema değişikliğinde `projects/_template.yaml` + MCP `project_update` şemasını birlikte güncelle.
