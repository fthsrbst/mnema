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
- `skills/` — agent skilleri; `hub sync` bunları `~/.claude/skills/`e kopyalar ve `~/.claude/CLAUDE.md`deki `<!-- hub:start/end -->` yönetilen bloğunu günceller.
- `prompts/` — rol bazlı sistem promptları: `master.md` (mühendis zihniyeti çekirdeği, her role otomatik eklenir) + `roles/*.md`. MCP `prompt_get`/`prompt_list` ile servis edilir; `local_llm` system prompt verilmezse master'ı enjekte eder. Gövdeler İngilizce (küçük modeller İngilizce talimatı daha iyi izler), açıklamalar Türkçe.
- `deploy/` — Pi kurulum/güncelleme/yedek scriptleri + systemd unit.

## Kurallar
- Embedding yoksa (GEMINI_API_KEY boş) veya sqlite-vec yüklenemezse sistem **FTS-only moda düşer, asla çökmez** — bu davranışı bozan değişiklik yapma.
- Vektör tabloları (memories_vec, chunks_vec) rowid üzerinden ana tablolara eşlenir; ana tablodan silerken vec tablosunu da temizle.
- EMBEDDING_DIM değişirse mevcut vektörler geçersiz olur → re-index gerekir.
- Kullanıcıya görünen metinler Türkçe, kod/identifier'lar İngilizce.
