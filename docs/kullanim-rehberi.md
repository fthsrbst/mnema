# Kullanım Rehberi — ai-hub'ı En Verimli Nasıl Kullanırım

Bu doküman "hangi tool var" listesi değil, "hangi durumda ne yaparım" rehberi.
Altı gerçek senaryo ve her birinde somut tool çağrıları/komutlar.

---

## (a) Yeni projeye başlarken

Amaç: proje daha ilk günden hub'da bir "map"e sahip olsun, ileride hangi
cihazdan/agent'tan açarsan aç aynı bağlamı bulasın.

1. `new-project` skill'ini tetikle (Claude Code'da otomatik, "yeni proje: X"
   dediğinde). Skill scaffold + git init + README'yi kurar.
2. Proje map'ini oluştur:
   ```
   project_update({
     name: "ornek-proje",
     status: "active",
     summary: "Tek paragraf: ne bu proje, neden var.",
     stack: ["nextjs", "sqlite"],
     current_focus: "auth akışını bitirmek",
     next_steps: ["login sayfası", "session middleware"]
   })
   ```
3. Stack/mimari seçimi yaparken gerekçeyi hemen yaz — sonradan "neden bunu
   seçmiştim?" sorusuna cevap kalıcı olsun:
   ```
   project_add_decision({
     name: "ornek-proje",
     decision: "2026-07: DB olarak SQLite seçildi — tek kullanıcı, ölçek
                gerekmiyor, operasyon yükü sıfır."
   })
   ```
4. Devam ederken küçük kararları da anında logla; oturum sonunu bekleme —
   "bunu neden böyle yaptım" 3 hafta sonra hatırlanmaz, sadece yazılırsa kalır.

**Sonuç:** başka bir cihazda `project_get("ornek-proje")` çağıran her agent,
proje sıfırdan anlatılmadan tam bağlamla başlar.

---

## (b) Cihaz değiştirirken kaldığı yerden devam

Senaryo: dizüstünde çalıştın, akşam masaüstünde devam edeceksin.

1. Dizüstünde işi bitirirken (`session-handoff` skill'i veya elle):
   ```
   session_log({
     summary: "## Yapılanlar\n- auth middleware yazıldı\n## Yarım kalanlar\n- refresh token akışı (JWT kütüphanesi seçilmedi)\n## Sıradaki adım\n- jsonwebtoken vs jose karşılaştır, birini seç",
     project: "ornek-proje"
   })
   ```
2. Masaüstünde önce senkronu çalıştır (dizüstünde yazılan hafıza/proje
   güncellemeleri Pi'ye ve oradan bu cihaza aksın):
   ```bash
   hub sync
   ```
   (Pi primary ise ve sen doğrudan Pi'ye bağlıysan bu adım gereksiz; ama
   PC'ler arası local-first sync kullanıyorsan `HUB_PRIMARY_URL` ayarlıysa
   otomatik/periyodik çalışır — bkz. `.env.example`.)
3. Masaüstünde oturuma başlarken:
   ```
   session_recent({ project: "ornek-proje", limit: 3 })
   project_get("ornek-proje")
   ```
   İkisi birlikte "dün nerede kaldım" sorusuna tam cevap verir — özet +
   yapısal durum (next_steps, current_focus).

**Kural:** `session_log` yazmadan kapatılan oturumlar kayıptır — hook'lar
otomatik hafıza çeker ama otomatik özet yazmaz, bu senin (veya skill'in)
sorumluluğu.

---

## (c) Öğrenme akışı

Senaryo: yeni bir kavram/teknoloji öğreniyorsun, bilgi buharlaşmasın.

1. `learn` skill'ini tetikle ("X öğrenmek istiyorum" demek yeterli). Skill
   önce var olan notu arar:
   ```
   memory_search("event loop")
   rag_search("event loop")
   ```
2. Konu katmanlı anlatılır (zihinsel model → kod örneği → tuzaklar), küçük
   bir egzersiz yaptırılır.
3. Konu kapanırken kompakt bir öğrenme notu `rag_add` ile indekslenir:
   ```
   rag_add({
     title: "Öğrenme notu: Node.js event loop",
     uri: "learn/nodejs-event-loop",
     project: "learning",
     text: "# Node.js Event Loop\n## Zihinsel model\n...\n## Tuzaklar\n...\n## Açık sorular\n..."
   })
   ```
   `uri` sabit tutulduğu için tekrar öğrenmede aynı kayıt güncellenir,
   çoğalmaz.
4. Sonraki oturumda (gün/hafta sonra, hangi agent olursa olsun):
   ```
   rag_search("event loop", { project: "learning" })
   ```
   Not anında geri gelir; sıfırdan anlatılmaz, üstüne inşa edilir. "Açık
   sorular" bölümü varsa oradan devam edilir, mini quiz ile pekiştirilir.

**Neden işe yarar:** RAG hibrit arama (BM25 + vektör) sayesinde notu tam
başlığıyla hatırlamasan da ("o async/await konusu neydi") bulabilirsin.

---

## (d) Rol disipliniyle ciddi bir iş

Senaryo: mimari karar gerektiren bir iş var (örn. "queue sistemi mi kurmalıyım,
polling mi yeterli").

1. İşe uygun rolü çek:
   ```
   prompt_list()                              # rolleri gör
   prompt_get("senior-software-architect")     # master çekirdek otomatik eklenir
   ```
2. Bu promptu **kendi çalışma disiplinin** olarak benimse (agent zaten bu rolle
   düşünmeye başlar) — veya alt modele (`local_llm`) devrettiğin bir alt görev
   varsa bu içeriği system prompt olarak ver.
3. Karar netleşince hemen kaydet — hem genel hafızaya hem proje map'ine:
   ```
   memory_save({
     type: "decision",
     title: "Queue yerine polling",
     body: "Hacim günde <1000 iş; queue (SQS/Redis) operasyon yükü getirir,
            polling + cron 5 dakikada bir yeterli. Hacim 10x artarsa
            yeniden değerlendir.",
     project: "ornek-proje"
   })
   project_add_decision({
     name: "ornek-proje",
     decision: "2026-07: polling seçildi (queue değil) — düşük hacim, düşük operasyon yükü"
   })
   ```

**Neden iki yere de yazılır:** `memory_save` genel aranabilirlik için (başka
projede benzer soru çıkarsa bulunur), `project_add_decision` o projenin
kronolojik karar geçmişi için — ikisinin amacı farklı.

---

## (e) Basit işleri bedava yerel modele verme

Senaryo: 40 dosyaya kısa özet yazılacak, commit mesajı üretilecek, taslak
çeviri lazım — hiçbiri yargı gerektirmiyor.

1. Önce yerel makine/model müsait mi bak:
   ```
   machine_status()
   ```
2. İşin zorluğuna göre karar ver (`local-model` skill'inin kuralı): basit/toplu/
   mekanik iş → `local_llm`; yargı gerektiren iş → sen (mevcut agent) kal.
   ```
   local_llm({
     prompt: "Bu commit diff'i için tek satır Türkçe commit mesajı yaz: <diff>",
     machine: "masaustu",
     model: "qwen2.5-coder-14b"
   })
   ```
   System prompt vermezsen sunucu otomatik `master` promptunu enjekte eder —
   yerel model de aynı "kanıta dayalı, abartısız" disiplinle çalışır.
3. Çıktıyı olduğu gibi kullanıcıya sunma — kendin doğrula/düzelt, özellikle
   kritik alanlarda (ör. güvenlik/para ile ilgili metin) örnekleyerek kontrol
   et.

**Ne zaman KULLANMA:** mimari karar, kod review, zor debug, hub'a yazılacak
son hâl — bunlar agent'ta (sende) kalmalı; local_llm çıktısı ham sunulmaz.

---

## (f) Telefondan kullanım

Senaryo: masadan uzaktasın, "hangi projede neredeydim" veya hızlı not almak
istiyorsun.

1. Telefonda Tailscale uygulaması kurulu ve VPN açık (aynı hesap:
   <tailscale-hesabın>).
2. Tarayıcıda hub adresine git (Pi'de `tailscale serve` açık olduğu için
   tailnet içinde HTTPS ile yayında), token'ı gir.
3. "Ana ekrana ekle" ile PWA olarak kur — normal bir uygulama gibi açılır,
   adres çubuğu görünmez.
4. Dashboard'dan: son session log'lara bak, proje durumlarını gör, hızlı not
   düş (varsa quick-capture input'u kullan; yoksa mini not için memory
   ekranından `fact`/`context` tipi bir kayıt at).

**Not:** Telefonda tam bir agent (Claude Code vb.) çalıştırmıyorsun — bu akış
"bak/hatırla/hızlı not al" içindir, ağır iş için masaya dönene kadar bekler.
MCP destekleyen mobil AI uygulaması varsa (bkz. `docs/connectors.md`) oradan
da tool çağrısı yapılabilir, ama günlük kullanım çoğunlukla web UI/PWA.

---

## Obsidian tabanlı second-brain'lerle karşılaştırma

Objektif bir bakış — ikisi de "kalıcı bilgi" problemine çözüm ama farklı
eksenlerde güçlüler.

### Obsidian'ın artıları
- **Olgun editör ekosistemi:** yıllarca geliştirilmiş, hızlı, güvenilir
  markdown editörü; canvas, backlink, template gibi özellikler cilalı.
- **Görselleştirme / graph view:** notlar arası ilişkiyi görsel olarak
  gezebilirsin — hub'da bunun karşılığı yok.
- **Dosya = veri sahipliği:** her not düz `.md` dosyası; vault'unu kopyala,
  başka bir editörle aç, hiçbir kilitlenme yok.
- **Plugin bolluğu:** binlerce community plugin — spaced repetition, kanban,
  excalidraw, günlük şablonları vb. hazır.
- **Sıfır sunucu:** kurulum = uygulamayı indir. Çalıştırmak için hiçbir
  arka plan servisi, port, token yönetimi gerekmez.

### Obsidian'ın eksileri
- **Çok-agent eşzamanlı erişim yok.** Bir AI agent'ın Obsidian vault'una
  "sorgu at" diye bir standart yolu yok; her agent dosya sistemini bilmeli,
  vault'un nerede olduğunu bilmeli, formatı kendi çözmeli.
- **Hibrit/vektör arama eklenti gerektirir ve zayıftır.** Yerleşik arama
  düz metin/başlık eşleşmesi; semantik arama için üçüncü parti plugin lazım,
  kalitesi ve bakımı topluluğa bağlı.
- **MCP sunucusu değil.** Claude Code, Cursor, opencode gibi araçlar
  Obsidian'a "bağlanamaz" — sadece dosya yolunu bilen bir agent, dosyaları
  okuyup elle parse ederek kullanabilir. Ortak protokol yok.
  bu yüzden her agent dosya yolunu ayrıca bilmek zorunda.
- **Mobil sync ücretli ve/veya karmaşık.** Resmi Obsidian Sync abonelik
  gerektirir; ücretsiz alternatifler (git, iCloud, Syncthing) elle kurulum
  ve çakışma yönetimi ister.
- **Yapılandırılmış sorgu yok.** "Bu projenin next_steps'i ne" gibi bir
  soruya dosya içeriğini insan gibi okumadan (ya da Dataview gibi ek plugin
  olmadan) cevap veremezsin — hub'da bu `project_get` ile tek çağrı.

### ai-hub'ın artıları
- **Agent-agnostik MCP arayüzü:** Claude Code, Cursor, opencode, Codex,
  hatta claude.ai/ChatGPT/Gemini aynı tool setini görür — hiçbiri özel
  entegrasyon yazmaz.
- **Hibrit arama built-in:** BM25 + vektör + RRF, ek plugin/kurulum yok.
- **Multi-device LWW sync:** birden fazla makinede çalışan kararlar/notlar
  otomatik reconcile olur.
- **API/otomasyon dostu:** REST + MCP, script'ten de agent'tan da aynı
  şekilde çağrılır — CI/cron entegrasyonu doğal.

### ai-hub'ın eksileri
- **UI/editör deneyimi Obsidian'a göre zayıf.** Web UI fonksiyonel ama
  markdown yazma/düzenleme deneyimi olgun bir editörle yarışmaz.
- **Tek geliştirici, tek kullanıcı ölçeği.** Obsidian'ın topluluk/test
  yüzeyi yok; bug'lar sende kalır.
- **Görselleştirme/graph view yok.** Notlar/kararlar arası ilişkiyi
  görsel gezinme imkanı şu an yok.
- **Operasyon yükü var.** Bir sunucu (Pi) ayakta tutman, token yönetmen,
  yedek almanı gerektirir — Obsidian'da bunların hiçbiri yok.

### Hangisi ne zaman

- **Serbest biçimli düşünme, uzun-form yazma, görsel not ilişkilendirme**
  (araştırma, kişisel günlük, kavramlar arası bağ kurma) → **Obsidian**
  daha iyi araç; editör kalitesi ve graph view burada kazanır.
- **Birden fazla AI agent'ın ortak, sorgulanabilir, yapılandırılmış bir
  hafızaya ihtiyacı olduğu iş akışı** (proje kararları, cihazlar arası
  devam eden kodlama işi, agent'ların "hatırlaması" gereken tercihler) →
  **ai-hub** daha iyi araç; MCP + hibrit arama + proje mapleri burada
  Obsidian'ın yapamadığını yapar.
- **İkisi birlikte de kullanılabilir:** Obsidian'ı serbest düşünme/araştırma
  vault'un olarak tut, önemli çıktıları (karar, öğrenme notu) `rag_add`/
  `memory_save` ile hub'a köprüle — iki aracın da güçlü yanını kullanırsın.
