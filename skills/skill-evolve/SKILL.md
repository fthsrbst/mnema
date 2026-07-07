---
name: skill-evolve
description: Skill setinin kendini geliştirme döngüsü — tekrarlanan hata/kalıp fark edildiğinde ilgili skill'i güncelle, commit'le, tüm cihazlara dağıt. Bir skill'in eksik/yanlış yönlendirdiğini gördüğünde veya kullanıcı aynı düzeltmeyi ikinci kez yaptığında kullan.
---

# Skill Evolve — Kendini Geliştiren Sistem

Skiller statik doküman değil, yaşayan sistem. Sen (agent) bu sistemin bakımcısısın.
Kaynak: `C:\Users\fatih\Desktop\dev\ai-hub\skills\` (git repo) → `hub sync` ile dağıtılır.

## Ne zaman tetiklenir
- Kullanıcı aynı düzeltmeyi/tercihi **ikinci kez** söylediğinde (bir kez = hafıza, iki kez = skill'e işlenir)
- Bir skill'in yönlendirmesi seni yanlış yola soktuğunda (örn. yanlış workflow önerisi, eskimiş komut)
- Zor bir problemde işe yarayan genellenebilir bir teknik bulduğunda
- Yeni bir araç/workflow eklendiğinde (envanter tabloları güncel kalmalı)

## Döngü
1. **Teşhis:** Hangi skill sorumlu? Yoksa: yeni skill mi gerekiyor, yoksa mevcut birine bölüm mü? (Yeni skill çıtası yüksek tut — az sayıda güçlü skill > çok sayıda cılız skill.)
2. **Güncelle:** Repo'daki `skills/<ad>/SKILL.md` dosyasını düzenle. Kural: değişiklik *davranış* değiştirmeli — "daha iyi ol" gibi laf kalabalığı ekleme; somut kural/tablo/komut ekle veya yanlışı sil.
3. **Kaydet:** `memory_save(type=howto, tags=["skill-evolve"])` — ne öğrenildi, hangi skill nasıl değişti. Bu, değişikliğin gerekçe kaydıdır.
4. **Dağıt:** `git add skills/ && git commit -m "skill: <ad> — <değişiklik>" && git push`, sonra `hub sync`. Diğer cihazlar bir sonraki `hub sync`'te alır.
5. **Kullanıcıya tek satır bildir:** "X skill'ine şunu işledim" — onay bekleme, geri alınabilir.

## Güvenlik: "ya daha kötü hale getirirsem?"
Her skill değişikliği git commit'i olduğu için **hiçbir değişiklik kalıcı hasar değildir**:
- **Geri alma:** `git log -- skills/<ad>/` ile geçmişi gör, `git revert <commit>` (veya `git checkout <eski-sha> -- skills/<ad>/SKILL.md`) + push + `hub sync` → eski hal tüm cihazlara döner.
- **Küçük diff kuralı:** Tek commit'te tek skill, tek konu. Toptan yeniden yazma YASAK — kötüleşmeyi fark etmeyi ve geri almayı zorlaştırır.
- **Silme yerine daraltma:** Var olan bir kuralı silmeden önce neden yanlış olduğunu commit mesajında kanıtla. Emin değilsen kuralı silme, "eskimiş olabilir" notu düş.
- **Kötüleşme sinyali:** Bir skill güncellemesinden sonra aynı türde iş 2+ kez daha kötü giderse, ilk şüphen son skill değişikliği olsun → `git log`'a bak, revert et, hafızaya ders yaz.
- Kullanıcı "bu skill eskiden daha iyiydi" derse: tartışma, önce revert, sonra konuş.

## Kalite çıtaları
- Skill'ler **kod/yazılım odaklı** kalır; genel amaçlı ofis skill'i ekleme.
- Her skill'de: ne zaman kullanılacağı (description) + somut akış + hata/istisna bölümü.
- Çelişki bulursan (iki skill farklı şey söylüyor): birleştir veya sınırı netleştir, ikisini de bırakma.
- Üç ayda bir (veya kullanıcı isteyince): tüm skill'leri tara, kullanılmayanı/eskiyeni tespit et, öner.
