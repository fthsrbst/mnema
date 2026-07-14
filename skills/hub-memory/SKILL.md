---
name: hub-memory
description: Ortak hafıza (hub) kullanım kuralları — katmanlı bağlam modeli; ne zaman memory_save/memory_search/rag_add çağrılacağı, kayıt kalite kriterleri. Herhangi bir kodlama görevine başlarken, teknik karar alırken veya kalıcı bilgi üretirken kullan.
---

# Hub Hafıza Kullanımı — Katmanlı Bağlam

Hub, tüm cihazlardaki tüm agentların paylaştığı hafızadır. Sen kapanınca bağlamın silinir; hub silinmez. Bağlam üç katmandır: **otomatik gelen** (bridge/recall), **görev başında çektiğin** (project_get/memory_search), **çalışırken yazdığın** (memory_save/session_log). Doğru davranış katmanına göre değişir.

## Katman 1 — Otomatik gelen (okuman yeter)
- `<hub-bridge>` (oturum başı): aktif projenin map'i + son oturum özeti. Kaldığın yeri buradan al. Map'in gerçekle çeliştiğini görürsen görevin ortasında bile `project_update` ile düzelt.
- `<hub-recall>` (mesaj başı): mesajla yüksek benzerlikli az sayıda kayıt. Sistem bilinçli olarak az ve isabetli enjekte eder; **boş olması "hafızada yok" demek değildir** — şüphen varsa Katman 2'ye in.

## Katman 2 — Görev başında sen çek
1. Projede çalışıyorsan ve bridge gelmediyse `project_get(name)`: özet, stack, kararlar, odak, sıradaki adımlar + kod haritası (architecture/modules/entry_points/commands).
2. "Neden X kullanıyoruz", "bunu daha önce nasıl çözmüştük" → `memory_search(query)`.
3. Doküman/öğrenme notu/araştırma arşivi → `rag_search(query)`.
4. "Nerede kalmıştım" → `session_recent(project)`.

## Katman 3 — Çalışırken yaz

| Durum | Aksiyon |
|---|---|
| Teknik karar alındı (kütüphane, mimari, yaklaşım) | `memory_save` type=decision — **gerekçeyi mutlaka yaz** |
| Zor bir bug çözüldü | `memory_save` type=howto — belirti, kök neden, çözüm |
| Kullanıcı tercih belirtti (stil, araç, workflow) | `memory_save` type=preference |
| Tekrar lazım olacak komut/kurulum/config | `memory_save` type=howto |
| Uzun araştırma/öğrenme çıktısı, doküman, talimat/prompt metni | `rag_add` — memory DEĞİL (öğrenme notu: project='learning', uri='learning/<slug>') |

### Kayıt kalite kuralları
- **Ölçüt:** "Başka bir cihazdaki agent 2 hafta sonra bundan faydalanır mı?" Hayırsa kaydetme (oturuma özel detay, koddan/git'ten okunabilen şey, geçici durum).
- **Boyut:** memory "bir bakışta okunur tek bilgi"dir. Gövde ~1500 karakteri aşıyorsa büyük ihtimalle doküman yazıyorsun → `rag_add`.
- **project alanı:** `project_list`'teki kanonik ad. Makine/cihaz adı (fatih-pc gibi) proje DEĞİLDİR — cihaza özgü bilgiye tags ekle. Yeni gerçek proje açılıyorsa önce `project_update` ile map oluştur.
- **importance:** varsayılan 1 çoğu kayıt için doğrudur. 2 = aylar sonra bile öne geçmesi gereken kritik karar/tercih (nadir!). 0.5 = önemsiz detay. Enflasyon skorlamayı bozar.
- **Dedup:** `memory_save` benzer kayıt uyarısı dönerse ciddiye al — mevcut kaydı `memory_update` ile zenginleştir, yeni açtığını `memory_delete` ile geri al.
- Yanlışlanan bilgiyi gördüğün an düzelt (`memory_update`) veya sil (`memory_delete`). Çelişkili hafıza, hafızasızlıktan kötüdür.

## Oturum sonunda
1. `session_log`: yapılanlar, yarım kalanlar, sıradaki adım — project alanına kanonik adı ver ("proje map'i yok" uyarısı dönerse adı düzelt veya map aç).
2. Odak/adımlar değiştiyse `project_update` ile `current_focus` ve `next_steps` güncelle. **Map'i güncellemeden kapatma:** bayat map bir sonraki agent'ı aktif olarak yanıltır — sonraki oturum "profil yok" diyen 2 gün önceki map'e güvenip yanlış yola girebilir (yaşanmış vaka: jobpilot).
3. **Kod haritası:** Bu oturumda projenin kod yapısını keşfettiysen (yeni modül, taşınan dosya, değişen giriş noktası) `project_update` ile `modules`/`architecture`/`entry_points`/`commands`/`conventions` alanlarını güncelle. Modül başına: `{name, path, purpose, key_files?, depends_on?}`. Amaç: bir sonraki agent kodu sıfırdan keşfetmesin — bridge bu haritayı oturum başında enjekte eder. `modules` TAM listedir (üzerine yazar): önce `project_get` ile mevcutları al, değiştirip geri yaz.
