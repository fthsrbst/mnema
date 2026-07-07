---
name: learn
description: Yazılım/kodlama öğrenme asistanı — konuyu katmanlı anlatır, kalıcı öğrenme notu üretip hub RAG'ine indeksler, mini quiz ile pekiştirir. Kullanıcı bir teknoloji/kavram öğrenmek istediğinde ("X nedir", "X öğrenmek istiyorum", "X nasıl çalışır") kullan.
---

# Learn — Öğrenme Akışı

Amaç: öğrenilen her konu aranabilir, tekrar edilebilir kalıcı bilgiye dönüşsün.

## Akış
1. **Seviye tespiti:** `memory_search("<konu>")` + `rag_search("<konu>")` — daha önce bu konuda not var mı? Varsa üstüne inşa et, sıfırdan anlatma.
2. **Katmanlı anlatım:**
   - Önce zihinsel model (bu ne, hangi sorunu çözüyor, neye benziyor)
   - Sonra çalışan minimal kod örneği (kullanıcının bildiği stack'te)
   - Sonra "gerçek hayatta nerede kırılır" (yaygın hatalar, edge case'ler)
3. **Uygulatma:** küçük bir egzersiz öner; kullanıcı kodu yazsın, sen review et. İzlemek değil yapmak öğretir.
4. **Not üret ve indeksle:** konu kapanırken kompakt bir öğrenme notu yaz ve `rag_add` ile kaydet:
   ```
   title: "Öğrenme notu: <konu>"
   uri: "learn/<konu-slug>"        ← tekrar öğrenmede re-index olur
   project: "learning"
   text:
   # <Konu>
   ## Zihinsel model  (2-3 cümle)
   ## Temel API/kavramlar  (madde madde)
   ## Kod örneği  (çalışan, minimal)
   ## Tuzaklar  (yaşanan hatalar dahil)
   ## Açık sorular  (henüz anlaşılmayanlar)
   ```
5. **Mini quiz:** 3-4 soru sor (kod okuma + "bu neden patlar?" tarzı). Yanlışları nota işle.

## Tekrar (spaced repetition)
Kullanıcı "tekrar edelim" derse: `rag_search(project="learning")` ile eski notları çek, "Açık sorular" bölümlerinden ve tuzaklardan quiz üret. Doğru cevaplananları nottan düşür, notu `rag_add` ile (aynı uri) güncelle.
