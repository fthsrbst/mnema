---
name: hub-memory
description: Ortak hafıza (hub) kullanım kuralları — ne zaman memory_save/memory_search/rag_add çağrılacağı. Herhangi bir kodlama görevine başlarken, teknik karar alırken veya kalıcı bilgi üretirken kullan.
---

# Hub Hafıza Kullanımı

Hub, tüm cihazlardaki tüm agentların paylaştığı hafızadır. Sen kapanınca bağlamın silinir; hub silinmez. Bu yüzden:

## Göreve başlarken
1. Mesaja `<hub-recall>` bloğu eklendiyse önce onu oku (otomatik gelir).
2. Bir proje üzerinde çalışıyorsan `project_get(name)` çağır: özet, stack, kararlar, mevcut odak, sıradaki adımlar.
3. Konuyla ilgili geçmiş karar/how-to olabilir → `memory_search(query)` — özellikle "neden X kullanıyoruz", "bunu daha önce nasıl çözmüştük" tarzı durumlarda.

## Çalışırken — kaydet
| Durum | Aksiyon |
|---|---|
| Teknik karar alındı (kütüphane, mimari, yaklaşım) | `memory_save` type=decision — **gerekçeyi mutlaka yaz** |
| Zor bir bug çözüldü | `memory_save` type=howto — belirti, kök neden, çözüm |
| Kullanıcı tercih belirtti (stil, araç, workflow) | `memory_save` type=preference |
| Tekrar lazım olacak komut/kurulum/config | `memory_save` type=howto |
| Uzun araştırma/öğrenme çıktısı üretildi | `rag_add` — markdown olarak indeksle |

## Kaydetme kriterleri
- **Kaydet:** bir sonraki oturumda (belki başka cihazda, belki başka agent) işe yarayacak bilgi.
- **Kaydetme:** bu oturuma özel detaylar, koddan/git geçmişinden zaten okunabilen şeyler, geçici durumlar.
- Yanlışlanan bilgiyi gör → `memory_update` ile düzelt veya `memory_delete` ile sil. Çelişkili hafıza, hafızasızlıktan kötüdür.

## Oturum sonunda
`session_log` ile özet bırak: ne bitti, ne yarım, sıradaki adım. Proje odağı değiştiyse `project_update` ile `current_focus` ve `next_steps` güncelle.
