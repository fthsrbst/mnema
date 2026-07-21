# Agent Intelligence Platform

Bu doküman ai-hub'ın "birden fazla agent aynı işte nasıl koordine olur" katmanını
anlatır: görev kuyruğu, agent yetenek kaydı, agent-agent mesajlaşma, hafıza
hijyeni, bilgi sıkıştırma (compaction), ders çıkarma (lessons), webhook'lar,
async iş kuyruğu (jobs) ve sistem metrikleri. Presence (`agent_checkin` /
`agent_checkout`) ile karıştırma — presence "kim nerede çalışıyor" bilgisidir
(advisory, kilit değil); bu platform "işi kim yapacak, kime devretti, ne
öğrendi" katmanıdır.

## Koordinasyon akışı

Tipik bir uçtan uca akış:

1. **Bir agent görev açar** — `task_create` ile başlık, açıklama, proje,
   öncelik ve varsa bağımlılıklar (`depends_on`) belirtilir.
2. **Diğer agent `task_claim` ile alır** — ya belirli bir `uid` ile ya da
   `project` verip kuyruktaki bir sonraki uygun görevi alarak (yalnızca
   bağımlılıkları çözülmüş, `pending` görevler alınabilir).
3. **Çalışma sırasında mesajlaşma/handoff** — `agent_message_send` ile
   agent'lar birbirine bilgi/istek/uyarı gönderir (`info`, `request`,
   `response`, `handoff`, `alert`); bir iş tamamen başka bir agent'a
   devredilecekse `agent_handoff` proje map'i, son oturumlar, aktif görevler,
   presence ve ilgili hafızaları tek pakette taşır.
4. **`task_complete` + `task_feedback`** — görev biterken `task_complete` ile
   sonuç (`result`) ve **doğrulama kanıtı** (`verification`) yazılır; ardından
   `task_feedback` ile sonuç (`success` / `partial` / `failure`), ne işe
   yaradı, ne başarısız oldu ve dersler (`lessons`) kaydedilir.
   - `verification` objesi: `{kind, command?, exit_code?, summary}`; `kind`
     `"tests"` | `"build"` | `"manual"` | `"none"`. Kolon nullable — boş bırakılırsa
     görev yine `done` olur AMA yanıtta belirgin bir `uyari` alanı döner
     (advisory, *sert kilit DEĞİL* — presence felsefesiyle tutarlı). `kind:"none"`
     bilinçli seçilirse uyarı verilmez. Kanıt eksikse `task_update` ile
     sonradan eklenebilir.
   - DORA 2025 + Faros AI verisi: AI agent'lar ~%98 daha fazla PR üretiyor ama
     teslim hızı iyileşmiyor; bu kapı "yaptım" demenin kolay yoldan geçişini
     zorlaştırmadan kanıt toplamayı nudge eder.
5. **Dersler kalıcı hafızaya düşer** — `task_feedback`'teki `lessons` alanı
   otomatik olarak `howto` tipinde bir hafıza kaydına dönüşür; `project_lessons`
   bir proje için birikmiş dersleri, `knowledge_transfer` ise başka projelerden
   etiket örtüşmesine göre aktarılabilecek bilgiyi bulur.

Görev durumları: `pending → claimed → in_progress → done` (veya `blocked`,
`cancelled`). `task_queue`, bağımlılığı çözülmüş `pending` görevleri önceliğe
göre sıralı döner — "sırada ne var" sorusunun cevabı budur.

## MCP araçları (yeni: Agent Intelligence Platform)

Aşağıdaki tablo `src/server/mcp.ts` içindeki gerçek `registerTool` çağrılarından
çıkarılmıştır. Mnema'nın önceki 46 aracına ek olarak bu platformla birlikte
**28 yeni araç** geldi (toplam 74). Var olan araçlar (context/recall, memory,
graph, RAG, project, session, profile, prompt/skill, presence, machine,
media, integrity/audit/vector) için bkz. `README.md` → "Tools".

### Görevler (task_*)

| Araç | Ne yapar |
|---|---|
| `task_create` | Agent'lar arası iş delegasyonu için yeni görev oluşturur; bağımlılık, öncelik ve etiket destekler. |
| `task_claim` | Belirli bir görevi veya proje kuyruğundaki bir sonraki uygun görevi alır. |
| `task_update` | Görev durumunu, önceliğini veya diğer alanlarını günceller. |
| `task_complete` | Görevi sonuç metni ve opsiyonel `verification` kanıtıyla `done` işaretler. Kanıt verilmezse görev yine done olur ama yanıtta `uyari` döner (advisory, sert kilit değil); `kind:"none"` açıkça verilirse uyarı verilmez. |
| `task_list` | Proje, durum, agent veya etikete göre filtrelenmiş görev listesi döner. |
| `task_queue` | Bağımlılığı çözülmüş, önceliğe göre sıralı bir sonraki uygulanabilir görevleri döner. |

### Yetenekler (agent_*)

| Araç | Ne yapar |
|---|---|
| `agent_register` | Bir agent'ın yeteneklerini (capabilities), modellerini ve eş zamanlılık limitini kaydeder/günceller. |
| `agent_find` | Belirli bir yeteneğe sahip agent'ları bulur, isteğe bağlı proje filtresiyle. |
| `agent_list` | Kayıtlı tüm agent'ları yetenek ve durumlarıyla listeler. |
| `agent_handoff` | Proje map'i, son oturumlar, aktif görevler, presence ve ilgili hafızaları içeren yapılandırılmış bir devir paketi oluşturur. |

### Mesajlaşma (agent_message_*, message_*)

| Araç | Ne yapar |
|---|---|
| `agent_message_send` | Başka bir agent'a (veya yayın olarak herkese) mesaj gönderir — `info`/`request`/`response`/`handoff`/`alert`. |
| `agent_inbox` | Bir agent'ın okunmamış mesajlarını döner, isteğe bağlı proje/tür filtresiyle. |
| `message_mark_read` | Tek bir mesajı okundu işaretler; yayınlarda agent bazlı okunma takibi yapar. |
| `message_mark_all_read` | Bir agent için tüm doğrudan mesajları ve okunmamış yayınları okundu işaretler. |
| `message_unread_count` | Bir agent için okunmamış mesaj sayısını döner. |

### Hafıza hijyeni (hygiene_*)

| Araç | Ne yapar |
|---|---|
| `hygiene_report` | Hafıza kalitesi raporu: yinelenenler, bayat kayıtlar, çelişkiler, sahipsiz ilişkiler. |
| `hygiene_run` | Otomatik hijyen geçişi çalıştırır: çok bayat/düşük önemli kayıtları arşivler, sahipsiz ilişkileri temizler. |

### Sıkıştırma ve öğrenme (compact_project, task_feedback, project_lessons, knowledge_transfer)

| Araç | Ne yapar |
|---|---|
| `compact_project` | Bir proje için bilgi sıkıştırmasını tetikler: oturumları ve kararları özet dokümanlara indirger. |
| `task_feedback` | Tamamlanan bir görev için geri bildirim kaydeder: sonuç, ne işe yaradı, ne başarısız oldu, dersler (dersler otomatik `howto` hafızasına düşer). |
| `project_lessons` | Bir proje için görev geri bildirimlerinden birikmiş dersleri döner. |
| `knowledge_transfer` | Etiket örtüşmesi ve öneme göre başka projelerden aktarılabilir bilgiyi bulur. |

### Webhook'lar (webhook_*)

| Araç | Ne yapar |
|---|---|
| `webhook_register` | Hub olaylarını almak için bir HTTP uç noktası kaydeder; olay filtresi ve HMAC imzalama destekler. |
| `webhook_list` | Kayıtlı tüm webhook'ları durumlarıyla listeler. |
| `webhook_remove` | UID ile kayıtlı bir webhook'u kaldırır. |

### İş kuyruğu (job_*)

| Araç | Ne yapar |
|---|---|
| `job_enqueue` | Worker kuyruğuna asenkron bir iş ekler — türler: `embed`, `compact`, `hygiene`, `webhook`, `sync`, `reindex`. |
| `job_status` | Belirli bir işin durumunu döner veya son işleri listeler. |

### Metrikler ve olaylar (metrics_overview, event_log)

| Araç | Ne yapar |
|---|---|
| `metrics_overview` | Sistem metriklerini döner: uptime, istek sayıları, gecikme yüzdelikleri, hafıza/görev/agent istatistikleri ve son 7 güne ait **koordinasyon-yükü bloğu** (`coordination`): `tasks_completed_7d`, `avg_task_cycle_time_min` (claim→finish dk ort.), `handoff_ratio` (handoff mesaj / tamamlanan görev; yüksek = iş devirde boğuluyor), `reclaim_count_7d` (aynı göreve ikinci+ claim — agent düşmüş / dönüp duran iş sinyali), `verification_coverage` (kanıt (kind != `none`) ile biten tamamlanan görev oranı). Tek SQL turu, sıcak yolda ~0.1 ms. |
| `event_log` | Hata ayıklama/izleme için son hub olaylarını döner. |

## Yeni DB tabloları

`src/core/db.ts` içinde tanımlı (bkz. `CREATE TABLE IF NOT EXISTS`):

- `tasks` — görev kuyruğu (durum, öncelik, `depends_on`, `claimed_by`, sonuç/hata, `verification` JSON kanıtı).
- `agent_capabilities` — agent kaydı: yetenekler, modeller, `max_concurrent`, durum (`available`/`busy`/`offline`), `last_seen_at`.
- `agent_messages` — agent-agent mesajları (insert-only; LWW gerektirmez).
- `agent_message_reads` — yayın mesajlarında agent bazlı okunma takibi.
- `task_feedback` — görev sonucu, ne işe yaradı/yaramadı, dersler.
- `webhooks` — kayıtlı webhook uç noktaları, olay filtreleri, HMAC secret, son tetiklenme durumu.
- `jobs` — async iş kuyruğu (durum, deneme sayısı, `next_run_at`, exponential backoff).
- `hub_events` — hata ayıklama/izleme için ham olay günlüğü.

## Worker / job modeli

`src/core/worker.ts`: SQLite tabanlı, tek iş parçacıklı (single-threaded) bir
kuyruk işleyicisi.

- `enqueueJob(kind, payload)` bir iş satırı ekler (`status='queued'`).
- `startWorker(intervalMs)` düzenli aralıklarla `processJobs()` çağırır; her
  turda en fazla 10 vadesi gelmiş (`next_run_at <= now`) işi işler.
- Başarılı iş `done` olur; hata alan iş `max_attempts`'e kadar üstel geri
  çekilme (exponential backoff: `2^deneme * 5` saniye) ile yeniden kuyruğa
  girer, aşılınca `failed` işaretlenir.
- İş türleri: `embed`, `compact`, `hygiene`, `webhook`, `sync`, `reindex` —
  her türün bir handler'ı `registerJobHandler` ile kaydedilir.
- `pruneJobs(daysOld)` tamamlanmış/başarısız işleri periyodik temizler.

## Cihazlar arası ne senkronize olur, ne yerelde kalır

`src/core/sync.ts`'e göre:

- **Senkronize olan** (peer/primary arasında push/pull ile taşınır):
  `tasks`, `agent_capabilities`, `agent_messages`. Bunlar "ortak gerçek" —
  bir cihazda açılan görevi başka bir cihazdaki agent almalı, bir agent'ın
  yeteneği/durumu her cihazdan görünmeli, mesajlaşma cihaz sınırı tanımamalı.
- **Yerelde kalan** (senkronize edilmez): `jobs`, `hub_events`, `webhooks`,
  `task_feedback`. Bunlar o node'a özgü operasyonel durumdur — bir başka
  cihazın worker kuyruğunu veya webhook listesini görmesi gerekmez;
  `task_feedback`'ten çıkan dersler zaten `memory_save` ile senkronize olan
  bir hafıza kaydına dönüştüğü için ayrıca taşınmasına gerek yoktur.

## Ortam değişkenleri

| Değişken | Varsayılan | Ne işe yarar |
|---|---|---|
| `HUB_WORKER_INTERVAL_MS` | `5000` | Worker'ın vadesi gelmiş işleri kaç ms'de bir kontrol edeceği. |
| `HUB_AGENT_TTL_MIN` | `60` | Bu kadar dakikadır görünmeyen agent capability kaydı `offline` sayılır. |
| `HUB_TASK_PRUNE_DAYS` | `30` | Bu kadar günden eski tamamlanmış/iptal görevler otomatik temizlenir. |

(Presence'e özgü `HUB_PRESENCE_TTL_MIN` bu platformun değil, `agent_checkin`/
`agent_active` advisory presence katmanının ayarıdır — bkz. kök `CLAUDE.md`.)

## Benchmark sonuçları (2026-07-20, Windows/Node 24, geçici DB, embedding kapalı)

Mikro-benchmark (`npx tsx scripts/benchmark.ts`): 32/32 test geçti, toplam 67 ms, ortalama 2,1 ms.

Ölçek testi — 5.000 memory + 3.000 görev + 4.000 mesaj yüklü DB:

| İşlem | Süre |
|---|---|
| `listTasks` (pending, limit 50) | 1,6 ms |
| `taskQueue` (proje bazlı) | 1,2 ms |
| `claimTask` ×100 ardışık | 26 ms |
| `inbox` / `unreadCount` | 1,5 / 0,3 ms |
| `findDuplicates` (tüm DB) | ~1.050 ms |
| `hygieneReport` (tek proje) | ~800 ms |
| `getMetricsSnapshot` | 0,5 ms |
| `coordinationStats` (7-günlük koordinasyon bloğu, tek SQL turu) | ~0,1 ms |

Not: `findDuplicates` maliyetinin tamamına yakını 2. geçişteki en yeni 200 memory için atılan
FTS sorgularıdır (kayıt başına ~5 ms). 6 saatlik bakım döngüsü ve elle tetiklenen
`hygiene_report` için kabul edilebilir; sıcak istek yolunda ÇAĞIRMA.
