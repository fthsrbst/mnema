# Hafızanın cihaz-farkındalığı: `memory_machine_state` defteri

- Durum: Onaylandı (tasarım)
- Tarih: 2026-07-21
- Branch: `feature/memory-machine-state` (master `ab066df` üzerine rebase edildi)

## Bağlam güncellemesi (2026-07-21, ikinci tur)

Tasarımın ilk yazımından sonra master ilerledi ve iki ADR merge oldu:

- **ADR-005 (change_log)** — sync teslimat watermark'ı artık trigger tabanlı
  merkezi `change_log` + `SYNC_TABLES` dizisi. Bu tasarımın beklediği bağımlılık
  **karşılandı**; birleştirme-sırası endişesi ortadan kalktı.
- **ADR-006 (hafıza yaşam döngüsü)** — `memories`'e `is_current`, `valid_to`,
  `supersedes_uid`, `invalidated_reason`, `verified_at`, `review_after` eklendi;
  okuma yolu artık varsayılan `is_current = 1` filtreliyor. Bu tasarımla
  **dikey olarak diktir** ama okuma yolunda birlikte çalışmalı (§3, §11).

Not: ADR-006 tam olarak bu tasarımı motive eden 24/52 numaralı SSH hafızalarını
ve Tailscale örneğini kullanıyor. İki eksen ayrıdır: ADR-006 **zaman** eksenidir
(bir iddia ne zaman doğru/yanlış), bu tasarım **uzay** eksenidir (bir çözüm hangi
cihazda geçerli). SSH kaydı ikisine de tabidir — hem uçucu hem cihaza bağlı.

## Problem

Mnema üç cihazda çalışıyor (`fatih-pc`, `fatihpi`, `fatih-mac`). Bir agent
"Tailscale sorununu şöyle çözmüştük" diyen bir hafıza kaydını okuduğunda, o
çözümün **hangi cihazda** uygulandığını bilmiyor. Sonuç: bir cihazda çözülmüş
ama diğerlerinde çözülmemiş bir sorunu "çözülmüş" sayıyor, ya da bir cihaza
özgü konfigürasyonu başka cihazda uygulamaya çalışıyor.

`origin_machine` bu ihtiyacı **karşılamaz**. O, kaydın nerede *yazıldığını*
söyler (provenance). Gereken şey, çözümün nerede *geçerli/uygulanmış* olduğu —
ayrı bir boyut. Bir kayıt `fatih-pc`'de yazılmış olabilir ama üç cihazda da
uygulanmış ya da hiçbirinde uygulanmamış olabilir.

İhtiyacın gerçek olduğunun kanıtı: hafıza id 24 (SSH erişimi) bunu elle çözmüş —
gövdesinde cihaz cihaz durum anlatıyor ve `machine-fatih-pc` gibi etiketler
taşıyor. Yani bugün konvansiyonla çözülüyor; agent gövdeyi dikkatle okumazsa
yanılıyor ve hiçbir şey onu uyarmıyor.

## Kapsam dışı (YAGNI)

- Agent kimliği / presence / fleet UI'daki online-offline sorunu — ayrı iş.
- Cihazlar arası otomatik "bunu şurada da uygula" eylemi. Bu tasarım yalnız
  **bilgiyi doğru tutar ve uyarır**; uygulamayı agent/insan yapar.
- Cihaz başına ayrı hafıza gövdesi (fork). Tek gövde + cihaz başına durum.
- Geçmiş/denetim izi (kim ne zaman hangi durumu değiştirdi). Yalnız son durum
  tutulur; ihtiyaç doğarsa `audit_events` zaten var.

## 1. Veri modeli

`src/core/db.ts` içindeki `migrate()`'e:

```sql
CREATE TABLE IF NOT EXISTS memory_machine_state(
  uid         TEXT PRIMARY KEY,
  memory_uid  TEXT NOT NULL,
  machine     TEXT NOT NULL,
  status      TEXT NOT NULL CHECK(status IN ('applied','not_applied','not_applicable')),
  note        TEXT,
  verified_at TEXT,
  verified_by TEXT,
  updated_at  TEXT NOT NULL,
  UNIQUE(memory_uid, machine)
);
CREATE INDEX IF NOT EXISTS idx_mms_memory ON memory_machine_state(memory_uid);
```

Ayrıca mevcut `addColumn` desenine uyarak: `memories.machine_scope TEXT` (nullable).
ADR-006 aynı desenle `memories`'e altı kolon ekledi (`src/core/db.ts:589-597`);
`machine_scope` onların hemen ardına, aynı `addColumn` bloğunda eklenir.

**`verified_at` çakışması değil, tamamlayıcı:** `memories.verified_at` (ADR-006)
kaydın **global** son doğrulama zamanıdır ("kimse 37 gündür bakmadı"). Buradaki
`memory_machine_state.verified_at` ise **o cihazda** en son ne zaman doğrulandığıdır.
Farklı tablolar, farklı anlam; uçucu + cihaza bağlı bir kayıtta ikisi birlikte
kullanılır (global "en son bakılan" + cihaz başına "burada uygulandı").

### Karar: `unknown` satır olarak YAZILMAZ

Durum kümesi yalnız `applied | not_applied | not_applicable`. "Bilinmiyor",
**satırın yokluğudur**. Gerekçe: aksi hâlde her kayıt × her cihaz için satır
üretmek gerekir (bugün 58 × 3 = 174, hepsi bilgi taşımayan) ve yeni bir cihaz
eklendiğinde tüm tabloyu doldurmak gerekir. Yokluk zaten doğru varsayılan:
**hiçbir şey bilmiyoruz.**

### Karar: `uid` deterministiktir

`uid = sha256(memory_uid + ":" + machine)` ilk 32 hex karakter — `assets`
tablosundaki `sha256(kind+name)` deseniyle aynı mantık.

Bu **kritik**: iki cihaz aynı (memory, machine) çifti için satır üretirse aynı
uid'yi üretir, dolayısıyla sync'te LWW ile birleşirler. Rastgele uid olsaydı
aynı gerçeğin iki kopyası oluşur ve `UNIQUE(memory_uid, machine)` kısıtı
apply sırasında patlardı.

### Karar: satırın tek sahibi vardır

Normal akışta `fatih-mac` yalnız `machine='fatih-mac'` satırını yazar. Bu
yüzden eşzamanlı yazımlar **yapısal olarak** çakışmaz. Alternatif tasarım
(`memories` tablosuna JSON kolon) satır seviyesi LWW'ye tabi olurdu: PC ve Mac
kendi durumlarını aynı anda işaretlese biri diğerini sessizce ezerdi — tam da
bu projenin daha önce yaşadığı sessiz veri kaybı sınıfı.

Başka cihaz adına işaretlemek yasak değildir (ör. "Mac'te uygulanmadığını
biliyorum"); nadirdir ve LWW halleder.

### `machine_scope`

| Değer | Anlamı |
|---|---|
| `NULL` / `global` | Cihazdan bağımsız. **Hiç uyarı üretmez.** |
| `machine_dependent` | Cihaza bağlı. Okuma yolunda durum kontrol edilir. |

`NULL`'ın global sayılması geriye dönük uyumluluğu sağlar: mevcut 58 kaydın
davranışı hiç değişmez.

## 2. Sınıflandırma — kim karar verir

`memory_save` girdisine opsiyonel `machine_scope` eklenir.

Verilmezse tipe göre davranılır:

| Tip | Varsayılan | Davranış |
|---|---|---|
| `decision`, `preference`, `fact` | `global` | sessiz |
| `howto`, `context` | `global` (kayıt yine yazılır) | yanıtta advisory `uyari` |

Advisory metin:

> Bu kayıt cihaza bağlı olabilir (`howto`). Öyleyse `machine_scope:"machine_dependent"`
> ver — yoksa başka cihazdaki agent bu çözümü orada da uygulanmış sayabilir.

**Uyar, kilitleme.** Presence'ın ve `task_complete` doğrulama kapısının
felsefesiyle aynı: kayıt her hâlükârda yazılır.

## 3. Okuma yolu — asıl koruma

`memory_search`, `recall`, `context_get` çıktılarında **yalnız
`machine_scope='machine_dependent'` kayıtlar için** iki alan eklenir:

```jsonc
"machine_state": {
  "current": "applied" | "not_applied" | "not_applicable" | null,
  "others": [ { "machine": "fatih-pc", "status": "applied", "verified_at": "..." } ]
},
"machine_warning": "⚠ ..." // yalnız uyarı gerektiğinde
```

**ADR-006 ile birleşim (önce yaşam döngüsü):** okuma yolu zaten varsayılan
`is_current = 1` filtreliyor. `is_current = 0` (geçersiz kılınmış) bir kayıt
yalnız `include_superseded` ile döner ve o durumda **cihaz uyarısı gösterilmez** —
supersession uyarısı önceliklidir; geçersiz bir kaydın "hangi cihazda uygulandı"
sorusu anlamsızdır. Yani cihaz uyarısı yalnız `is_current = 1 AND
machine_scope = 'machine_dependent'` kayıtlarda üretilir.

Uyarı matrisi (`current` = bu cihazın durumu):

| `current` | Uyarı |
|---|---|
| `applied` | yok |
| `not_applicable` | yok |
| `not_applied` | ⚠ "bu cihazda UYGULANMADI olarak işaretli" |
| yok, başka cihazda `applied` var | ⚠ "yalnız {liste}'de doğrulandı; burada BİLİNMİYOR" |
| yok, hiç satır yok | ⚠ "hiçbir cihazda doğrulanmamış" |

Uyarı metni her zaman **kapatma yolunu** söyler:

> ⚠ Cihaz durumu: bu çözüm yalnız `fatih-pc`'de doğrulandı (2026-07-20). Bu
> cihazda (`fatih-mac`) durum BİLİNMİYOR — uygulanmış varsayma. Doğruladıktan
> sonra `memory_machine_mark` ile işaretle.

**Gürültü kontrolü:** `global` kayıtlar hiç uyarı üretmediği ve varsayılan
`global` olduğu için uyarı nadirdir. Alarm yorgunluğunu engelleyen tek şey bu;
her kaydı `machine_dependent` yapmak tasarımı işlevsiz kılar.

**`context_get` token bütçesi:** uyarı satırı kaydın kendisiyle birlikte
sayılır ve kayıt bütçeye sığmıyorsa uyarı da düşer — ama uyarı **asla tek
başına kırpılmaz**. Yani "kayıt var, uyarısı kırpılmış" durumu oluşamaz;
bu, sessizce yanlış güven üretecek tek senaryo olurdu.

## 4. Yazma yolu

Yeni MCP aracı:

```
memory_machine_mark(memory_uid, status, machine?, note?, verified_by?)
```

- **`memory_uid` kullanılır, `id` değil.** `memories.id` cihaz-yereldir; aynı
  kayıt üç cihazda farklı id taşır. Deftere yerel id yazmak satırı diğer
  cihazlarda yanlış kayda bağlar.
- `machine` verilmezse `resolveMachineName()`.
- `verified_by` **açık parametredir** (agent adı, ör. `"claude-code"`). Sunucu
  çağıranın kimliğini bilmez — MCP oturumu agent adı taşımaz. Verilmezse `NULL`
  kalır; uydurma yapılmaz.
- `verified_at` = şimdi (sunucu saati).
- Upsert (deterministik uid sayesinde `INSERT ... ON CONFLICT(uid) DO UPDATE`).
- **Yan etki:** kaydın `machine_scope`'u `NULL`/`global` ise `machine_dependent`
  yapılır. Gerekçe: bir kaydı cihaz bazında işaretlemek, cihaza bağlılığının
  itirafıdır; ayrıca scope güncellemesi istemek gereksiz sürtünme yaratır.

REST karşılığı: `POST /api/memories/:uid/machine-state`.

## 5. Sync

ADR-005 sonrası sync artık `SYNC_TABLES` dizisiyle sürülüyor (`src/core/db.ts:444`).
Entegrasyon iki parçadır:

1. **Trigger/seed/silme-koruması — tek satır.** `SYNC_TABLES` dizisine ekle:

   ```ts
   { tbl: "memory_machine_state", rowKey: "uid", triggerRowKey: "new.uid", deleteGuard: true },
   ```

   Bu tek girdi `installChangeTriggers` (change_log trigger'ları), `seedChangeLog`
   (yükseltmede mevcut satırların bir kereye mahsus yayını) ve ADR-005 silme-koruma
   trigger'ını otomatik bağlar. ADR-005 bu genişlemeyi açıkça öngörmüştü.

2. **collect/apply — elle bölüm.** `collectChangesBySeq` ve `applyChangesUnsafe`
   hâlâ tablo başına elle kod içeriyor (dizi güdümlü değil). `SyncPayload`'a
   `memory_machine_state` alanı + LWW (`updated_at`) apply bloğu eklenir; deterministik
   uid sayesinde INSERT/UPDATE upsert olur. Legacy peer alanı hiç göndermezse
   `origin_machine`/ADR-006 için kurulan `COALESCE(@col, col)` desenini izle:
   yokluğu boş dizi say, yerel satırı ezme.

- **Silme:** bir memory silindiğinde state satırları da silinir. Silme-koruma
  trigger'ı (`deleteGuard`) satır başına gözlem yapar; ayrıca `deletions`'a
  `tbl='memory_machine_state'` tombstone'u yazılmalı — ADR-005'in "tombstone'suz
  silme replike olmaz" invariant'ı. Cascade tercihi: state satırları memory silme
  yolunda (memories.ts sil fonksiyonu) açıkça temizlenir, trigger'a bırakılmaz.

**Bağımlılık durumu:** ADR-005 ve ADR-006 master'a indi; branch `ab066df` üzerine
rebase edildi. Beklenen sync.ts çakışması artık yok — altyapı hazır.

## 6. Geçiş / backfill

**Otomatik backfill YOK.** Mevcut kayıtlar `machine_scope=NULL` → `global` →
sıfır uyarı, sıfır davranış değişikliği.

`origin_machine`'den otomatik `applied` **türetilmez**: bir kaydı yazmış olmak,
o çözümü o cihazda doğrulamış olmak demek değildir. Yanlış güven üretir.

Birleştirmeden sonra elle işaretlenecek bilinen cihaza-bağlı kayıtlar:
id 24 (SSH erişimi), id 63 (hub cwd/startup), `HUB_MACHINE_NAME` ile ilgili olanlar.

## 7. Test planı (`scripts/smoke.ts`)

Bu görev testsiz kapatılamaz. En az:

1. `global` kayıt → hiçbir cihazda uyarı yok.
2. `machine_dependent`, defter boş → uyarı var.
3. Bu cihazda `applied` → uyarı yok.
4. Yalnız başka cihazda `applied` → uyarı var ve o cihazın adını içeriyor.
5. `not_applicable` → uyarı yok.
6. İlk `memory_machine_mark` → `machine_scope` otomatik `machine_dependent` oldu.
7. Deterministik uid: aynı (memory, machine) iki kez → aynı uid, tek satır.
8. **Sync çakışmasızlığı (bu tasarımın ana iddiası):** iki farklı `machine`
   değeri için satır üret, karşılıklı apply et → **iki satır da hayatta**.
   Bu test geçmezse tasarımın gerekçesi çürümüş demektir.
9. Memory silme → state satırları gitti **ve** tombstone'ları yazıldı.

`npm run build` + `npm run smoke` geçmeli. `task_complete` çağrısında
`verification` kanıtı zorunlu (`kind:"tests"`, komut ve sonuç).

## 8. Doküman güncellemeleri

- `CLAUDE.md` + `AGENTS.md` — **eş içerikli tutulmalı**; agent protokolüne
  cihaz durumu maddesi.
- `docs/agent-platform.md` — yeni MCP aracı ve alanlar.

## 9. Ön koşullar

`HUB_MACHINE_NAME` üç cihazda da kanonik ad vermeli; yoksa `os.hostname()`'e
düşer ve defter yanlış anahtarla dolar — defterin kendisi yalan söyler.

**2026-07-21 itibarıyla sağlandı ve canlı doğrulandı:**

| Cihaz | Durum |
|---|---|
| `fatih-pc` | `.env`'e yazıldı (önce yalnız process env'indeydi) |
| `fatihpi` | zaten vardı |
| `fatih-mac` | `.env`'e yazıldı (hostname zaten eşleşiyordu) |

İlgili bulgu: `.env` `process.cwd()`'den okunur ve `process.env` önceliklidir
(`src/core/config.ts`). Sunucu yanlış dizinden başlarsa konfigürasyon sessizce
kaybolur — bkz. hafıza id 63.

## 10. Riskler

| Risk | Karşılık |
|---|---|
| Alarm yorgunluğu (çok fazla uyarı) | Varsayılan `global`; uyarı yalnız `machine_dependent`'ta |
| Defter dolmaz, boş kalır | Uyarı metni `memory_machine_mark`'ı adıyla söyler — kapatma yolu görünür |
| Cihaz adı kayması | Ön koşul bölümü; üç cihazda da `.env`'e yazıldı |
| `sync.ts` çakışması | ADR-005/006 merge oldu; branch rebase edildi — çakışma yok |
| Agent alanı okumaz | Uyarı ayrı bir alan **ve** metin içinde; sessiz alan değil |
| Geçersiz kılınmış kayıtta gereksiz uyarı | Cihaz uyarısı yalnız `is_current = 1`'de üretilir (§3) |
