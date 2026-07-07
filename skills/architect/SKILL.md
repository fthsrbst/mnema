---
name: architect
description: Sistem mimarisi kurma disiplini — kod yazmadan önce tasarım, teknoloji seçimi, veri modeli ve sınır tanımları. Yeni proje/özellik/servis tasarlanırken veya "nasıl kurmalıyım" sorusunda kullan.
---

# Architect — Önce Tasarım, Sonra Kod

Orta+ büyüklükte her iş için: koda atlamadan önce bu akışı çalıştır.

## Akış
1. **Geçmişi tara:** `memory_search(type=decision)` + `project_get` — benzer karar daha önce verilmiş mi? Fatih'in stack tercihleri neler? Çelişen karar üretme; değiştireceksen gerekçesiyle değiştir.
2. **Gereksinimleri sıkıştır:** İşlevsel (ne yapacak) + işlevsel olmayan (ölçek, gecikme, maliyet, offline?) — bilinmeyenleri kullanıcıya TEK turda sor, sorularla süründürme.
3. **Veri modelinden başla:** Varlıklar, ilişkiler, yaşam döngüsü. Veri modeli doğruysa kodun yarısı bitmiştir; API ve UI ondan türer.
4. **Sınırları çiz:** Modül/servis sınırları, kim kiminle konuşur, hangi katman neyi bilmez. Tek cümleyle söylenemeyen sorumluluk = yanlış sınır.
5. **En basit mimariyi seç, ölçek yolunu not et:** "Şimdilik SQLite; 1M kayıtta Postgres'e geçiş şurası değişir" tarzı. Bugünün problemi için kur, yarının problemi için kapı bırak (soyutlama katmanı değil — sadece temiz arayüz).
6. **Kararları yaz:** Her önemli seçim için `memory_save(type=decision)` + `project_add_decision`: seçenek, seçilen, gerekçe, ret nedenleri. Format: "YYYY-MM: X seçildi — gerekçe; Y reddedildi çünkü ...".
7. **Doğrulama planı:** Mimarinin en riskli varsayımı ne? Onu ilk sprint'te ucuz bir spike ile test et.

## Refleksler
- İki benzer teknoloji arasında kararsızsan: ekosistem olgunluğu + Fatih'in mevcut bilgisi > yenilik parlaklığı.
- Soyutlamayı ikinci tekrarda ekle, ilk yazımda değil ([[code-conventions]]).
- Dış servis/API entegrasyonunda: timeout, retry, degrade davranışı tasarımın parçası — sonradan eklenti değil.
- Mimari dokümanı kısa tut: 1 diyagram + karar listesi + veri modeli. Uzun doküman okunmaz, güncellenmez.
