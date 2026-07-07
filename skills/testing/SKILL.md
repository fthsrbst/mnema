---
name: testing
description: Test yazma disiplini — neyi test etmeli, neyi etmemeli, test önce mi sonra mı, smoke/birim/uçtan uca dengesi. Yeni özellik yazarken, bug düzeltirken veya "test yazalım mı" sorusunda kullan.
---

# Testing — Ne Zaman, Ne Kadar, Nasıl

## Temel kurallar
- **Her bug düzeltmesi = önce onu yakalayan test.** Test kırmızıyken düzelt, yeşile dön (bu repo'daki smoke pattern'i). Testsiz düzeltilen bug geri gelir.
- **Davranışı test et, implementasyonu değil:** "fonksiyon X'i çağırıyor mu" değil, "girdi A → çıktı B mi". İç yapıya bağlı test, her refactor'da kırılan yüktür.
- **Test piramidi pragmatik:** Bol hızlı birim testi çekirdek mantığa (chunker, arama, LWW merge gibi); az sayıda uçtan uca smoke gerçek akışa (kaydet→ara→bul). UI/entegrasyon testini gerçek fayda varsa yaz.

## Neyi MUTLAKA test et
- Para/veri kaybettirebilecek yollar: silme, senkron/merge, migration
- Sınır koşulları: boş, null, unicode/Türkçe, eşzamanlılık, büyük girdi
- Sözleşmeler: API response şekli, geriye dönük uyumluluk
- Daha önce kırılmış her şey (regresyon)

## Neyi test ETME
- Framework'ün kendisini (express route'a istek atıp "çalışıyor mu" bakmak — bir smoke yeter)
- Getter/setter, saf konfig, tek satırlık delegasyon
- Mock'un mock'unu gerektiren şeyler — tasarım kokusudur; önce bağımlılığı ayrıştır

## Pratik akış (yeni özellik)
1. En riskli davranışı belirle → onun testini İLK yaz (kırmızı)
2. Geçir (yeşil), sonra kenar durumları ekle
3. Smoke'a bir uçtan uca satır ekle (gerçek akış hâlâ bütün mü?)
4. CI yoksa bile: `npm run smoke` alışkanlığı — commit'ten önce çalıştır

## Hata anatomisi
Test başarısız olduğunda mesaj üç soruyu cevaplamalı: ne bekleniyordu, ne geldi, hangi girdiyle. `assert(x)` değil `assert.equal(sonuc, beklenen, "girdi: ...")`.
