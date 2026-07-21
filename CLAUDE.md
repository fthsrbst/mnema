# mnema

> Bu dosya [AGENTS.md](AGENTS.md) ile eş içeriklidir (Codex/opencode AGENTS.md okur,
> Claude Code CLAUDE.md okur). Birini güncellerken diğerini de güncelle.

Tüm AI agentların ortak hafızası: MCP + REST üzerinden hafıza, RAG, proje mapleri ve agent
koordinasyonu. Raspberry Pi 5'te systemd servisi olarak çalışır; istemciler Tailscale/LAN
üzerinden bağlanır. Detaylı mimari ve fazlar: PLAN.md.

## Komutlar
- `npm run dev` — sunucuyu lokal başlat (http://127.0.0.1:8033)
- `npm run build` — tsc → dist/
- `npm run smoke` — uçtan uca smoke test (geçici DB ile; `GEMINI_API_KEY=` boş bırakarak çalıştır)
- `npm run smoke:cloud` — SaaS/Cloud smoke paketi (saas-security + tenant + router + rate-store + hosted)
- `npm run eval:context` — context kalite regresyonu (gerçek hub DB'sine karşı; `HUB_DB_PATH` ile hedef DB ver)
- `npm run hub -- <komut>` — CLI'ı kaynak koddan çalıştır (örn. `npm run hub -- status`)

## Yapı
- `src/core/` — DB (SQLite + sqlite-vec + FTS5), Gemini embedding, chunker, hibrit arama (RRF),
  memory/document/project/session/presence işlemleri. Sunucudan bağımsız, saf kütüphane.
- `src/server/` — Express: `/mcp` (Streamable HTTP, stateless), `/api` (REST), `/health`.
  Auth: `HUB_AUTH_TOKENS` (scope'lu tokenlar) veya legacy `HUB_TOKEN`; ikisi de boşsa kapalı (local_dev).
- `src/saas/` — hosted Cloud profili: Supabase JWT doğrulama, Postgres RLS tenancy, Paddle billing,
  Valkey rate-limit. Community (self-host) kodundan izole.
- `src/cli/` — `hub` komutu. REST üzerinden konuşur. `hub recall --hook` (UserPromptSubmit) ve
  `hub bridge --hook` (SessionStart) Claude Code hook'larıdır: sessizce başarısız olur.
  `hub sync` skill/MCP/kural dosyalarını cihaza dağıtır (~/.claude/CLAUDE.md,
  ~/.config/opencode/AGENTS.md, ~/.codex/AGENTS.md yönetilen blokları dahil).
- `skills/`, `prompts/` — DB authority (`assets` tablosu). Bu klasörler yalnızca ilk kurulum
  SEED'idir; sonraki yazımlar (`skill_save`) DB'ye düşer ve sync ile yayılır — git gerekmez.
- Agent presence (`agent_presence` tablosu, `src/core/presence.ts`) — advisory koordinasyon,
  KİLİT DEĞİL. Aşağıdaki "Agent koordinasyon protokolü"ne bak.
- `evals/` — context_get golden suite; kanonik canlı bilgi durumuna (proje: mnema) karşı yazılır.
- `deploy/` — Pi kurulum/güncelleme/yedek scriptleri + systemd unit; `deploy/cloud/` hosted compose.
- Agent Intelligence Platform (`src/core/tasks.ts`, `capabilities.ts`, `messaging.ts`, `hygiene.ts`,
  `compaction.ts`, `learning.ts`, `worker.ts`, `webhooks.ts`) — görev kuyruğu, agent yetenek kaydı, agent-agent
  mesajlaşma, hafıza hijyeni, bilgi sıkıştırma, ders çıkarma, webhook'lar ve async job kuyruğu.
  Detay ve tam MCP tool listesi: `docs/agent-platform.md`.

## Agent koordinasyon protokolü (presence)
Bu hub'ı kullanan HER agent (Claude Code, Codex, opencode, cursor…) şu protokolü izler:
1. Bir projede çalışmaya BAŞLARKEN: `agent_checkin(project, task, branch?)` (MCP) veya
   `POST /api/agents/checkin`. Dönen `uid`yi sakla.
2. Uzun işte task değiştikçe / ~15 dk'da bir: aynı `uid` ile tekrar `agent_checkin` (heartbeat).
3. Bitirince: `agent_checkout(uid)` — status `done` (varsayılan) veya `abandoned`.
4. Oturum başında bridge çıktısındaki "⚠ Bu projede aktif agent var" satırını ciddiye al:
   `agent_active(project)` ile detay çek, aynı dosyalara dokunacaksan görev/branch ayrıştır.
5. Bu bir mutual-exclusion kilidi DEĞİLDİR: aktif kayıt görsen de devam edebilirsin; crash eden
   agent kilit bırakmaz — TTL (`HUB_PRESENCE_TTL_MIN`, varsayılan 30 dk) sonrası kayıt `stale`
   işaretlenir ve "muhtemelen düşmüş" diye görünür. Stale kayıtları yok say.
6. Görev almadan önce `task_queue(project)` ile bağımlılığı çözülmüş, önceliğe göre sıralı
   bekleyen işleri kontrol et; uygun olanı `task_claim` ile al.
7. İş bitince `task_complete` + `task_feedback` (outcome, ne işe yaradı/yaramadı, dersler) —
   `task_complete` çağrılırken mümkünse `verification` kanıtı geçir
   (`{kind, command?, exit_code?, summary}`; `kind`: `tests`|`build`|`manual`|`none`).
   Kanıt verilmezse görev yine `done` olur ama yanıtta `uyari` döner (advisory,
   sert kilit DEĞİL — presence felsefesiyle tutarlı); `kind:"none"` bilinçli
   seçilirse uyarı verilmez. Dersler otomatik `howto` hafızasına düşer ve
   `project_lessons` ile başka agent'lara ulaşır.
8. Agent'lar arası mesajlar için `agent_inbox` / `agent_message_send` kullan (presence'tan
   ayrı bir kanaldır); bir işi tamamen başka bir agent'a devredeceksen `agent_handoff`.

## Kurallar
- Embedding yoksa (GEMINI_API_KEY boş) veya sqlite-vec yüklenemezse sistem **FTS-only moda düşer,
  asla çökmez** — bu davranışı bozan değişiklik yapma.
- Vektör tabloları (memories_vec, chunks_vec) rowid üzerinden ana tablolara eşlenir; ana tablodan
  silerken vec tablosunu da temizle.
- EMBEDDING_DIM değişirse mevcut vektörler geçersiz olur → re-index gerekir.
- Kullanıcıya görünen metinler Türkçe, kod/identifier'lar İngilizce. Context intent kalıpları
  aksan-katlanmış uzayda eşleşir (`src/core/context.ts` foldTurkishAscii) — yeni Türkçe kalıpları
  aksansız yaz.
- DB, WAL, vektör indeksi, export, yedek, secret ve .env dosyaları ASLA commit'lenmez; runtime
  bilgi yalnızca Mnema sync veya Cloud API ile taşınır.
- Proje map'leri kod haritası taşır (`architecture`, `modules`, `entry_points`, `commands`,
  `conventions`, `data_model` — bkz. `src/core/types.ts` ProjectMap). Şema değişikliğinde
  `projects/_template.yaml` + MCP `project_update` şemasını birlikte güncelle.
