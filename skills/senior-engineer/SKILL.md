---
name: senior-engineer
description: Senior yazılımcı disiplini — kod yazarken kalite çıtası, bitmeden önce kontrol listesi, kısayol/borç kararlarının bilinçli verilmesi. Her ciddi kod yazma/değiştirme işinde uygula.
---

# Senior Engineer Disiplini

Junior kod "çalışır"; senior kod **değiştirilebilir, hata durumunda anlaşılır ve gelecekteki okuyucuya dürüsttür**. Bu skill davranış çıtasıdır.

## Yazarken
- **Önce oku, sonra yaz:** Değiştireceğin kodun çağıranlarını ve testlerini görmeden dokunma. Var olan pattern'i takip et; "daha iyi" pattern'i habersiz sokma ([[code-conventions]]).
- **Hata yolları birinci sınıf:** Her dış çağrı (ağ, dosya, DB, process) için: timeout var mı, hata mesajı teşhis ettirir mi, degrade davranışı bilinçli mi? Mutlu yol kadar hata yolunu da yaz.
- **Sınır koşulları yazarken düşün:** boş liste, null, aynı anda iki çağrı, çok büyük girdi, Türkçe/unicode. Sonradan test yazarken değil, kodu yazarken.
- **Geri alınabilirlik:** Şema/format değişikliklerinde eski veriyle karşılaşınca ne olur? Migration tek yönlü mü? (Bu repo'daki `migrate()` pattern'i örnek.)

## Bitti demeden önce (kontrol listesi)
1. Çalıştırdın mı? (derleme ≠ çalışma; test ≠ gerçek akış)
2. Hata yolunu en az bir kez tetikledin mi?
3. Sildiğin/değiştirdiğin şeyin başka kullanıcısı var mıydı? (grep)
4. Log/hata mesajları, sorunu YAŞAMAYAN birinin teşhis etmesine yeter mi?
5. Değişikliğin en riskli varsayımı ne — ve nasıl doğruladın?
6. Alınan kalıcı karar varsa hub'a yazdın mı? (`memory_save` type=decision)

## Teknik borç: bilinçli al, kaydet
Kısayol almak bazen doğrudur — ama **sessizce değil**:
- Kısayolu kod içinde `// TODO(borç):` ile işaretle + gerekçe.
- Önemliyse proje map'ine `next_steps` olarak ekle.
- "Sonra düzeltirim" deme; ya şimdi düzelt ya kayda geçir. Kayıtsız borç faizle döner.

## Ölçek refleksi
- O(n²) döngü + kullanıcı verisi = ileride şikayet. Yazarken n'in kaç olabileceğini bir kez düşün.
- Ama erken optimizasyon da yapma: ölçmediğin şeyi hızlandırma. Önce doğru, sonra ölç, sonra hızlandır.
