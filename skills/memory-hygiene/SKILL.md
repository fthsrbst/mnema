---
name: memory-hygiene
description: Bellek hijyeni — tekrar tespiti, eskimiş kayıt temizliği, çelişki çözümü, bilgi sıkıştırma. Hub'daki bilgi kalitesini korumak için periyodik veya sorun tespitinde kullan.
---

# Bellek Hijyeni (Memory Hygiene)

Hub zamanla tekrar, eskimiş ve çelişkili kayıtlarla dolar. Hijyen araçları bu sorunları tespit eder ve çözer.

## Hijyen Raporu

### hygiene_report
```json
{}
```

Dönen rapor:
- `duplicates` — benzer/tekrar kayıtlar (aynı bilgi farklı wording)
- `stale` — uzun süredir erişilmemiş, düşük önem kayıtlar
- `contradictions` — `contradicts` ilişkisi olan ama ikisi de aktif kayıtlar
- `suggestions` — önerilen aksiyonlar

## Otomatik Temizlik

### hygiene_run
```json
{}
```

Yapılan işlemler:
1. **Eskileri arşivle:** 90+ gün erişilmemiş, importance < 0.7 → importance 0.5'e düşür, "archived" tag ekle
2. **Çelişkileri işaretle:** `contradicts` ilişkisi olan kayıtları raporla

**Dikkat:** Otomatik temizlik silmez, sadece arşivler. Silme kararı manuel verilmeli.

## Manuel Müdahale

### Tekrar Birleştirme
İki kayıt aynı bilgiyi içeriyorsa:
1. İyi olanı seç (daha eksiksiz, daha güncel)
2. `memory_update` ile diğerinin bilgisini ekle
3. Kötü olanı `memory_delete` ile sil

### Çelişki Çözümü
İki kayıt çelişiyorsa:
1. Hangisi doğru/güncel belirle
2. Yanlış olanı sil VEYA `memory_update` ile düzelt
3. Çelişki ilişkisini kaldır

### Eskimiş Temizliği
`stale` listesindeki kayıtlar için:
- Hâlâ geçerli mi? → importance artır, `last_accessed` güncelle
- Artık geçersiz mi? → sil
- Nadiren lazım mı? → arşivde bırak (importance 0.5)

## Bilgi Sıkıştırma (Compaction)

### compact_project
```json
{ "project": "my-project", "mode": "sessions" }
```

Modlar:
- `sessions` — son N oturum özetini tek "proje geçmişi" dokümanına sıkıştır
- `decisions` — eski kararları karar-özet dokümanına birleştir
- `distill` — tam sıkıştırma: oturumlar + kararlar + eski hafızalar → özet referans

**Ne zaman sıkıştır:**
- Proje çok uzun süredir aktif (50+ oturum)
- Bağlam çok büyüdü, recall yavaşladı
- Eski bilgiler artık detay değil, sadece özet yeterli

## Periyodik Bakım Önerisi

| Sıklık | Aksiyon |
|---|---|
| Her oturum | Çelişki görürsen hemen düzelt |
| Haftalık | `hygiene_report` kontrol et |
| Aylık | `hygiene_run` + manuel tekrar birleştirme |
| Proje bazlı | 50+ oturumda `compact_project` |

## En İyi Pratikler

1. **Erken müdahale:** Çelişki gördüğün an düzelt — birikmesin
2. **Sil, arşivleme:** Gerçekten geçersiz bilgiyi sil, arşivde tutma
3. **Birleştir:** Tekrarları tek kayıtta topla — arama kalitesi artar
4. **Sıkıştır:** Uzun projelerde detayları özete dönüştür
5. **importance:** Arşivlenen kaydın importance'ı 0.5 — arama sonuçlarında geriye düşer ama silinmez
