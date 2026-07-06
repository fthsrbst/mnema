---
name: image-gen
description: Hub üzerinden ComfyUI ile görsel/medya üretimi — bir iş için görsel gerektiğinde (UI mockup dokusu, blog kapağı, asset, test görseli) agent kendisi üretir. workflow seçimi, placeholder kullanımı ve hata ayıklama.
---

# Görsel Üretimi (ComfyUI via Hub)

Bir görsel gerektiğinde kullanıcıdan isteme — hub'daki `image_generate` ile kendin üret.

## Akış
1. `machine_status` → ComfyUI açık mı? Kapalıysa kullanıcıya "ComfyUI'ı açar mısın" de, başka yolu yok.
2. `workflow_list` → mevcut workflowlar. İsimlendirme: `<model>-<görev>` (örn. `z-image-turbo-t2i`, `flux2-t2i`, `qwen-image-edit`).
3. `image_generate(workflow, inputs)` çağır:
   - `inputs.prompt` — İngilizce yaz (görsel modeller İngilizce prompt'ta belirgin daha iyi).
   - Prompt'u zenginleştir: özne + stil + kompozisyon + ışık ("a minimal flat illustration of ..., soft pastel colors, centered composition").
   - `width`/`height` workflow destekliyorsa amaca göre seç (banner 1536x640, ikon 1024x1024).
4. Dönen `files` yerel yol, `urls` hub üzerinden erişim (`http://<hub>:8033/outputs/...`). Dosyayı işinde doğrudan kullan (kopyala, README'ye göm, projeye taşı).

## Workflow seçim rehberi
| İş | Workflow tercihi |
|---|---|
| Hızlı taslak/iterasyon | turbo/distill modeller (z-image-turbo gibi, ~saniyeler) |
| Kaliteli final görsel | flux2 / qwen-image (daha yavaş, daha iyi) |
| Var olan görseli düzenleme | *-edit workflowları (input image ister) |

Önce turbo ile 2-3 varyant üret, beğenilen kompozisyonu kaliteli modelle finalize et.

## Hatalar
- "workflow yok" → `workflow_list`'e bak; yeni workflow eklemek kullanıcı işi (ComfyUI'da "Save (API Format)" + repo `workflows/`).
- "doldurulmamış girdi bekliyor: X" → `inputs.X` değeri ver.
- Zaman aşımı → büyük model ilk yüklemede yavaş; `timeoutSec: 600` ile bir kez daha dene, yine olmazsa kullanıcıya bildir.
- Üretilen görseli beğenmediysen `seed` vermeden tekrar çağır (otomatik rastgele) — aynı prompt farklı sonuç verir.
