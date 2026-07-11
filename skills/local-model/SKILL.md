---
name: local-model
description: Model yönlendirme politikası — işin zorluğuna göre yerel LLM (LM Studio/Ollama) mi, mevcut agent mı karar verilir. Toplu/basit/tekrarlı metin işlerinde API maliyetini sıfırlamak için kullan.
---

# Model Yönlendirme: Zorluğa Göre Karar

Temel kural: **işin zorluğuna göre karar ver.** Üç seviye:

1. **Basit/toplu/mekanik** → `local_llm` (LM Studio veya Ollama, ücretsiz, veri lokalde)
2. **Orta ve zor** → **sen** (mevcut agent) yaparsın — sen zaten güçlü bir bulut modelisin; ekstra API key veya entegrasyon gerekmez. Fatih'in kullandığı agent (Claude Code, opencode go aboneliği vb.) hangisiyse zor işin modeli odur.
3. **Görsel/video/medya** → `media_generate` (ComfyUI, [[media-gen]] skill'i)

Hub'a ayrıca bulut LLM API'si bağlamıyoruz — bilinçli karar: agent'ın kendisi o katman.

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
1. `machine_status` → hangi makinede LM Studio/Ollama açık, hangi modeller var.
2. Model seçimi (isimden çıkarım):
   - `*coder*` → kod işleri
   - küçük model (7-20B) → hızlı basit işler; büyük (30B+) → kalite gereken taslaklar
   - model belirtmezsen yüklü ilk model kullanılır — toplu işte önce 1 örnekle dene, çıktı iyiyse devam et.
3. `local_llm(prompt, model?, backend?, system?, max_tokens?)` — backend boşsa LM Studio öncelikli, `backend: "ollama"` ile Ollama'ya yönlendir. Uzun işlerde çıktıyı doğrula: yerel modeller talimat kaçırabilir; kritik alanları örneklemle kontrol et.

## Kural
Sonucu kendi çıktın gibi sunma — yerel model çıktısını kullandıysan doğrulamandan geçir. Hata bulursan kendin düzelt, kullanıcıya ham yerel model çıktısı gösterme.
