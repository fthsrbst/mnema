---
name: local-model
description: İşleri Fatih'in PC'sindeki yerel LLM'lere (LM Studio) yönlendirme politikası — hangi işler local_llm'e uygun, model seçimi nasıl yapılır. Toplu/basit/tekrarlı metin işlerinde API maliyetini sıfırlamak için kullan.
---

# Yerel Model Yönlendirme

Hub'daki `local_llm` tool'u LM Studio'daki modelleri çalıştırır — API maliyeti yok, veri dışarı çıkmıyor.

## local_llm'e uygun işler
- Toplu/tekrarlı işler: 50 dosyaya özet, commit mesajı üretimi, veri temizleme/dönüştürme, etiketleme
- Taslaklar: ilk sürüm docstring, test iskeleti, çeviri taslağı (sonra sen rafine et)
- Hassas veri: kullanıcının dışarı çıkmasını istemediği içerik üzerinde işlem
- Kod tamamlama tarzı mekanik üretim: boilerplate, regex, SQL taslağı

## Sende kalması gereken işler (local_llm'e YOLLAMA)
- Mimari kararlar, kod review, zor debug — yargı gerektiren her şey
- Kullanıcıyla diyalog ve nihai çıktı kalitesinin önemli olduğu metinler
- Hub hafızasına yazılacak kayıtların son hali (kalite senin sorumluluğun)

## Kullanım
1. `machine_status` → hangi makinede LM Studio açık, hangi modeller var.
2. Model seçimi (isimden çıkarım):
   - `*coder*` → kod işleri
   - küçük model (7-20B) → hızlı basit işler; büyük (30B+) → kalite gereken taslaklar
   - model belirtmezsen yüklü ilk model kullanılır — toplu işte önce 1 örnekle dene, çıktı iyiyse devam et.
3. `local_llm(prompt, model?, system?, max_tokens?)` — uzun işlerde çıktıyı doğrula: yerel modeller talimat kaçırabilir; kritik alanları örneklemle kontrol et.

## Kural
Sonucu kendi çıktın gibi sunma — yerel model çıktısını kullandıysan doğrulamandan geçir. Hata bulursan kendin düzelt, kullanıcıya ham yerel model çıktısı gösterme.
