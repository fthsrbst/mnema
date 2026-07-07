# AI Hub — Ortak Hafıza, RAG ve Skill Sistemi

> Tüm AI agentların (Claude Code, opencode, Cursor/Windsurf, Codex, özel agentlar)
> ortak bir hafızaya, RAG arama motoruna, proje maplerine ve skill setine
> eriştiği; Raspberry Pi 5 (16GB) üzerinde çalışan, Tailscale ile her cihazdan
> erişilebilen merkezi sistem.

---

## 1. Kararlar (verilmiş)

| Konu | Karar | Gerekçe |
|---|---|---|
| Sunucu | Raspberry Pi 5, 16GB | Mevcut donanım; bu iş için fazlasıyla yeterli |
| Erişim | Tailscale (kurulu) | Port açmadan, her cihazdan güvenli erişim |
| Embedding | Gemini API (`gemini-embedding-001`) | Cömert ücretsiz kota, Türkçe desteği iyi |
| Dil/stack | TypeScript (Node 22) | MCP SDK'ları en olgun; agent ekosistemiyle aynı dil |
| Git | GitHub private + Pi mirror | Yedeklilik; Pi ölürse veri GitHub'da yaşar |
| Protokol | MCP (Streamable HTTP) + REST | MCP: tüm agentların ortak dili. REST: özel agentlar ve script'ler için |

## 2. Kararlar (önerilen varsayılanlar)

| Konu | Öneri | Gerekçe |
|---|---|---|
| Vector DB | SQLite + `sqlite-vec` + FTS5 | Tek dosya, sıfır operasyon yükü, ~500K vektöre kadar rahat. Gerekirse Qdrant'a geçiş yolu açık |
| Arama | Hibrit: BM25 (FTS5) + vektör, RRF ile birleştirme | Sadece vektör arama kod/teknik terimde zayıf kalır; hibrit fark yaratır |
| Embedding boyutu | 768 (Matryoshka kırpma) | Pi'de hız/depolama dengesi; kalite kaybı ihmal edilebilir |
| Deploy | systemd servisi (**Docker'sız**) | Bkz. §11 — tek Node prosesi + tek SQLite dosyası için Docker katmanı fayda değil yük getirir |
| Alt agentlar | Sonnet 5 | Uygulama sırasında Agent tool ile açılan tüm alt agentlar `sonnet` modeliyle çalışır |
| Auth | Bearer token (Tailscale zaten ağ katmanında koruyor) | Çift katman: ağ + token |

---

## 3. Mimari

```
┌──────────────────────────────────────────────────────────────┐
│ Raspberry Pi 5 — "hub"  (Tailscale IP: 100.x.x.x)            │
│                                                              │
│  ┌────────────────────────────────────────────┐              │
│  │ hub-server (Node 22, systemd)              │              │
│  │  ├── MCP endpoint   /mcp   (Streamable HTTP)│             │
│  │  ├── REST API       /api/* (özel agentlar)  │             │
│  │  └── Mini web UI    /      (telefondan bakış)│            │
│  └───────────────┬────────────────────────────┘              │
│                  │                                           │
│  ┌───────────────▼────────────────────────────┐              │
│  │ SQLite (tek dosya: hub.db)                 │              │
│  │  ├── memories      (yapısal hafıza)        │              │
│  │  ├── documents     (RAG kaynak dokümanlar) │              │
│  │  ├── chunks + vec  (sqlite-vec embeddings) │              │
│  │  ├── chunks_fts    (FTS5 BM25 indeksi)     │              │
│  │  └── projects      (proje mapleri)         │              │
│  └────────────────────────────────────────────┘              │
│                                                              │
│  hub-indexer (cron/CLI): repo & doküman ingest → Gemini      │
│  embed → upsert                                              │
│  Yedek: gece 03:00 → sqlite backup + markdown export →       │
│  git push (GitHub + lokal bare mirror)                       │
└──────────────────────────────────────────────────────────────┘
         ▲ Tailscale (tailnet içi, port açık değil)
         │
   ┌─────┴──────────────────────────────────────┐
   │ Cihazlar (PC, laptop, telefon)             │
   │  ├── Claude Code  → MCP (http)             │
   │  ├── opencode     → MCP (http)             │
   │  ├── Cursor       → MCP (mcp.json)         │
   │  ├── Codex CLI    → MCP (config.toml)      │
   │  ├── Özel agentlar→ REST API               │
   │  ├── hub CLI      → REST (insan kullanımı) │
   │  └── skills repo  → git pull ile senkron   │
   └────────────────────────────────────────────┘
```

**Gemini embedding çağrıları Pi'den yapılır** — istemciler sadece ham metin
gönderir. Böylece API key tek yerde durur, tüm cihazlarda key dağıtmak gerekmez.

---

## 4. Veri Modeli

### 4.1 `memories` — yapısal hafıza (agentların "beyni")
```sql
memories(
  id, type,            -- fact | preference | decision | howto | context
  title, body,         -- markdown
  project,             -- opsiyonel proje bağı
  tags,                -- json array
  source,              -- hangi agent/cihaz yazdı
  created_at, updated_at,
  embedding            -- otomatik üretilir (arama için)
)
```
Örnek: "fatih dark theme tercih ediyor", "X projesinde auth için Clerk seçildi
çünkü...", "deploy komutu: ...".

### 4.2 `documents` + `chunks` — RAG deposu
- Kaynak: proje README'leri, dokümanlar, notlar, makale/kaynak dökümleri,
  geçmiş konuşma özetleri.
- Chunking: markdown-aware, ~400-600 token, başlık hiyerarşisi metadata'da.
- Her chunk: vektör (sqlite-vec) + FTS5 kaydı. Arama ikisinin RRF birleşimi.

### 4.3 `projects` — proje mapleri
```yaml
# projects/ornek-proje.yaml (git'te de yaşar, DB'ye senkronlanır)
name: ornek-proje
status: active          # active | paused | done | idea
path: { pc: "C:/Users/fatih/Desktop/dev/ornek", pi: null }
repo: github.com/fatih/ornek
stack: [nextjs, sqlite]
summary: >
  Tek paragraf: ne bu proje, neden var.
current_focus: "auth akışını bitirmek"
decisions:
  - "2026-07: DB olarak sqlite seçildi çünkü ..."
next_steps:
  - "login sayfası"
links: [ ... ]
```
Agent hangi cihazda olursa olsun `project_get("ornek-proje")` ile aynı bağlamı
alır. "Projelerimi çok iyi yönetebileceğim proje mapleri" tam olarak bu tablo +
`hub projects` dashboard'u.

---

## 5. MCP Arayüzü (tüm agentların gördüğü toollar)

| Tool | İş |
|---|---|
| `memory_save` | Hafızaya kayıt (type, title, body, project, tags) — otomatik embed |
| `memory_search` | Hibrit arama; type/project/tag filtreli |
| `memory_update` / `memory_delete` | Güncelle / sil |
| `rag_search` | Doküman chunk'larında hibrit arama, kaynak referanslı |
| `rag_add` | Metin/doküman ekle (chunk + embed otomatik) |
| `project_list` | Projeler + durumları |
| `project_get` | Tek projenin tam map'i |
| `project_update` | Focus, decision, next_step güncelle |
| `session_log` | Oturum sonu özeti kaydet ("bugün X'te şunu yaptık") |

MCP **prompts** olarak da: `recall` (oturum başında ilgili hafızayı çek),
`handoff` (oturum sonunda özet yaz) — agentlar tek komutla çağırır.

## 6. REST API (özel agentlar + hub CLI + web UI)

`POST /api/memory`, `GET /api/memory/search?q=`, `GET /api/projects`,
`POST /api/rag/search`, `POST /api/rag/documents` … MCP toollarıyla birebir
aynı core fonksiyonları çağırır (tek iş mantığı, iki kapı).

## 7. Otomatik Hafıza (Auto-Recall) ve CLAUDE.md Yönetimi

> Amaç: herhangi bir mesaj attığında agent'ın **sormadan** hub'a gidip ilgili
> hafızayı çekmesi. İki katmanlı çözüm — hook (deterministik) + CLAUDE.md
> yönergesi (davranışsal):

### 7.1 Hook katmanı (garanti çalışır)
- **Claude Code:** `UserPromptSubmit` hook'u her mesajda tetiklenir →
  `hub recall "<mesaj>"` çalışır → hub hibrit arama yapar, en alakalı N kaydı
  (skor eşiği üstündekileri) döner → hook çıktısı otomatik olarak bağlama
  enjekte edilir. Sen hiçbir şey yazmazsın; agent mesajını ilgili hafızayla
  birlikte görür.
- Aynı hook `SessionEnd`/`Stop` tarafında `session_log` ile oturum özetini
  hub'a geri yazar → hafıza kendi kendini besler.
- **opencode:** plugin API'sindeki `chat.message` hook'u ile aynı akış.
- **Cursor/Windsurf:** hook mekanizması yok → rules dosyası + MCP tool'u
  "her görevde önce memory_search çağır" yönergesiyle (davranışsal katman).
- Gecikme bütçesi: recall çağrısı < 300ms hedef (Tailscale içi + SQLite bunu
  rahat karşılar); hub erişilemezse hook sessizce boş döner, akışı bozmaz.

### 7.2 CLAUDE.md katmanı (yönerge)
- `hub sync`, her cihazda **yönetilen blok** yaklaşımıyla CLAUDE.md günceller:
  - `~/.claude/CLAUDE.md` (global): hub'ın varlığı, ne zaman `memory_save`
    çağrılacağı ("kalıcı olması gereken her karar/tercih/öğrenim"), proje
    başlarken `project_get` çağırma kuralı.
  - Proje içi `CLAUDE.md`: o projenin map özeti + hub proje adı.
  - Blok `<!-- hub:start -->…<!-- hub:end -->` işaretleri arasında yaşar;
    senin elle yazdığın kısımlara dokunulmaz.
- Aynı içerik opencode için `AGENTS.md`, Cursor için `.cursor/rules`'a
  export edilir — tek kaynaktan üç format.

## 8. Skiller

- `skills/` klasörü: **Claude Code skill formatı** (SKILL.md + frontmatter)
  ortak format; opencode da markdown skill okuyabiliyor, Cursor için rules
  export script'i.
- Senkron: her cihazda `hub sync` → git pull + `~/.claude/skills/` içine
  symlink/copy. Pi'ye gerek yok, skiller istemci tarafında çalışır.
- Başlangıç skill seti (öneri):
  - `project-context`: oturum başında ilgili proje map'ini + hafızayı çeker
  - `session-handoff`: oturum sonunda özeti hub'a yazar
  - `new-project`: yeni proje scaffold + proje map'i oluşturur
  - `research-to-rag`: araştırma çıktısını RAG'e indeksler
  - `code-conventions`: fatih'in kod standartları (tek kaynak)

## 9. Dev Toollar (`hub` CLI)

Tek binary (npm global / bun compile), AI'sız da işini görür:

```
hub search "auth kararı"        # hafıza + RAG'de ara
hub remember "..."              # hızlı not → hafıza
hub projects                    # proje durum tablosu
hub project ornek-proje         # tek proje detayı
hub index ./docs                # klasörü RAG'e indeksle
hub recall "<metin>"            # auto-recall'un kullandığı komut (hook çağırır)
hub sync                        # skills + CLAUDE.md yönetilen blok senkronu
hub status                      # Pi sağlık: disk, DB boyutu, son yedek
```

## 10. Yedekleme ve Dayanıklılık

1. **Gece 03:00 cron (Pi):** `sqlite3 .backup` → sıkıştır → 7 günlük rotasyon.
2. **Markdown export:** hafıza + proje mapleri düz markdown'a dökülür →
   git commit → GitHub push. (İnsan-okur yedek; DB ölse bile bilgi kaybolmaz.)
3. **Pi bare mirror:** GitHub'a ek olarak Pi'de bare repo — çift kopya.
4. SD kart yerine **NVMe/USB SSD** şiddetle önerilir (SD kartlar yazma
   yükünde ölür — DB için kritik).

## 11. Deploy: Docker mı, systemd mi?

**Karar: Docker yok, doğrudan systemd.** Gerekçe:

- Sistem tek bir Node prosesi + tek SQLite dosyası. Docker'ın çözdüğü
  problemler (bağımlılık izolasyonu, çoklu servis orkestrasyonu) burada yok.
- Pi'de Docker katmanı = ekstra RAM, ekstra imaj bakımı, SQLite volume mount
  ve dosya izni sürprizleri.
- systemd zaten ihtiyacımız olan her şeyi veriyor: otomatik başlatma,
  crash'te restart, journald ile log, `systemctl status hub` ile sağlık.
- Deploy akışı: Pi'de `git pull && npm ci && npm run build &&
  systemctl restart hub` — tek script (`deploy/update.sh`).

İleride Qdrant'a geçersek **o zaman** docker-compose ekleriz (Qdrant'ın
dağıtımı Docker'la kolay) — sunucumuz yine host'ta kalır. Yani cevap:
Docker'da çalışmayacak; bilinçli tercih, kapı açık.

## 12. Güvenlik

- Sunucu **sadece Tailscale arayüzüne bind** olur (`100.x.x.x`), LAN/internete
  kapalı.
- Üstüne bearer token (`Authorization: Bearer ...`) — tailnet'e giren bir
  cihaz ele geçse bile ikinci katman.
- Gemini API key sadece Pi'de (`.env`, git dışı).
- ChatGPT web'e bağlamak istersek: Tailscale Funnel ile sadece `/mcp` yolunu
  açıp OAuth ekleriz — **Faz 5, opsiyonel**.

---

## 13. Fazlar

> Uygulama boyunca alt agentlar (Agent tool) **Sonnet 5** modeliyle çalıştırılır.

### Faz 0 — İskelet (yarım gün) ✅
Tek paket (monorepo yerine bilinçli sadeleştirme: tek build, tek deploy):
`src/core` (DB şeması, embedding client, chunking, hibrit arama),
`src/server` (Express: MCP + REST), `src/cli`, `skills/`, `projects/`,
`deploy/`. Windows'ta lokal çalışır halde.

### Faz 1 — Hafıza çekirdeği (1 gün) ✅
SQLite şema + memory CRUD + Gemini embed + hibrit arama. MCP server ayakta,
`memory_save`/`memory_search` uçtan uca test (11/11 smoke; embedding'li yol
GEMINI_API_KEY beklıyor). RAG pipeline (Faz 2'nin çekirdeği) ve hook'lu
auto-recall da bu fazda geldi.

### Faz 2 — RAG pipeline (1 gün)
Chunker, `rag_add`/`rag_search`, `hub index` ile klasör ingest. Kalite testi:
gerçek dokümanlarınla arama isabeti.

### Faz 3 — Proje mapleri + skiller + auto-recall (1,5 gün)
`projects` tablosu + YAML senkron, `project_*` toolları, başlangıç skill seti,
`hub` CLI komutları, tüm agent istemci konfigleri (Claude Code, opencode,
Cursor, Codex). **Auto-recall:** `hub recall` + Claude Code
`UserPromptSubmit`/`SessionEnd` hook'ları + opencode plugin'i + CLAUDE.md
yönetilen blok üretimi (`hub sync`).

### Faz 4 — Pi deploy (yarım gün)
Deploy script: Node 22 kurulum, systemd unit, Tailscale bind, token, yedek
cron'ları. Cihaz konfiglerini Pi adresine çevir. Uçtan uca test: telefondan
`hub search`.

### Faz 5 — Ekstralar (istendikçe, önceliklendirilecek)

**Skill adayları** (agentların içinde çalışır):
- `daily-brief`: "bugün nerede kalmıştım?" — tüm projelerin son session_log +
  next_steps özetini tek bakışta verir
- `research-to-rag`: web araştırması / makale çıktısını özetleyip RAG'e indeksler
- `decision-logger`: bir tartışma sonunda alınan kararı gerekçesiyle
  hafızaya + proje map'ine yazar
- `code-conventions`: senin kod standartların tek kaynakta; her agent aynı
  stille yazar
- `new-project`: scaffold + proje map'i + GitHub repo + CLAUDE.md tek komutta
- `pr-summary`: commit/PR'ları özetleyip proje geçmişine işler

**Tool adayları** (AI'sız da işe yarar):
- `hub ask "<soru>"`: RAG + Gemini Flash ile terminalden direkt cevap
  (agent açmadan hızlı sorgu)
- **Quick capture:** telefondan not/link atma — mini web UI'da tek input;
  attığın link otomatik fetch + özet + RAG'e ingest (okuma listesi hafızası)
- `hub clip`: panodakini hafızaya at (Windows'ta kısayol tuşuna bağlanır)
- **Watch mode:** belirlenen klasörleri (notlar, docs) izleyip değişeni
  otomatik re-index
- `hub timeline <proje>`: bir projenin karar/oturum geçmişini kronolojik döker

### Faz 6 — Yerel AI Orkestrasyonu (LM Studio + ComfyUI)

> Amaç: agentlar bir iş için görsel gerekince kendileri üretebilsin; basit
> işleri Fatih'in PC'lerindeki yerel modellere yönlendirebilsin.

- **Machines registry:** hub'da `machines` kaydı — cihaz adı, Tailscale IP,
  yetenekler (lmstudio/comfyui portları). `machine_status` tool'u ile
  hangi cihaz/servis ayakta görülür.
- **LM Studio:** OpenAI-uyumlu API (`:1234/v1`). Hub tool'u `local_llm`
  (machine, model, messages) → çıktıyı döner. Kullanım: özet, sınıflandırma,
  taslak gibi basit işler API maliyeti olmadan yerelde.
  Şart: LM Studio'da "Serve on local network" açık olmalı (Tailscale'den erişim).
- **ComfyUI:** API (`:8188`). Workflowlar repo'da `workflows/*.json`
  (API format). Hub tool'u `image_generate(workflow, inputs)` →
  `POST /prompt` ile kuyruğa atar, `/history` poll'lar, çıktı görseli
  alıp kaydeder, dosya yolunu döner. Agent görseli doğrudan işinde kullanır.
- Uzun üretimler için job kaydı (id, durum) — agent sormadan önce
  `machine_status`/job durumuna bakar.

**Altyapı ekstraları:**
- Mini web UI (telefonda hafıza/proje görüntüleme + quick capture)
- ChatGPT web connector (Tailscale Funnel + OAuth)
- Qdrant'a geçiş (ölçek gerektirirse), konuşma geçmişi toplu ingest
- Haftalık "hafıza bakımı" cron'u: eskiyen/çelişen kayıtları raporlar

---

## 14. Riskler / Bilinçli Tercihler

- **sqlite-vec ölçeği:** ~1M vektör üstünde yavaşlar. O noktaya gelirsek
  Qdrant'a geçiş planlı; veri modeli buna göre soyutlanacak (repo pattern).
- **Gemini bağımlılığı:** Embedding provider `core` içinde arayüz arkasında —
  ileride Voyage/OpenAI'a geçiş tek dosya değişikliği. Boyut değişirse
  re-index gerekir (script hazır olacak).
- **Tek Pi = tek nokta:** Markdown+git yedeği sayesinde veri kaybolmaz;
  Pi çökerse aynı repo herhangi bir makinede `hub-server` olarak ayağa kalkar.
