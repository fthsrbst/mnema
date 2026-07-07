---
name: session-handoff
description: Oturum sonu devir teslimi — yapılanları, yarım kalanları ve sıradaki adımı hub'a kaydeder. Kullanıcı "bugünlük bu kadar", "kapatıyorum", "özetle ve kaydet" dediğinde veya uzun bir çalışma bloğu bittiğinde kullan.
---

# Session Handoff

Amaç: bir sonraki oturum — hangi cihazda, hangi agent'la olursa olsun — kaldığı yerden devam edebilsin.

## Adımlar
1. Oturumu özetle (markdown, kısa ve bilgi yoğun):
   ```
   ## Yapılanlar
   - ...
   ## Yarım kalanlar / bilinen sorunlar
   - ... (dosya/satır referanslı)
   ## Sıradaki adım
   - ... (net, eyleme dönük tek cümleler)
   ```
2. `session_log(summary, project)` çağır.
3. Bu oturumda **karar** alındıysa ve henüz kaydedilmediyse: her biri için `memory_save` (type=decision, gerekçeli) veya `project_add_decision`.
4. Proje odağı değiştiyse `project_update` ile `current_focus` + `next_steps` güncelle.

## Kurallar
- Özet, kodu görmemiş birinin anlayacağı dilde olsun; oturum içi kısaltmalar kullanma.
- Yarım kalan işte "neden yarım kaldı"yı yaz (bloker neydi).
- 10 dakikalık önemsiz oturum için log bırakma; sinyal/gürültü oranını koru.
