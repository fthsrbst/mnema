# ComfyUI Workflowları

Her `.json` dosyası **API formatında** bir ComfyUI workflow'udur.

## Yeni workflow ekleme
1. ComfyUI arayüzünde workflow'u kur, çalıştığını doğrula.
2. Ayarlar → "Dev mode options" açık iken **"Save (API Format)"** ile dışa aktar.
3. Dosyayı buraya `<isim>.json` olarak koy.
4. Değişken olmasını istediğin alanları `{{placeholder}}` ile değiştir:
   - Metin alanı: `"text": "{{prompt}}"`
   - Sayı alanı: `"seed": "{{seed}}"` (tırnaklı yaz; otomatik sayıya çevrilir)
5. `hub sync` sonrası agentlar `image_generate(workflow: "<isim>", inputs: {...})`
   ile kullanır.

## Konvansiyonlar
- `{{prompt}}` — pozitif prompt (zorunlu kabul edilir)
- `{{negative}}` — negatif prompt
- `{{width}}`, `{{height}}`, `{{seed}}` — opsiyonel; seed verilmezse rastgele atanır
- Doldurulmamış placeholder kalırsa üretim reddedilir (sessiz bozuk çıktı yerine hata).
