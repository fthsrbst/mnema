# Repo Analizi — ai-hub vs 4 Açık Kaynak Proje (Temmuz 2026)

> 2026-07-07 tarihli tarihsel snapshot. Sonraki sürüm authoritative
> `context_get`, document lifecycle, scoped auth, typed temporal relations,
> generation-aware sync, audit/integrity kontrolleri ve VectorStore sınırı
> ekledi. Güncel mimari için `architecture/enterprise-context-platform.md`
> kullanılmalı; bu dosya yalnız tarihli rakip gözlemleri içindir.

Bu rapor, ai-hub'ı (Raspberry Pi 5 üzerinde çalışan, tek kullanıcılı ortak hafıza + RAG + proje map sunucusu) dört açık kaynak projeyle karşılaştırır: **avenoxbeyin**, **raold/second-brain**, **M0nkeyFl0wer/second-brain-hybrid-graph** ve **crewAI**. Amaç övgü değil eksik listesi: hangi fikirler ai-hub'a taşınmaya değer, hangileri tek kullanıcılı Pi kurulumuna uymaz. Analiz tarihi: 2026-07-07. ai-hub'ın mevcut durumu: Faz 1 tamam (memory CRUD, Gemini embedding, hibrit arama RRF, MCP+REST, auto-recall hook, FTS-only fallback), sync (LWW + tombstone + embedding taşıma) ve machines registry (LM Studio/ComfyUI) kodda mevcut.

---

## 1. avenoxbeyin (avenoxai/avenoxbeyin)

**Ne:** Obsidian + Claude Code üzerine kurulu, dosya tabanlı "second brain" şablonu. Sunucu yok, DB yok — Markdown vault + üç bash hook'u.

**Mimari:** `template/` altında PARA benzeri klasör yapısı (Inbox, Command-Center, Projects, Knowledge, Companion, Archive). Hafıza `🔮 850-Companion/` içinde dört Markdown dosyası: `Core.md` (kimlik/çıpalar), `Last-Session.md` (oturum köprüsü), `Threads.md` (süregelen konular), `Journal.md`. Continuity engine üç sıfır-bağımlılık hook'u: `session-start.sh` (son oturum + aktif thread'leri bağlama enjekte eder), `prompt-counter.sh`, `session-end.sh` (hafıza güncellenmeden kapanırsa `needs_reflection` bayrağı bırakır — sonraki oturum başında uyarı çıkar). Opsiyonel mem0 ile semantik arama.

**Hafıza/RAG yaklaşımı:** Saf dosya tabanlı; arama motoru yok (mem0 opsiyonel). Hafıza insan-okur anlatı formatında — "ne oldu, nerede kaldık" köprüsü ai-hub'ın session_log'una benzer ama daha yapılandırılmış (Threads = süregelen hikaye çizgileri, kapanmamış işlerin izlenmesi).

**ai-hub'da olmayan öne çıkanlar:**
- `needs_reflection` guard'ı: oturum özet yazılmadan biterse bir sonraki oturumda deterministik uyarı. Basit ve etkili bir "hafıza kendini besler" garantisi.
- `Threads.md` kavramı: proje bazlı değil, oturumlar-arası açık konu takibi (ai-hub'da next_steps proje map'inde var ama proje-dışı thread kavramı yok).
- SessionStart hook'unda yapılandırılmış enjeksiyon (ai-hub UserPromptSubmit kullanıyor; SessionStart'ta "son oturum köprüsü" enjekte etmiyor).

**Zayıf yönler:** Arama yok, ölçek yok (dosyalar büyüyünce bağlam şişer), macOS'a bağlı launcher, tek agent (Claude Code), cihazlar arası senkron = git'e bırakılmış. ai-hub'ın çözdüğü problemlerin çoğunu çözmüyor; buradan alınacak şey mimari değil, oturum sürekliliği UX kalıpları.

---

## 2. second-brain (raold/second-brain, v5)

**Ne:** "%100 lokal" kişisel bilgi yönetimi: Python/FastAPI + PostgreSQL/pgvector, Docker Compose, LM Studio + CLIP + LLaVA lokal model servisleri.

**Mimari:** `app/` altında routes/services/storage/core katmanları. Depolama Postgres + pgvector (`postgres_unified.py`) + mock storage fallback. Embedding: nomic-embed-text (768d, lokal). Multimodal: CLIP servisiyle görsel embedding/benzerlik, LLaVA ile görüntü analizi + OCR. Google Drive OAuth ingest. `core/degradation.py` kademeli bozulma yöneticisi (FULL → NO_VECTOR → NO_PERSISTENCE → READONLY → MAINTENANCE).

**Hafıza/RAG yaklaşımı:** Memory CRUD + semantik/keyword/hibrit arama. Dikkat çeken servis metotları: `create_relationship` / `get_related_memories` / `build_knowledge_graph` (hafızalar arası ilişki), `find_duplicate_memories` / `auto_consolidate_duplicates` / `consolidate_memories` (embedding benzerliğiyle mükerrer tespiti ve birleştirme), `get_memory_insights` (istatistik/içgörü).

**ai-hub'da olmayan öne çıkanlar:**
- Otomatik mükerrer tespiti + konsolidasyon (kayıt anında `_check_for_duplicates`).
- Hafızalar arası açık ilişki kaydı ve basit knowledge graph çıktısı.
- Çok seviyeli degradation modeli (ai-hub'da tek seviye var: FTS-only fallback — bu zaten iyi).
- Multimodal arama (görselle arama, OCR).

**Zayıf yönler:** Stack tek kullanıcı için ağır (Docker + Postgres + 3 ayrı model servisi + k8s manifestleri); README'nin vaatleriyle kod olgunluğu arasında mesafe var (mock storage hâlâ içeride, insights modülü iskelet); son commit 2026-05, tempo düşük. Pi 5'te bu stack çalışmaz; fikirler alınır, mimari alınmaz.

---

## 3. second-brain-hybrid-graph (M0nkeyFl0wer)

**Ne:** "Homelab" hibrit graph-RAG: düz vektör aramadan **tipli graph traversal**'a geçiş denemesi. Local-first, daemon'sız — ai-hub felsefesine en yakın proje.

**Mimari:** Python. İki gömülü DB: **DuckDB** (chunk'lar, BM25 + HNSW, RRF füzyonu — ai-hub'ın SQLite+FTS5+sqlite-vec+RRF üçlüsünün birebir muadili) ve **LadybugDB** (tipli kenar graph'ı: entity'ler + kanıt taşıyan ilişkiler). Ollama ile lokal extraction + embedding (nomic-embed-text, llama3.2:3b). NetworkX/Ripser ile topoloji analizi. systemd unit'leri repo'da.

**Hafıza/RAG yaklaşımı:** Ingest sırasında her nottan LLM ile **entity + tipli ilişki (triplet) çıkarımı**; ilişkiler YAML **ontology**'ye (entity_types, edge_types, domain/range) karşı doğrulanır — katı ontoloji LLM önerilerinin ~%75-80'ini eler (bilinçli hassasiyet/kapsam ayarı). Sorgu modları: vector / keyword / hybrid / **path** (iki fikir arasındaki bağlantı yolunu bulma). Feedback döngüleri: enrichment (planlı yeniden okuma), pruning (reconstruct-and-swap ile güvenli toplu temizlik), pathfinding. `briefing.py` günlük özet, `mcp_server.py` (deneysel), dashboard (deneysel).

**ai-hub'da olmayan öne çıkanlar:**
- Tipli entity-ilişki graph'ı ve path sorgusu ("X ile Y nasıl bağlantılı?").
- Ontology'nin YAML config olması + domain/range doğrulama.
- Pruning'in reconstruct-and-swap deseni (geri dönüşsüz toplu mutasyon için filtreli kopya → doğrula → değiştir).
- Dürüst "pipeline maturity" tablosu (hangi parça core, hangisi deneysel — dokümantasyon pratiği olarak örnek alınası).

**Zayıf yönler:** Yarısı deneysel; ingest not başına LLM çalıştırıyor (Pi'de çok yavaş olur, Fatih'in kurulumunda LM Studio makinelerine yönlendirilebilir ama gecikme ciddi); tek geliştirici, 20 test dosyası; MCP server olgun değil. Graph katmanının tek kullanıcı ölçeğinde getirisi henüz kanıtlanmış değil — repo sahibi de bunu saklamıyor.

---

## 4. crewAI (crewAIInc/crewAI)

**Ne:** Üretim seviyesi multi-agent framework (Python). ai-hub'ın rakibi değil — ai-hub bir *sunucu*, crewAI bir *framework* — ama memory modülü sınıfının en rafine örneği.

**Orkestrasyon mimarisi:** `Crew` (agent takımı) + `Agent` (rol/hedef/araçlar) + `Task` + `Process` (sequential / hierarchical — hierarchical'da bir manager LLM görev dağıtır). `Flow` sınıfı: `@start/@listen/@router` dekoratörleriyle olay güdümlü, durum taşıyan iş akışları. Ek modüller: `knowledge/` (kaynak-tabanlı bilgi enjeksiyonu), `rag/` (ChromaDB/Qdrant backend'leri, çok sağlayıcılı embedding factory), `events/` (event bus — memory dahil her şey olay yayar), `a2a/` (agent-to-agent), `mcp/` desteği. Aktif geliştirme (son commit Temmuz 2026).

**Memory modülü (asıl ilginç kısım):** Tek `Memory` sınıfı, LLM-analizli, depolama takılabilir (LanceDB varsayılan, Qdrant edge):
- **Kayıt (EncodingFlow, 5 adım):** toplu embed → batch içi cosine dedup → paralel benzer-kayıt arama → paralel LLM analizi (scope/kategori/önem çıkarımı + **konsolidasyon planı**: benzerlik > 0.85 ise mevcut kaydı güncelle/birleştir) → toplu yazım.
- **MemoryRecord alanları:** hiyerarşik `scope` (örn. `/company/team/user`), `categories`, `importance` (0-1, LLM takdir eder), `entities/dates/topics` (extracted_metadata), `last_accessed`, `source` (provenance), `private` bayrağı.
- **Recall (RecallFlow, "RLM-inspired"):** sorguyu LLM ile analiz et → alt-sorgulara damıt → scope seç → paralel arama → güven skoruna göre **adaptif derinlik** (yeterliyse dur, değilse recursive exploration + yeniden arama) → sentez: dedup + kompozit skor + "evidence gap" işaretleme.
- **Kompozit skor:** `0.5·semantik + 0.3·güncellik (30 gün yarı ömürlü üstel azalma) + 0.2·önem`.

**Zayıf yönler (Fatih'in bağlamında):** Python; framework'e gömülü (memory'yi ayrık kullanmak mümkün ama bağımlılık ağır); her save/recall LLM çağrısı = gecikme + maliyet (ai-hub'ın <300ms recall bütçesiyle çelişir); varsayılan embedder OpenAI. Orkestrasyon katmanı (Crew/Task) ai-hub'ın kapsamı dışında — agent'lar zaten Claude Code; hub'ın işi hafıza, orkestrasyon değil.

---

## 5. Karşılaştırma Tablosu

| Boyut | **ai-hub** | avenoxbeyin | second-brain | hybrid-graph | crewAI |
|---|---|---|---|---|---|
| Tür | Hafıza/RAG **sunucusu** | Obsidian şablonu + hook | KM uygulaması | Graph-RAG pipeline | Multi-agent **framework** |
| Dil/stack | TS/Node 22, Express | Bash + Markdown | Python/FastAPI | Python | Python |
| Depolama | SQLite (tek dosya) | Düz dosya | Postgres+pgvector | DuckDB + LadybugDB | LanceDB/Qdrant (takılabilir) |
| Embedding | Gemini 768 (API, tek yerde) | — (ops. mem0) | nomic (lokal) | Ollama nomic (lokal) | OpenAI vd. (factory) |
| Arama | Hibrit BM25+vek, **RRF** | yok | Semantik+hibrit | Hibrit RRF + **graph path** | Semantik + kompozit skor |
| Hafıza modeli | 5 tip, tag, proje | Anlatı (4 dosya) | Memory + ilişki | Entity+tipli kenar | Scope/kategori/önem, LLM-analizli |
| Konsolidasyon/dedup | ❌ | ❌ | ✅ otomatik | pruning script'leri | ✅ kayıt anında |
| Güncellik/önem skoru | ❌ (sadece RRF) | — | kısmi | ❌ | ✅ (decay + importance) |
| Auto-recall | ✅ hook, <300ms | ✅ SessionStart | ❌ | ❌ | ✅ (LLM'li, yavaş) |
| Çoklu agent istemcisi | ✅ MCP+REST (her agent) | Sadece Claude Code | REST | MCP (deneysel) | Kendi agent'ları |
| Cihazlar arası sync | ✅ LWW+tombstone | git'e bırakılmış | ❌ | ❌ | ❌ (SaaS: kısmi) |
| Multimodal | ❌ (ComfyUI üretim var, arama yok) | ❌ | ✅ CLIP/LLaVA/OCR | ❌ | ❌ |
| Deployment hedefi | Pi 5, systemd, Docker'sız | mac masaüstü | Docker/k8s | homelab, systemd | pip kütüphanesi |
| Olgunluk | Aktif, Faz 1/6 | Basit ama bitmiş | Orta; vaat>kod | Yarısı deneysel, dürüst | Yüksek, çok aktif |

---

## 6. Önceliklendirilmiş Eksik Listesi

Efor: **S** ≈ yarım gün, **M** ≈ 1-2 gün, **L** ≈ 3+ gün. Ölçüt: tek kullanıcı, Pi 5, <300ms recall bütçesi, sıfır-operasyon felsefesi.

### Almaya değer (öncelik sırasıyla)

**1. Kompozit skorlama: güncellik azalması + önem alanı — S/M** *(kaynak: crewAI)*
Ne: RRF sonucunu `w1·rrf + w2·recency(üstel, ~30 gün yarı ömür) + w3·importance` ile yeniden sırala; `memories`e `importance REAL` kolonu (varsayılan 0.5, memory_save parametresi). Neden: Auto-recall şu an salt alaka bakıyor; hafıza büyüdükçe 8 ay önceki bayat karar, dünkü kararın önüne geçebilir. Saf SQL/TS işi, LLM gerektirmez, recall bütçesini bozmaz. En yüksek getiri/efor oranı bu.

**2. Kayıt anında dedup + konsolidasyon önerisi — M** *(kaynak: crewAI EncodingFlow, second-brain auto_consolidate)*
Ne: `memory_save` embedding'i zaten üretiyor; kaydetmeden önce memories_vec'te benzerlik araması yap, eşik üstünde (örn. cosine > 0.9) mevcut kayıt varsa MCP yanıtında "şu kayıtla çakışıyor: güncelle mi, yeni mi?" döndür (veya `dedupe:auto` modunda güncelle). Neden: CLAUDE.md'deki "hafızayı çöplüğe çevirme" kuralının tek garantisi şu an agent disiplini; sistem desteği yok. PLAN'daki "haftalık hafıza bakımı" cron'unun da temeli.

**3. last_accessed / hit sayacı — S** *(kaynak: crewAI)*
Ne: recall/search'te dönen memory'lerin `last_accessed` + `hits` alanını güncelle (tek UPDATE, sync'e dahil etmeye gerek yok). Neden: Hangi hafızanın gerçekten işe yaradığının verisi olmadan pruning kararı verilemez; madde 2 ve gelecekteki bakım cron'u bu sinyale muhtaç. Neredeyse bedava.

**4. Oturum sürekliliği: SessionStart köprüsü + needs_reflection guard'ı — S** *(kaynak: avenoxbeyin)*
Ne: (a) Claude Code SessionStart hook'u: son session_log + aktif projenin current_focus/next_steps'ini enjekte et ("dün nerede kalmıştık" köprüsü — UserPromptSubmit recall'undan farklı, mesajdan bağımsız). (b) SessionEnd'de session_log yazılmadıysa yerel bayrak bırak, sonraki SessionStart'ta "önceki oturum özetsiz kapandı" uyarısı çıkar. Neden: session_log'un kendini besleme döngüsündeki en zayıf halka "agent unutursa" durumu; bash 30 satırıyla kapanıyor.

**5. session_log'dan otomatik hafıza çıkarımı — M** *(kaynak: crewAI extract_memories_from_content)*
Ne: Gece cron'u: günün session_log'larını LM Studio'daki lokal modele (machines registry zaten var — `local_llm`) ver, kalıcı olmaya değer fact/decision adaylarını çıkart, `source:auto-extract` etiketiyle ve onay kuyruğuyla kaydet. Neden: Hafızanın dolması şu an tamamen agent'ların memory_save disiplinine bağlı; crewAI'ın gösterdiği gibi bu iş LLM'e devredilebilir — ve Fatih'in kurulumunda API maliyeti sıfır (yerel model). Onay adımı şart, yoksa çöp üretir.

**6. Hafif entity metadata'sı — M (tam graph değil!)** *(kaynak: hybrid-graph + crewAI extracted_metadata)*
Ne: memory_save/rag_add sırasında (veya 5. maddedeki cron'da) lokal LLM ile entity listesi çıkar (`entities` JSON kolonu), aramada entity filtresi sun. Neden: "X kişisi/projesi hakkında ne biliyorum" sorgusu tag disiplinine bağlı kalmaz. Tam tipli graph + traversal'ın (LadybugDB benzeri) tek kullanıcı ölçeğinde getirisi kanıtsız ve L efor — o kısmı almıyoruz, sadece ucuz kısmını alıyoruz.

**7. `hub status`a degradation görünürlüğü — S** *(kaynak: second-brain degradation.py)*
Ne: FTS-only moda düşüş zaten var ama sessiz; `/health` ve `hub status` çıktısına "mod: full/fts-only, sebep: X, süredir: Y" ekle; web UI'da rozet. Neden: Pi'de Gemini kotası bitince/sqlite-vec bozulunca aramanın sessizce kötüleştiğini fark etmemek gerçek bir risk. Mevcut fallback'i gözlemlenebilir yapmak yarım günlük iş.

**8. Dokümantasyona "maturity tablosu" — S** *(kaynak: hybrid-graph README)*
Ne: README'ye hangi özelliğin core/deneysel/planlı olduğunu gösteren tablo. Neden: Çok cihazdan çok agent bu sunucuya güvenecek; hangi tool'un ne kadar güvenilir olduğunu agent'ların (ve 6 ay sonraki Fatih'in) bilmesi ucuz sigorta.

### Bilinçli olarak alınmayanlar

- **Tam graph DB + path traversal** (hybrid-graph): Tek kullanıcı hafıza ölçeğinde (binlerce kayıt) getirisi kanıtsız; LadybugDB gibi ikinci bir DB "tek dosya, sıfır operasyon" felsefesini bozar. Madde 6'daki hafif versiyon yeter; ihtiyaç doğarsa veri (entities kolonu) zaten birikmiş olur.
- **LLM'li RecallFlow (adaptif derinlik, alt-sorgular)** (crewAI): Hook path'inde <300ms bütçeyi katlar. Açık `memory_search`e opsiyonel `deep:true` parametresi olarak ileride düşünülebilir; şimdi değil.
- **Multimodal arama (CLIP/LLaVA/OCR)** (second-brain): Pi'de GPU yok; kullanım senaryosu (görselle hafıza arama) mevcut iş akışında yok. ComfyUI entegrasyonu üretim tarafını zaten karşılıyor.
- **Postgres/pgvector veya Qdrant'a geçiş**: PLAN'daki eşik (~500K vektör) çok uzak; SQLite doğru karar.
- **Google Drive ingest** (second-brain): Fatih'in kaynakları dosya sistemi + git; PLAN'daki watch-mode ve quick capture daha yüksek öncelikli.
- **Orkestrasyon katmanı (Crew/Task/Process)** (crewAI): Hub'ın işi hafıza sunmak; orkestrasyonu Claude Code/subagent'lar zaten yapıyor. Kapsam kaymasına gerek yok.
- **mem0 entegrasyonu** (avenoxbeyin): ai-hub'ın kendisi zaten mem0'ın yaptığını (ve fazlasını) lokalde yapıyor.
