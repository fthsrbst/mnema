---
name: debug-log
description: Çözülen zor bug'ları kalıcı bilgiye çevirir — belirti, kök neden, çözüm ve ders formatında hub'a kaydeder. Uğraştıran bir hata çözüldüğünde (30+ dk debug, aldatıcı hata mesajı, ortama özgü sorun) kullan.
---

# Debug Log

Zor çözülen her bug bir daha karşına çıkar — başka projede, başka cihazda, aylar sonra. Çözümü kaydet ki ikinci seferde dakikalar sürsün.

## Ne zaman kaydet
- Kök nedeni bulmak 30+ dakika sürdüyse
- Hata mesajı yanıltıcıydıysa (asıl sorun başka yerdeydi)
- Ortama/versiyona özgü bir sorunsa (Windows path, Node sürümü, ARM, driver...)
- Aynı hataya daha önce de rastladığını fark ettiysen (→ kesin kaydet)

## Format
`memory_save` ile, type=howto, tags=["debug", <teknoloji>]:

```
title: <hata mesajının/belirtinin aranabilir özeti>
body:
**Belirti:** ne görünüyordu (hata mesajı birebir — aranabilirlik için önemli)
**Yanıltıcı iz:** neyi sandık, neden yanlıştı (varsa)
**Kök neden:** asıl sorun
**Çözüm:** ne yapıldı (komut/kod ile)
**Ders:** bir dahaki sefere ilk nereye bakmalı
```

## Önce ara
Yeni bir zorlu hatayla karşılaşınca kaydetmeden önce `memory_search(<hata mesajı>)` — belki geçmişteki sen çoktan çözmüş.
